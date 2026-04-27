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
const POLL_INTERVAL_MS = 30 * 1000;
const AGENT_COMMAND_TIMEOUT_MS = 8 * 60 * 1000;
const VALIDATED_TARGET = 10;
const DISCOVERY_TARGET = 30;
const MAX_DISCOVERY_ROUNDS = 3;
const MAX_RETRY_ROUNDS = 2;
const MIN_FULL_DURATION_SEC = 90;
const CONFIG_VERSION = 13;
const NXVAV_TOKEN = "nxvav";
const TEST_QUERIES = ["周杰伦", "林俊杰", "Taylor Swift"];
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
    this.failedSources = new Set();
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
      retryCount: 0,
      manualActionRequired: false,
      manualActionMessage: "",
      dependencyStatus: [],
      configVersion: CONFIG_VERSION,
      agentLogs: [],
      failedUrls: [],
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
      message: "Agent 启动音源发现。Agent 将联网搜索最新可用的音乐 API。",
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
      message: `检测到本地 ${agent.name}。Agent 将联网搜索最新音乐 API...`,
      progress: 3,
      agentLaunch: {
        name: agent.name,
        resolvedPath: agent.resolvedPath || null,
        mode: agent.mode || "native",
      },
    });

    this._executeTask(task, agent).catch((error) => {
      if (task.cancelled) return;

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
    return task ? this._serializeTask(task) : null;
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
    if (!task) return null;

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
    if (!fs.existsSync(this.configFile)) return null;
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
      if (task.cancelled) return;

      task.attempts = round;
      this._updateTask(task, {
        progress: 5 + Math.floor((round - 1) * 15),
        message: `Agent 第 ${round} 轮搜索：联网查找最新音乐 API...`,
      });

      const excludedForThisRound = [
        ...discoveredUrls,
        ...task.failedUrls,
        ...this.failedSources,
      ];

      const discovery = await this._discoverSourceCandidates(
        task,
        agent,
        task.testSong,
        excludedForThisRound,
        DISCOVERY_TARGET,
        round,
        validatedSources.length,
      );

      latestManualActionRequired = latestManualActionRequired || Boolean(discovery.manualActionRequired);
      latestManualActionMessage = discovery.manualActionMessage || latestManualActionMessage;
      latestDependencyStatus = discovery.dependencyStatus.length
        ? discovery.dependencyStatus
        : latestDependencyStatus;

      if (discovery.agentLogs?.length) {
        task.agentLogs.push(...discovery.agentLogs);
        this._updateTask(task, { agentLogs: task.agentLogs });
      }

      let newCandidates = 0;
      for (const candidate of discovery.candidates) {
        if (!discoveredUrls.has(candidate.searchUrl)) {
          discoveredUrls.add(candidate.searchUrl);
          discoveredCandidates.push(candidate);
          newCandidates++;
        }
      }

      this._updateTask(task, {
        progress: 10 + Math.floor((round - 1) * 15),
        message: `Agent 发现 ${newCandidates} 个新候选。正在验证搜索和播放...`,
        manualActionRequired: latestManualActionRequired,
        manualActionMessage: latestManualActionMessage,
        dependencyStatus: latestDependencyStatus,
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

      if (round < MAX_DISCOVERY_ROUNDS) {
        this._updateTask(task, {
          message: `已验证 ${validatedSources.length}/${VALIDATED_TARGET}，Agent 将继续搜索更多...`,
        });
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

    if (topSources.length < VALIDATED_TARGET && topSources.length > 0) {
      this._updateTask(task, {
        message: `部分成功：找到 ${topSources.length}/${VALIDATED_TARGET} 个可用音源。`,
      });
    }

    if (topSources.length === 0) {
      const manualSuffix = latestManualActionRequired && latestManualActionMessage
        ? ` 需要手动操作: ${latestManualActionMessage}`
        : "";
      throw new Error(
        `Agent 未能找到任何可用音源。${manualSuffix}`
      );
    }

    this._updateTask(task, {
      status: "success",
      progress: 100,
      message: `Agent 发现 ${topSources.length} 个已验证音源，可供选择。`,
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
      "未检测到 Hermes 或 OpenClaw。请安装 Hermes 或 OpenClaw，或通过 HERMES_COMMAND / OPENCLAW_COMMAND 环境变量指定路径，或配置 HERMES_DOCKER_IMAGE / OPENCLAW_DOCKER_IMAGE Docker 镜像。"
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

    if (directPath) return this._buildLaunchSpec(directPath);
    if (commonPaths) return this._buildLaunchSpec(commonPaths);

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
        if (candidate && fs.existsSync(candidate)) return candidate;
        return null;
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) return result.value;
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

    if (process.platform === "win32" && lower.endsWith(".cmd")) {
      const mjsPath = this._findMjsFromCmdWrapper(resolvedPath);
      if (mjsPath) {
        return { resolvedPath: mjsPath, mode: "native", launchCommand: "node", launchArgsPrefix: [mjsPath] };
      }
    }

    if (process.platform === "win32" && lower.endsWith(".ps1")) {
      return { resolvedPath, mode: "native", launchCommand: "powershell.exe", launchArgsPrefix: ["-ExecutionPolicy", "Bypass", "-File", resolvedPath] };
    }

    if (process.platform === "win32" && lower.endsWith(".mjs")) {
      return { resolvedPath, mode: "native", launchCommand: "node", launchArgsPrefix: [resolvedPath] };
    }

    // On Windows, npm shim files have no extension. Detect by checking for sibling .cmd.
    // Also handle the case where `where` returns the bare shim path (e.g. C:\...\npm\openclaw).
    if (process.platform === "win32") {
      const noExt = !lower.includes(".");
      if (noExt || lower.endsWith(".exe")) {
        const withoutExt = resolvedPath.replace(/\.exe$/i, "");
        const cmdSibling = withoutExt + ".cmd";
        if (fs.existsSync(cmdSibling)) {
          const mjsPath = this._findMjsFromCmdWrapper(cmdSibling);
          if (mjsPath) {
            return { resolvedPath: mjsPath, mode: "npm-shim", launchCommand: "node", launchArgsPrefix: [mjsPath] };
          }
        }
      }
    }

    return { resolvedPath, mode: "native", launchCommand: resolvedPath, launchArgsPrefix: [] };
  }

  _findMjsFromCmdWrapper(cmdPath) {
    try {
      const dir = path.dirname(cmdPath);
      const basename = path.basename(cmdPath, path.extname(cmdPath));
      const mjsCandidate = path.join(dir, "node_modules", basename, `${basename}.mjs`);
      if (fs.existsSync(mjsCandidate)) return mjsCandidate;
    } catch {}
    return null;
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

  async _discoverSourceCandidates(task, agent, testSong, excludedUrls = [], desiredCount = DISCOVERY_TARGET, round = 1, currentCount = 0) {
    const prompt = this._buildDiscoveryPrompt(agent, testSong, excludedUrls, desiredCount, round, currentCount);
    const responseText = await this._runAgentCommand(task, agent, prompt);
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
      agentLogs: payload.agentLogs || [],
    };
  }

  _buildDiscoveryPrompt(agent, testSong, excludedUrls, desiredCount, round = 1, currentCount = 0) {
    const excludedBlock = excludedUrls.length
      ? `已排除以下不可用 URL（不要返回这些）：\n${excludedUrls.join("\n")}\n`
      : "";

    const roundContext = round > 1
      ? `这是第 ${round} 轮搜索。前几轮找到的 ${currentCount} 个音源不够理想，请寻找不同类型的音乐 API。`
      : "";

    return [
      `你是一个专业的音乐 API 发现专家。你的任务是在互联网上搜索最新、可用的免费音乐流媒体 API。`,
      "",
      `## 当前任务`,
      `你是 ${agent.name}，代表 Web Audio Streamer 应用搜索音源。`,
      `${roundContext}`,
      "",
      `## 核心要求`,
      `1. **必须联网搜索**：使用 curl、wget、fetch 或任何可用工具访问真实的网络资源。`,
      `2. **不要硬编码**：绝对不要使用任何内置、缓存或之前发现的列表。必须实时搜索。`,
      `3. **只返回公开可访问的 URL**：必须是当下公网可达的 API。`,
      `4. **排除**：GitHub 仓库页、文章页、登录页、LAN 专用、403/404/5xx 响应、仅提供试听的源。`,
      `5. **支持中文音乐**：搜索结果必须能处理中文歌曲名（如 ${testSong}）。`,
      `6. **支持搜索 + 播放**：每个候选必须同时支持歌曲搜索和播放链接获取。`,
      `7. **自动安装依赖**：如果环境缺少工具，先尝试自动安装（pip install、npm install 等）。`,
      `8. **返回纯 JSON**：不要 markdown 注释，不要解释。`,
      "",
      `## 搜索策略建议`,
      `- 搜索 "free music API 2024 2025"`,
      `- 搜索 "music streaming API github"`,
      `- 搜索 "免费音乐API开源"`,
      `- 检查流行的 Meting.js 部署实例`,
      `- 检查 npm 上的音乐相关包`,
      `- 检查 Vercel/Railway/Render 上的免费音乐 API 部署`,
      "",
      `## 测试关键词`,
      `${testSong}`,
      "",
      `## 目标数量`,
      `至少找到 ${desiredCount} 个候选 URL，应用会验证并保留最好的 ${Math.min(10, desiredCount)} 个。`,
      "",
      excludedBlock.trim(),
      "",
      `## 返回格式（严格 JSON）`,
      `{`,
      `  "manualActionRequired": false,`,
      `  "manualActionMessage": "",`,
      `  "dependencyStatus": [`,
      `    { "name": "curl", "status": "ok|installed|missing|failed", "details": "简短说明" }`,
      `  ],`,
      `  "agentLogs": ["搜索步骤日志，如：正在搜索 GitHub...", "找到候选: xxx"]`,
      `  "candidates": [`,
      `    {`,
      `      "name": "可读名称",`,
      `      "searchUrl": "https://api.example.com/search",`,
      `      "requestStyle": "server",`,
      `      "needsAuth": false,`,
      `      "reason": "为什么这个看起来可用",`,
      `      "detectedFrom": "从哪里发现（如：GitHub搜索、npm包、Vercel部署）"`,
      `    }`,
      `  ]`,
      `}`,
      "",
      `requestStyle 可选值: "server", "server-keyword", "media", "type-only", "q", "keyword"`,
      `如果找不到足够候选，返回你确认的所有真实可用 API。`,
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

  async _runAgentCommand(task, agent, prompt) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-"));
    const promptFile = path.join(tmpDir, "prompt.txt");
    fs.writeFileSync(promptFile, prompt, "utf8");

    const fullArgs = [
      "infer", "model", "run",
      "--prompt", `@${promptFile}`,
      "--json",
      "--local",
    ];

    let command, args, options;

    if (agent.launchShellCommand) {
      const shellArgs = parseShellWords(agent.launchShellCommand);
      if (!shellArgs.length) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        throw new Error(`Invalid ${agent.name} command override`);
      }
      command = shellArgs[0];
      args = [...shellArgs.slice(1), ...fullArgs];
      options = { cwd: process.cwd(), env: process.env, windowsHide: true, shell: false };
    } else if (agent.launchCommand === "node") {
      command = "node";
      args = [...(agent.launchArgsPrefix || []), ...fullArgs];
      options = { cwd: process.cwd(), env: process.env, windowsHide: true, shell: false };
    } else {
      command = agent.launchCommand || agent.executable;
      args = [...(agent.launchArgsPrefix || []), ...fullArgs];
      options = { cwd: process.cwd(), env: process.env, windowsHide: true, shell: true };
    }

    const fullCmd = `${command} ${args.join(" ")}`;
    console.log(`[AgentDiscovery] ════════════════════════════════════════════`);
    console.log(`[AgentDiscovery] >>> Agent 执行命令:`);
    console.log(`[AgentDiscovery]     ${fullCmd}`);
    console.log(`[AgentDiscovery] ════════════════════════════════════════════`);

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
      const timeoutMs = Math.min(this.maxTimeout, AGENT_COMMAND_TIMEOUT_MS);
      let stdout = "";
      let stderr = "";
      let settled = false;

      task.child = child;

      const cleanup = () => {
        task.child = null;
        try { fs.unlinkSync(promptFile); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      };

      const finish = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        cleanup();
        callback();
      };

      const timeoutHandle = setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
        finish(() => {
          reject(new Error(`${agent.name} command timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
      }, timeoutMs);

      const clearPendingTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        cleanup();
      };

      child.once("close", clearPendingTimeout);
      child.once("error", clearPendingTimeout);

      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", (code) => {
        try { fs.unlinkSync(promptFile); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        if (code !== 0 && !stdout) {
          reject(new Error(stderr.trim() || `${agent.name} exited with code ${code}`));
          return;
        }
        console.log(`[AgentDiscovery] <<< Agent 响应 (${stdout.length} chars)`);
        resolve(`${stdout}\n${stderr}`.trim());
      });

      child.on("error", (err) => {
        try { fs.unlinkSync(promptFile); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        reject(err);
      });
    });
  }

  _extractAgentPayload(rawOutput) {
    const directJson = this._extractLastJsonValue(rawOutput);
    if (Array.isArray(directJson)) {
      return {
        manualActionRequired: false,
        manualActionMessage: "",
        dependencyStatus: [],
        agentLogs: [],
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
          agentLogs: [],
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

    throw new Error("Agent 返回格式无法解析。");
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
      if (task.cancelled) return results;

      const candidate = candidates[index];
      if (alreadyValidatedUrls.has(candidate.searchUrl)) {
        continue;
      }

      const progress = 15 + Math.floor(((index + 1) / Math.max(candidates.length, 1)) * 75);
      this._updateTask(task, {
        progress,
        message: `验证中 ${index + 1}/${candidates.length}: ${candidate.name}`,
      });

      const validated = await this._validateSource(candidate);
      if (validated) {
        results.push(validated);
      } else {
        task.failedUrls.push(candidate.searchUrl);
        this.failedSources.add(candidate.searchUrl);
      }

      if (existingCount + results.length >= VALIDATED_TARGET) {
        break;
      }
    }

    return results.sort((a, b) => b.aiScore - a.aiScore);
  }

  async _validateSource(candidate) {
    const styleCandidates = candidate.requestStyle ? [candidate.requestStyle] : REQUEST_STYLES;

    for (const requestStyle of styleCandidates) {
      const validation = await this._validateSourceWithStyle(candidate, requestStyle);
      if (validation) return validation;
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
        if (!songs.length) continue;

        const playableSong = await this._findPlayableSong(candidate.searchUrl, requestStyle, songs);
        if (!playableSong) continue;

        queryResults.push({ query, songs, playableSong });
        if (!bestPlayable || playableSong.durationSec > bestPlayable.durationSec) {
          bestPlayable = playableSong;
        }
      } catch {
        continue;
      }
    }

    if (!queryResults.length || !bestPlayable) return null;

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
      repo: candidate.detectedFrom || "Agent 发现",
      description: candidate.notes || `${requestStyle} 模式`,
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
      if (!playable) continue;

      const durationSec = this._extractDurationSec(song) || this._probeDuration(playable.url);
      if (!durationSec || durationSec < MIN_FULL_DURATION_SEC) continue;

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
    if (!numericDuration) return null;
    if (numericDuration > 10000) return numericDuration / 1000;
    return numericDuration;
  }

  _scoreCandidate({ averageLatency, averageResults, averageDuration, queryCount, confidence }) {
    let score = 40;

    if (queryCount >= 2) score += 15;
    else if (queryCount === 1) score += 5;

    score += Math.min(averageResults, 20);
    score += Math.min(15, Math.round((confidence || 0) / 10));

    if (averageLatency < 1500) score += 15;
    else if (averageLatency < 3000) score += 8;

    if (averageDuration >= 240) score += 10;
    else if (averageDuration >= 180) score += 6;
    else if (averageDuration >= 120) score += 3;

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
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.result)) return payload.result;
    if (Array.isArray(payload?.songs)) return payload.songs;
    if (Array.isArray(payload?.data?.songs)) return payload.data.songs;
    return [];
  }

  async _resolvePlayableUrl(baseUrl, requestStyle, song) {
    if (song?.url && /^https?:/i.test(song.url)) {
      const directUrl = await this._followRedirect(song.url);
      if (directUrl) return { url: directUrl, needsAuth: false };
    }

    const songId = song?.id;
    if (!songId) return null;

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
          return { url: playableUrl, needsAuth: attempt.needsAuth };
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

    if (response.statusCode !== 200) return null;

    const contentType = String(response.headers["content-type"] || "");
    if (contentType.includes("application/json")) {
      try {
        const payload = JSON.parse(response.body);
        if (typeof payload === "string" && /^https?:/i.test(payload)) return payload;
        if (payload?.url && /^https?:/i.test(payload.url)) return payload.url;
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
      if (Number.isFinite(value) && value > 0) return value;
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
      fs.writeFileSync(this.resultFile, JSON.stringify(this._serializeTask(task), null, 2));
    } catch (error) {
      console.error("[HermesSourceApi] Failed to persist progress:", error.message);
    }
  }

  _serializeTask(task) {
    const { child, ...serializableTask } = task || {};
    return JSON.parse(JSON.stringify(serializableTask));
  }

  _loadPersistedProgress() {
    if (!fs.existsSync(this.resultFile)) return;

    try {
      const task = JSON.parse(fs.readFileSync(this.resultFile, "utf-8"));
      if (task?.id) {
        this.tasks.set(task.id, task);
        this.currentTaskId = task.id;
        if (task.failedUrls?.length) {
          task.failedUrls.forEach((url) => this.failedSources.add(url));
        }
      }
    } catch {
      // ignore invalid result file
    }
  }
}
