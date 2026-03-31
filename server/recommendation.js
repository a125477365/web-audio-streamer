/**
 * 推荐引擎
 * 基于本地音乐库分析推荐相似音乐
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { OpenClawConfig } from './openclaw-config.js';

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
    const musicPath = this.config.music?.downloadPath || './music';
    this.localMusicCache = this._scanLocalMusic(musicPath);
    
    if (this.localMusicCache.length === 0) {
      // 如果本地没有音乐，随机推荐热门歌曲
      return await this._randomRecommend(options);
    }
    
    // 2. 分析本地音乐并生成推荐
    const recommendations = await this._generateRecommendations(options);
    
    // 3. 搜索并播放
    this.currentPlaylist = recommendations;
    this.currentIndex = 0;
    
    return {
      success: true,
      playlist: this.currentPlaylist,
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
    
    // 调用 AI 模型生成推荐
    try {
      const aiRecommendations = await this._callAIForRecommendations(artists, options);
      return aiRecommendations;
    } catch (error) {
      console.error('[Recommend] AI call failed:', error.message);
      // 降级：直接搜索艺术家相关歌曲
      return await this._fallbackRecommendations(artists);
    }
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
    const { provider, model, baseUrl } = this.config.ai || {};
    
    // 从配置获取 API Key
    const apiKey = process.env.NVIDIA_API_KEY || this._findApiKey();
    
    if (!apiKey) {
      throw new Error('No API key found');
    }
    
    const prompt = `你是一个音乐推荐专家。用户本地有以下艺术家的歌曲：${artists.join('、')}。

请推荐10首与这些艺术家风格相似的高质量无损音乐（可以是相同艺术家或其他相似艺术家的歌曲）。

返回格式要求：每行一首，格式为"歌手 - 歌名"，不要其他内容。`;

    const response = await this._callLLM(baseUrl, apiKey, model || 'z-ai/glm5', prompt);
    
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
      .slice(0, 10);
    
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
    const recommendations = [];
    
    for (const artist of artists.slice(0, 3)) {
      try {
        const searchResults = await this._searchOnline(artist);
        recommendations.push(...searchResults.slice(0, 3));
      } catch (e) {
        console.error('[Recommend] Search failed for:', artist);
      }
    }
    
    return recommendations.slice(0, 10);
  }

  /**
   * 在线搜索
   */
  async _searchOnline(query) {
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=5`;
    
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
    const randomArtists = ['周杰伦', '林俊杰', '邓紫棋', '陈奕迅', '薛之谦', '毛不易', '华晨宇', '李荣浩'];
    const selected = randomArtists.sort(() => Math.random() - 0.5).slice(0, 3);
    
    return await this._fallbackRecommendations(selected);
  }
}
