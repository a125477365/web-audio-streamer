/**
 * 音源管理器 v3.0
 * 
 * 核心流程：
 * 1. 用户点击"智能获取音源" → 调用 OpenClaw Agent 联网搜索并测试 → 返回6个最优选供用户选择
 * 2. 用户选择后永久保存
 * 3. 搜索时如果无源，自动触发获取流程
 * 4. 代码不写死任何音源
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'web-audio-streamer');
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, 'source-config.json');

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
	 * 加载已保存的配置
	 */
	loadConfig() {
		try {
			if (fs.existsSync(SOURCE_CONFIG_FILE)) {
				this.config = JSON.parse(fs.readFileSync(SOURCE_CONFIG_FILE, 'utf-8'));
				return this.config;
			}
		} catch (e) {
			console.error('[SourceManager] Failed to load config:', e.message);
		}
		return null;
	}

	/**
	 * 保存配置
	 */
	saveConfig(data) {
		try {
			fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(data, null, 2));
			this.config = data;
			console.log('[SourceManager] Config saved');
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
		if (!this.config) this.loadConfig();
		return this.config?.selectedSource || null;
	}

	/**
	 * 获取已保存的候选源列表
	 */
	getCandidateSources() {
		if (!this.config) this.loadConfig();
		return this.config?.candidateSources || [];
	}

	/**
	 * 保存用户选择的音源
	 */
	saveSelectedSource(source) {
		if (!this.config) this.loadConfig();
		this.config = this.config || {};
		this.config.selectedSource = source;
		this.config.selectedAt = new Date().toISOString();
		this.saveConfig(this.config);
		console.log('[SourceManager] Saved selected source:', source.name);
	}

	/**
	 * 检查是否已有可用音源
	 */
	hasAvailableSource() {
		const source = this.getCurrentSource();
		return source && source.searchUrl;
	}

	/**
	 * 调用 OpenClaw Agent 联网搜索音源
	 */
	async discoverSourcesViaAgent() {
		return new Promise((resolve) => {
			console.log('[SourceManager] Calling OpenClaw agent to discover music sources...');

			const prompt = `你是一个音乐API发现专家。请帮我搜索当前可用的免费音乐API，要求：

1. 搜索关键词："落雪音乐 API"、"免费音乐搜索API"、"网易云代理API"、"音乐解析API"
2. 必须是能返回完整歌曲播放链接的API（不要试听/片段）
3. 每个API需要测试：能否搜索、能否获取播放链接、链接是否为完整歌曲（非试听）

请返回你找到并验证过的API，格式如下（JSON数组）：
[
  {
    "name": "音源名称",
    "searchUrl": "https://xxx/api/search接口",
    "playUrlTemplate": "https://xxx/api/play?id={id}",
    "description": "简短描述",
    "tested": true,
    "canPlayFull": true,
    "avgDuration": 200
  }
]

只返回JSON数组，不要其他内容。如果找到多个，按可用性排序返回前10个。`;

			const proc = spawn('openclaw', [
				'agent',
				'--local',
				'--message', prompt,
				'--timeout', '180'
			], {
				cwd: process.cwd(),
				env: process.env,
				shell: true
			});

			let stdout = '';
			let stderr = '';

			proc.stdout.on('data', (d) => { stdout += d; });
			proc.stderr.on('data', (d) => { stderr += d; });

			proc.on('close', (code) => {
				if (code !== 0) {
					console.log('[SourceManager] Agent exit code:', code);
					if (stderr) console.log('[SourceManager] Agent stderr:', stderr.slice(0, 500));
				}

				try {
					// 尝试从输出中提取 JSON 数组
					const jsonMatches = stdout.match(/\[[\s\S]*?\]/g);
					if (jsonMatches && jsonMatches.length > 0) {
						// 取最后一个匹配（通常是最终结果）
						const lastMatch = jsonMatches[jsonMatches.length - 1];
						const sources = JSON.parse(lastMatch);
						console.log('[SourceManager] Agent discovered', sources.length, 'sources');
						resolve(sources);
					} else {
						console.log('[SourceManager] No JSON array found in agent output');
						console.log('[SourceManager] Output preview:', stdout.slice(0, 300));
						resolve([]);
					}
				} catch (e) {
					console.log('[SourceManager] Failed to parse agent output:', e.message);
					resolve([]);
				}
			});

			proc.on('error', (e) => {
				console.log('[SourceManager] Failed to spawn agent:', e.message);
				resolve([]);
			});

			// 超时保护（3分钟）
			setTimeout(() => {
				try { proc.kill(); } catch (e) {}
				resolve([]);
			}, 185000);
		});
	}

	/**
	 * 测试单个音源是否可用
	 */
	async testSource(source, testSong = '周杰伦') {
		const startTime = Date.now();
		
		try {
			// 构造搜索URL
			let searchUrl = source.searchUrl;
			if (!searchUrl.includes('?')) {
				searchUrl += `?server=netease&type=search&id=${encodeURIComponent(testSong)}`;
			}

			console.log(`[SourceManager] Testing source: ${source.name} -> ${searchUrl}`);
			
			const data = await this._fetch(searchUrl);
			const latency = Date.now() - startTime;
			
			// 解析结果
			const items = this._parseResults(data);
			const resultCount = items.length;

			if (resultCount === 0) {
				return { ...source, success: false, error: 'No results', latency };
			}

			// 抽样测试前3条的播放链接
			const sampleItems = items.slice(0, 3);
			let maxDuration = 0;
			let hasFullSong = false;
			const sampleResults = [];

			for (const item of sampleItems) {
				const playUrl = item.playUrl || item.url || 
					(source.playUrlTemplate ? source.playUrlTemplate.replace('{id}', item.id) : null);
				
				if (!playUrl) continue;

				const duration = this._probeDuration(playUrl);
				sampleResults.push({ id: item.id, duration });
				
				if (duration && duration > maxDuration) {
					maxDuration = duration;
				}
			}

			// 判断是否为完整歌曲（至少有一条 >= 180秒）
			hasFullSong = maxDuration >= 180;
			const isPreview = maxDuration > 0 && maxDuration < 90;

			console.log(`[SourceManager] ${source.name}: ${resultCount} results, maxDuration=${maxDuration}s, hasFullSong=${hasFullSong}`);

			return {
				...source,
				success: true,
				latency,
				resultCount,
				maxDuration,
				hasFullSong,
				isPreview,
				sampleResults,
				testedAt: new Date().toISOString()
			};
		} catch (e) {
			return { 
				...source, 
				success: false, 
				error: e.message, 
				latency: Date.now() - startTime 
			};
		}
	}

	/**
	 * 智能获取音源 - 完整流程
	 * 1. 调用 Agent 发现
	 * 2. 测试每个源
	 * 3. 过滤试听源
	 * 4. 返回6个最优选
	 */
	async fetchAndTestSources(testSong = '周杰伦') {
		console.log('[SourceManager] Starting smart source discovery...');

		// 1. 调用 Agent 发现音源
		const discovered = await this.discoverSourcesViaAgent();
		
		if (discovered.length === 0) {
			console.log('[SourceManager] Agent found no sources, using fallback');
			// 备用：如果 agent 完全失败，返回空（让前端提示用户重试）
			return [];
		}

		// 2. 测试每个发现的源
		console.log('[SourceManager] Testing', discovered.length, 'discovered sources...');
		const testedResults = [];

		for (const source of discovered) {
			const result = await this.testSource(source, testSong);
			testedResults.push(result);
		}

		// 3. 过滤：必须成功 + 能播放完整歌曲（非试听）
		const validSources = testedResults.filter(r => 
			r.success && 
			r.hasFullSong === true && 
			r.resultCount > 0
		);

		console.log('[SourceManager] Valid sources after filtering:', validSources.length);

		// 4. 排序：按 maxDuration 降序，然后按 latency 升序
		validSources.sort((a, b) => {
			// 优先选择能播放完整歌曲的
			if (a.hasFullSong !== b.hasFullSong) {
				return b.hasFullSong ? 1 : -1;
			}
			// 然后按延迟排序
			return a.latency - b.latency;
		});

		// 5. 返回前6个
		const top6 = validSources.slice(0, 6);

		// 6. 保存候选列表（供用户选择）
		if (top6.length > 0) {
			this.config = this.config || {};
			this.config.candidateSources = top6;
			this.config.lastDiscoveryAt = new Date().toISOString();
			this.config.discoveryVersion = 3;
			this.saveConfig(this.config);
		}

		console.log('[SourceManager] Returning top 6 sources:', top6.map(s => s.name));
		return top6;
	}

	/**
	 * 批量探测搜索结果中每首歌的duration（标记试听）
	 */
	probeSearchResults(items, probeLimit = 10) {
		const results = [];
		const toProbe = items.slice(0, probeLimit);

		for (const item of toProbe) {
			const url = item?.playUrl || item?.url;
			if (!url) {
				results.push({ ...item, durationSec: null, isPreview: null });
				continue;
			}
			const dur = this._probeDuration(url);
			const isPreview = typeof dur === 'number' && dur > 0 && dur < 90;
			results.push({ ...item, durationSec: dur, isPreview });
		}

		// 剩余的不探测
		for (const item of items.slice(probeLimit)) {
			results.push({ ...item, durationSec: null, isPreview: null });
		}

		return results;
	}

	// ============ 辅助方法 ============

	_fetch(url) {
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			const lib = parsed.protocol === 'https:' ? https : http;
			
			const req = lib.get(url, {
				headers: { 'User-Agent': 'Mozilla/5.0' },
				timeout: 15000
			}, (res) => {
				// 处理重定向
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					const newUrl = res.headers.location.startsWith('http') 
						? res.headers.location 
						: new URL(res.headers.location, parsed.origin).href;
					return this._fetch(newUrl).then(resolve).catch(reject);
				}

				let data = '';
				res.on('data', c => data += c);
				res.on('end', () => {
					try { resolve(JSON.parse(data)); }
					catch { resolve(data); }
				});
			});

			req.on('error', reject);
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Timeout'));
			});
		});
	}

	_parseResults(data) {
		if (Array.isArray(data)) return data;
		if (data?.results) return data.results;
		if (data?.data) {
			if (Array.isArray(data.data)) return data.data;
			if (data.data.songs) return data.data.songs;
		}
		return [];
	}

	_probeDuration(url) {
		try {
			const out = execSync(
				`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`,
				{ timeout: 8000, encoding: 'utf-8', shell: true }
			).trim();
			const v = parseFloat(out);
			if (Number.isFinite(v) && v > 0) return v;
		} catch {}
		return null;
	}
}
