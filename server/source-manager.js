/**
 * 音源管理器
 * 
 * 功能：
 * 1. 智能测试音源，使用AI评分
 * 2. 保存用户选择的音源
 * 3. 读取已保存的音源配置
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';

// 配置文件路径
// 需要长期保存：
// - topSources: 最近一次 AI 评估的前 5 个音源（用于 UI 展示 + 快速切换）
// - selectedSource: 用户当前选中的音源
const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'web-audio-streamer');
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, 'source-config.json');

// 已知的音源API列表
const KNOWN_SOURCES = [
	{
		name: 'nuoxian',
		searchUrl: 'https://api.nxvav.cn/api/music/',
		format: 'json',
		needsAuth: false,
		platforms: ['netease', 'tencent', 'kugou', 'baidu', 'kuwo'],
		priority: 10,
		description: '落雪音乐API，多平台支持'
	},
	{
		name: 'injahow-meting',
		searchUrl: 'https://api.injahow.cn/meting/',
		format: 'json',
		needsAuth: false,
		platforms: ['netease', 'tencent', 'kugou'],
		priority: 5,
		knownIssue: '部分歌曲只有45秒试听',
		description: 'Meting API，稳定但部分试听'
	},
	{
		name: 'bugpk',
		searchUrl: 'https://api.bugpk.com/api/music',
		format: 'json',
		needsAuth: false,
		platforms: ['netease', 'tencent'],
		priority: 7,
		description: 'BugPK音乐API'
	},
	{
		name: 'sunzongzheng',
		searchUrl: 'https://suen-music-api.leanapp.cn/',
		format: 'json',
		needsAuth: false,
		platforms: ['netease', 'qq'],
		priority: 6,
		description: 'LeanCloud音乐API'
	}
];

export class SourceManager {
	constructor() {
		this.config = null;
		this._ensureConfigDir();
	}

	_ensureConfigDir() {
		if (!fs.existsSync(CONFIG_DIR)) {
			fs.mkdirSync(CONFIG_DIR, { recursive: true });
		}
	}

	/**
	 * 加载已保存的音源配置
	 */
	loadSavedSource() {
		try {
			if (fs.existsSync(SOURCE_CONFIG_FILE)) {
				const data = JSON.parse(fs.readFileSync(SOURCE_CONFIG_FILE, 'utf-8'));
				this.config = data;
				return data;
			}
		} catch (e) {
			console.error('[SourceManager] Failed to load config:', e.message);
		}
		return null;
	}

	/**
	 * 获取已保存的 Top5 音源列表
	 */
	getTopSources() {
		if (!this.config) {
			this.loadSavedSource();
		}
		return this.config?.topSources || [];
	}

	/**
	 * 保存 Top5 音源列表（长期保存）
	 */
	saveTopSources(topSources) {
		try {
			const existing = this.config || this.loadSavedSource() || {};
			const next = {
				...existing,
				topSources: topSources,
				lastTestAt: new Date().toISOString(),
				version: 2,
			};
			fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(next, null, 2));
			this.config = next;
			console.log('[SourceManager] Saved topSources:', Array.isArray(topSources) ? topSources.length : 0);
			return true;
		} catch (e) {
			console.error('[SourceManager] Failed to save topSources:', e.message);
			return false;
		}
	}

	/**
	 * 保存用户选择的音源
	 */
	saveSource(source) {
		try {
			const existing = this.config || this.loadSavedSource() || {};
			const config = {
				...existing,
				selectedSource: source,
				selectedAt: new Date().toISOString(),
				version: Math.max(existing.version || 1, 2),
			};
			fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(config, null, 2));
			this.config = config;
			console.log('[SourceManager] Saved source:', source.name);
			return true;
		} catch (e) {
			console.error('[SourceManager] Failed to save config:', e.message);
			return false;
		}
	}

	/**
	 * 获取当前使用的音源
	 */
	getCurrentSource() {
		if (!this.config) {
			this.loadSavedSource();
		}
		return this.config?.selectedSource || null;
	}

	/**
	 * 查找 OpenClaw 配置并解析 LLM 信息
	 */
	async findLLMConfig() {
		const candidates = [
			path.join(os.homedir(), '.openclaw', 'openclaw.json'),
			'/app/openclaw.json',
			'/opt/openclaw/openclaw.json',
			path.join(process.cwd(), '.openclaw', 'openclaw.json'),
		];

		for (const configPath of candidates) {
			try {
				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, 'utf-8');
					const config = JSON.parse(content);
					
					// 解析默认模型
					const defaultModel = config.agents?.defaults?.model?.primary 
						|| config.defaultModel 
						|| config.model;
					
					if (!defaultModel) continue;

					// 解析 provider 信息
					const parts = defaultModel.split('/');
					const providerName = parts[0];
					const modelId = parts.slice(1).join('/');
					
					// 获取 provider 配置
					const providers = config.models?.providers || config.providers || {};
					const provider = providers[providerName];
					
					if (provider) {
						console.log(`[SourceManager] Found LLM config: ${defaultModel}`);
						return {
							provider: providerName,
							modelId: modelId,
							fullId: defaultModel,
							baseUrl: provider.baseUrl || provider.base_url,
							apiKey: provider.apiKey || provider.api_key,
							apiType: provider.api || 'openai-completions'
						};
					}
				}
			} catch (e) {
				console.log(`[SourceManager] Failed to parse ${configPath}:`, e.message);
			}
		}

		console.log('[SourceManager] No LLM config found, using simple evaluation');
		return null;
	}

	/**
	 * 调用 LLM API
	 */
	async _callLLM(llmConfig, prompt) {
		return new Promise((resolve, reject) => {
			let url;
			try {
				url = new URL(llmConfig.baseUrl);
				if (!url.pathname.includes('/chat')) {
					url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
				}
			} catch (e) {
				url = new URL(llmConfig.baseUrl + '/chat/completions');
			}

			const lib = url.protocol === 'https:' ? https : http;
			
			const data = JSON.stringify({
				model: llmConfig.modelId,
				messages: [{ role: 'user', content: prompt }],
				temperature: 0.3,
				max_tokens: 2000
			});

			const options = {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${llmConfig.apiKey}`
				},
				timeout: 60000
			};

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
	async _evaluateWithLLM(llmConfig, source, testData) {
		const prompt = `你是一个音乐API评估专家。请评估以下音乐API的质量：

音源名称: ${source.name}
描述: ${source.description || '未知'}
响应延迟: ${testData.latency}ms
搜索结果数: ${testData.resultCount}
是否能获取完整播放链接: ${testData.hasFullUrl ? '是' : '否'}
已知问题: ${source.knownIssue || '无'}

请从以下维度评分（每项0-100分）：
1. 完整性：能否获取完整歌曲（不是试听片段）
2. 响应速度：API响应是否快速
3. 稳定性：服务是否稳定可靠
4. 结果质量：搜索结果是否准确丰富

请以JSON格式返回评分结果：
{"完整性":X,"响应速度":X,"稳定性":X,"结果质量":X,"总分":X,"备注":"简短评价"}

只返回JSON，不要其他内容。`;

		try {
			const response = await this._callLLM(llmConfig, prompt);
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const eval_ = JSON.parse(jsonMatch[0]);
				return {
					source: source.name,
					success: true,
					...testData,
					aiScore: eval_.总分,
					score: eval_.总分 + (source.priority || 5) * 10,
					details: eval_
				};
			}
		} catch (e) {
			console.log(`[SourceManager] LLM eval failed for ${source.name}:`, e.message);
		}

		return this._simpleEvaluation(source, testData);
	}

	/**
	 * 简单评分（无LLM时使用）
	 */
	_simpleEvaluation(source, testData) {
		let score = 50;
		// 行业标准：不可用的源直接判 0
		if (testData.success === false) return { source: source.name, success: false, ...testData, score: 0 };
		if (!testData.hasFullUrl) score -= 80;
		if (testData.resultCount === 0) score -= 60;
		
		if (testData.hasFullUrl) score += 40;
		else score -= 30;
		
		if (testData.latency < 500) score += 20;
		else if (testData.latency < 1000) score += 10;
		else if (testData.latency > 3000) score -= 10;
		
		if (testData.resultCount > 20) score += 15;
		else if (testData.resultCount === 0) score -= 20;
		
		score += (source.priority || 5) * 5;
		
		if (source.knownIssue) score -= 30;
		// 如果探测到试听/短片段，直接让它出局
		if (testData.isPreview) score = 0;

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
	async _testSource(source, testSong = '周杰伦') {
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
			const firstUrl = this._extractFirstPlayUrl(data);
			const hasFullUrl = this._checkFullUrl(data);
			// 试听检测：探测第一条结果的时长（秒）
			const durationSec = firstUrl ? this._probeDuration(firstUrl) : null;
			const isPreview = typeof durationSec === 'number' && durationSec > 0 && durationSec < 90;

			return {
				success: true,
				latency,
				resultCount,
				hasFullUrl,
				firstUrl: firstUrl || null,
				durationSec,
				isPreview,
				rawData: data
			};
		} catch (e) {
			return {
				success: false,
				latency: Date.now() - startTime,
				resultCount: 0,
				hasFullUrl: false,
				firstUrl: null,
				durationSec: null,
				isPreview: false,
				error: e.message
			};
		}
	}

	_extractFirstPlayUrl(data) {
		try {
			const results = Array.isArray(data) ? data : (data?.results || data?.data || []);
			if (!results || results.length === 0) return null;
			const first = results[0];
			return first?.playUrl || first?.url || null;
		} catch {
			return null;
		}
	}

	_probeDuration(inputUrl) {
		try {
			const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputUrl}"`;
			const out = execSync(cmd, { timeout: 8000, encoding: 'utf-8', shell: true }).trim();
			const v = parseFloat(out);
			if (Number.isFinite(v) && v > 0) return v;
		} catch (e) {
			// ignore
		}
		return null;
	}

	/**
	 * 批量测试所有音源并返回前5个最佳
	 */
	async testAndRankSources(testSong = '周杰伦') {
		console.log(`[SourceManager] Testing sources with "${testSong}"...`);
		
		// 查找 LLM 配置
		const llmConfig = await this.findLLMConfig();
		
		const results = [];
		
		for (const source of KNOWN_SOURCES) {
			console.log(`[SourceManager] Testing ${source.name}...`);
			const testData = await this._testSource(source, testSong);
			
			let result;
			if (llmConfig) {
				result = await this._evaluateWithLLM(llmConfig, source, testData);
			} else {
				result = this._simpleEvaluation(source, testData);
			}
			
			// 添加音源详情
			result.sourceInfo = source;
			results.push(result);
		}

		// 按分数排序
		results.sort((a, b) => b.score - a.score);

		// 返回前5个
		const top5 = results.slice(0, 5);
		console.log(`[SourceManager] Top 5 sources:`, top5.map(r => `${r.source}(${r.score})`));
		// 长期保存 Top5（包含评分/测试信息）
		this.saveTopSources(top5);
		
		return top5;
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
