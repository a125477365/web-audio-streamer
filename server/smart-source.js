/**
 * 智能音源搜索模块
 * 
 * 自动读取 OpenClaw 配置，使用默认模型进行智能搜索
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

// OpenClaw 配置路径（跨平台）
function getOpenClawConfigPaths() {
  const home = os.homedir();
  return {
    linux: [
      path.join(home, '.openclaw', 'openclaw.json'),
      path.join(home, '.openclaw', 'agents', 'main', 'agent', 'models.json'),
      '/app/openclaw.json',
      '/app/agents/main/agent/models.json',
    ],
    darwin: [
      path.join(home, '.openclaw', 'openclaw.json'),
      path.join(home, '.openclaw', 'agents', 'main', 'agent', 'models.json'),
    ],
    win32: [
      path.join(home, '.openclaw', 'openclaw.json'),
      path.join(home, '.openclaw', 'agents', 'main', 'agent', 'models.json'),
    ]
  };
}

// 已知的音源API列表（用于测试）
const KNOWN_SOURCES = [
  {
    name: 'nuoxian',
    searchUrl: 'https://api.nxvav.cn/api/music/',
    format: 'json',
    needsAuth: true,
    platforms: ['netease', 'tencent', 'kugou', 'baidu', 'kuwo'],
    priority: 10
  },
  {
    name: 'injahow-meting',
    searchUrl: 'https://api.injahow.cn/meting/',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'tencent', 'kugou'],
    priority: 5,
    knownIssue: '只有45秒试听'
  },
  {
    name: 'bugpk',
    searchUrl: 'https://api.bugpk.com/api/music',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'tencent'],
    priority: 7
  },
  {
    name: 'sunzongzheng',
    searchUrl: 'https://suen-music-api.leanapp.cn/',
    format: 'json',
    needsAuth: false,
    platforms: ['netease', 'qq'],
    priority: 6
  }
];

export class SmartSourceFinder {
  constructor(config) {
    this.config = config;
    this.openClawConfig = null;
    this.defaultModel = null;
    this.llmProvider = null;
    this.testResults = [];
  }

  /**
   * 自动检测并加载 OpenClaw 配置
   */
  async detectOpenClawConfig() {
    const platform = os.platform();
    const paths = getOpenClawConfigPaths()[platform] || getOpenClawConfigPaths().linux;
    
    let openclawJson = null;
    let modelsJson = null;

    // 优先查找 openclaw.json
    for (const p of paths) {
      if (p.includes('openclaw.json') && fs.existsSync(p)) {
        try {
          openclawJson = JSON.parse(fs.readFileSync(p, 'utf-8'));
          console.log(`[SmartSource] Found openclaw.json: ${p}`);
          break;
        } catch (e) {
          console.log(`[SmartSource] Failed to parse ${p}:`, e.message);
        }
      }
    }

    // 如果没找到，尝试 models.json
    if (!openclawJson) {
      for (const p of paths) {
        if (p.includes('models.json') && fs.existsSync(p)) {
          try {
            modelsJson = JSON.parse(fs.readFileSync(p, 'utf-8'));
            console.log(`[SmartSource] Found models.json: ${p}`);
            break;
          } catch (e) {}
        }
      }
    }

    if (!openclawJson && !modelsJson) {
      console.log('[SmartSource] No OpenClaw config found, using fallback');
      return this._getFallbackConfig();
    }

    this.openClawConfig = openclawJson;
    return this._parseOpenClawConfig(openclawJson, modelsJson);
  }

  /**
   * 解析 OpenClaw 配置，提取默认模型信息
   */
  _parseOpenClawConfig(openclawJson, modelsJson) {
    let providers = {};
    let defaultModel = null;

    if (openclawJson) {
      // 从 openclaw.json 提取
      providers = openclawJson.models?.providers || {};
      
      // 获取默认模型
      const defaultPrimary = openclawJson.agents?.defaults?.model?.primary;
      if (defaultPrimary) {
        // 格式: "provider/model-id"
        const [providerKey, modelId] = defaultPrimary.split('/');
        defaultModel = {
          provider: providerKey,
          modelId: modelId,
          fullId: defaultPrimary
        };
      }

      // 获取对应的 provider 配置
      if (defaultModel && providers[defaultModel.provider]) {
        const provider = providers[defaultModel.provider];
        this.llmProvider = {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiType: provider.api || 'openai-completions',
          modelId: defaultModel.modelId
        };
      }
    }

    if (modelsJson) {
      // 从 models.json 提取（备用）
      providers = modelsJson.providers || {};
    }

    this.defaultModel = defaultModel;
    this.openClawConfig = { providers };

    console.log(`[SmartSource] Default model: ${defaultModel?.fullId || 'not set'}`);
    console.log(`[SmartSource] LLM Provider: ${this.llmProvider?.baseUrl || 'not configured'}`);

    return {
      hasConfig: true,
      defaultModel: defaultModel?.fullId,
      llmProvider: this.llmProvider ? {
        baseUrl: this.llmProvider.baseUrl,
        modelId: this.llmProvider.modelId,
        hasApiKey: !!this.llmProvider.apiKey
      } : null
    };
  }

  /**
   * 回退配置（当找不到 OpenClaw 配置时）
   */
  _getFallbackConfig() {
    return {
      hasConfig: false,
      defaultModel: null,
      llmProvider: null
    };
  }

  /**
   * 使用默认 LLM 搜索音源
   */
  async searchSourcesWithLLM() {
    if (!this.llmProvider) {
      console.log('[SmartSource] No LLM provider configured, using known sources');
      return KNOWN_SOURCES;
    }

    const prompt = `你是一个音乐API专家。请搜索并列出2024-2025年可用的免费音乐API。

要求：
1. 必须能获取完整歌曲播放链接（不能只是试听片段）
2. 支持搜索功能
3. 返回JSON格式数据

请返回JSON数组格式，每项包含：
- name: API名称
- url: API地址
- platforms: 支持的平台数组（如["netease", "qq"]）
- needsAuth: 是否需要认证
- description: 简短描述

只返回JSON数组，不要其他内容。`;

    try {
      console.log(`[SmartSource] Calling LLM: ${this.llmProvider.modelId}`);
      const response = await this._callLLM(prompt);
      
      // 解析JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const llmSources = JSON.parse(jsonMatch[0]);
        console.log(`[SmartSource] LLM found ${llmSources.length} sources`);
        
        // 合并已知源和LLM找到的源（去重）
        const allSources = [...KNOWN_SOURCES];
        for (const src of llmSources) {
          if (!allSources.find(s => s.name === src.name || s.url === src.url)) {
            allSources.push({
              name: src.name,
              searchUrl: src.url,
              platforms: src.platforms || [],
              needsAuth: src.needsAuth || false,
              description: src.description
            });
          }
        }
        return allSources;
      }
    } catch (e) {
      console.log('[SmartSource] LLM search failed:', e.message);
    }

    return KNOWN_SOURCES;
  }

  /**
   * 调用 LLM API（OpenAI 兼容格式）
   */
  async _callLLM(prompt) {
    return new Promise((resolve, reject) => {
      const { baseUrl, apiKey, modelId } = this.llmProvider;
      
      let url;
      try {
        url = new URL(baseUrl);
        if (!url.pathname.endsWith('/chat/completions')) {
          url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
        }
      } catch (e) {
        url = new URL(baseUrl + '/chat/completions');
      }

      const lib = url.protocol === 'https:' ? https : http;
      
      const data = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 60000
      };

      console.log(`[SmartSource] POST ${url.href}`);

      const req = lib.request(url, options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`LLM API error: ${res.statusCode} - ${body}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            const content = json.choices?.[0]?.message?.content || '';
            resolve(content);
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
   * 使用 LLM 评估单个音源
   */
  async evaluateSourceWithLLM(source, testData) {
    if (!this.llmProvider) {
      return this._simpleEvaluation(source, testData);
    }

    const prompt = `请评估以下音乐API的质量，返回JSON格式的评分结果：

音源名称: ${source.name}
API地址: ${source.searchUrl}
支持平台: ${source.platforms?.join(', ') || '未知'}
测试结果:
- 搜索延迟: ${testData.latency}ms
- 返回结果数: ${testData.resultCount}
- 是否有完整播放URL: ${testData.hasFullUrl ? '是' : '否'}
- 已知问题: ${source.knownIssue || '无'}

请从以下维度评分（每项0-100分）：
1. 完整性：是否能获取完整歌曲（而不是试听片段）
2. 响应速度：API响应是否快速
3. 稳定性：是否稳定可用
4. 结果质量：搜索结果是否准确丰富

返回JSON格式：
{
  "完整性": <分数>,
  "响应速度": <分数>,
  "稳定性": <分数>,
  "结果质量": <分数>,
  "总分": <综合分数>,
  "推荐指数": <1-5星>,
  "备注": "<简短评价>"
}

只返回JSON，不要其他内容。`;

    try {
      const response = await this._callLLM(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const eval_ = JSON.parse(jsonMatch[0]);
        return {
          source: source.name,
          success: true,
          ...testData,
          aiScore: eval_.总分,
          aiEvaluation: eval_,
          score: eval_.总分 + (source.priority || 0) * 10
        };
      }
    } catch (e) {
      console.log(`[SmartSource] LLM evaluation failed for ${source.name}:`, e.message);
    }

    return this._simpleEvaluation(source, testData);
  }

  /**
   * 简单评分（无LLM时使用）
   */
  _simpleEvaluation(source, testData) {
    let score = 50;

    // 完整URL 加分
    if (testData.hasFullUrl) score += 40;
    else score -= 30;

    // 延迟
    if (testData.latency < 500) score += 20;
    else if (testData.latency < 1000) score += 10;
    else if (testData.latency > 3000) score -= 10;

    // 结果数量
    if (testData.resultCount > 20) score += 15;
    else if (testData.resultCount > 10) score += 10;
    else if (testData.resultCount === 0) score -= 20;

    // 优先级加成
    score += (source.priority || 5) * 5;

    // 已知问题扣分
    if (source.knownIssue) score -= 30;

    return {
      source: source.name,
      success: testData.success !== false,
      ...testData,
      score: Math.max(0, Math.min(100, score))
    };
  }

  /**
   * 测试单个音源
   */
  async testSource(source, testSong = '周杰伦') {
    const startTime = Date.now();
    
    try {
      let url;
      const encodedSong = encodeURIComponent(testSong);
      
      switch (source.name) {
        case 'nuoxian':
          url = `${source.searchUrl}?server=netease&type=search&id=${encodedSong}`;
          break;
        case 'injahow-meting':
          url = `${source.searchUrl}?type=search&id=${encodedSong}`;
          break;
        case 'bugpk':
          url = `${source.searchUrl}?media=netease&type=search&id=${encodedSong}`;
          break;
        case 'sunzongzheng':
          url = `${source.searchUrl}?vendor=netease&method=searchSong&params=[{"keyword":"${testSong}"}]`;
          break;
        default:
          url = source.searchUrl.includes('?') 
            ? `${source.searchUrl}&keyword=${encodedSong}`
            : `${source.searchUrl}?keyword=${encodedSong}`;
      }

      const data = await this._fetch(url);
      const latency = Date.now() - startTime;

      const resultCount = this._countResults(data);
      const hasFullUrl = this._checkFullUrl(data);

      return {
        success: true,
        latency,
        resultCount,
        hasFullUrl,
        rawData: data
      };
    } catch (e) {
      return {
        success: false,
        latency: Date.now() - startTime,
        resultCount: 0,
        hasFullUrl: false,
        error: e.message
      };
    }
  }

  /**
   * 批量测试所有音源并使用AI评分排序
   */
  async testAndRankSources(testSong = '周杰伦') {
    // 先检测配置
    if (!this.openClawConfig) {
      await this.detectOpenClawConfig();
    }

    // 获取要测试的源列表
    const sources = await this.searchSourcesWithLLM();
    console.log(`[SmartSource] Testing ${sources.length} sources with "${testSong}"...`);

    // 测试每个源
    const testPromises = sources.map(async (source) => {
      const testData = await this.testSource(source, testSong);
      return this.evaluateSourceWithLLM(source, testData);
    });

    const results = await Promise.all(testPromises);

    // 按分数排序
    results.sort((a, b) => b.score - a.score);

    this.testResults = results;
    return results;
  }

  /**
   * 获取最佳音源
   */
  getBestSource() {
    if (this.testResults.length === 0) return null;
    return this.testResults[0];
  }

  // 辅助方法
  _countResults(data) {
    if (Array.isArray(data)) return data.length;
    if (data.results && Array.isArray(data.results)) return data.results.length;
    if (data.data) {
      if (Array.isArray(data.data)) return data.data.length;
      if (data.data.songs) return data.data.songs.length;
    }
    return 0;
  }

  _checkFullUrl(data) {
    const results = Array.isArray(data) ? data : (data.results || data.data || []);
    if (results.length === 0) return false;
    const first = results[0];
    if (first.playUrl || first.url) {
      const url = first.playUrl || first.url;
      if (url.includes('auth=') || url.includes('.mp3') || url.includes('.m4a')) return true;
    }
    return false;
  }

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
        timeout: 15000
      };

      lib.get(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const location = res.headers.location;
          const newUrl = location.startsWith('http') ? location : new URL(location, parsedUrl.origin).href;
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
}
