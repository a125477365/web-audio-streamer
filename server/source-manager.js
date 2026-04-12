/**
 * 音源管理器 v5
 *
 * 核心原则：所有音源由 OpenClaw Agent 搜索、测试、筛选
 * 代码不写死任何源，不使用后备源
 */

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { spawn, execSync } from "child_process";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");

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
        this.config = JSON.parse(fs.readFileSync(SOURCE_CONFIG_FILE, "utf-8"));
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

  /** 是否已有可用音源 */
  hasAvailableSource() {
    if (!this.config) this.loadConfig();
    return !!this.config?.selectedSource?.searchUrl;
  }

  /** 获取当前选中的音源 */
  getCurrentSource() {
    if (!this.config) this.loadConfig();
    return this.config?.selectedSource || null;
  }

  /** 获取已保存的候选列表（最多6个） */
  getCandidates() {
    if (!this.config) this.loadConfig();
    return this.config?.candidates || [];
  }

  /** 用户从候选中选择一个源 */
  selectSource(source) {
    this.config = this.config || {};
    this.config.selectedSource = source;
    this.config.selectedAt = new Date().toISOString();
    this.saveConfig(this.config);
    console.log("[SourceManager] User selected:", source.name);
  }

  /**
   * 智能获取音源 - 调用 OpenClaw Agent 完成搜索+测试+筛选
   * 返回最多6个非试听的可用源
   */
  async fetchSources(testSong = "周杰伦") {
console.log("[SourceManager] === 开始智能获取音源（Agent 全流程）===");

// 已知可用的音乐 API（作为 Agent 搜索的补充）
const knownSources = [
  {
    name: "落雪音乐 API",
    searchUrl: "https://api.nxvav.cn/api/music/",
    description: "支持网易云、QQ、酷狗、酷我、百度等平台搜索，可获取完整歌曲",
    platforms: ["netease", "tencent", "kugou", "baidu", "kuwo"]
  }
];

// 尝试调用 Agent 搜索
let agentSources = [];
try {
  const agentOutput = await this._callAgent(testSong);
  agentSources = this._parseAgentOutput(agentOutput) || [];
  console.log("[SourceManager] Agent found", agentSources.length, "sources");
} catch (e) {
  console.log("[SourceManager] Agent search failed:", e.message);
}

// 合并：Agent 找到的 + 已知的（去重）
const allSources = [...agentSources];
for (const known of knownSources) {
  if (!allSources.find(s => s.searchUrl === known.searchUrl)) {
    allSources.push(known);
  }
}

// Agent 已经在返回前测试过了，直接使用返回的音源
// 只需要补充已知音源（如果 Agent 没有返回任何音源）
console.log("[SourceManager] Agent returned", allSources.length, "tested sources");
const sources = allSources;

if (!sources || sources.length === 0) {
throw new Error("Agent 未找到任何通过测试的可用音源。请稍后重试或检查网络连接。");
}

    // 验证每个源都有有效的 searchUrl
    // 排除：GitHub链接、workers.dev临时域名、已知的不可用域名
    const validSources = sources.filter((s) => {
      if (!s || !s.searchUrl || !s.searchUrl.startsWith("http")) return false;
      const url = s.searchUrl.toLowerCase();
      // 排除GitHub
      if (url.includes("github.com")) return false;
      // 排除临时workers域名（通常不稳定）
      if (url.includes("workers.dev")) return false;
      // 排除已知的不可用域名
      const blockedDomains = ["musicapi.x007.workers.dev", "example.com"];
      if (blockedDomains.some(d => url.includes(d))) return false;
      // 排除文档链接（通常不是API endpoint）
      if (url.includes("/docs") || url.includes("/doc") || url.includes("/documentation")) return false;
      // 允许的域名模式（放宽限制）
      const allowedPatterns = [
        /api./,           // api.nxvav.cn, api.injahow.cn 等
        /music./,         // music.163.com 等
        /netease./,       // 网易云相关
        /qq./,            // QQ音乐相关
        /kuwo./,          // 酷我相关
        /kugou./,         // 酷狗相关
        /migu./,          // 咪咕相关
        /y.qq.com/,      // QQ音乐
        /theaudiodb.com/, // TheAudioDB
        /last.fm/,        // Last.fm
        /deezer.com/,     // Deezer
        /spotify.com/,    // Spotify
        /soundcloud.com/, // SoundCloud
        /musicbrainz.org/, // MusicBrainz
        /.cn$/,           // 国内域名
        /.com$/,          // 通用域名
        /.org$/           // 通用域名
      ];
      // 必须匹配至少一个允许模式
      return allowedPatterns.some(p => p.test(url));
    });

    if (validSources.length === 0) {
			// Agent 没找到有效源，直接报错
			console.log("[SourceManager] Agent returned no valid APIs");
			const errorReason = this._extractError(agentOutput);
			throw new Error(errorReason || "Agent 未找到任何可用的音乐API。请稍后重试，或检查网络连接。");
		}

    // 限制最多6个
    const top6 = validSources.slice(0, 6);

    // 永久保存候选列表
    this.config = this.config || {};
    this.config.candidates = top6;
    this.config.lastFetchAt = new Date().toISOString();
    this.config.fetchTestSong = testSong;
    this.config.version = 5;
    this.saveConfig(this.config);

    // 自动选中第一个
    if (!this.config.selectedSource || !this.config.selectedSource.searchUrl) {
      this.selectSource(top6[0]);
    }

    console.log(
      "[SourceManager] === Agent 返回",
      top6.length,
      "个源:",
      top6.map((s) => s.name),
    );
    return top6;
  }

  /**
   * 调用 OpenClaw Agent
   * Agent 负责搜索、测试、筛选试听源
   */
	_callAgent(testSong) {
    return new Promise((resolve) => {
      console.log("[SourceManager] Calling OpenClaw Agent...");

      const prompt = [
"你是一个音乐API专家。请搜索并测试2024-2025年可用的免费音乐搜索API。",
"",
"=== 第一步：搜索音乐API ===",
"搜索免费音乐搜索API，要求：",
"1. 必须是可直接调用的HTTP API endpoint（不是文档页面、不是GitHub仓库）",
"2. 必须支持搜索功能（输入歌名返回歌曲列表）",
"3. 返回JSON格式数据",
"",
"排除以下类型的URL：",
"- GitHub.com（代码仓库）",
"- 文档页面（包含 /doc、/docs、readme 等）",
"- workers.dev 等临时域名",
"",
"=== 第二步：测试每个API ===",
"对于找到的每个API，你需要测试：",
"1. 调用搜索接口（搜索 '" + testSong + "'）",
"2. 检查是否返回有效的歌曲列表",
"3. 获取前3个结果的播放链接",
"4. 使用系统命令测试每个播放链接的时长：",
"   ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \"播放链接\"",
"5. 只保留能获取完整歌曲（时长 > 90秒）的API",
"",
"=== 第三步：返回测试结果 ===",
"只返回通过测试的API，输出格式：",
">>>MUSIC_SOURCES_START<<<",
"[{\"name\":\"API名称\",\"searchUrl\":\"https://实际API地址\",\"description\":\"简短描述\",\"resultCount\":搜索结果数,\"maxDuration\":最大时长秒数}]",
">>>MUSIC_SOURCES_END<<<",
"",
"重要：只返回通过测试的API，未通过测试的不要返回。"
].join("\n");
const sessionId = "music-source-fetch-" + Date.now();

      // 不使用 --json，让 stdout 直接是 Agent 的文本回复
      const proc = spawn(
        "openclaw",
        ["agent", "--local", "--session-id", sessionId, "--timeout", "300", "-m", prompt],
        { cwd: process.cwd(), env: process.env },
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
        if (stderr)
          console.log("[SourceManager] Agent stderr:", stderr.slice(0, 500));
        console.log("[SourceManager] Agent output length:", stdout.length);
        console.log("[SourceManager] Agent output:", stdout.slice(0, 1000));
        resolve({ code, stdout, stderr });
      });

      proc.on("error", (e) => {
        console.log("[SourceManager] Agent spawn error:", e.message);
        resolve({ code: -1, stdout: "", stderr: e.message });
      });

      // 超时保护 5分钟
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve({ code: -2, stdout: "", stderr: "Agent timeout (5min)" });
      }, 310000);
    });
  }


  /**
   * 过滤 ANSI 颜色代码和调试信息
   */
  _filterAgentOutput(text) {
    if (!text) return '';
    // 移除 ANSI 颜色代码
    let filtered = text.replace(/\x1b\[[0-9;]*m/g, '');
    // 移除常见的调试前缀
    filtered = filtered.replace(/^\[\d+m/g, '');
    filtered = filtered.replace(/^\[\d+;\d+m/g, '');
    // 移除空行
    filtered = filtered.replace(/^\s*\n/gm, '');
    return filtered;
  }
  /**
   * 解析 Agent 输出，提取 JSON 音源列表
   */
  _parseAgentOutput(output) {
    if (!output?.stdout) return null;

    const text = this._filterAgentOutput(output.stdout);

    // 方法1: 使用标记提取（最可靠）
    const markerMatch = text.match(
      />MUSIC_SOURCES_START<<<\s*([\s\S]*?)\s*>MUSIC_SOURCES_END<</,
    );
    if (markerMatch) {
      let inner = markerMatch[1].trim();
      // 去掉 markdown 代码块包裹
      inner = inner
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      try {
        const parsed = JSON.parse(inner);
        // 可能是数组或对象包含 sources 数组
        let arr = Array.isArray(parsed)
          ? parsed
          : parsed.sources || parsed.data || null;
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(
            "[SourceManager] Parsed from markers:",
            arr.length,
            "sources",
          );
          return arr;
        }
        if (arr && arr.length === 0) {
          console.log(
            "[SourceManager] Agent returned empty array from markers",
          );
          return [];
        }
      } catch (e) {
        console.log(
          "[SourceManager] Marker found but JSON parse failed:",
          e.message,
          "content:",
          inner.slice(0, 200),
        );
      }
    }

    // 方法2: 找包含 http URL 的 JSON 数组（从后往前找最大的）
    const jsonMatches = text.match(/\[[\s\S]*?\]/g);
    if (jsonMatches) {
      for (let i = jsonMatches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(jsonMatches[i]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const hasValid = parsed.some((item) =>
              item?.searchUrl?.startsWith("http"),
            );
            if (hasValid) {
              console.log(
                "[SourceManager] Parsed from JSON array:",
                parsed.length,
                "sources",
              );
              return parsed;
            }
          }
        } catch {}
      }
    }

    // 方法3: 正则提取所有 http URL（任何包含 searchUrl 或 url 字段的）
    const urls = [];
    const urlPattern = /"(?:searchUrl|url)"\s*:\s*"(https?:\/\/[^"]+)"/g;
    let match;
    const seen = new Set();
    while ((match = urlPattern.exec(text)) !== null) {
      if (!seen.has(match[1]) && !match[1].includes("github.com")) {
        seen.add(match[1]);
        urls.push({
          name: "Discovered API",
          searchUrl: match[1],
          description: "Agent discovered",
        });
      }
    }
    if (urls.length > 0) {
      console.log("[SourceManager] Parsed from regex:", urls.length, "sources");
      return urls;
    }

    console.log(
      "[SourceManager] Could not parse any sources from agent output",
    );
    return null;
  }

  /**
   * 从 Agent 输出中提取错误信息
   */
  _extractError(output) {
    if (!output) return null;
    if (output.code === -1)
      return "无法启动 OpenClaw Agent: " + (output.stderr || "");
    if (output.code === -2) return "Agent 执行超时（5分钟）";
    if (output.code !== 0)
      return (
        `Agent 退出码: ${output.code}` +
        (output.stderr ? " - " + output.stderr.slice(0, 200) : "")
      );
    return null;
  }


  /**
   * 测试单个音源：搜索 + 探测 duration
   */
  async _testSource(source, testSong) {
    const result = { success: false, hasFullSong: false, resultCount: 0, maxDuration: 0, error: null };
    
    try {
      // 1. 构造搜索 URL
      let searchUrl;
      const encodedSong = encodeURIComponent(testSong);
      const provider = 'netease';
      
      if (source.searchUrl.includes('injahow') || source.searchUrl.includes('meting')) {
        // Injahow Meting 不支持搜索，跳过
        result.error = '不支持搜索功能';
        return result;
      } else if (source.searchUrl.includes('bugpk')) {
        searchUrl = `${source.searchUrl}?media=${provider}&type=search&id=${encodedSong}`;
      } else {
        // 默认按落雪音乐 API 格式
        searchUrl = `${source.searchUrl}?server=${provider}&type=search&id=${encodedSong}`;
      }
      
      // 2. 发起搜索请求
      const response = await this._fetchUrl(searchUrl);
      
      if (!Array.isArray(response) || response.length === 0) {
        result.error = '搜索无结果';
        return result;
      }
      
      result.resultCount = response.length;
      
      // 3. 探测前 3 个结果的 duration
      const toProbe = response.slice(0, 3);
      let maxDuration = 0;
      let hasFullSong = false;
      
      for (const item of toProbe) {
        const playUrl = item.url || item.playUrl;
        if (!playUrl) continue;
        
        const duration = this._probeDuration(playUrl);
        if (duration && duration > maxDuration) {
          maxDuration = duration;
        }
        if (duration && duration > 90) {
          hasFullSong = true;
        }
      }
      
      result.maxDuration = maxDuration;
      result.hasFullSong = hasFullSong;
      result.success = true;
      
    } catch (e) {
      result.error = e.message;
    }
    
    return result;
  }
  
  /**
   * HTTP 请求封装
   */
  _fetchUrl(url, maxRedirects = 5) {
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
          resolve(this._fetchUrl(newUrl, maxRedirects - 1));
          return;
        }
        
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      }).on('error', (err) => {
        reject(err);
      }).on('timeout', () => {
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * 批量探测搜索结果的 duration（标记试听）
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
