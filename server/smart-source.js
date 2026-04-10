/**
 * 智能音源搜索模块
 * 
 * 使用AI自动搜索并测试多个音源API，评分排序选择最佳音源
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

// OpenClaw 配置路径（跨平台支持）
const CONFIG_PATHS = {
  linux: [
    process.env.HOME + '/.openclaw/agents/main/agent/models.json',
    process.env.HOME + '/.openclaw/config/api-keys.env',
    '/app/agents/main/agent/models.json',
    '/app/config/api-keys.env',
  ],
  darwin: [ // macOS
    process.env.HOME + '/.openclaw/agents/main/agent/models.json',
    process.env.HOME + '/.openclaw/config/api-keys.env',
  ],
  win32: [
    process.env.USERPROFILE + '/.openclaw/agents/main/agent/models.json',
    process.env.USERPROFILE + '/.openclaw/config/api-keys.env',
  ]
};

// 已知的音源API列表
const KNOWN_SOURCES = [
  {
    name: 'nuoxian',
    searchUrl: 'https://api.nxvav.cn/api/music/',
    format: 'json',
    needsAuth: true,
    platforms: ['netease', 'tencent', 'kugou', 'baidu', 'kuwo']
  },
  {
    name: 'injahow-meting',
    searchUrl: 'https://api.injahow.cn/meting/',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'tencent', 'kugou']
  },
  {
    name: 'bugpk',
    searchUrl: 'https://api.bugpk.com/api/music',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'tencent']
  },
  {
    name: 'sunzongzheng',
    searchUrl: 'https://suen-music-api.leanapp.cn/',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'qq']
  }
];

export class SmartSourceFinder {
  constructor(config) {
    this.config = config;
    this.llmConfig = null;
    this.testResults = [];
  }

  /**
   * 自动检测OpenClaw配置
   */
  async detectOpenClawConfig() {
    const platform = process.platform;
    const paths = CONFIG_PATHS[platform] || CONFIG_PATHS.linux;
    
    let modelsConfig = null;
    let apiKeys = {};

    // 查找 models.json
    for (const p of paths) {
      if (p.includes('models.json') && fs.existsSync(p)) {
        try {
          modelsConfig = JSON.parse(fs.readFileSync(p, 'utf-8'));
          console.log(`[SmartSource] Found models config: ${p}`);
          break;
        } catch (e) {}
      }
    }

    // 查找 api-keys.env
    for (const p of paths) {
      if (p.includes('api-keys.env') && fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          content.split('\n').forEach(line => {
            const match = line.match(/^(\w+)=(.+)$/);
            if (match) {
              apiKeys[match[1]] = match[2].trim();
            }
          });
          console.log(`[SmartSource] Found API keys: ${p}`);
          break;
        } catch (e) {}
      }
    }

    this.llmConfig = {
      models: modelsConfig,
      apiKeys: apiKeys
    };

    return this.llmConfig;
  }

  /**
   * 使用LLM搜索更多音源
   */
  async searchSourcesWithLLM() {
    if (!this.llmConfig) {
      await this.detectOpenClawConfig();
    }

    // 获取可用的LLM配置
    const providers = this.llmConfig?.models?.providers || {};
    let llmEndpoint = null;
    let llmApiKey = null;
    let llmModel = null;

    // 优先使用 zhipu-glm
    if (providers['zhipu-glm']) {
      llmEndpoint = providers['zhipu-glm'].baseUrl;
      llmApiKey = providers['zhipu-glm'].apiKey;
      llmModel = 'glm-5-turbo';
    } else if (providers['modelstudio']) {
      llmEndpoint = providers['modelstudio'].baseUrl;
      llmApiKey = 'qqqqq'; // 需要从apiKeys获取
      llmModel = 'qwen3.5-plus';
    }

    if (!llmEndpoint) {
      console.log('[SmartSource] No LLM config found, using known sources');
      return KNOWN_SOURCES;
    }

    // 使用LLM搜索音源信息
    const prompt = `请搜索并列出2024-2025年可用的免费音乐API，要求：
1. 能获取完整歌曲播放链接（不是试听片段）
2. 支持搜索功能
3. 返回JSON格式数据
4. 列出API地址、支持的平台（网易云、QQ音乐等）、是否需要认证

请直接返回JSON数组格式，例如：
[{"name":"xxx","url":"https://xxx","platforms":["netease"],"needsAuth":false}]`;

    try {
      const response = await this._callLLM(llmEndpoint, llmApiKey, llmModel, prompt);
      // 尝试解析LLM返回的JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const llmSources = JSON.parse(jsonMatch[0]);
        console.log(`[SmartSource] LLM found ${llmSources.length} additional sources`);
        return [...KNOWN_SOURCES, ...llmSources];
      }
    } catch (e) {
      console.log('[SmartSource] LLM search failed:', e.message);
    }

    return KNOWN_SOURCES;
  }

  /**
   * 调用LLM API
   */
  async _callLLM(endpoint, apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint + '/chat/completions');
      const lib = url.protocol === 'https:' ? https : http;
      
      const data = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2000
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 30000
      };

      const req = lib.request(url, options, (res) => {
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
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM request timeout'));
      });
      req.write(data);
      req.end();
    });
  }

  /**
   * 测试单个音源
   */
  async testSource(source, testSong = '周杰伦') {
    const startTime = Date.now();
    
    try {
      let url;
      if (source.name === 'nuoxian') {
        url = `${source.searchUrl}?server=netease&type=search&id=${encodeURIComponent(testSong)}`;
      } else if (source.name === 'injahow-meting') {
        url = `${source.searchUrl}?type=search&id=${encodeURIComponent(testSong)}`;
      } else if (source.name === 'bugpk') {
        url = `${source.searchUrl}?media=netease&type=search&id=${encodeURIComponent(testSong)}`;
      } else {
        url = `${source.searchUrl}?vendor=netease&method=searchSong&params=[{"keyword":"${testSong}"}]`;
      }

      const data = await this._fetch(url);
      const latency = Date.now() - startTime;

      // 评估搜索结果
      const score = this._evaluateSearchResult(source, data, latency);

      return {
        source: source.name,
        success: true,
        latency,
        score,
        resultCount: this._countResults(data),
        hasFullUrl: this._checkFullUrl(data)
      };
    } catch (e) {
      return {
        source: source.name,
        success: false,
        latency: Date.now() - startTime,
        score: 0,
        error: e.message
      };
    }
  }

  /**
   * 批量测试所有音源并排序
   */
  async testAndRankSources(testSong = '周杰伦') {
    const sources = await this.searchSourcesWithLLM();
    console.log(`[SmartSource] Testing ${sources.length} sources...`);

    const results = await Promise.all(
      sources.map(source => this.testSource(source, testSong))
    );

    // 按分数排序
    results.sort((a, b) => b.score - a.score);

    this.testResults = results;
    return results;
  }

  /**
   * 评估搜索结果质量
   */
  _evaluateSearchResult(source, data, latency) {
    let score = 100;

    // 结果数量 (30分)
    const count = this._countResults(data);
    if (count > 20) score += 30;
    else if (count > 10) score += 20;
    else if (count > 5) score += 10;
    else score += count * 2;

    // 延迟 (20分)
    if (latency < 500) score += 20;
    else if (latency < 1000) score += 15;
    else if (latency < 2000) score += 10;
    else score += Math.max(0, 20 - latency / 200);

    // 完整URL (30分) - 最重要
    if (this._checkFullUrl(data)) score += 30;
    else score -= 50; // 没有完整URL的扣分

    // 稳定性 (10分)
    if (source.name === 'nuoxian') score += 10; // 已验证稳定
    if (source.name === 'injahow-meting') score -= 30; // 已知只有试听

    return Math.max(0, score);
  }

  /**
   * 统计搜索结果数量
   */
  _countResults(data) {
    if (Array.isArray(data)) return data.length;
    if (data.results && Array.isArray(data.results)) return data.results.length;
    if (data.data) {
      if (Array.isArray(data.data)) return data.data.length;
      if (data.data.songs) return data.data.songs.length;
    }
    return 0;
  }

  /**
   * 检查是否有完整播放URL
   */
  _checkFullUrl(data) {
    const results = Array.isArray(data) ? data : 
                   (data.results || data.data || []);
    
    if (results.length === 0) return false;
    
    const first = results[0];
    // 检查是否有playUrl、url字段
    if (first.playUrl || first.url) {
      // 进一步检查URL是否看起来像完整歌曲链接
      const url = first.playUrl || first.url;
      // 如果URL包含auth参数，通常是完整链接
      if (url.includes('auth=')) return true;
      // 如果URL直接指向mp3文件
      if (url.includes('.mp3') || url.includes('.m4a')) return true;
    }
    return false;
  }

  /**
   * HTTP请求封装
   */
  _fetch(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error('Too many redirects'));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      
      const options = {
        headers: {
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      };

      lib.get(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const location = res.headers.location;
          const newUrl = location.startsWith('http') ? location : 
                        new URL(location, parsedUrl.origin).href;
          resolve(this._fetch(newUrl, maxRedirects - 1));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 获取最佳音源
   */
  getBestSource() {
    if (this.testResults.length === 0) return null;
    return this.testResults[0];
  }
}
