/**
 * 音源管理器 v4.1
 *
 * 流程：
 * 1. Agent 负责：搜索可用音乐API
 * 2. 后端负责：用 ffprobe 测试每条播放链接，过滤试听源
 * 3. 返回6个最优选
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
   * 调用 OpenClaw Agent 搜索音乐API
   * Agent 只负责搜索，后端负责测试
   */
  async discoverSourcesViaAgent(testSong = "周杰伦") {
    return new Promise((resolve) => {
      console.log(
        "[SourceManager] Calling OpenClaw Agent to search for music APIs...",
      );

      const prompt = `你是一个音乐API搜索专家。请使用 web_search 工具搜索当前可用的免费音乐API。

搜索步骤：
1. 用 web_search 搜索："落雪音乐 API 免费"
2. 用 web_search 搜索："免费音乐搜索 API 网易云"
3. 从搜索结果中找到可用的API地址

每个API必须返回：
- name: API名称
- searchUrl: 完整的API搜索接口URL（必须是 http:// 或 https:// 开头的完整URL）
- description: 简短描述

返回JSON数组格式：
[{"name":"xxx","searchUrl":"https://api.xxx.com/music","description":"xxx"}]

只返回有效的HTTP/HTTPS URL，不要返回文件名或其他内容。最多返回10个。`;

      const sessionId = "source-search-" + Date.now();

      const proc = spawn(
        "openclaw",
        [
          "agent",
          "--session-id",
          sessionId,
          "--timeout",
          "180",
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
        if (stderr)
          console.log("[SourceManager] stderr:", stderr.slice(0, 300));
        if (stdout)
          console.log("[SourceManager] stdout length:", stdout.length);

        try {
          // 尝试多种方式提取 JSON
          let sources = null;

          // 方法1: 找 JSON 数组
          const jsonMatches = stdout.match(/\[[\s\S]*?\]/g);
          if (jsonMatches) {
            for (const match of jsonMatches) {
              try {
                const parsed = JSON.parse(match);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  sources = parsed;
                  break;
                }
              } catch (e) {}
            }
          }

          // 方法2: 在 stdout 中找包含 searchUrl 的对象
          if (!sources && stdout.includes("searchUrl")) {
            try {
              // 尝试提取所有包含 searchUrl 的对象
              const urlPattern = /"searchUrl"\s*:\s*"([^"]+)"/g;
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
                sources = results;
              }
            } catch (e) {}
          }

          if (sources && sources.length > 0) {
            console.log(
              "[SourceManager] Agent found",
              sources.length,
              "potential sources",
            );
            resolve(sources);
          } else {
            console.log("[SourceManager] No sources found in agent output");
            console.log(
              "[SourceManager] Output preview:",
              stdout.slice(0, 500),
            );
            resolve([]);
          }
        } catch (e) {
          console.log("[SourceManager] Parse error:", e.message);
          resolve([]);
        }
      });

      proc.on("error", (e) => {
        console.log("[SourceManager] Spawn error:", e.message);
        resolve([]);
      });

      // 超时保护
      setTimeout(() => {
        try {
          proc.kill();
        } catch (e) {}
        resolve([]);
      }, 200000);
    });
  }

  /**
   * 测试单个音源（后端用 ffprobe 测试）
   */
  async testSource(source, testSong = "周杰伦") {
    const startTime = Date.now();

    try {
      // 检查 searchUrl 是否有效
      if (!source.searchUrl || typeof source.searchUrl !== "string") {
        return {
          ...source,
          success: false,
          error: "Invalid or missing searchUrl",
          resultCount: 0,
        };
      }

      // 构造搜索 URL
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

      // 抽样测试前3条的播放链接
      const sampleItems = items.slice(0, 3);
      let maxDuration = 0;
      let hasFullSong = false;

      for (const item of sampleItems) {
        const playUrl = item.playUrl || item.url;
        if (!playUrl) continue;

        const duration = this._probeDuration(playUrl);
        if (duration && duration > maxDuration) {
          maxDuration = duration;
        }
      }

      // 判断是否为完整歌曲（>= 90秒）
      hasFullSong = maxDuration >= 90;
      const isPreview = maxDuration > 0 && maxDuration < 90;

      console.log(
        `[SourceManager] ${source.name}: ${resultCount} results, maxDuration=${maxDuration}s, hasFullSong=${hasFullSong}`,
      );

      return {
        ...source,
        success: true,
        latency,
        resultCount,
        maxDuration,
        hasFullSong,
        isPreview,
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
   * 智能获取音源 - 完整流程
   */
  async fetchAndTestSources(testSong = "周杰伦") {
    console.log("[SourceManager] === Starting smart source discovery ===");

    // 1. Agent 搜索音源
    const discovered = await this.discoverSourcesViaAgent(testSong);

    if (discovered.length === 0) {
      console.log("[SourceManager] Agent found no sources");
      return [];
    }

    // 2. 后端测试每个源
    console.log(
      "[SourceManager] Testing",
      discovered.length,
      "discovered sources...",
    );
    const testedResults = [];

    for (const source of discovered) {
      const result = await this.testSource(source, testSong);
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
        "- error:",
        result.error || "none",
      );
      testedResults.push(result);
    }

    // 3. 过滤：必须成功 + 非试听 + 有结果
    const validSources = testedResults.filter(
      (r) => r.success && r.hasFullSong === true && r.resultCount > 0,
    );

    console.log(
      "[SourceManager] Valid sources after testing:",
      validSources.length,
      "/",
      testedResults.length,
    );

    // 4. 排序：按 maxDuration 降序，然后按 latency 升序
    validSources.sort((a, b) => {
      if (a.maxDuration !== b.maxDuration) {
        return b.maxDuration - a.maxDuration;
      }
      return a.latency - b.latency;
    });

    // 5. 返回前6个
    const top6 = validSources.slice(0, 6);

    // 6. 保存候选列表
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

  // ============ 辅助方法 ============

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
