import { execSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";

const DEFAULT_PROVIDER = "netease";
const DEFAULT_TEST_SONG = "周杰伦";
const SOURCE_RESULT_FILE =
  process.env.SOURCE_RESULT_FILE ||
  path.join(os.tmpdir(), "web-audio-streamer-source-progress.json");
const SOURCE_CONFIG_FILE =
  process.env.SOURCE_CONFIG_PATH ||
  path.join(os.homedir(), ".openclaw", "web-audio-streamer", "source-config.json");
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const VALIDATED_TARGET = 10;
const DISCOVERY_TARGET = 40;
const MAX_DISCOVERY_ROUNDS = 2;
const MIN_FULL_DURATION_SEC = 90;
const NXVAV_TOKEN = "nxvav";

const TEST_QUERIES = ["周杰伦", "林俊杰"];

const BUILTIN_SOURCE_CANDIDATES = [
  {
    name: "Qijieya Meting",
    searchUrl: "https://api.qijieya.cn/meting/",
    requestStyle: "server",
    needsAuth: false,
    notes: "已知可用公开实例",
  },
  {
    name: "Nuoxian Music API",
    searchUrl: "https://api.nxvav.cn/api/music/",
    requestStyle: "server",
    needsAuth: true,
    notes: "已知可用公开实例",
  },
  {
    name: "Randall Meting",
    searchUrl: "https://musicapi.randallanjie.com/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "已知可用公开实例",
  },
  {
    name: "Xiaoguan Meting",
    searchUrl: "https://met.api.xiaoguan.fit/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "有文档页的公开实例",
  },
  {
    name: "Fengzhe Meting",
    searchUrl: "https://api.fengzhe.site/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "已知可用公开实例",
  },
  {
    name: "Fluolab Meting",
    searchUrl: "https://metingapi.fluolab.cn/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "有运行页的公开实例",
  },
  {
    name: "Meting Lac",
    searchUrl: "https://metingapi-lac.vercel.app/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "已知可用公开实例",
  },
  {
    name: "Meting Bay Nine",
    searchUrl: "https://meting-api-bay-nine.vercel.app/api",
    requestStyle: "server",
    needsAuth: false,
    notes: "已知可用公开实例",
  },
  {
    name: "Injahow Meting",
    searchUrl: "https://api.injahow.cn/meting/",
    requestStyle: "type-only",
    needsAuth: false,
    notes: "常见 meting 实例",
  },
  {
    name: "BugPk Music",
    searchUrl: "https://api.bugpk.com/api/music",
    requestStyle: "media",
    needsAuth: false,
    notes: "常见 music 实例",
  },
  {
    name: "Suen Music API",
    searchUrl: "https://suen-music-api.leanapp.cn/",
    requestStyle: "server",
    needsAuth: false,
    notes: "常见 music 实例",
  },
  {
    name: "Leonus Meting",
    searchUrl: "https://music.leonus.cn/",
    requestStyle: "server",
    needsAuth: false,
    notes: "公开实例候选",
  },
  {
    name: "Mo App Meting",
    searchUrl: "https://metingapi.mo-app.cn/",
    requestStyle: "server-keyword",
    needsAuth: false,
    notes: "支持 search+keyword 的公开实例",
  },
  {
    name: "NanoRocky Meting",
    searchUrl: "https://metingapi.nanorocky.top/",
    requestStyle: "server-keyword",
    needsAuth: false,
    notes: "支持 search+keyword 的公开实例",
  },
];

const REQUEST_STYLES = ["server", "server-keyword", "media", "type-only", "q", "keyword"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAuth(provider, type, id) {
  return crypto
    .createHmac("sha1", NXVAV_TOKEN)
    .update(`${provider}${type}${id}`)
    .digest("hex");
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class HermesSourceApi {
  constructor(options = {}) {
    this.maxTimeout = options.maxTimeout || MAX_TIMEOUT_MS;
    this.pollInterval = options.pollInterval || POLL_INTERVAL_MS;
    this.resultFile = options.resultFile || SOURCE_RESULT_FILE;
    this.configFile = options.configFile || SOURCE_CONFIG_FILE;
    this.tasks = new Map();
    this.currentTaskId = null;
    this._loadPersistedProgress();
  }

  createTask(testSong = DEFAULT_TEST_SONG, agentName = null) {
    const taskId = `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id: taskId,
      status: "pending",
      message: "任务已创建",
      progress: 0,
      sources: [],
      provider: agentName,
      testSong,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      cancelled: false,
      attempts: 0,
    };

    this.tasks.set(taskId, task);
    return taskId;
  }

  async startFetch(testSong = DEFAULT_TEST_SONG) {
    const agent = await this._detectAvailableAgent();
    const taskId = this.createTask(testSong, agent.name);
    const task = await this.startTask(taskId, agent);

    return {
      success: true,
      taskId,
      provider: task.provider,
      pollIntervalMs: this.pollInterval,
      timeoutMs: this.maxTimeout,
      message: "音源获取任务已启动，请每 2 分钟轮询一次，最长等待 30 分钟",
    };
  }

  async startTask(taskId, detectedAgent = null) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    if (task.status === "running") {
      return this.getTaskStatus(taskId);
    }

    const agent = detectedAgent || (await this._detectAvailableAgent());
    this.currentTaskId = taskId;
    task.status = "running";
    task.provider = agent.name;
    task.startedAt = new Date().toISOString();

    this._updateTask(task, {
      message: `已检测到本地 ${agent.name}，开始联网搜索最新音源`,
      progress: 3,
    });

    this._executeTask(task, agent).catch((error) => {
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

    if (!fs.existsSync(this.resultFile)) {
      return {
        status: "not_started",
        message: "任务未启动",
        progress: 0,
        sources: [],
      };
    }

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

  async _executeTask(task, agent) {
    const discoveredCandidates = [];
    const validatedSources = [];
    const validatedUrls = new Set();
    const discoveredUrls = new Set();

    for (let round = 1; round <= MAX_DISCOVERY_ROUNDS; round += 1) {
      if (task.cancelled) {
        return;
      }

      task.attempts = round;
      const roundProgress = 5 + (round - 1) * 8;
      this._updateTask(task, {
        progress: roundProgress,
        message:
          round === 1
            ? `正在让 ${agent.name} 搜索最近仍可用的公开音源实例`
            : `可用音源不足 10 个，正在让 ${agent.name} 继续补充新实例`,
      });

      const newlyDiscovered = await this._discoverSourceCandidates(
        agent,
        task.testSong,
        [...discoveredUrls],
        DISCOVERY_TARGET,
      );

      for (const candidate of newlyDiscovered) {
        if (discoveredUrls.has(candidate.searchUrl)) {
          continue;
        }

        discoveredUrls.add(candidate.searchUrl);
        discoveredCandidates.push(candidate);
      }

      this._updateTask(task, {
        progress: roundProgress + 5,
        message: `已汇总 ${discoveredCandidates.length} 个候选，开始逐个验证搜索与播放能力`,
      });

      const ranked = await this._validateAndRankSources(
        discoveredCandidates,
        task,
        validatedUrls,
        validatedSources.length,
      );

      for (const source of ranked) {
        if (!validatedUrls.has(source.searchUrl)) {
          validatedUrls.add(source.searchUrl);
          validatedSources.push(source);
        }
      }

      if (validatedSources.length >= VALIDATED_TARGET) {
        break;
      }
    }

    const topSources = validatedSources
      .sort((a, b) => b.aiScore - a.aiScore)
      .slice(0, VALIDATED_TARGET)
      .map((source, index) => ({
        ...source,
        id: `source_${String(index + 1).padStart(3, "0")}`,
        selected: false,
      }));

    if (topSources.length < VALIDATED_TARGET) {
      throw new Error(
        `只验证到 ${topSources.length} 个可直接搜索和播放的音源，未达到 10 个要求`,
      );
    }

    this._updateTask(task, {
      status: "success",
      progress: 100,
      message: `音源获取完成，已保存 10 个已验证可直接搜索和播放的音源`,
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
      { name: "Hermes", executable: "hermes" },
      { name: "OpenClaw", executable: "openclaw" },
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

    const directPath = await this._which(command);
    if (directPath) {
      return this._buildLaunchSpec(directPath);
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

  async _discoverSourceCandidates(agent, testSong, excludedUrls = [], desiredCount = DISCOVERY_TARGET) {
    const prompt = this._buildDiscoveryPrompt(testSong, excludedUrls, desiredCount);
    const responseText = await this._runAgentCommand(agent, prompt);
    const parsed = this._extractJsonPayload(responseText);
    const items = Array.isArray(parsed) ? parsed : [];

    const normalized = items
      .map((item) => ({
        name: String(item.name || item.title || "Unknown Source").trim(),
        searchUrl: this._normalizeBaseUrl(item.url || item.searchUrl || ""),
        requestStyle: this._normalizeRequestStyle(item.requestStyle),
        needsAuth: Boolean(item.needsAuth),
        notes: String(item.reason || item.notes || "").trim(),
      }))
      .filter((item) => item.searchUrl.startsWith("http"));

    return this._mergeCandidates(normalized, BUILTIN_SOURCE_CANDIDATES, excludedUrls);
  }

  _buildDiscoveryPrompt(testSong, excludedUrls, desiredCount) {
    const excludedBlock = excludedUrls.length
      ? `\n排除这些已经试过的地址，不要再次返回：\n${excludedUrls.join("\n")}`
      : "";

    return [
      "你是 Web Audio Streamer 的在线音乐音源搜索代理。",
      "目标：联网搜索并整理“当前仍可访问、可直接用于搜索歌曲并返回可播放链接”的公开音乐 API / Meting 实例。",
      "必须优先寻找最近仍在运行、最近有文档页/测试页/运行页/真实实例页面可访问的来源。",
      "必须排除：GitHub 仓库页、教程文章里没有真实 API 地址的内容、明显 403/404/5xx 或无法跨公网访问的地址。",
      "请重点寻找以下类型的真实公开实例：",
      "1. 运行页里直接给出 api 地址的 Meting 实例",
      "2. 文档页里直接给出 /api 或 /meting 路径的音乐 API 实例",
      "3. 可用于 server=netease&type=search&id=关键词 的公开接口",
      `测试关键词：${testSong}`,
      "返回至少 40 个候选，按你判断的可用性从高到低排序。",
      "每一项必须输出这些字段：",
      'name: 实例名称',
      'url: 可直接调用的基础地址，例如 https://example.com/api',
      'requestStyle: 只能是 "server"、"server-keyword"、"media"、"type-only"、"q"、"keyword" 之一',
      'needsAuth: true 或 false',
      'reason: 一句简短说明，说明你为什么认为它是最近仍可用且适合作为音源',
      "只输出 JSON 数组，不要输出解释，不要输出 Markdown 代码块。",
      excludedBlock,
      `如果你找不到 ${desiredCount} 个高置信候选，也要尽量返回你能确认的全部真实实例。`,
    ].join("\n");
  }

  _normalizeRequestStyle(value) {
    return REQUEST_STYLES.includes(value) ? value : null;
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
      const combinedText = wrapper.payloads
        .map((payload) => payload?.text || "")
        .join("\n")
        .trim();
      const payloadJson = this._extractLastJsonValue(combinedText);
      if (payloadJson) {
        return payloadJson;
      }
    }

    const directJson = this._extractLastJsonValue(rawOutput);
    if (directJson) {
      return directJson;
    }

    throw new Error("无法解析本地代理返回的 JSON 结果");
  }

  _extractLastJsonValue(text) {
    const cleaned = text.replace(/```json|```/gi, "").trim();
    for (let end = cleaned.length - 1; end >= 0; end -= 1) {
      if (cleaned[end] !== "}" && cleaned[end] !== "]") {
        continue;
      }

      for (let start = end; start >= 0; start -= 1) {
        if (cleaned[start] !== "{" && cleaned[start] !== "[") {
          continue;
        }

        const candidate = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  _mergeCandidates(primary, fallback, excludedUrls = []) {
    const excludedSet = new Set(excludedUrls.map((item) => this._normalizeBaseUrl(item)));
    const seen = new Set();
    const merged = [];

    for (const source of [...primary, ...fallback]) {
      const normalizedUrl = this._normalizeBaseUrl(source.searchUrl || source.url || "");
      if (!normalizedUrl || seen.has(normalizedUrl) || excludedSet.has(normalizedUrl)) {
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

  async _validateAndRankSources(candidates, task, alreadyValidatedUrls = new Set(), existingCount = 0) {
    const results = [];

    for (let index = 0; index < candidates.length; index += 1) {
      if (task.cancelled) {
        return results;
      }

      const candidate = candidates[index];
      if (alreadyValidatedUrls.has(candidate.searchUrl)) {
        continue;
      }

      const progress = 15 + Math.floor(((index + 1) / Math.max(candidates.length, 1)) * 80);
      this._updateTask(task, {
        progress,
        message: `正在验证音源 ${index + 1}/${candidates.length}: ${candidate.name}`,
      });

      const validated = await this._validateSource(candidate);
      if (validated) {
        results.push(validated);
        if (existingCount + results.length >= VALIDATED_TARGET) {
          break;
        }
      }
    }

    return results.sort((a, b) => b.aiScore - a.aiScore);
  }

  async _validateSource(candidate) {
    const styleCandidates = candidate.requestStyle
      ? [candidate.requestStyle]
      : REQUEST_STYLES;

    for (const requestStyle of styleCandidates) {
      const validation = await this._validateSourceWithStyle(candidate, requestStyle);
      if (validation) {
        return validation;
      }
    }

    return null;
  }

  async _validateSourceWithStyle(candidate, requestStyle) {
    const queryResults = [];
    let bestPlayable = null;
    let totalLatency = 0;

    for (const query of TEST_QUERIES) {
      const searchUrl = this._buildSearchUrl(candidate.searchUrl, requestStyle, query);

      try {
        const startedAt = Date.now();
        const payload = await this._fetchJson(searchUrl);
        const songs = this._extractSongs(payload);
        totalLatency += Date.now() - startedAt;
        if (!songs.length) {
          continue;
        }

        const playableSong = await this._findPlayableSong(candidate.searchUrl, requestStyle, songs);
        if (!playableSong) {
          continue;
        }

        queryResults.push({
          query,
          songs,
          playableSong,
        });

        if (!bestPlayable || playableSong.durationSec > bestPlayable.durationSec) {
          bestPlayable = playableSong;
        }
      } catch {
        continue;
      }
    }

    if (!queryResults.length || !bestPlayable) {
      return null;
    }

    const averageLatency = Math.round(totalLatency / queryResults.length);
    const averageResults = Math.round(
      queryResults.reduce((sum, item) => sum + item.songs.length, 0) / queryResults.length,
    );
    const averageDuration = Math.round(
      queryResults.reduce((sum, item) => sum + item.playableSong.durationSec, 0) / queryResults.length,
    );

    return {
      name: candidate.name,
      searchUrl: candidate.searchUrl,
      requestStyle,
      needsAuth: bestPlayable.needsAuth,
      repo: candidate.notes ? "AI 实时搜索" : "内置候选",
      description: candidate.notes || `${requestStyle} 风格接口`,
      aiScore: this._scoreCandidate({
        averageLatency,
        averageResults,
        averageDuration,
        queryCount: queryResults.length,
      }),
      verifiedAt: new Date().toISOString(),
      sampleSong: bestPlayable.title,
      sampleArtist: bestPlayable.artist,
      sampleDurationSec: bestPlayable.durationSec,
      samplePlayUrl: bestPlayable.playUrl,
      queryCount: queryResults.length,
    };
  }

  async _findPlayableSong(baseUrl, requestStyle, songs) {
    const songCandidates = songs.slice(0, 8);

    for (const song of songCandidates) {
      const playable = await this._resolvePlayableUrl(baseUrl, requestStyle, song);
      if (!playable) {
        continue;
      }

      const durationSec =
        this._extractDurationSec(song) ||
        this._probeDuration(playable.url);

      if (!durationSec || durationSec < MIN_FULL_DURATION_SEC) {
        continue;
      }

      return {
        title: song.title || song.name || "未知歌曲",
        artist: song.author || song.artist || "未知歌手",
        durationSec,
        playUrl: playable.url,
        needsAuth: playable.needsAuth,
      };
    }

    return null;
  }

  _extractDurationSec(song) {
    const rawDuration = song?.duration ?? song?.time ?? null;
    const numericDuration = toNumber(rawDuration);
    if (!numericDuration) {
      return null;
    }

    if (numericDuration > 10000) {
      return numericDuration / 1000;
    }

    return numericDuration;
  }

  _scoreCandidate({ averageLatency, averageResults, averageDuration, queryCount }) {
    let score = 45;

    if (queryCount >= 2) {
      score += 15;
    } else if (queryCount === 1) {
      score += 5;
    }

    score += Math.min(averageResults, 20);

    if (averageLatency < 1500) {
      score += 15;
    } else if (averageLatency < 3000) {
      score += 8;
    }

    if (averageDuration >= 240) {
      score += 12;
    } else if (averageDuration >= 180) {
      score += 8;
    } else if (averageDuration >= 120) {
      score += 4;
    }

    return Math.max(1, Math.min(100, score));
  }

  _buildSearchUrl(baseUrl, requestStyle, query, provider = DEFAULT_PROVIDER) {
    const encodedQuery = encodeURIComponent(query);

    switch (requestStyle) {
      case "server-keyword":
        return `${baseUrl}?server=${provider}&type=search&id=0&keyword=${encodedQuery}`;
      case "media":
        return `${baseUrl}?media=${provider}&type=search&id=${encodedQuery}`;
      case "type-only":
        return `${baseUrl}?type=search&id=${encodedQuery}`;
      case "q":
        return `${baseUrl}?q=${encodedQuery}`;
      case "keyword":
        return `${baseUrl}?keyword=${encodedQuery}`;
      case "server":
      default:
        return `${baseUrl}?server=${provider}&type=search&id=${encodedQuery}`;
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
      const directUrl = await this._followRedirect(song.url);
      if (directUrl) {
        return {
          url: directUrl,
          needsAuth: false,
        };
      }
    }

    const songId = song?.id;
    if (!songId) {
      return null;
    }

    const attempts = [];

    if (requestStyle === "server" || requestStyle === "server-keyword") {
      attempts.push({
        url: `${baseUrl}?server=${DEFAULT_PROVIDER}&type=url&id=${songId}`,
        needsAuth: false,
      });
      attempts.push({
        url: `${baseUrl}?server=${DEFAULT_PROVIDER}&type=url&id=${songId}&auth=${createAuth(DEFAULT_PROVIDER, "url", songId)}`,
        needsAuth: true,
      });
    } else if (requestStyle === "media") {
      attempts.push({
        url: `${baseUrl}?media=${DEFAULT_PROVIDER}&type=url&id=${songId}`,
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
        const playableUrl = await this._followRedirect(attempt.url);
        if (playableUrl) {
          return {
            url: playableUrl,
            needsAuth: attempt.needsAuth,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
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
        return null;
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

      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;

      const request = transport.get(
        url,
        {
          headers: {
            Accept: "*/*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 15000,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk.toString();
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode || 0,
              headers: response.headers,
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

      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(new Error("请求超时"));
      });
    });
  }

  _probeDuration(url) {
    try {
      const output = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`,
        { timeout: 10000, encoding: "utf-8", shell: true },
      ).trim();
      const value = Number.parseFloat(output);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      return null;
    }

    return null;
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
      // ignore invalid result file
    }
  }
}
