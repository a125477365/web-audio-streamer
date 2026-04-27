import { execSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";

const DEFAULT_PROVIDER = "netease";
const DEFAULT_TEST_SONG = "Jay Chou";
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
const CONFIG_VERSION = 12;
const NXVAV_TOKEN = "nxvav";
const TEST_QUERIES = ["周杰伦", "林俊杰"];
const REQUEST_STYLES = ["server", "server-keyword", "media", "type-only", "q", "keyword"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createAuth(provider, type, id) {
  return crypto
    .createHmac("sha1", NXVAV_TOKEN)
    .update(`${provider}${type}${id}`)
    .digest("hex");
}

function parseShellWords(command) {
  const matches = String(command || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"(.*)"$/, "$1"));
}

function normalizeDependencyStatus(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      name: String(item?.name || item?.dependency || "").trim(),
      status: String(item?.status || "").trim() || "unknown",
      details: String(item?.details || item?.message || "").trim(),
    }))
    .filter((item) => item.name);
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
      message: "Task created",
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
      manualActionRequired: false,
      manualActionMessage: "",
      dependencyStatus: [],
      configVersion: CONFIG_VERSION,
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
      message: "Source discovery started. Poll every 2 minutes for up to 30 minutes.",
    };
  }

  async startTask(taskId, detectedAgent = null) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
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
      message: `Detected local ${agent.name}. Starting realtime source discovery.`,
      progress: 3,
      agentLaunch: {
        name: agent.name,
        resolvedPath: agent.resolvedPath || null,
        mode: agent.mode || "native",
      },
    });

    this._executeTask(task, agent).catch((error) => {
      if (task.cancelled) {
        return;
      }

      this._updateTask(task, {
        status: "error",
        progress: 100,
        error: error.message,
        message: error.message,
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
        message: "Task not started",
        progress: 0,
        sources: [],
        manualActionRequired: false,
        manualActionMessage: "",
      };
    }

    try {
      return JSON.parse(fs.readFileSync(this.resultFile, "utf-8"));
    } catch (error) {
      return {
        status: "error",
        message: `Failed to read progress: ${error.message}`,
        progress: 0,
        sources: [],
        manualActionRequired: false,
        manualActionMessage: "",
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
      message: "Task cancelled",
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
    const discoveredUrls = new Set();
    const validatedSources = [];
    const validatedUrls = new Set();
    let latestManualActionRequired = false;
    let latestManualActionMessage = "";
    let latestDependencyStatus = [];

    for (let round = 1; round <= MAX_DISCOVERY_ROUNDS; round += 1) {
      if (task.cancelled) {
        return;
      }

      task.attempts = round;
      this._updateTask(task, {
        progress: 5 + (round - 1) * 8,
        message:
          round === 1
            ? `Asking ${agent.name} to discover live music sources.`
            : `Validated sources are still below 10. Asking ${agent.name} for more live sources.`,
      });

      const discovery = await this._discoverSourceCandidates(
        agent,
        task.testSong,
        [...discoveredUrls],
        DISCOVERY_TARGET,
      );

      latestManualActionRequired = latestManualActionRequired || Boolean(discovery.manualActionRequired);
      latestManualActionMessage = discovery.manualActionMessage || latestManualActionMessage;
      latestDependencyStatus = discovery.dependencyStatus.length
        ? discovery.dependencyStatus
        : latestDependencyStatus;

      this._updateTask(task, {
        manualActionRequired: latestManualActionRequired,
        manualActionMessage: latestManualActionMessage,
        dependencyStatus: latestDependencyStatus,
      });

      for (const candidate of discovery.candidates) {
        if (discoveredUrls.has(candidate.searchUrl)) {
          continue;
        }

        discoveredUrls.add(candidate.searchUrl);
        discoveredCandidates.push(candidate);
      }

      this._updateTask(task, {
        progress: 10 + (round - 1) * 8,
        message: `Discovered ${discoveredCandidates.length} live candidates. Validating search and playback now.`,
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
      const manualSuffix = latestManualActionRequired && latestManualActionMessage
        ? ` Manual action required: ${latestManualActionMessage}`
        : "";
      throw new Error(
        `Only validated ${topSources.length} directly usable sources out of the required 10.${manualSuffix}`,
      );
    }

    this._updateTask(task, {
      status: "success",
      progress: 100,
      message: "Source discovery finished. 10 validated sources are ready for user selection.",
      finishedAt: new Date().toISOString(),
      sources: topSources,
      manualActionRequired: latestManualActionRequired,
      manualActionMessage: latestManualActionMessage,
      dependencyStatus: latestDependencyStatus,
      result: {
        provider: agent.name,
        total: topSources.length,
        sources: topSources,
        configVersion: CONFIG_VERSION,
      },
    });
  }

  async _detectAvailableAgent() {
    const candidates = [
      { name: "Hermes", executable: "hermes" },
      { name: "OpenClaw", executable: process.platform === "win32" ? "openclaw.cmd" : "openclaw" },
    ];

    const results = await Promise.allSettled(
      candidates.map(async (c) => {
        const resolved = await this._resolveExecutable(c.executable);
        return resolved ? { ...c, ...resolved } : null;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        return result.value;
      }
    }

    throw new Error(
      "No local Hermes/OpenClaw runtime detected. Install Hermes or OpenClaw, or set HERMES_COMMAND / OPENCLAW_COMMAND, or configure a Docker image through HERMES_DOCKER_IMAGE / OPENCLAW_DOCKER_IMAGE.",
    );
  }

  async _resolveExecutable(command) {
    const upper = command.toUpperCase();
    const commandOverride = process.env[`${upper}_COMMAND`];
    if (commandOverride) {
      return {
        resolvedPath: commandOverride,
        mode: "command-override",
        launchShellCommand: commandOverride,
      };
    }

    const dockerImage = process.env[`${upper}_DOCKER_IMAGE`];

    const [directPath, commonPaths] = await Promise.all([
      this._which(command),
      this._findInCommonPaths(command),
    ]);

    if (directPath) {
      return this._buildLaunchSpec(directPath);
    }

    if (commonPaths) {
      return this._buildLaunchSpec(commonPaths);
    }

    if (dockerImage) {
      const dockerPath = await this._which("docker");
      if (dockerPath) {
        const workspace = process.cwd().replace(/\\/g, "/");
        const shellCommand =
          `docker run --rm -i -v "${workspace}:/workspace" -w /workspace ${dockerImage}`;
        return {
          resolvedPath: dockerPath,
          mode: "docker",
          launchShellCommand: shellCommand,
        };
      }
    }

    return null;
  }

  async _findInCommonPaths(command) {
    const commonPaths = this._getCommonExecutablePaths(command);
    const results = await Promise.allSettled(
      commonPaths.map(async (candidate) => {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
        return null;
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        return result.value;
      }
    }
    return null;
  }

  _getCommonExecutablePaths(command) {
    const home = os.homedir();
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

    if (process.platform === "win32") {
      return [
        path.join(appData, "npm", `${command}.cmd`),
        path.join(appData, "npm", `${command}.ps1`),
        path.join(appData, "npm", `${command}.exe`),
        path.join(localAppData, "Programs", command, `${command}.exe`),
        path.join(programFiles, command, `${command}.exe`),
        path.join(programFilesX86, command, `${command}.exe`),
      ];
    }

    return [
      `/usr/local/bin/${command}`,
      `/usr/bin/${command}`,
      `/opt/homebrew/bin/${command}`,
      `/snap/bin/${command}`,
      path.join(home, ".local", "bin", command),
      path.join(home, "bin", command),
    ];
  }

  _buildLaunchSpec(resolvedPath) {
    const lower = resolvedPath.toLowerCase();

    if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
      return {
        resolvedPath,
        mode: "native",
        launchCommand: "cmd.exe",
        launchArgsPrefix: ["/d", "/s", "/c", resolvedPath],
      };
    }

    if (process.platform === "win32" && lower.endsWith(".ps1")) {
      return {
        resolvedPath,
        mode: "native",
        launchCommand: "powershell.exe",
        launchArgsPrefix: ["-ExecutionPolicy", "Bypass", "-File", resolvedPath],
      };
    }

    return {
      resolvedPath,
      mode: "native",
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
    const prompt = this._buildDiscoveryPrompt(agent, testSong, excludedUrls, desiredCount);
    const responseText = await this._runAgentCommand(agent, prompt);
    const payload = this._extractAgentPayload(responseText);
    const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];

    const candidates = rawCandidates
      .map((item) => this._normalizeCandidate(item))
      .filter(Boolean);

    return {
      candidates,
      manualActionRequired: Boolean(payload.manualActionRequired),
      manualActionMessage: String(payload.manualActionMessage || "").trim(),
      dependencyStatus: normalizeDependencyStatus(payload.dependencyStatus),
    };
  }

  _buildDiscoveryPrompt(agent, testSong, excludedUrls, desiredCount) {
    const excludedBlock = excludedUrls.length
      ? `Do not return these URLs again:\n${excludedUrls.join("\n")}\n`
      : "";

    return [
      `You are ${agent.name} running on behalf of Web Audio Streamer.`,
      "Goal: perform realtime discovery of PUBLIC music source APIs that are live now and can directly support both song search and playback URL retrieval.",
      "Hard requirements:",
      "1. Do not use any built-in, hardcoded, cached, or previously bundled source list.",
      "2. Search live network resources now and only return URLs that are publicly reachable right now.",
      "3. Prefer the newest and highest quality reachable public instances.",
      "4. Exclude GitHub repo pages, article pages without a real API base URL, dead endpoints, login-only endpoints, LAN-only endpoints, 403/404/5xx endpoints, and sources that only provide previews.",
      "5. If the environment is missing dependencies, tools, or skills needed to perform the search, first try to install them automatically using the best method for the current environment.",
      "6. Consider Windows, macOS, Linux, Docker, npm global installs, shell aliases, and custom install paths when deciding how to work.",
      "7. If automatic installation fails and blocks discovery, set manualActionRequired=true and explain exactly what the user must install manually.",
      "8. Return JSON only. No markdown. No commentary.",
      "",
      "Before returning candidates, verify each candidate as much as possible from your side:",
      "- it should look like a real API base URL",
      "- it should support song search for Chinese music",
      "- it should be intended for direct API calls rather than documentation only",
      "",
      `Use this test keyword while discovering: ${testSong}`,
      `Target at least ${desiredCount} candidate URLs so the app can validate and keep the best 10.`,
      excludedBlock.trim(),
      "",
      "Return exactly one JSON object with this shape:",
      "{",
      '  "manualActionRequired": false,',
      '  "manualActionMessage": "",',
      '  "dependencyStatus": [',
      '    { "name": "curl", "status": "ok|installed|missing|failed", "details": "short message" }',
      "  ],",
      '  "candidates": [',
      "    {",
      '      "name": "Readable source name",',
      '      "searchUrl": "https://example.com/api",',
      '      "requestStyle": "server",',
      '      "needsAuth": false,',
      '      "reason": "Why this looks live and suitable now",',
      '      "detectedFrom": "where you found it",',
      '      "confidence": 0',
      "    }",
      "  ]",
      "}",
      'Allowed requestStyle values: "server", "server-keyword", "media", "type-only", "q", "keyword".',
      "Every candidate must already match the config file format fields used by the app: name, searchUrl, requestStyle, needsAuth, reason.",
      "If you cannot find enough candidates, still return every real live candidate you can confirm.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  _normalizeCandidate(item) {
    const searchUrl = this._normalizeBaseUrl(item?.searchUrl || item?.url || "");
    if (!searchUrl || !/^https?:/i.test(searchUrl)) {
      return null;
    }

    const requestStyle = this._normalizeRequestStyle(item?.requestStyle);
    return {
      name: String(item?.name || item?.title || "Unknown Source").trim(),
      searchUrl,
      requestStyle,
      needsAuth: Boolean(item?.needsAuth),
      notes: String(item?.reason || item?.notes || "").trim(),
      detectedFrom: String(item?.detectedFrom || "").trim(),
      confidence: Math.max(0, Math.min(100, toNumber(item?.confidence) || 0)),
    };
  }

  _normalizeRequestStyle(value) {
    return REQUEST_STYLES.includes(value) ? value : null;
  }

  async _runAgentCommand(agent, prompt) {
    const agentArgs = [
      "agent",
      "--json",
      "--timeout",
      String(Math.ceil(this.maxTimeout / 1000)),
      "--to",
      "+10000000000",
      "--message",
      prompt,
    ];

    let command = agent.launchCommand || agent.executable;
    let args = [...(agent.launchArgsPrefix || []), ...agentArgs];
    let options = {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      shell: true,
    };

    if (agent.launchShellCommand) {
      const shellArgs = parseShellWords(agent.launchShellCommand);
      if (!shellArgs.length) {
        throw new Error(`Invalid ${agent.name} command override`);
      }
      command = shellArgs.shift();
      args = [...shellArgs, ...agentArgs];
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
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
          reject(new Error(stderr.trim() || `${agent.name} exited with code ${code}`));
          return;
        }

        resolve(`${stdout}\n${stderr}`.trim());
      });

      child.on("error", reject);
    });
  }

  _extractAgentPayload(rawOutput) {
    const directJson = this._extractLastJsonValue(rawOutput);
    if (Array.isArray(directJson)) {
      return {
        manualActionRequired: false,
        manualActionMessage: "",
        dependencyStatus: [],
        candidates: directJson,
      };
    }

    if (directJson?.payloads) {
      const combinedText = directJson.payloads
        .map((payload) => payload?.text || "")
        .join("\n")
        .trim();
      const nestedJson = this._extractLastJsonValue(combinedText);
      if (Array.isArray(nestedJson)) {
        return {
          manualActionRequired: false,
          manualActionMessage: "",
          dependencyStatus: [],
          candidates: nestedJson,
        };
      }
      if (nestedJson && typeof nestedJson === "object") {
        return nestedJson;
      }
    }

    if (directJson && typeof directJson === "object") {
      return directJson;
    }

    throw new Error("Failed to parse JSON returned by local agent.");
  }

  _extractLastJsonValue(text) {
    const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
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
        message: `Validating source ${index + 1}/${candidates.length}: ${candidate.name}`,
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
    const styleCandidates = candidate.requestStyle ? [candidate.requestStyle] : REQUEST_STYLES;

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

        queryResults.push({ query, songs, playableSong });
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
      repo: "AI realtime discovery",
      description: candidate.notes || `${requestStyle} source`,
      aiScore: this._scoreCandidate({
        averageLatency,
        averageResults,
        averageDuration,
        queryCount: queryResults.length,
        confidence: candidate.confidence,
      }),
      verifiedAt: new Date().toISOString(),
      sampleSong: bestPlayable.title,
      sampleArtist: bestPlayable.artist,
      sampleDurationSec: bestPlayable.durationSec,
      samplePlayUrl: bestPlayable.playUrl,
      queryCount: queryResults.length,
      detectedFrom: candidate.detectedFrom || "",
    };
  }

  async _findPlayableSong(baseUrl, requestStyle, songs) {
    const songCandidates = songs.slice(0, 8);

    for (const song of songCandidates) {
      const playable = await this._resolvePlayableUrl(baseUrl, requestStyle, song);
      if (!playable) {
        continue;
      }

      const durationSec = this._extractDurationSec(song) || this._probeDuration(playable.url);
      if (!durationSec || durationSec < MIN_FULL_DURATION_SEC) {
        continue;
      }

      return {
        title: song.title || song.name || "Unknown Song",
        artist: song.author || song.artist || "Unknown Artist",
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

  _scoreCandidate({ averageLatency, averageResults, averageDuration, queryCount, confidence }) {
    let score = 40;

    if (queryCount >= 2) {
      score += 15;
    } else if (queryCount === 1) {
      score += 5;
    }

    score += Math.min(averageResults, 20);
    score += Math.min(15, Math.round((confidence || 0) / 10));

    if (averageLatency < 1500) {
      score += 15;
    } else if (averageLatency < 3000) {
      score += 8;
    }

    if (averageDuration >= 240) {
      score += 10;
    } else if (averageDuration >= 180) {
      score += 6;
    } else if (averageDuration >= 120) {
      score += 3;
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
        return { url: directUrl, needsAuth: false };
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
      throw new Error(`Endpoint did not return JSON: ${url}`);
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
        reject(new Error("Too many redirects"));
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
        request.destroy(new Error("Request timeout"));
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
