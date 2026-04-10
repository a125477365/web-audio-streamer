/**
 * 智能音源搜索模块
 * 
 * 动态查找并解析 OpenClaw 配置文件，使用默认模型进行智能搜索
 * 不硬编码任何路径或模型信息
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
    // 不保存任何配置，每次都重新解析
  }

  /**
   * 动态查找 OpenClaw 安装目录
   * 遵循 XDG Base Directory Specification
   */
  _findOpenClawInstallDir() {
    const candidates = [];
    
    // 1. 检查环境变量
    if (process.env.OPENCLAW_HOME) {
      candidates.push(process.env.OPENCLAW_HOME);
    }
    
    // 2. 检查标准位置
    const home = os.homedir();
    candidates.push(path.join(home, '.openclaw'));
    
    // 3. 检查系统级安装位置
    if (process.platform === 'linux') {
      candidates.push('/opt/openclaw');
      candidates.push('/usr/local/openclaw');
      candidates.push('/app');  // Docker/容器环境
    }
    
    // 4. 检查工作目录附近的可能位置
    const cwd = process.cwd();
    candidates.push(path.join(cwd, '.openclaw'));
    candidates.push(path.dirname(cwd));
    
    // 返回第一个存在的目录
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          return dir;
        }
      } catch (e) {
        // 忽略权限错误等
      }
    }
    
    return null;
  }

  /**
   * 在指定目录中查找配置文件
   */
  _findConfigFile(dir, filename) {
    const candidates = [
      path.join(dir, filename),
      path.join(dir, 'config', filename),
      path.join(dir, 'agents', 'main', 'agent', filename),
    ];
    
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return p;
        }
      } catch (e) {}
    }
    
    return null;
  }

  /**
   * 解析配置文件，提取模型配置
   * 每次调用都重新解析，不缓存
   */
  _parseModelConfig(configData) {
    const result = {
      defaultModel: null,
      llmProvider: null
    };
    
    if (!configData || typeof configData !== 'object') {
      return result;
    }
    
    // 查找默认模型
    // 格式: "provider/model-id" 或嵌套结构
    const defaultPrimary = configData?.agents?.defaults?.model?.primary ||
                          configData?.defaultModel ||
                          configData?.model;
    
    if (defaultPrimary) {
      const parts = defaultPrimary.split('/');
      if (parts.length >= 2) {
        result.defaultModel = {
          provider: parts[0],
          modelId: parts.slice(1).join('/'),
          fullId: defaultPrimary
        };
      }
    }
    
    // 查找 provider 配置
    const providers = configData?.models?.providers || 
                     configData?.providers || 
                     {};
    
    if (result.defaultModel && providers[result.defaultModel.provider]) {
      const provider = providers[result.defaultModel.provider];
      result.llmProvider = {
        baseUrl: provider.baseUrl || provider.base_url,
        apiKey: provider.apiKey || provider.api_key,
        apiType: provider.api || provider.apiType || 'openai-completions',
        modelId: result.defaultModel.modelId
      };
    }
    
    return result;
  }

  /**
   * 每次调用都重新查找并解析配置
   */
  async detectOpenClawConfig() {
    // 查找安装目录
    const installDir = this._findOpenClawInstallDir();
    if (!installDir) {
      console.log('[SmartSource] OpenClaw installation not found');
      return { hasConfig: false };
    }
    
    console.log(`[SmartSource] Found OpenClaw at: ${installDir}`);
    
    // 查找主配置文件
    const configFile = this._findConfigFile(installDir, 'openclaw.json') ||
                       this._findConfigFile(installDir, 'models.json') ||
                       this._findConfigFile(installDir, 'config.json');
    
    if (!configFile) {
      console.log('[SmartSource] No config file found');
      return { hasConfig: false, installDir };
    }
    
    console.log(`[SmartSource] Reading config: ${configFile}`);
    
    // 读取并解析配置（每次都重新读取）
    let configData;
    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      configData = JSON.parse(content);
    } catch (e) {
      console.log(`[SmartSource] Failed to parse config: ${e.message}`);
      return { hasConfig: false, configFile, error: e.message };
    }
    
    // 解析模型配置
    const { defaultModel, llmProvider } = this._parseModelConfig(configData);
    
    if (defaultModel) {
      console.log(`[SmartSource] Default model: ${defaultModel.fullId}`);
    }
    if (llmProvider) {
      console.log(`[SmartSource] LLM endpoint: ${llmProvider.baseUrl}`);
    }
    
    return {
      hasConfig: true,
      installDir,
      configFile,
      defaultModel: defaultModel?.fullId || null,
      llmProvider: llmProvider ? {
        baseUrl: llmProvider.baseUrl,
        modelId: llmProvider.modelId,
        hasApiKey: !!llmProvider.apiKey
      } : null
    };
  }

  /**
   * 使用 LLM 搜索更多音源
   * 每次调用都重新解析配置
   */
  async searchSourcesWithLLM() {
    // 重新获取配置
    const config = await this.detectOpenClawConfig();
    
    if (!config.llmProvider || !config.llmProvider.hasApiKey) {
      console.log('[SmartSource] No LLM provider available, using known sources');
      return KNOWN_SOURCES;
    }
    
    // 重新读取配置文件获取 API key（不保存）
    const content = fs.readFileSync(config.configFile, 'utf-8');
    const configData = JSON.parse(content);
    const { llmProvider } = this._parseModelConfig(configData);
    
    if (!llmProvider?.apiKey) {
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

只返回JSON数组，不要其他内容。`;

    try {
      console.log(`[SmartSource] Calling LLM: ${llmProvider.modelId}`);
      const response = await this._callLLM(llmProvider, prompt);
      
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const llmSources = JSON.parse(jsonMatch[0]);
        console.log(`[SmartSource] LLM found ${llmSources.length} sources`);
        
        const allSources = [...KNOWN_SOURCES];
        for (const src of llmSources) {
          if (!allSources.find(s => s.name === src.name)) {
            allSources.push({
              name: src.name,
              searchUrl: src.url,
              platforms: src.platforms || [],
              needsAuth: src.needsAuth || false
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
   * 调用 LLM API
   */
  async _callLLM(provider, prompt) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(provider.baseUrl);
        if (!url.pathname.includes('/chat')) {
          url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
        }
      } catch (e) {
        url = new URL(provider.baseUrl + '/chat/completions');
      }

      const lib = url.protocol === 'https:' ? https : http;
      
      const data = JSON.stringify({
        model: provider.modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        timeout: 60000
      };

      const req = lib.request(url, options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`LLM API error: ${res.statusCode}`));
            return;
          }
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
        reject(new Error('Timeout'));
      });
      req.write(data);
      req.end();
    });
  }

  /**
   * 使用 LLM 评估音源质量
   */
  async _evaluateWithLLM(source, testData) {
    // 重新获取配置
    const config = await this.detectOpenClawConfig();
    
    if (!config.llmProvider || !config.llmProvider.hasApiKey) {
      return this._simpleEvaluation(source, testData);
    }
    
    // 重新读取获取 API key
    const content = fs.readFileSync(config.configFile, 'utf-8');
    const configData = JSON.parse(content);
    const { llmProvider } = this._parseModelConfig(configData);
    
    if (!llmProvider?.apiKey) {
      return this._simpleEvaluation(source, testData);
    }

    const prompt = `评估音乐API质量，返回JSON：
音源: ${source.name}
延迟: ${testData.latency}ms
结果数: ${testData.resultCount}
完整URL: ${testData.hasFullUrl ? '是' : '否'}
已知问题: ${source.knownIssue || '无'}

评分维度（0-100）：
- 完整性（是否能获取完整歌曲）
- 响应速度
- 稳定性
- 结果质量

返回格式：
{"完整性":X,"响应速度":X,"稳定性":X,"结果质量":X,"总分":X,"备注":"..."}`;

    try {
      const response = await this._callLLM(llmProvider, prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const eval_ = JSON.parse(jsonMatch[0]);
        return {
          source: source.name,
          success: true,
          ...testData,
          aiScore: eval_.总分,
          score: eval_.总分 + (source.priority || 5) * 10
        };
      }
    } catch (e) {
      console.log(`[SmartSource] LLM eval failed: ${e.message}`);
    }

    return this._simpleEvaluation(source, testData);
  }

  /**
   * 简单评分（无LLM）
   */
  _simpleEvaluation(source, testData) {
    let score = 50;
    if (testData.hasFullUrl) score += 40;
    else score -= 30;
    if (testData.latency < 500) score += 20;
    else if (testData.latency < 1000) score += 10;
    else if (testData.latency > 3000) score -= 10;
    if (testData.resultCount > 20) score += 15;
    else if (testData.resultCount === 0) score -= 20;
    score += (source.priority || 5) * 5;
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
      const encodedSong = encodeURIComponent(testSong);
      let url;
      
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
        default:
          url = `${source.searchUrl}?q=${encodedSong}`;
      }

      const data = await this._fetch(url);
      const latency = Date.now() - startTime;
      const resultCount = this._countResults(data);
      const hasFullUrl = this._checkFullUrl(data);

      return { success: true, latency, resultCount, hasFullUrl, rawData: data };
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
   * 批量测试并排序
   */
  async testAndRankSources(testSong = '周杰伦') {
    const sources = await this.searchSourcesWithLLM();
    console.log(`[SmartSource] Testing ${sources.length} sources...`);

    const results = await Promise.all(
      sources.map(async (source) => {
        const testData = await this.testSource(source, testSong);
        return this._evaluateWithLLM(source, testData);
      })
    );

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * 获取最佳音源（每次重新计算）
   */
  async getBestSource() {
    const results = await this.testAndRankSources();
    return results[0] || null;
  }

  // 辅助方法
  _countResults(data) {
    if (Array.isArray(data)) return data.length;
    if (data?.results) return data.results.length;
    if (data?.data) {
      if (Array.isArray(data.data)) return data.data.length;
      if (data.data.songs) return data.data.songs.length;
    }
    return 0;
  }

  _checkFullUrl(data) {
    const results = Array.isArray(data) ? data : (data?.results || data?.data || []);
    if (results.length === 0) return false;
    const url = results[0]?.playUrl || results[0]?.url;
    if (!url) return false;
    return url.includes('auth=') || url.includes('.mp3') || url.includes('.m4a');
  }

  _fetch(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
      
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      
      lib.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const newUrl = res.headers.location.startsWith('http') 
            ? res.headers.location 
            : new URL(res.headers.location, parsedUrl.origin).href;
          return resolve(this._fetch(newUrl, maxRedirects - 1));
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(data); }
        });
      }).on('error', reject);
    });
  }
}
