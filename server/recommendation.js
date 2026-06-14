/**
 * 推荐引擎
 * 基于本地音乐库分析推荐相似音乐
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { OpenClawConfig } from './openclaw-config.js';
import { hasHermes, runHermesOneshot } from './hermes-agent.js';

export class RecommendationEngine {
  constructor(config) {
    this.config = config;
    this.isPlaying = false;
    this.currentPlaylist = [];
    this.currentIndex = 0;
    this.localMusicCache = [];
    this.stopRequested = false;
    this.onPlayCallback = null;
  }

  /**
   * 开始推荐播放
   */
  async start(options = {}) {
    this.stopRequested = false;
    this.isPlaying = true;
    
    // 1. 获取本地音乐列表
    const musicPath = this.config.music?.path || './music';
    this.localMusicCache = this._scanLocalMusic(musicPath);

    // 2. 生成推荐（本地没有音乐时随机推荐热门歌手）
    const recommendations = this.localMusicCache.length === 0
      ? await this._randomRecommend(options)
      : await this._generateRecommendations(options);

    // 3. 解析为可播放歌曲（补全歌曲 id，前端通过 /api/online/play 播放）
    //    已带 id 的直接用；hermes 返回的(歌手-歌名)并发搜网易云补 id，保持原推荐顺序。
    const resolved = new Array(recommendations.length).fill(null);
    const concurrency = 6;
    let cursor = 0;
    const worker = async () => {
      while (cursor < recommendations.length) {
        const idx = cursor++;
        const rec = recommendations[idx];
        if (rec.id) { resolved[idx] = { source: 'wy', ...rec }; continue; }
        try {
          const found = await this._searchOnline(`${rec.artist} ${rec.title}`);
          if (found.length > 0) resolved[idx] = { ...found[0], source: 'wy' };
        } catch (e) {
          console.warn('[Recommend] 解析歌曲失败:', rec.artist, rec.title, e.message);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    this.currentPlaylist = resolved.filter(Boolean);
    this.currentIndex = 0;

    return {
      success: true,
      playlist: this.currentPlaylist,
      source: this.lastSource || 'fallback',
      localMusicCount: this.localMusicCache.length
    };
  }

  /**
   * 停止推荐
   */
  stop() {
    this.stopRequested = true;
    this.isPlaying = false;
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      isPlaying: this.isPlaying,
      running: this.isPlaying,
      currentIndex: this.currentIndex,
      playlistLength: this.currentPlaylist.length,
      localMusicCount: this.localMusicCache.length
    };
  }

  /**
   * 设置播放回调
   */
  onPlay(callback) {
    this.onPlayCallback = callback;
  }

  /**
   * 扫描本地音乐
   */
  _scanLocalMusic(dir) {
    const musicFiles = [];
    
    if (!fs.existsSync(dir)) {
      return musicFiles;
    }
    
    const scanDir = (currentDir) => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      
      items.forEach(item => {
        const fullPath = path.join(currentDir, item.name);
        
        if (item.isDirectory()) {
          scanDir(fullPath);
        } else if (this._isMusicFile(item.name)) {
          musicFiles.push({
            path: fullPath,
            name: item.name,
            dir: currentDir
          });
        }
      });
    };
    
    scanDir(dir);
    return musicFiles;
  }

  /**
   * 判断是否为音乐文件
   */
  _isMusicFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.ape'].includes(ext);
  }

  /**
   * 生成推荐列表
   */
  async _generateRecommendations(options) {
    // 提取本地音乐的艺术家
    const artists = this._extractArtists();

    // 优先级1：本地 Hermes Agent（智能推荐，无需在本应用配置 LLM key）
    if (hasHermes()) {
      try {
        const recs = await this._callHermesForRecommendations(artists);
        if (recs.length > 0) {
          console.log(`[Recommend] ✅ 本地 Hermes Agent 推荐 ${recs.length} 首`);
          this.lastSource = 'hermes';
          return recs;
        }
        console.warn('[Recommend] Hermes 未解析出有效推荐，回退');
      } catch (e) {
        console.warn('[Recommend] Hermes 推荐失败，回退:', e.message);
      }
    }

    // 优先级2：直连 LLM（需在 openclaw 配置/环境变量里有 API key）
    try {
      const recs = await this._callAIForRecommendations(artists, options);
      this.lastSource = 'llm';
      return recs;
    } catch (error) {
      console.error('[Recommend] AI call failed:', error.message);
      // 优先级3：纯关键词搜索兜底（无 AI）
      this.lastSource = 'fallback';
      return await this._fallbackRecommendations(artists);
    }
  }

  /**
   * 调用本地 Hermes Agent 生成推荐列表
   * 返回 [{ artist, title }]，由 start() 再解析为可播放歌曲
   */
  async _callHermesForRecommendations(artists) {
    const seed = (artists && artists.length)
      ? `用户喜欢这些歌手：${artists.join('、')}。`
      : '用户喜欢华语流行音乐。';
    const prompt =
      `${seed}请推荐30首风格相似、适合连续聆听的华语歌曲（可包含相同或相似歌手）。` +
      `严格要求：只输出歌曲列表，每行一首，格式为「歌手 - 歌名」，不要序号、不要解释、不要空行、不要使用任何工具或联网，直接凭你的音乐知识回答。`;

    // Hermes 启动+推理较慢，给一个有界超时；超时则上层回退到关键词搜索，避免 FM 无限等待。
    // 可用 HERMES_RECOMMEND_TIMEOUT_MS 环境变量调整（默认 300s，hermes 启动+推理较慢）。
    const timeoutMs = parseInt(process.env.HERMES_RECOMMEND_TIMEOUT_MS, 10) || 300000;
    const text = await runHermesOneshot(prompt, { timeoutMs, lightweight: true });

    const recommendations = [];
    const seen = new Set();
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim().replace(/^\d+[.、)]\s*/, ''); // 去掉可能的序号
      // 必须形如 "歌手 - 歌名"
      const m = line.match(/^(.{1,40}?)\s*[-–—]\s*(.{1,60})$/);
      if (!m) continue;
      const artist = m[1].trim();
      const title = m[2].trim();
      if (!artist || !title) continue;
      // 过滤明显的非歌曲行（含冒号说明、括号注释开头等）
      if (/[:：]/.test(artist)) continue;
      const key = `${title}|${artist}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recommendations.push({ artist, title });
      if (recommendations.length >= 30) break;
    }
    return recommendations;
  }

  /**
   * 提取艺术家列表
   */
  _extractArtists() {
    const artists = new Set();
    
    this.localMusicCache.forEach(file => {
      const name = file.name;
      // 尝试从文件名提取艺术家 (格式: 歌手 - 歌名.mp3)
      const match = name.match(/^(.+?)\s*-\s*(.+)\.[^.]+$/);
      if (match) {
        artists.add(match[1].trim());
      }
    });
    
    return Array.from(artists).slice(0, 10); // 最多10个艺术家
  }

  /**
   * 调用 AI 模型获取推荐
   */
  async _callAIForRecommendations(artists, options) {
    const llmConfig = await this._getLLMConfig();

    if (!llmConfig?.apiKey) {
      throw new Error('No AI API key found in OpenClaw config or environment');
    }

    const baseUrl = llmConfig.baseUrl || "https://integrate.api.nvidia.com/v1";
    const apiKey = llmConfig.apiKey;
    const model = llmConfig.model || 'nvidia/nemotron-3-super-120b-a12b';

    const prompt = `你是一个音乐推荐专家。用户本地有以下艺术家的歌曲：${artists.join('、')}。

请推荐30首与这些艺术家风格相似的高质量无损音乐（可以是相同艺术家或其他相似艺术家的歌曲）。

返回格式要求：每行一首，格式为"歌手 - 歌名"，不要其他内容。`;

    const response = await this._callLLM(baseUrl, apiKey, model, prompt);

    // 解析推荐列表
    const recommendations = response.split('\n')
      .filter(line => line.includes('-'))
      .map(line => {
        const parts = line.split('-').map(p => p.trim());
        return {
          artist: parts[0],
          title: parts.slice(1).join('-')
        };
      })
      .slice(0, 30);

    return recommendations;
  }

  /**
   * 查找 API Key
   */
  async _initOpenClawConfig() {
 if (!this.openclawConfig) {
 this.openclawConfig = await new OpenClawConfig().init();
 }
 }
 
 _findApiKey() {
 return null; // 由 _callAIForRecommendations 处理
 }
 
 async _getLLMConfig() {
 await this._initOpenClawConfig();
 return this.openclawConfig.getLLMConfig();
 }

 /**
   * 调用 LLM
   */
  async _callLLM(baseUrl, apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.8
      });
      
      const options = {
        hostname: new URL(baseUrl).hostname,
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(data)
        }
      };
      
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * 降级推荐方案
   */
  async _fallbackRecommendations(artists) {
    const TARGET = 30;
    const recommendations = [];
    const seen = new Set();
    const pool = (artists && artists.length)
      ? artists
      : ['周杰伦', '林俊杰', '邓紫棋', '陈奕迅', '薛之谦', '毛不易', '华晨宇', '李荣浩'];

    for (const artist of pool) {
      if (recommendations.length >= TARGET) break;
      try {
        const searchResults = await this._searchOnline(artist);
        for (const s of searchResults) {
          const key = `${s.title || ''}|${s.artist || ''}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          recommendations.push(s);
          if (recommendations.length >= TARGET) break;
        }
      } catch (e) {
        console.error('[Recommend] Search failed for:', artist);
      }
    }

    return recommendations.slice(0, TARGET);
  }

  /**
   * 在线搜索
   */
  async _searchOnline(query) {
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=10`;
    
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://music.163.com/'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const songs = json.result?.songs || [];
            resolve(songs.map(s => ({
              id: s.id,
              title: s.name,
              artist: s.artists?.map(a => a.name).join('/') || '未知'
            })));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 随机推荐（本地无音乐时）
   */
  async _randomRecommend(options) {
    const randomArtists = ['周杰伦', '林俊杰', '邓紫棋', '陈奕迅', '薛之谦', '毛不易', '华晨宇', '李荣浩', '王力宏', '五月天', '蔡依林', '张惠妹', '孙燕姿', '周深'];
    const selected = randomArtists.sort(() => Math.random() - 0.5).slice(0, 8);

    return await this._fallbackRecommendations(selected);
  }
}
