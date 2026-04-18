/**
 * Hermes API 音源获取模块
 * 
 * 支持两种调用方式：
 * 1. Hermes API Server (优先) - HTTP API 方式
 * 2. OpenClaw CLI (备选) - 命令行方式
 * 
 * 通过 Hermes API Server (OpenAI 兼容接口) 自动获取可靠的音乐源
 * 要求：获取5个可靠优质的非试听洛雪音乐源
 */

import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Hermes API Server 配置
const HERMES_API_URL = process.env.HERMES_API_URL || 'http://127.0.0.1:8642';
const HERMES_API_KEY = process.env.HERMES_API_KEY || 'hermes-open-webui-2024';
const HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent';

// OpenClaw CLI 配置
const OPENCLAW_TIMEOUT = parseInt(process.env.OPENCLAW_TIMEOUT || '300000', 10); // 5分钟

export class HermesSourceApi {
    constructor(config = {}) {
        this.apiUrl = config.hermesApiUrl || HERMES_API_URL;
        this.apiKey = config.hermesApiKey || HERMES_API_KEY;
        this.model = config.hermesModel || HERMES_MODEL;
        this.timeout = config.timeout || 120000; // 2分钟超时 (Hermes API)
        this.openclawTimeout = config.openclawTimeout || OPENCLAW_TIMEOUT;
        
        // 缓存 OpenClaw 是否可用
        this._openclawAvailable = null;
    }

    /**
     * 获取音乐源（自动选择最佳方式）
     * @param {string} testSong - 测试歌曲名
     * @returns {Promise<Array>} - 返回音源列表
     */
    async fetchMusicSources(testSong = '周杰伦') {
        console.log('[SourceAPI] 开始获取音乐源...');
        
        // 策略1: 优先尝试 Hermes API Server
        const hermesAvailable = await this._checkHermesApi();
        
        if (hermesAvailable) {
            console.log('[SourceAPI] 使用 Hermes API Server 获取音源...');
            try {
                const sources = await this._fetchViaHermesApi(testSong);
                if (sources && sources.length > 0) {
                    console.log(`[SourceAPI] Hermes API 成功获取 ${sources.length} 个音源`);
                    return sources;
                }
            } catch (error) {
                console.log('[SourceAPI] Hermes API 获取失败:', error.message);
            }
        }
        
        // 策略2: 备选方案 - OpenClaw CLI
        const openclawAvailable = await this._checkOpenClawCli();
        
        if (openclawAvailable) {
            console.log('[SourceAPI] 使用 OpenClaw CLI 获取音源...');
            try {
                const sources = await this._fetchViaOpenClaw(testSong);
                if (sources && sources.length > 0) {
                    console.log(`[SourceAPI] OpenClaw CLI 成功获取 ${sources.length} 个音源`);
                    return sources;
                }
            } catch (error) {
                console.log('[SourceAPI] OpenClaw CLI 获取失败:', error.message);
            }
        }
        
        // 两种方式都失败
        const hermesStatus = hermesAvailable ? '可用但返回空' : '不可用';
        const openclawStatus = openclawAvailable ? '可用但返回空' : '未安装';
        
        throw new Error(
            `无法获取音源。Hermes API: ${hermesStatus}, OpenClaw CLI: ${openclawStatus}。` +
            `请确保 Hermes Agent 正在运行 (端口 8642) 或安装 OpenClaw CLI。`
        );
    }

    /**
     * 检查 Hermes API 是否可用
     */
    async _checkHermesApi() {
        try {
            const url = new URL(`${this.apiUrl}/health`);
            return new Promise((resolve) => {
                const lib = url.protocol === 'https:' ? https : http;
                const req = lib.get(url, { timeout: 5000 }, (res) => {
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
            });
        } catch {
            return false;
        }
    }

    /**
     * 检查 OpenClaw CLI 是否可用
     */
    async _checkOpenClawCli() {
        if (this._openclawAvailable !== null) {
            return this._openclawAvailable;
        }
        
        return new Promise((resolve) => {
            const proc = spawn('openclaw', ['--version'], { 
                timeout: 5000,
                shell: true 
            });
            
            let stdout = '';
            proc.stdout.on('data', (d) => { stdout += d; });
            proc.on('close', (code) => {
                this._openclawAvailable = code === 0;
                resolve(this._openclawAvailable);
            });
            proc.on('error', () => {
                this._openclawAvailable = false;
                resolve(false);
            });
        });
    }

    /**
     * 通过 Hermes API Server 获取音源
     */
    async _fetchViaHermesApi(testSong) {
        console.log('[HermesAPI] 开始通过 Hermes API 获取音乐源...');
        
        const prompt = this._buildPrompt(testSong);
        
        const response = await this._callHermesApi(prompt);
        const sources = this._parseResponse(response);
        
        if (sources && sources.length > 0) {
            return sources;
        }
        
        throw new Error('Hermes API 未返回有效音源');
    }

    /**
     * 通过 OpenClaw CLI 获取音源
     */
    async _fetchViaOpenClaw(testSong) {
        console.log('[OpenClawCLI] 开始通过 OpenClaw CLI 获取音乐源...');
        
        const prompt = this._buildPrompt(testSong);
        const sessionId = 'music-source-fetch-' + Date.now();
        
        return new Promise((resolve, reject) => {
            const proc = spawn(
                'openclaw',
                ['agent', '--local', '--session-id', sessionId, '--timeout', '300', '-m', prompt],
                { 
                    cwd: process.cwd(), 
                    env: process.env,
                    shell: true
                }
            );
            
            let stdout = '';
            let stderr = '';
            
            proc.stdout.on('data', (d) => { stdout += d; });
            proc.stderr.on('data', (d) => { stderr += d; });
            
            proc.on('close', (code) => {
                console.log('[OpenClawCLI] Exit code:', code);
                if (stderr) console.log('[OpenClawCLI] Stderr:', stderr.slice(0, 500));
                
                if (code === 0) {
                    const sources = this._parseResponse(stdout);
                    if (sources && sources.length > 0) {
                        resolve(sources);
                    } else {
                        reject(new Error('OpenClaw CLI 未返回有效音源'));
                    }
                } else {
                    reject(new Error(`OpenClaw CLI 退出码: ${code}`));
                }
            });
            
            proc.on('error', (e) => {
                reject(new Error(`OpenClaw CLI 启动失败: ${e.message}`));
            });
            
            // 超时保护
            setTimeout(() => {
                try { proc.kill(); } catch {}
                reject(new Error('OpenClaw CLI 执行超时'));
            }, this.openclawTimeout);
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
     * 调用 Hermes API (OpenAI 兼容格式)
     */
    async _callHermesApi(prompt) {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.apiUrl}/v1/chat/completions`);
            const lib = url.protocol === 'https:' ? https : http;
            
            const data = JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: '你是一个专业的音乐API测试专家，擅长搜索和测试各种音乐API的可用性。' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 4000
            });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: this.timeout
            };

            const req = lib.request(url, options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Hermes API error: ${res.statusCode} - ${body}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(body);
                        const content = json.choices?.[0]?.message?.content || '';
                        resolve(content);
                    } catch (e) {
                        reject(new Error(`Failed to parse Hermes response: ${e.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Hermes API request timeout'));
            });
            req.write(data);
            req.end();
        });
    }

    /**
     * 解析响应（支持 Hermes API 和 OpenClaw CLI 的输出）
     */
    _parseResponse(response) {
        if (!response) return null;

        console.log('[SourceAPI] 解析响应...');
        
        // 过滤 ANSI 颜色代码（OpenClaw CLI 输出可能包含）
        let text = response.replace(/\x1b\[[0-9;]*m/g, '');
        
        // 方法1: 提取 JSON 代码块
        const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return this._validateAndCleanSources(parsed);
                }
            } catch (e) {
                console.log('[SourceAPI] JSON block parse failed:', e.message);
            }
        }

        // 方法2: 查找 JSON 数组
        const jsonMatches = text.match(/\[[\s\S]*?\]/g);
        if (jsonMatches) {
            // 从后往前找最大的有效 JSON 数组
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
                    description: '通过 API 搜索发现',
                    tested: true
                });
            }
        }
        
        if (urls.length > 0) {
            return this._validateAndCleanSources(urls);
        }

        console.log('[SourceAPI] 无法解析响应');
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

    /**
     * 检查可用性（兼容旧接口）
     */
    async checkAvailability() {
        return await this._checkHermesApi() || await this._checkOpenClawCli();
    }
}

export default HermesSourceApi;
