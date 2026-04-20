import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import https from "https";

const DEFAULT_PROVIDER = "netease";
const DEFAULT_TEST_SONG = "周杰伦";
const RESULT_FILE =
  process.env.SOURCE_RESULT_FILE ||
  path.join(os.tmpdir(), "web-audio-streamer-source-progress.json");
const CONFIG_FILE =
  process.env.SOURCE_CONFIG_PATH ||
  path.join(os.homedir(), ".openclaw", "web-audio-streamer", "source-config.json");
const MAX_TIMEOUT = 30 * 60 * 1000;
const POLL_INTERVAL = 2 * 60 * 1000;
const NXVAV_TOKEN = "nxvav";

const BUILTIN_SOURCE_CANDIDATES = [
  {
    name: "Qijieya Meting",
    searchUrl: "https://api.qijieya.cn/meting/",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Injahow Meting",
    searchUrl: "https://api.injahow.cn/meting/",
    requestStyle: "type-only",
    needsAuth: false,
  },
  {
    name: "BugPk Music",
    searchUrl: "https://api.bugpk.com/api/music",
    requestStyle: "media",
    needsAuth: false,
  },
  {
    name: "Nuoxian Music API",
    searchUrl: "https://api.nxvav.cn/api/music/",
    requestStyle: "server",
    needsAuth: true,
  },
  {
    name: "Randall Meting",
    searchUrl: "https://musicapi.randallanjie.com/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Xiaoguan Meting",
    searchUrl: "https://met.api.xiaoguan.fit/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Fengzhe Meting",
    searchUrl: "https://api.fengzhe.site/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Fluolab Meting",
    searchUrl: "https://metingapi.fluolab.cn/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Meting Lac",
    searchUrl: "https://metingapi-lac.vercel.app/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Meting Bay Nine",
    searchUrl: "https://meting-api-bay-nine.vercel.app/api",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Suen Music API",
    searchUrl: "https://suen-music-api.leanapp.cn/",
    requestStyle: "server",
    needsAuth: false,
  },
  {
    name: "Leonus Meting",
    searchUrl: "https://music.leonus.cn/",
    requestStyle: "server",
    needsAuth: false,
  },
];

const REQUEST_STYLES = ["server", "media", "type-only", "q", "keyword"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hmacAuth(provider, type, id) {
  return crypto
    .createHmac("sha1", NXVAV_TOKEN)
    .update(`${provider}${type}${id}`)
    .digest("hex");
}

export class HermesSourceApi {
  constructor(options = {}) {
    this.maxTimeout = options.maxTimeout || MAX_TIMEOUT;
    this.pollInterval = options.pollInterval || POLL_INTERVAL;
    this.resultFile = options.resultFile || RESULT_FILE;
    this.configFile = options.configFile || CONFIG_FILE;
    this.tasks = new Map();
    this.currentTaskId = null;
    this._loadPersistedProgress();
  }

  createTask(testSong = DEFAULT_TEST_SONG) {
    const taskId = `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id: taskId,
      status: "pending",
      message: "任务已创建",
      progress: 0,
      sources: [],
      provider: null,
      testSong,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      pid: null,
      error: null,
      result: null,
      cancelled: false,
    };
    this.tasks.set(taskId, task);
    return taskId;
  }

  async startFetch(testSong = DEFAULT_TEST_SONG) {
    const taskId = this.createTask(testSong);
    const task = await this.startTask(taskId);
    return {
      success: true,
      taskId,
      provider: task.provider,
      pollIntervalMs: this.pollInterval,
      timeoutMs: this.maxTimeout,
      message: "音源获取任务已启动，请按 2 分钟一次轮询，最多等待 30 分钟",
    };
  }

  async startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    if (task.status === "running") {
      return this.getTaskStatus(taskId);
    }

    this.currentTaskId = taskId;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this._updateTask(task, {
      message: "正在检测本地 Hermes / OpenClaw ...",
      progress: 2,
    });

    this._executeTask(task).catch((error) => {
      if (task.cancelled) {
        return;
      }

      this._updateTask(task, {
        status: "error",
        progress: 100,
        error: error.message,
        message: `音源获取失败: ${error.message}`,
        finishedAt: new Date().toISOString(),
      });
    });

    return this.getTaskStatus(taskId);
  }

  getTaskStatus(taskId) {
    const task = this.tasks.get(taskId);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }

  checkProgress() {
    if (this.currentTaskId && this.tasks.has(this.currentTaskId)) {
      return this.getTaskStatus(this.currentTaskId);
    }

    if (fs.existsSync(this.resultFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.resultFile, "utf-8"));
      } catch (error) {
        return {
          status: "error",
          message: `读取进度失败: ${error.message}`,
          progress: 0,
          sources: [],
        };
      }
    }

    return {
      status: "not_started",
      message: "任务未启动",
      progress: 0,
      sources: [],
    };
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    task.cancelled = true;
    if (task.child && !task.child.killed) {
      task.child.kill();
    }

    this._updateTask(task, {
      status: "cancelled",
      message: "任务已取消",
      progress: 100,
      finishedAt: new Date().toISOString(),
    });

    return this.getTaskStatus(taskId);
  }

  getConfigPath() {
    return this.configFile;
  }

  readConfig() {
    if (!fs.existsSync(this.configFile)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(this.configFile, "utf-8"));
  }

  saveConfig(config) {
    const dir = path.dirname(this.configFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    return config;
  }

  async _executeTask(task) {
    const agent = await this._detectAvailableAgent();
    this._updateTask(task, {
      provider: agent.name,
      message: `已检测到本地 ${agent.name}，开始搜索可用音源 API...`,
      progress: 8,
    });

    const discovered = await this._discoverSourceCandidates(agent, task.testSong);
    if (task.cancelled) {
      return;
    }

    this._updateTask(task, {
      message: `已拿到 ${discovered.length} 个候选地址，开始验证兼容性与音质...`,
      progress: 28,
    });

    const ranked = await this._validateAndRankSources(discovered, task.testSong, task);
    const rankedUrls = new Set(ranked.map((item) => item.searchUrl));
    const fallbackCandidates = discovered
      .filter((item) => !rankedUrls.has(item.searchUrl))
      .map((item) => ({
        name: item.name,
        searchUrl: item.searchUrl,
        requestStyle: item.requestStyle || "server",
        needsAuth: Boolean(item.needsAuth),
        repo: item.repo || "AI 搜索候选",
        description: item.notes || "候选音源，待手动验证",
        aiScore: 20,
        verifiedAt: null,
        sampleSong: null,
      }));

    const topSources = [...ranked, ...fallbackCandidates].slice(0, 10).map((source, index) => ({
      ...source,
      id: `source_${String(index + 1).padStart(3, "0")}`,
      selected: false,
    }));

    if (!topSources.length) {
      throw new Error("没有找到可用于搜索和播放的音源");
    }

    this._updateTask(task, {
      status: "success",
      progress: 100,
      message: `音源获取完成，已写入 ${topSources.length} 个候选音源（优先已验证可用项）`,
      finishedAt: new Date().toISOString(),
      sources: topSources,
      result: {
        provider: agent.name,
        total: topSources.length,
        sources: topSources,
      },
    });
  }

  async _detectAvailableAgent() {
    const candidates = [
      { name: "Hermes", executable: "hermes", kind: "hermes" },
      { name: "OpenClaw", executable: "openclaw", kind: "openclaw" },
    ];

    for (const candidate of candidates) {
      const resolved = await this._resolveExecutable(candidate.executable);
      if (resolved) {
        return { ...candidate, ...resolved };
      }
    }

    throw new Error("本地未检测到可用的 Hermes 或 OpenClaw CLI");
  }

  async _resolveExecutable(command) {
    if (process.platform === "win32") {
      const npmBin = path.join(process.env.APPDATA || "", "npm");
      const windowsCandidates = [
        path.join(npmBin, `${command}.cmd`),
        path.join(npmBin, `${command}.ps1`),
        path.join(npmBin, `${command}.exe`),
      ];

      for (const file of windowsCandidates) {
        if (file && fs.existsSync(file)) {
          return this._buildLaunchSpec(file);
        }
      }
    }

    const direct = await this._which(command);
    if (direct) {
      return this._buildLaunchSpec(direct);
    }

    return null;
  }

  _buildLaunchSpec(resolvedPath) {
    const lower = resolvedPath.toLowerCase();
    if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
      return {
        resolvedPath,
        launchCommand: "cmd.exe",
        launchArgsPrefix: ["/d", "/s", "/c", resolvedPath],
      };
    }

    if (process.platform === "win32" && lower.endsWith(".ps1")) {
      return {
        resolvedPath,
        launchCommand: "powershell.exe",
        launchArgsPrefix: ["-ExecutionPolicy", "Bypass", "-File", resolvedPath],
      };
    }

    return {
      resolvedPath,
      launchCommand: resolvedPath,
      launchArgsPrefix: [],
    };
  }

  async _which(command) {
    return new Promise((resolve) => {
      const checker = spawn(process.platform === "win32" ? "where" : "which", [command], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      let output = "";
      checker.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      checker.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }

        const firstLine = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);
        resolve(firstLine || null);
      });
      checker.on("error", () => resolve(null));
    });
  }

  async _discoverSourceCandidates(agent, testSong) {
    const prompt = [
      "你是在线音乐 API 搜索助手。",
      "请联网搜索当前仍可访问、可用于'搜索歌曲 + 获取播放地址'的公开音乐 API / meting 风格接口。",
      "要求兼容中文歌曲搜索，优先返回可用于网易云/QQ/酷狗/酷我任一平台的接口。",
      "请重点寻找适合作为 Web Audio Streamer 音源的接口，而不是 GitHub 仓库页面。",
      `测试关键词: ${testSong}`,
      "返回格式必须是 JSON 数组，且只能输出 JSON，不要解释：",
      "[{\"name\":\"接口名称\",\"url\":\"https://example.com/api/music/\",\"notes\":\"一句短说明\"}]",
      "至少返回 12 个候选；url 必须是接口基础地址，不要附带查询参数。",
    ].join("\n");

    const responseText = await this._runAgentCommand(agent, prompt);
    const parsed = this._extractJsonPayload(responseText);
    const items = Array.isArray(parsed) ? parsed : [];

    const discovered = items
      .map((item) => ({
        name: String(item.name || item.title || "Unknown Source").trim(),
        searchUrl: this._normalizeBaseUrl(item.url || item.searchUrl || ""),
        notes: String(item.notes || item.reason || "").trim(),
      }))
      .filter((item) => item.searchUrl.startsWith("http"));

    return this._mergeCandidates(discovered, BUILTIN_SOURCE_CANDIDATES);
  }

  async _runAgentCommand(agent, prompt) {
    const args = [
      ...(agent.launchArgsPrefix || []),
      "agent",
      "--json",
      "--timeout",
      String(Math.ceil(this.maxTimeout / 1000)),
      "--to",
      "+10000000000",
      "--message",
      prompt,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(agent.launchCommand || agent.executable, args, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(stderr.trim() || `${agent.name} 退出码 ${code}`));
          return;
        }

        resolve(`${stdout}\n${stderr}`.trim());
      });

      child.on("error", reject);
    });
  }

  _extractJsonPayload(rawOutput) {
    const wrapper = this._extractLastJsonValue(rawOutput);
    if (wrapper && wrapper.payloads) {
      const text = wrapper.payloads
        .map((payload) => payload?.text || "")
        .join("\n")
        .trim();
      const payloadJson = this._extractLastJsonValue(text);
      if (payloadJson) {
        return payloadJson;
      }
    }

    const direct = this._extractLastJsonValue(rawOutput);
    if (direct) {
      return direct;
    }

    throw new Error("无法解析本地代理返回的 JSON 结果");
  }

  _extractLastJsonValue(text) {
    const cleaned = text.replace(/```json|```/gi, "").trim();
    for (let i = cleaned.length - 1; i >= 0; i -= 1) {
      if (cleaned[i] !== "}" && cleaned[i] !== "]") {
        continue;
      }

      for (let start = i; start >= 0; start -= 1) {
        if (cleaned[start] !== "{" && cleaned[start] !== "[") {
          continue;
        }

        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  _mergeCandidates(primary, fallback) {
    const seen = new Set();
    const merged = [];

    for (const source of [...primary, ...fallback]) {
      const normalizedUrl = this._normalizeBaseUrl(source.searchUrl || source.url || "");
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        continue;
      }

      seen.add(normalizedUrl);
      merged.push({
        name: source.name || normalizedUrl,
        searchUrl: normalizedUrl,
        requestStyle: source.requestStyle || null,
        needsAuth: Boolean(source.needsAuth),
        notes: source.notes || "",
      });
    }

    return merged;
  }

  _normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\?+$/, "");
  }

  async _validateAndRankSources(candidates, testSong, task) {
    const results = [];
    const limit = Math.min(candidates.length, 20);

    for (let index = 0; index < limit; index += 1) {
      if (task.cancelled) {
        return [];
      }

      const candidate = candidates[index];
      const progress = 30 + Math.floor(((index + 1) / limit) * 60);
      this._updateTask(task, {
        progress,
        message: `正在验证第 ${index + 1}/${limit} 个候选音源: ${candidate.name}`,
      });

      const validated = await this._validateSource(candidate, testSong);
      if (validated) {
        results.push(validated);
      }
    }

    results.sort((a, b) => b.aiScore - a.aiScore);
    return results;
  }

  async _validateSource(candidate, testSong) {
    const styleCandidates = candidate.requestStyle
      ? [candidate.requestStyle]
      : REQUEST_STYLES;

    for (const requestStyle of styleCandidates) {
      const searchUrl = this._buildSearchUrl(candidate.searchUrl, requestStyle, testSong);

      try {
        const startedAt = Date.now();
        const payload = await this._fetchJson(searchUrl);
        const songs = this._extractSongs(payload);
        if (!songs.length) {
          continue;
        }

        const firstSong = songs[0];
        const playable = await this._resolvePlayableUrl(candidate.searchUrl, requestStyle, firstSong);
        if (!playable) {
          continue;
        }

        const latency = Date.now() - startedAt;
        const qualityScore = this._scoreCandidate({
          latency,
          resultCount: songs.length,
          hasDuration: Boolean(firstSong.duration || firstSong.time),
          hasCover: Boolean(firstSong.pic || firstSong.cover),
          needsAuth: playable.needsAuth,
        });

        return {
          name: candidate.name,
          searchUrl: candidate.searchUrl,
          requestStyle,
          needsAuth: playable.needsAuth,
          repo: candidate.repo || agentLabel(candidate.notes),
          description: candidate.notes || `${requestStyle} 风格接口`,
          aiScore: qualityScore,
          verifiedAt: new Date().toISOString(),
          sampleSong: firstSong.title || firstSong.name || testSong,
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  _buildSearchUrl(baseUrl, requestStyle, query, provider = DEFAULT_PROVIDER) {
    const encoded = encodeURIComponent(query);

    switch (requestStyle) {
      case "media":
        return `${baseUrl}?media=${provider}&type=search&id=${encoded}`;
      case "type-only":
        return `${baseUrl}?type=search&id=${encoded}`;
      case "q":
        return `${baseUrl}?q=${encoded}`;
      case "keyword":
        return `${baseUrl}?keyword=${encoded}`;
      case "server":
      default:
        return `${baseUrl}?server=${provider}&type=search&id=${encoded}`;
    }
  }

  _extractSongs(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (Array.isArray(payload?.data)) {
      return payload.data;
    }

    if (Array.isArray(payload?.result)) {
      return payload.result;
    }

    if (Array.isArray(payload?.songs)) {
      return payload.songs;
    }

    if (Array.isArray(payload?.data?.songs)) {
      return payload.data.songs;
    }

    return [];
  }

  async _resolvePlayableUrl(baseUrl, requestStyle, song) {
    if (song?.url && /^https?:/i.test(song.url)) {
      return { url: song.url, needsAuth: false };
    }

    const songId = song?.id;
    if (!songId) {
      return null;
    }

    const provider = DEFAULT_PROVIDER;
    const attempts = [];

    if (requestStyle === "server") {
      attempts.push({
        url: `${baseUrl}?server=${provider}&type=url&id=${songId}`,
        needsAuth: false,
      });
      attempts.push({
        url: `${baseUrl}?server=${provider}&type=url&id=${songId}&auth=${hmacAuth(provider, "url", songId)}`,
        needsAuth: true,
      });
    } else if (requestStyle === "media") {
      attempts.push({
        url: `${baseUrl}?media=${provider}&type=url&id=${songId}`,
        needsAuth: false,
      });
    } else if (requestStyle === "type-only") {
      attempts.push({
        url: `${baseUrl}?type=url&id=${songId}`,
        needsAuth: false,
      });
    }

    for (const attempt of attempts) {
      try {
        const redirected = await this._followRedirect(attempt.url);
        if (redirected) {
          return { url: redirected, needsAuth: attempt.needsAuth };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  _scoreCandidate({ latency, resultCount, hasDuration, hasCover, needsAuth }) {
    let score = 40;

    score += Math.min(resultCount, 20);
    if (latency < 1500) {
      score += 20;
    } else if (latency < 4000) {
      score += 10;
    }
    if (hasDuration) {
      score += 8;
    }
    if (hasCover) {
      score += 6;
    }
    if (!needsAuth) {
      score += 4;
    }

    return Math.max(1, Math.min(100, score));
  }

  async _fetchJson(url) {
    const response = await this._request(url);
    try {
      return JSON.parse(response.body);
    } catch {
      throw new Error(`接口没有返回 JSON: ${url}`);
    }
  }

  async _followRedirect(url, maxRedirects = 5) {
    const response = await this._request(url, maxRedirects, false);

    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      const nextUrl = response.headers.location.startsWith("http")
        ? response.headers.location
        : new URL(response.headers.location, url).href;
      return this._followRedirect(nextUrl, maxRedirects - 1);
    }

    if (response.statusCode !== 200) {
      return null;
    }

    const contentType = String(response.headers["content-type"] || "");
    if (contentType.includes("application/json")) {
      try {
        const payload = JSON.parse(response.body);
        if (typeof payload === "string" && /^https?:/i.test(payload)) {
          return payload;
        }
        if (payload?.url && /^https?:/i.test(payload.url)) {
          return payload.url;
        }
      } catch {
        return null;
      }
    }

    return url;
  }

  _request(url, maxRedirects = 5, parseJson = true) {
    return new Promise((resolve, reject) => {
      if (maxRedirects < 0) {
        reject(new Error("重定向次数过多"));
        return;
      }

      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            Accept: "*/*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 15000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body,
              json:
                parseJson && body
                  ? (() => {
                      try {
                        return JSON.parse(body);
                      } catch {
                        return null;
                      }
                    })()
                  : null,
            });
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("请求超时"));
      });
    });
  }

  _updateTask(task, patch) {
    Object.assign(task, patch, {
      updatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });

    this.tasks.set(task.id, task);
    this._persistProgress(task);
  }

  _persistProgress(task) {
    try {
      fs.writeFileSync(this.resultFile, JSON.stringify(task, null, 2));
    } catch (error) {
      console.error("[HermesSourceApi] Failed to persist progress:", error.message);
    }
  }

  _loadPersistedProgress() {
    if (!fs.existsSync(this.resultFile)) {
      return;
    }

    try {
      const task = JSON.parse(fs.readFileSync(this.resultFile, "utf-8"));
      if (task?.id) {
        this.tasks.set(task.id, task);
        this.currentTaskId = task.id;
      }
    } catch {
      // ignore invalid persisted files
    }
  }
}

function agentLabel(notes) {
  return notes ? "AI 搜索结果" : "自动验证";
}
