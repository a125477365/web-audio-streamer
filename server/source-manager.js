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

    const agentOutput = await this._callAgent(testSong);
    const sources = this._parseAgentOutput(agentOutput);

    if (!sources || sources.length === 0) {
      // Agent 没找到源
      const errorReason = this._extractError(agentOutput);
      throw new Error(errorReason || "Agent 未找到任何可用音源");
    }

    // 验证每个源都有有效的 searchUrl（排除 GitHub 等非 API URL）
    const validSources = sources.filter(
      (s) =>
        s &&
        s.searchUrl &&
        s.searchUrl.startsWith("http") &&
        !s.searchUrl.includes("github.com"),
    );

    if (validSources.length === 0) {
			// Agent 没找到有效源，使用预定义的后备源
			console.log("[SourceManager] Agent returned no valid APIs, using fallback sources");
			const fallbacks = this._getFallbackSources();
			console.log("[SourceManager] Testing", fallbacks.length, "fallback sources...");
			const tested = await this._testSources(fallbacks, testSong);
			if (tested.length === 0) {
				throw new Error("所有音源均不可用，请稍后重试");
			}
			this.config = this.config || {};
			this.config.candidates = tested.slice(0, 6);
			this.config.lastFetchAt = new Date().toISOString();
			this.config.fetchTestSong = testSong;
			this.config.version = 5;
			this.saveConfig(this.config);
			if (!this.config.selectedSource) {
				this.selectSource(tested[0]);
			}
			console.log("[SourceManager] Using", tested.length, "fallback sources:", tested.map(s => s.name));
			return tested;
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
  
	_getFallbackSources() {
		return [
			{ name: "落雪音乐 API", searchUrl: "https://api.nxvav.cn/api/music/", description: "落雪音乐API，多平台支持" },
			{ name: "Injahow Meting", searchUrl: "https://api.injahow.cn/meting/", description: "Meting API，多平台" },
			{ name: "BugPK Music", searchUrl: "https://api.paugram.com/netease/", description: "网易云音乐搜索" }
		];
	}

	_callAgent(testSong) {
    return new Promise((resolve) => {
      console.log("[SourceManager] Calling OpenClaw Agent...");

      const prompt = [
	"搜索免费音乐API。",
	"输出格式:",
	">>>MUSIC_SOURCES_START<<<",
	"[{\"name\":\"API名\",\"searchUrl\":\"https://xxx\",\"description\":\"描述\"}]",
	">>>MUSIC_SOURCES_END<<<",
].join("\n");
const sessionId = "music-source-fetch-" + Date.now();

      // 不使用 --json，让 stdout 直接是 Agent 的文本回复
      const proc = spawn(
        "openclaw",
        ["agent", "--session-id", sessionId, "--timeout", "300", "-m", prompt],
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
   * 解析 Agent 输出，提取 JSON 音源列表
   */
  _parseAgentOutput(output) {
    if (!output?.stdout) return null;

    const text = output.stdout;

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
