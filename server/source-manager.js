/**
 * 音源管理器 v4.2
 * 
 * 流程：
 * 1. 尝试调用 Agent 搜索音源
 * 2. 如果 Agent 失败，使用预定义的已知可用源作为后备
 * 3. 后端用 ffprobe 测试每条播放链接，过滤试听源
 * 4. 返回最多6个最优选
 */

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { spawn, execSync } from "child_process";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");

// 预定义的已知音乐源（作为 Agent 失败时的后备）
const FALLBACK_SOURCES = [
	{
		name: "落雪音乐 API",
		searchUrl: "https://api.nxvav.cn/api/music/",
		description: "落雪音乐API，多平台支持",
	},
	{
		name: "Injahow Meting",
		searchUrl: "https://api.injahow.cn/meting/",
		description: "Meting API",
	},
	{
		name: "BugPK Music",
		searchUrl: "https://api.bugpk.com/api/music",
		description: "BugPK音乐API",
	},
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

	loadConfig() {
		try {
			if (fs.existsSync(SOURCE_CONFIG_FILE)) {
				this.config = JSON.parse(
					fs.readFileSync(SOURCE_CONFIG_FILE, "utf-8"),
				);
				return this.config;
			}
		} catch (e) {
			console.error("[SourceManager] Failed to load config:", e.message);
		}
		return null;
	}

	saveConfig(data) {
		try {
			fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(data, null, 2));
			this.config = data;
			console.log("[SourceManager] Config saved");
			return true;
		} catch (e) {
			console.error("[SourceManager] Failed to save config:", e.message);
			return false;
		}
	}

	getCurrentSource() {
		if (!this.config) this.loadConfig();
		return this.config?.selectedSource || null;
	}

	getCandidateSources() {
		if (!this.config) this.loadConfig();
		return this.config?.candidateSources || [];
	}

	saveSelectedSource(source) {
		if (!this.config) this.loadConfig();
		this.config = this.config || {};
		this.config.selectedSource = source;
		this.config.selectedAt = new Date().toISOString();
		this.saveConfig(this.config);
		console.log("[SourceManager] Saved selected source:", source.name);
	}

	hasAvailableSource() {
		const source = this.getCurrentSource();
		return source && source.searchUrl;
	}

	/**
	 * 智能获取音源 - 完整流程
	 */
	async fetchAndTestSources(testSong = "周杰伦") {
		console.log("[SourceManager] === Starting smart source discovery ===");

		// 1. 尝试调用 Agent 搜索
		let discovered = [];
		try {
			discovered = await this._discoverViaAgent(testSong);
		} catch (e) {
			console.log("[SourceManager] Agent discovery failed:", e.message);
		}

		// 2. 如果 Agent 没有返回有效结果，使用后备源
		if (discovered.length === 0) {
			console.log(
				"[SourceManager] Agent returned no results, using fallback sources",
			);
			discovered = FALLBACK_SOURCES.map((s) => ({
				...s,
				fromFallback: true,
			}));
		}

		// 3. 测试每个源
		console.log(
			"[SourceManager] Testing",
			discovered.length,
			"sources...",
		);
		const testedResults = [];

		for (const source of discovered) {
			const result = await this._testSource(source, testSong);
			console.log(
				"[SourceManager] Test result:",
				result.name,
				"- success:",
				result.success,
				"- resultCount:",
				result.resultCount,
				"- maxDuration:",
				result.maxDuration,
				"- hasFullSong:",
				result.hasFullSong,
			);
			testedResults.push(result);
		}

		// 4. 过滤：必须成功 + 非试听 + 有结果
		const validSources = testedResults.filter(
			(r) =>
				r.success &&
				r.hasFullSong === true &&
				r.resultCount > 0,
		);

		console.log(
			"[SourceManager] Valid sources after testing:",
			validSources.length,
			"/",
			testedResults.length,
		);

		// 5. 排序
		validSources.sort((a, b) => {
			if (a.maxDuration !== b.maxDuration) {
				return b.maxDuration - a.maxDuration;
			}
			return a.latency - b.latency;
		});

		// 6. 返回前6个
		const top6 = validSources.slice(0, 6);

		// 7. 保存候选列表
		if (top6.length > 0) {
			this.config = this.config || {};
			this.config.candidateSources = top6;
			this.config.lastFetchAt = new Date().toISOString();
			this.config.version = 4;
			this.saveConfig(this.config);
		}

		console.log(
			"[SourceManager] === Returning",
			top6.length,
			"sources:",
			top6.map((s) => s.name),
		);
		return top6;
	}

	/**
	 * 调用 Agent 搜索音源
	 */
	async _discoverViaAgent(testSong) {
		return new Promise((resolve) => {
			console.log(
				"[SourceManager] Calling OpenClaw Agent to search for music APIs...",
			);

			const prompt = `请使用 web_search 工具搜索免费音乐API。

搜索关键词：落雪音乐 API

返回格式（JSON数组）：
[{"name":"API名称","searchUrl":"https://xxx/api","description":"描述"}]

只返回包含 https:// 或 http:// 开头的 URL 的 JSON 数组。`;

			const sessionId = "source-search-" + Date.now();

			const proc = spawn(
				"openclaw",
				[
					"agent",
					"--session-id",
					sessionId,
					"--timeout",
					"120",
					"--json",
					"-m",
					prompt,
				],
				{
					cwd: process.cwd(),
					env: process.env,
				},
			);

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (d) => {
				stdout += d;
			});
			proc.stderr.on("data", (d) => {
				stderr += d;
			});

			proc.on("close", (code) => {
				console.log("[SourceManager] Agent exit code:", code);

				try {
					// 找包含 http URL 的 JSON 数组
					const jsonMatches = stdout.match(/\[[\s\S]*?\]/g);
					if (jsonMatches) {
						for (let i = jsonMatches.length - 1; i >= 0; i--) {
							try {
								const parsed = JSON.parse(jsonMatches[i]);
								if (Array.isArray(parsed) && parsed.length > 0) {
									const hasValidUrl = parsed.some(
										(item) =>
											item &&
											typeof item.searchUrl === "string" &&
											(item.searchUrl.startsWith("http://") ||
												item.searchUrl.startsWith("https://")),
									);
									if (hasValidUrl) {
										const filtered = parsed.filter(
											(s) =>
												s &&
												s.searchUrl &&
												(s.searchUrl.startsWith("http://") ||
													s.searchUrl.startsWith("https://")),
										);
										if (filtered.length > 0) {
											console.log(
												"[SourceManager] Agent found",
												filtered.length,
												"valid sources",
											);
											return resolve(filtered);
										}
									}
								}
							} catch (e) {}
						}
					}

					// 方法2: 找 http URL
					const urlPattern = /"searchUrl"\s*:\s*"(https?:\/\/[^"]+)"/g;
					const results = [];
					let match;
					while ((match = urlPattern.exec(stdout)) !== null) {
						results.push({
							name: "Discovered API",
							searchUrl: match[1],
							description: "Agent discovered",
						});
					}
					if (results.length > 0) {
						return resolve(results);
					}

					console.log("[SourceManager] Agent returned no valid URLs");
					resolve([]);
				} catch (e) {
					console.log("[SourceManager] Parse error:", e.message);
					resolve([]);
				}
			});

			proc.on("error", (e) => {
				console.log("[SourceManager] Spawn error:", e.message);
				resolve([]);
			});

			setTimeout(() => {
				try {
					proc.kill();
				} catch (e) {}
				resolve([]);
			}, 130000);
		});
	}

	/**
	 * 测试单个音源
	 */
	async _testSource(source, testSong) {
		const startTime = Date.now();

		try {
			if (!source.searchUrl || typeof source.searchUrl !== "string") {
				return {
					...source,
					success: false,
					error: "Invalid or missing searchUrl",
					resultCount: 0,
				};
			}

			let searchUrl = source.searchUrl;
			if (!searchUrl.includes("?")) {
				searchUrl += `?server=netease&type=search&id=${encodeURIComponent(testSong)}`;
			}

			console.log(`[SourceManager] Testing: ${source.name} -> ${searchUrl}`);

			const data = await this._fetch(searchUrl);
			const latency = Date.now() - startTime;

			const items = this._parseResults(data);
			const resultCount = items.length;

			if (resultCount === 0) {
				return {
					...source,
					success: false,
					error: "No results",
					latency,
					resultCount: 0,
				};
			}

			// 抽样测试前3条
			const sampleItems = items.slice(0, 3);
			let maxDuration = 0;

			for (const item of sampleItems) {
				const playUrl = item.playUrl || item.url;
				if (!playUrl) continue;
				const duration = this._probeDuration(playUrl);
				if (duration && duration > maxDuration) {
					maxDuration = duration;
				}
			}

			const hasFullSong = maxDuration >= 90;

			return {
				...source,
				success: true,
				latency,
				resultCount,
				maxDuration,
				hasFullSong,
				isPreview: maxDuration > 0 && maxDuration < 90,
				sampleDuration: maxDuration,
				testedAt: new Date().toISOString(),
			};
		} catch (e) {
			return {
				...source,
				success: false,
				error: e.message,
				latency: Date.now() - startTime,
				resultCount: 0,
			};
		}
	}

	/**
	 * 批量探测搜索结果的 duration
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
			const isPreview = typeof dur === "number" && dur > 0 && dur < 90;
			results.push({ ...item, durationSec: dur, isPreview });
		}

		for (const item of items.slice(probeLimit)) {
			results.push({ ...item, durationSec: null, isPreview: null });
		}

		return results;
	}

	_fetch(url) {
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			const lib = parsed.protocol === "https:" ? https : http;

			const req = lib.get(
				url,
				{
					headers: { "User-Agent": "Mozilla/5.0" },
					timeout: 15000,
				},
				(res) => {
					if (
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers.location
					) {
						const newUrl = res.headers.location.startsWith("http")
							? res.headers.location
							: new URL(res.headers.location, parsed.origin).href;
						return this._fetch(newUrl).then(resolve).catch(reject);
					}

					let data = "";
					res.on("data", (c) => (data += c));
					res.on("end", () => {
						try {
							resolve(JSON.parse(data));
						} catch {
							resolve(data);
						}
					});
				},
			);

			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new Error("Timeout"));
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
				{ timeout: 8000, encoding: "utf-8", shell: true },
			).trim();
			const v = parseFloat(out);
			if (Number.isFinite(v) && v > 0) return v;
		} catch {}
		return null;
	}
}
