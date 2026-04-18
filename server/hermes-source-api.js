/**
 * Hermes API 音源获取模块
 * 
 * 通过 Hermes API Server (OpenAI 兼容接口) 自动获取可靠的音乐源
 * 要求：获取5个可靠优质的非试听洛雪音乐源
 */

import https from 'https';
import http from 'http';

// Hermes API Server 配置
const HERMES_API_URL = process.env.HERMES_API_URL || 'http://127.0.0.1:8642';
const HERMES_API_KEY = process.env.HERMES_API_KEY || 'hermes-open-webui-2024';
const HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent';

export class HermesSourceApi {
    constructor(config = {}) {
        this.apiUrl = config.hermesApiUrl || HERMES_API_URL;
        this.apiKey = config.hermesApiKey || HERMES_API_KEY;
        this.model = config.hermesModel || HERMES_MODEL;
        this.timeout = config.timeout || 120000; // 2分钟超时
    }

    /**
     * 调用 Hermes API 获取音乐源
     * @param {string} testSong - 测试歌曲名
     * @returns {Promise<Array>} - 返回音源列表
     */
    async fetchMusicSources(testSong = '周杰伦') {
        console.log('[HermesAPI] 开始通过 Hermes API 获取音乐源...');
        
        const prompt = this._buildPrompt(testSong);
        
        try {
            const response = await this._callHermes(prompt);
            const sources = this._parseResponse(response);
            
            if (sources && sources.length > 0) {
                console.log(`[HermesAPI] 成功获取 ${sources.length} 个音源`);
                return sources;
            } else {
                throw new Error('Hermes API 未返回有效音源');
            }
        } catch (error) {
            console.error('[HermesAPI] 获取音源失败:', error.message);
            throw error;
        }
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
    async _callHermes(prompt) {
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
     * 解析 Hermes API 响应
     */
    _parseResponse(response) {
        if (!response) return null;

        console.log('[HermesAPI] 解析响应...');
        
        // 方法1: 提取 JSON 代码块
        const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return this._validateAndCleanSources(parsed);
                }
            } catch (e) {
                console.log('[HermesAPI] JSON block parse failed:', e.message);
            }
        }

        // 方法2: 查找 JSON 数组
        const jsonArrayMatch = response.match(/\[[\s\S]*?\]/);
        if (jsonArrayMatch) {
            try {
                const parsed = JSON.parse(jsonArrayMatch[0]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return this._validateAndCleanSources(parsed);
                }
            } catch (e) {
                console.log('[HermesAPI] JSON array parse failed:', e.message);
            }
        }

        // 方法3: 提取 URL
        const urls = [];
        const urlPattern = /"(?:searchUrl|url)":\s*"(https?:\/\/[^"]+)"/g;
        let match;
        const seen = new Set();
        while ((match = urlPattern.exec(response)) !== null) {
            if (!seen.has(match[1]) && !match[1].includes('github.com')) {
                seen.add(match[1]);
                urls.push({
                    name: 'Hermes Discovery',
                    searchUrl: match[1],
                    description: '通过 Hermes API 发现',
                    tested: true
                });
            }
        }
        
        if (urls.length > 0) {
            return urls;
        }

        console.log('[HermesAPI] 无法解析响应');
        return null;
    }

    /**
     * 验证和清理音源列表
     */
    _validateAndCleanSources(sources) {
        return sources
            .filter(s => {
                // 必须有有效的 searchUrl
                if (!s || !s.searchUrl || !s.searchUrl.startsWith('http')) {
                    return false;
                }
                // 排除 GitHub
                if (s.searchUrl.includes('github.com')) {
                    return false;
                }
                // 排除临时域名
                if (s.searchUrl.includes('workers.dev')) {
                    return false;
                }
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
     * 检查 Hermes API 是否可用
     */
    async checkAvailability() {
        try {
            const url = new URL(`${this.apiUrl}/health`);
            return new Promise((resolve) => {
                const lib = url.protocol === 'https:' ? https : http;
                lib.get(url, { timeout: 5000 }, (res) => {
                    resolve(res.statusCode === 200);
                }).on('error', () => resolve(false));
            });
        } catch {
            return false;
        }
    }
}

export default HermesSourceApi;
