/**
 * OpenClaw 配置解析器
 * 支持多种配置路径、模型提供商、API Key 来源
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export class OpenClawConfig {
  constructor() {
    this.config = null;
    this.configPath = null;
    this.apiKeysEnv = {};
  }

  /**
   * 初始化配置
   */
  async init() {
    await this._loadConfig();
    await this._loadApiKeysEnv();
    return this;
  }

  /**
   * 加载 OpenClaw 配置文件
   */
  async _loadConfig() {
    const configPaths = [
      process.env.OPENCLAW_CONFIG,
      process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, 'config', 'openclaw.json') : null,
      path.join(os.homedir(), '.openclaw', 'openclaw.json'),
      path.join(os.homedir(), '.openclaw', 'config', 'openclaw.json'),
      '/home/node/.openclaw/openclaw.json',
      '/root/.openclaw/openclaw.json',
      '/etc/openclaw/openclaw.json',
    ].filter(Boolean);

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          this.config = JSON.parse(content);
          this.configPath = configPath;
          console.log(`[OpenClawConfig] Loaded from: ${configPath}`);
          return;
        }
      } catch (e) {
        // 继续尝试下一个路径
      }
    }

    // 配置文件不存在，使用默认值
    console.log('[OpenClawConfig] No config file found, using defaults');
    this.config = {};
  }

  /**
   * 加载 api-keys.env 文件
   */
  async _loadApiKeysEnv() {
    const envPaths = [
      process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, 'config', 'api-keys.env') : null,
      path.join(os.homedir(), '.openclaw', 'api-keys.env'),
      path.join(os.homedir(), '.openclaw', 'config', 'api-keys.env'),
      '/home/node/.openclaw/api-keys.env',
      '/root/.openclaw/api-keys.env',
      '/etc/openclaw/api-keys.env',
    ].filter(Boolean);

    for (const envPath of envPaths) {
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf-8');
          // 解析 env 文件格式: KEY=value
          const lines = content.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const [key, ...valueParts] = trimmed.split('=');
              if (key && valueParts.length > 0) {
                this.apiKeysEnv[key.trim()] = valueParts.join('=').trim();
              }
            }
          }
          console.log(`[OpenClawConfig] Loaded api-keys.env from: ${envPath}`);
          return;
        }
      } catch (e) {
        // 继续尝试
      }
    }
  }

  /**
   * 获取默认模型配置
   * @returns {Object} { provider, model, baseUrl, apiKey }
   */
  getDefaultModelConfig() {
    // 1. 从 agents.defaults.model.primary 获取默认模型（支持对象或字符串格式）
    const defaultModelRef = this.config?.agents?.defaults?.model?.primary ||
                          this.config?.agents?.defaults?.model ||
                          this.config?.defaultModel;
    if (!defaultModelRef) {
      return null;
    }

    // 解析模型引用格式: "provider/model" 或 "provider/owner/model"
    const modelStr = typeof defaultModelRef === 'string' ? defaultModelRef : null;
    if (!modelStr) {
      return null;
    }

    const parts = modelStr.split('/');
    if (parts.length < 2) {
      return null;
    }

    const providerName = parts[0];
    const modelName = parts.slice(1).join('/');

    // 2. 从 models.providers 获取提供商配置
    const providers = this.config?.models?.providers || {};
    const providerConfig = providers[providerName];

    if (!providerConfig) {
      // 没有在 openclaw.json 中配置，尝试从环境变量获取
      return this._getModelConfigFromEnv(providerName, modelName);
    }

    // 3. 获取 API Key
    let apiKey = providerConfig.apiKey;
    let baseUrl = providerConfig.baseUrl;

    // 如果 apiKey 是引用格式 $SOME_KEY，从环境变量获取
    if (apiKey && apiKey.startsWith('$')) {
      const keyName = apiKey.slice(1);
      apiKey = this.apiKeysEnv[keyName] || process.env[keyName];
    }

    return {
      provider: providerName,
      model: modelName,
      baseUrl: baseUrl || this._getDefaultBaseUrl(providerName),
      apiKey: apiKey,
    };
  }

  /**
   * 从环境变量获取模型配置
   */
  _getModelConfigFromEnv(providerName, modelName) {
    // 常见的 API Key 环境变量名映射
    const keyMappings = {
      'openai': 'OPENAI_API_KEY',
      'anthropic': 'ANTHROPIC_API_KEY',
      'nvidia-openai-qwen3-5': 'NVIDIA_API_KEY',
      'nvidia': 'NVIDIA_API_KEY',
      'google': 'GOOGLE_API_KEY',
      'gemini': 'GEMINI_API_KEY',
      'deepseek': 'DEEPSEEK_API_KEY',
      'moonshot': 'MOONSHOT_API_KEY',
      'zhipu': 'ZHIPU_API_KEY',
    };

    const keyName = keyMappings[providerName] || `${providerName.toUpperCase()}_API_KEY`;
    const apiKey = this.apiKeysEnv[keyName] || process.env[keyName];

    if (!apiKey) {
      return null;
    }

    return {
      provider: providerName,
      model: modelName,
      baseUrl: this._getDefaultBaseUrl(providerName),
      apiKey: apiKey,
    };
  }

  /**
   * 获取默认 Base URL
   */
  _getDefaultBaseUrl(providerName) {
    const baseUrls = {
      'openai': 'https://api.openai.com/v1',
      'anthropic': 'https://api.anthropic.com/v1',
      'nvidia-openai-qwen3-5': 'https://integrate.api.nvidia.com/v1',
      'nvidia': 'https://integrate.api.nvidia.com/v1',
      'google': 'https://generativelanguage.googleapis.com/v1',
      'gemini': 'https://generativelanguage.googleapis.com/v1',
      'deepseek': 'https://api.deepseek.com/v1',
      'moonshot': 'https://api.moonshot.cn/v1',
      'zhipu': 'https://open.bigmodel.cn/api/paas/v4',
    };

    return baseUrls[providerName] || null;
  }

  /**
   * 获取完整的 LLM 配置（用于调用）
   */
  getLLMConfig() {
    const modelConfig = this.getDefaultModelConfig();
    
    if (!modelConfig) {
      // 尝试直接从环境变量获取
      const fallbackKeys = ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
      for (const key of fallbackKeys) {
        const apiKey = this.apiKeysEnv[key] || process.env[key];
        if (apiKey) {
          return {
            provider: 'unknown',
            model: 'default',
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: apiKey,
          };
        }
      }
      return null;
    }

    return modelConfig;
  }
}
