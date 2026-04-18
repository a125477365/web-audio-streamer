/**
 * Hermes CLI 音源获取模块
 * 
 * 使用 Hermes CLI 方式获取音源（无需 API Key）
 * 调用 Hermes Agent 的 venv Python 环境执行
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Hermes CLI 配置
const HERMES_VENV_PYTHON = process.env.HERMES_VENV_PYTHON || '/opt/hermes/.venv/bin/python3';
const HERMES_CLI_PATH = process.env.HERMES_CLI_PATH || '/opt/hermes/cli.py';
const DEFAULT_TIMEOUT = parseInt(process.env.HERMES_CLI_TIMEOUT || '120000', 10); // 2分钟

export class HermesSourceApi {
    constructor(config = {}) {
        this.venvPython = config.venvPython || HERMES_VENV_PYTHON;
        this.cliPath = config.cliPath || HERMES_CLI_PATH;
        this.timeout = config.timeout || DEFAULT_TIMEOUT;
        
        // 检测可用性缓存
        this._available = null;
    }

    /**
     * 获取音乐源（使用 Hermes CLI）
     * @param {string} testSong - 测试歌曲名
     * @returns {Promise<Array>} - 返回音源列表
     */
    async fetchMusicSources(testSong = '周杰伦') {
        console.log('[HermesCLI] 开始获取音乐源...');
        
        // 检查 CLI 是否可用
        const available = await this.checkAvailability();
        if (!available) {
            throw new Error(`Hermes CLI 不可用。请检查路径: ${this.venvPython} ${this.cliPath}`);
        }
        
        console.log('[HermesCLI] Hermes CLI 可用，开始查询...');
        
        const prompt = this._buildPrompt(testSong);
        
        try {
            const response = await this._callHermesCli(prompt);
            const sources = this._parseResponse(response);
            
            if (sources && sources.length > 0) {
                console.log(`[HermesCLI] 成功获取 ${sources.length} 个音源`);
                return sources;
            }
            
            throw new Error('Hermes CLI 未返回有效音源');
        } catch (error) {
            console.error('[HermesCLI] 获取失败:', error.message);
            throw error;
        }
    }

    /**
     * 检查 Hermes CLI 是否可用
     */
    async checkAvailability() {
        if (this._available !== null) {
            return this._available;
        }
        
        // 检查 Python 解释器是否存在
        if (!fs.existsSync(this.venvPython)) {
            console.log(`[HermesCLI] Python 不存在: ${this.venvPython}`);
            this._available = false;
            return false;
        }
        
        // 检查 CLI 脚本是否存在
        if (!fs.existsSync(this.cliPath)) {
            console.log(`[HermesCLI] CLI 脚本不存在: ${this.cliPath}`);
            this._available = false;
            return false;
        }
        
        // 尝试运行 --help 验证
        return new Promise((resolve) => {
            const proc = spawn(this.venvPython, [this.cliPath, '--help'], {
                timeout: 10000,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let completed = false;
            
            proc.on('close', (code) => {
                if (!completed) {
                    completed = true;
                    this._available = code === 0;
                    resolve(this._available);
                }
            });
            
            proc.on('error', () => {
                if (!completed) {
                    completed = true;
                    this._available = false;
                    resolve(false);
                }
            });
            
            // 超时保护
            setTimeout(() => {
                if (!completed) {
                    completed = true;
                    try { proc.kill(); } catch {}
                    this._available = false;
                    resolve(false);
                }
            }, 10000);
        });
    }

    /**
     * 构建 prompt
     */
    _buildPrompt(testSong) {
        return `你是一个音乐API专家。请搜索并测试2024-2025年可用的洛雪音乐API（LuoXue Music API）。

=== 任务要求 ===
1. 搜索可用的洛雪音乐API地址
2. 测试每个API是否能获取完整歌曲（非试听）
3. 只返回通过测试的API

=== 测试步骤 ===
对于找到的每个API，你需要：
1. 调用搜索接口（搜索 "${testSong}"）
2. 检查是否返回有效的歌曲列表
3. 获取前3个结果的播放链接
4. 使用 ffprobe 测试每个播放链接的时长：
   ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "播放链接"
5. 只保留能获取完整歌曲（时长 > 90秒，排除试听）的API

=== 排除条件 ===
- GitHub.com（代码仓库）
- 文档页面（包含 /doc、/docs、readme 等）
- workers.dev 等临时域名
- 只能获取45秒试听的API
- 返回空白或错误的API

=== 返回格式 ===
请严格按照以下JSON格式返回5个可靠优质的音源：

\`\`\`json
[
  {
    "name": "洛雪音乐API - xxx",
    "searchUrl": "https://实际API地址/",
    "description": "简短描述（如：支持网易云、QQ音乐等）",
    "platforms": ["netease", "tencent", "kugou"],
    "resultCount": 搜索结果数,
    "maxDuration": 最大时长秒数,
    "tested": true
  }
]
\`\`\`

重要：只返回通过测试的API，每个API必须能获取完整歌曲（时长>90秒）。返回5个最佳音源。`;
    }

    /**
     * 调用 Hermes CLI
     */
    _callHermesCli(prompt) {
        return new Promise((resolve, reject) => {
            console.log('[HermesCLI] 正在调用 Hermes Agent...');
            
            const proc = spawn(this.venvPython, [
                this.cliPath,
                '--query', prompt,
                '--toolsets', 'web,browser,terminal'  // 启用必要工具
            ], {
                timeout: this.timeout,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stdout = '';
            let stderr = '';
            
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            let completed = false;
            
            proc.on('close', (code) => {
                if (completed) return;
                completed = true;
                
                console.log('[HermesCLI] Exit code:', code);
                
                if (code === 0) {
                    resolve(stdout);
                } else {
                    const errorMsg = stderr.slice(0, 500) || `Exit code: ${code}`;
                    reject(new Error(`Hermes CLI 失败: ${errorMsg}`));
                }
            });
            
            proc.on('error', (err) => {
                if (completed) return;
                completed = true;
                reject(new Error(`Hermes CLI 启动失败: ${err.message}`));
            });
            
            // 超时保护
            setTimeout(() => {
                if (completed) return;
                completed = true;
                try { proc.kill(); } catch {}
                reject(new Error('Hermes CLI 执行超时'));
            }, this.timeout);
        });
    }

    /**
     * 解析响应
     */
    _parseResponse(response) {
        if (!response) return null;

        console.log('[HermesCLI] 解析响应...');
        
        // 过滤 ANSI 颜色代码和进度条
        let text = response
            .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI 颜色
            .replace(/\x1b\].*?\x07/g, '')    // OSC 序列
            .replace(/╭.*?╮/gs, '')            // 边框
            .replace(/│.*?│/g, '')             // 侧边栏
            .replace(/├.*?┤/g, '')             // 分隔线
            .replace(/╰.*?╯/gs, '')            // 底部边框
            .replace(/^[─━═]+$/gm, '')         // 水平线
            .replace(/\(and \d+ more toolsets?\.\.\.\)/g, '');
        
        // 方法1: 提取 JSON 代码块
        const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return this._validateAndCleanSources(parsed);
                }
            } catch (e) {
                console.log('[HermesCLI] JSON block parse failed:', e.message);
            }
        }
        
        // 方法2: 查找 JSON 数组（从后往前找）
        const jsonMatches = text.match(/\[[\s\S]*?\]/g);
        if (jsonMatches) {
            for (let i = jsonMatches.length - 1; i >= 0; i--) {
                try {
                    const parsed = JSON.parse(jsonMatches[i]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const hasValid = parsed.some(item => item?.searchUrl?.startsWith('http'));
                        if (hasValid) {
                            return this._validateAndCleanSources(parsed);
                        }
                    }
                } catch {}
            }
        }
        
        // 方法3: 提取 URL
        const urls = [];
        const urlPattern = /"(?:searchUrl|url)":\s*"(https?:\/\/[^"]+)"/g;
        let match;
        const seen = new Set();
        
        while ((match = urlPattern.exec(text)) !== null) {
            if (!seen.has(match[1]) && !match[1].includes('github.com')) {
                seen.add(match[1]);
                urls.push({
                    name: 'Discovered API',
                    searchUrl: match[1],
                    description: '通过 Hermes CLI 发现',
                    tested: true
                });
            }
        }
        
        if (urls.length > 0) {
            return this._validateAndCleanSources(urls);
        }
        
        console.log('[HermesCLI] 无法解析响应');
        return null;
    }

    /**
     * 验证和清理音源列表
     */
    _validateAndCleanSources(sources) {
        return sources
            .filter(s => {
                if (!s || !s.searchUrl || !s.searchUrl.startsWith('http')) return false;
                const url = s.searchUrl.toLowerCase();
                if (url.includes('github.com')) return false;
                if (url.includes('workers.dev')) return false;
                if (url.includes('/doc')) return false;
                return true;
            })
            .map(s => ({
                name: s.name || '未知音源',
                searchUrl: s.searchUrl,
                description: s.description || '',
                platforms: s.platforms || ['netease'],
                resultCount: s.resultCount || 0,
                maxDuration: s.maxDuration || 0,
                tested: s.tested !== false
            }))
            .slice(0, 5); // 最多返回5个
    }
}

export default HermesSourceApi;
