import { execSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";

const DEFAULT_PROVIDER = "netease";
const DEFAULT_TEST_SONG = "周杰伦 搁浅";
const SOURCE_RESULT_FILE =
  process.env.SOURCE_RESULT_FILE ||
  path.join(os.tmpdir(), "web-audio-streamer-source-progress.json");
const SOURCE_CONFIG_FILE =
  process.env.SOURCE_CONFIG_PATH ||
  path.join(os.homedir(), ".openclaw", "web-audio-streamer", "source-config.json");

const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const AGENT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const VALIDATED_TARGET = 8;
const DISCOVERY_TARGET = 15;
const MAX_DISCOVERY_ROUNDS = 2;
const MAX_RETRY_ROUNDS = 2;
const MIN_FULL_DURATION_SEC = 180;
const CONFIG_VERSION = 14;
const NXVAV_TOKEN = "nxvav";
const TEST_QUERIES = ["周杰伦 搁浅"];
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

 const paths = [
 `/usr/local/bin/${command}`,
 `/usr/bin/${command}`,
 `/opt/homebrew/bin/${command}`,     // macOS Homebrew
 `/snap/bin/${command}`,              // Linux Snap
 path.join(home, ".local", "bin", command),
 path.join(home, "bin", command),
 ];

 // Auto-detect: search installed paths via `which`/`where`
 try {
 const whichCmd = process.platform === "win32" ? "where" : "which";
 const result = require("child_process").execSync(`${whichCmd} ${command} 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim();
 if (result) {
 for (const line of result.split(/\r?\n/)) {
 const p = line.trim();
 if (p && !paths.includes(p)) paths.unshift(p); // prefer detected path
 }
 }
 } catch (_) { /* not found via which/where, that's fine */ }

 // Fallback: common install locations not in PATH
 const fallbacks = [
 `/opt/hermes/.venv/bin/${command}`,   // Docker hermes container
 `/opt/hermes/${command}`,             // Docker alt
 path.join(home, ".hermes", ".venv", "bin", command),  // User install
 path.join(home, ".local", "share", "hermes", ".venv", "bin", command), // XDG
 ];
 for (const f of fallbacks) { if (!paths.includes(f)) paths.push(f); }

 return paths;
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

 let payload;
 let usedProbeFallback = false;
 try {
 payload = this._extractAgentPayload(responseText);
 } catch (extractError) {
 // 主请求解析失败，检查是否有询问请求的备用结果
 if (task._probeCandidates?.length > 0) {
 console.log(`[AgentDiscovery] 主请求解析失败，使用询问请求的 ${task._probeCandidates.length} 个备用候选`);
 payload = {
 success: true,
 message: `主请求失败，使用询问结果：${extractError.message}`,
 candidates: task._probeCandidates,
 manualActionRequired: false,
 manualActionMessage: "",
 dependencyStatus: [],
 agentLogs: [`备用: 主请求解析失败(${extractError.message})，使用询问请求的 ${task._probeCandidates.length} 个候选`],
 };
 usedProbeFallback = true;
 } else {
 throw extractError;
 }
 }

 // 清理备用数据
 delete task._probeCandidates;

 // 检查 Agent 是否明确报告失败
 if (payload.success === false && payload.candidates.length === 0) {
 const failMsg = payload.message || "Agent 报告搜索失败";
 throw new Error(`Agent 搜索失败: ${failMsg}`);
 }

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
 `## 搜索方式（必须遵守）`,
 `你必须使用 Chromium 无头浏览器搜索互联网。具体步骤：`,
 `1. 检查系统是否已安装 chromium 或 google-chrome：执行 which chromium || which chromium-browser || which google-chrome`,
 `2. 如果未安装，则自行安装：`,
 ` - Debian/Ubuntu: apt-get update && apt-get install -y chromium-browser 或 chromium`,
 ` - Alpine: apk add chromium`,
 ` - CentOS/RHEL: yum install -y chromium`,
 ` - 如果 apt 源不可用，尝试 snap install chromium 或从 PPA 安装`,
 `3. 安装完成后，使用无头模式搜索：`,
 ` chromium --headless --no-sandbox --disable-gpu --dump-dom "https://www.google.com/search?q=免费音乐API+2025&tbs=qdr:m"`,
 ` chromium --headless --no-sandbox --disable-gpu --dump-dom "https://github.com/search?q=NeteaseCloudMusicApi+deploy&type=repositories&s=updated&o=desc"`,
 ` chromium --headless --no-sandbox --disable-gpu --dump-dom "https://github.com/search?q=meting+api&type=repositories&s=updated&o=desc"`,
 `4. 也可以结合 curl 辅助验证 URL 可达性，但主要发现必须通过浏览器搜索完成`,
 `5. 如果浏览器搜索获取到页面内容，从中提取 API 部署地址`,
 "",
 `## 音源地址格式说明`,
 `你搜索到的音源 URL 必须是洛雪音乐助手(LX Music)兼容的 API 端点，常见格式如下：`,
 "",
 `### 1. NeteaseCloudMusicApi 类型（最常见）`,
 `URL 格式: https://xxx.vercel.app 或 https://xxx.onrender.com 等`,
 `搜索接口: GET ?server=netease&type=search&id=周杰伦%20搁浅`,
 `播放接口: GET ?server=netease&type=url&id=歌曲ID`,
 `requestStyle 填: "server"`,
 "",
 `### 2. Meting API 类型`,
 `URL 格式: https://xxx.vercel.app/api/meting 或 https://meting-api.xxx.workers.dev`,
 `搜索接口: GET ?server=netease&type=search&id=周杰伦%20搁浅`,
 `播放接口: GET ?server=netease&type=url&id=歌曲ID`,
 `requestStyle 填: "server"`,
 "",
 `### 3. 自定义类型`,
 `URL 格式: 各种 API 部署地址`,
 `搜索接口: GET ?type=search&id=关键词 或 ?q=关键词 或 ?keyword=关键词`,
 `requestStyle 填: "type-only" / "q" / "keyword"`,
 "",
 `### ⚠️ URL 必须是 API 端点，不是仓库页面`,
 `❌ 错误: https://github.com/xxx/NeteaseCloudMusicApi`,
 `❌ 错误: https://github.com/xxx/lx-music-source`,
 `✅ 正确: https://netease-cloud-music-api-xxx.vercel.app`,
 `✅ 正确: https://meting-api-xxx.onrender.com`,
 "",
 `## 核心要求`,
 `1. **必须用 Chromium 无头浏览器联网搜索**：不要只用 curl，浏览器能看到更完整的搜索结果。`,
 `2. **不要硬编码**：绝对不要使用任何内置、缓存或之前发现的列表。必须实时搜索。`,
 `3. **只返回公开可访问的 API 端点 URL**：必须是当下公网可达的 API（不是仓库页面）。`,
 `4. **排除**：GitHub 仓库页、文章页、登录页、LAN 专用、403/404/5xx 响应、仅提供试听的源。`,
 `5. **验证标准**：每个候选 API 必须能搜索"周杰伦 搁浅"并返回时长≥3分钟(180秒)的完整歌曲，文件越大越好（无损优先）。`,
 `6. **按发布时间排序**：优先搜索最新发布的 API 部署，优先返回近期创建/更新的实例。`,
 `7. **精简高效**：找到 ${desiredCount} 个候选即可停止，不要过度扫描。`,
 `8. **最后只输出一个 JSON 结果块**：所有搜索日志放 agentLogs，最终音源列表放 candidates，不要在 JSON 之外写任何额外解释。`,
 "",
 `## 搜索策略建议`,
 `- 用 Chromium 访问 Google 搜索 "free music API 2024 2025" 并按时间排序`,
 `- 用 Chromium 访问 GitHub 搜索 "NeteaseCloudMusicApi vercel" 按最近更新排序`,
 `- 用 Chromium 访问 GitHub 搜索 "meting api deploy" 按最新排序`,
 `- 用 Chromium 访问 Google 搜索 "免费音乐API开源 2025"`,
 `- 优先检查最近创建的 Vercel/Railway/Render 部署`,
 `- 用 curl 逐一验证找到的 API 端点是否可达、能搜索`,
 "",
 `## 测试歌曲`,
 `验证歌曲：周杰伦 - 搁浅（时长必须≥3分钟/180秒，无损文件越大越好）`,
 "",
 `## 目标数量`,
 `找到 ${desiredCount} 个候选 URL 即可（按发布时间从新到旧排列），应用会验证并保留最好的 ${Math.min(8, desiredCount)} 个。`,
 "",
 excludedBlock.trim(),
 "",
 `## 返回格式（严格 JSON，整个输出中只能有这一个 JSON）`,
 `你的最终回复必须包含且仅包含以下 JSON 结构（可以先用文字记录搜索过程，但最后必须输出这个 JSON）：`,
 "```json",
 `{`,
 ` "success": true,`,
 ` "message": "搜索完成，找到 N 个候选",`,
 ` "manualActionRequired": false,`,
 ` "manualActionMessage": "",`,
 ` "dependencyStatus": [`,
 ` { "name": "chromium", "status": "ok|installed|missing|failed", "details": "简短说明" }`,
 ` ],`,
 ` "agentLogs": [`,
 ` "步骤1: 正在检查 chromium...",`,
 ` "步骤2: 正在安装 chromium...",`,
 ` "步骤3: 用浏览器搜索 GitHub...",`,
 ` "步骤4: 找到候选 https://xxx.vercel.app",`,
 ` "步骤5: 用 curl 验证该 API 可达..."`,
 ` ],`,
 ` "candidates": [`,
 ` {`,
 ` "name": "NeteaseCloudMusicApi Vercel 实例",`,
 ` "searchUrl": "https://netease-cloud-music-api-xxx.vercel.app",`,
 ` "requestStyle": "server",`,
 ` "needsAuth": false,`,
 ` "confidence": 80,`,
 ` "reason": "从 GitHub 搜索发现，Vercel 部署，curl 测试搜索返回结果",`,
 ` "detectedFrom": "GitHub 搜索 NeteaseCloudMusicApi"`,
 ` },`,
 ` {`,
 ` "name": "Meting API Render 实例",`,
 ` "searchUrl": "https://meting-api-xxx.onrender.com",`,
 ` "requestStyle": "server",`,
 ` "needsAuth": false,`,
 ` "confidence": 70,`,
 ` "reason": "从 Google 搜索发现，Render 部署",`,
 ` "detectedFrom": "Google 搜索 free music API"`,
 ` }`,
 ` ]`,
 `}`,
 "```",
 "",
 `### 字段说明`,
 `- **success**: true=搜索成功找到候选，false=搜索失败（如网络不通、chromium装不上）`,
 `- **message**: 一句话总结搜索结果`,
 `- **confidence**: 0-100，你对这个 URL 可用性的把握程度`,
 `- **requestStyle 可选值**: "server" | "server-keyword" | "media" | "type-only" | "q" | "keyword"`,
 `- **searchUrl**: 必须是可直接发 HTTP 请求的 API 地址，不带查询参数`,
 "",
 `### 如果搜索失败`,
 `如果 Chromium 安装失败或网络不通，返回：`,
 "```json",
 `{ "success": false, "message": "chromium 安装失败: xxx", "candidates": [], "agentLogs": [...] }`,
 "```",
 "",
 `⚠️ 重要：JSON 必须是合法的、可被 JSON.parse() 直接解析的。不要有尾逗号、注释、或 markdown 代码块包裹（代码块标记可省略）。`,
 `如果找不到足够候选，返回你确认的所有真实可用 API，success 仍为 true。`,
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
 // Priority 1: Hermes API Server (most reliable, handles tool calls properly)
 const apiResult = await this._runViaApiServer(task, agent, prompt);
 if (apiResult !== null) return apiResult;

 // Priority 2: CLI fallback (for OpenClaw or when API server unavailable)
 return this._runViaCli(task, agent, prompt);
 }

 async _runViaApiServer(task, agent, prompt) {
 // Auto-detect API config: env vars > Hermes .env > defaults
 let apiBaseUrl = process.env.HERMES_API_URL || "";
 let apiKey = process.env.HERMES_API_KEY || "";
 let apiPort = "";
 let apiEnabled = false;

 // Try reading from Hermes .env file
 const hermesEnvPaths = [
 "/opt/data/.env", // Docker container
 path.join(os.homedir(), ".hermes", ".env"), // Linux/Mac user install
 path.join(os.homedir(), ".config", "hermes", ".env"), // XDG
 ];
 for (const envPath of hermesEnvPaths) {
 try {
 const envContent = fs.readFileSync(envPath, "utf8");
 if (!apiEnabled) {
 const enabledMatch = envContent.match(/^API_SERVER_ENABLED=(.+)$/m);
 if (enabledMatch && enabledMatch[1].trim().toLowerCase() === "true") apiEnabled = true;
 }
 if (!apiPort) {
 const portMatch = envContent.match(/^API_SERVER_PORT=(\d+)/m);
 if (portMatch) apiPort = portMatch[1].trim();
 }
 if (!apiKey) {
 const keyMatch = envContent.match(/^API_SERVER_KEY=(.+)$/m);
 if (keyMatch && keyMatch[1].trim()) {
 apiKey = keyMatch[1].trim().replace(/^["']|["']$/g, "");
 console.log(`[AgentDiscovery] 从 ${envPath} 读取 API key`);
 }
 }
 if (apiKey && apiPort) break; // found all we need
 } catch (_) { /* file not found, skip */ }
 }

 // Build base URL
 if (!apiBaseUrl) {
 const port = apiPort || "8642";
 apiBaseUrl = `http://localhost:${port}`;
 }
 const url = new URL("/v1/chat/completions", apiBaseUrl);

 console.log(`[AgentDiscovery] >>> 尝试 Hermes API Server: ${url.href}`);

 return new Promise((resolve) => {
 const timeoutMs = Math.min(this.maxTimeout, AGENT_COMMAND_TIMEOUT_MS);
 const PROBE_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟主动询问一次
 const body = JSON.stringify({
 model: "hermes-agent",
 messages: [{ role: "user", content: prompt }],
 max_tokens: 16384,
 stream: false,
 });

 const httpModule = url.protocol === "https:" ? https : http;
 const reqOpts = {
 hostname: url.hostname,
 port: url.port,
 path: url.pathname,
 method: "POST",
 headers: {
 "Content-Type": "application/json",
 "Authorization": `Bearer ${apiKey}`,
 "Content-Length": Buffer.byteLength(body),
 },
 timeout: timeoutMs,
 };

 // 进度更新：API 模式是阻塞的，在等待期间周期性更新进度
 let elapsedSeconds = 0;
 const progressMessages = [
 "Agent 正在联网搜索音乐 API...",
 "Agent 正在搜索 Meting API 部署实例...",
 "Agent 正在搜索 NeteaseCloudMusicApi 部署...",
 "Agent 正在测试发现的 API 端点...",
 "Agent 正在验证搜索和播放功能...",
 "Agent 正在大规模发现更多端点...",
 "Agent 正在深入测试可用性...",
 "Agent 正在整理结果...",
 ];
 let progressInterval = null;
 let probeInterval = null;
 let resolved = false;

 const cleanup = () => {
 if (progressInterval) {
 clearInterval(progressInterval);
 progressInterval = null;
 }
 if (probeInterval) {
 clearInterval(probeInterval);
 probeInterval = null;
 }
 };

 const doResolve = (value) => {
 if (resolved) return;
 resolved = true;
 cleanup();
 resolve(value);
 };

 // 进度更新定时器
 if (task) {
 progressInterval = setInterval(() => {
 elapsedSeconds += 10;
 const msgIndex = Math.min(
 Math.floor(elapsedSeconds / 60),
 progressMessages.length - 1
 );
 // 进度从 15% 缓慢增长到 85%（留空间给验证阶段）
 const progress = Math.min(85, 15 + Math.floor(elapsedSeconds / 15));
 this._updateTask(task, {
 progress,
 message: progressMessages[msgIndex],
 });
 console.log(`[AgentDiscovery] API 等待中... ${elapsedSeconds}s, 进度 ${progress}%`);
 }, 10000); // 每10秒更新一次

 // 主动询问 Agent 结果（防止会话断开导致丢失进度）
 probeInterval = setInterval(() => {
 if (resolved) return;
 console.log(`[AgentDiscovery] Agent 长时间未响应 (${elapsedSeconds}s)，发送询问请求...`);
 this._sendProbeRequest(url, apiKey, task).catch(() => {});
 }, PROBE_INTERVAL_MS);
 }

 const req = httpModule.request(reqOpts, (res) => {
 let data = "";
 res.on("data", (chunk) => { data += chunk.toString(); });
 res.on("end", () => {
 if (res.statusCode === 200) {
 try {
 const json = JSON.parse(data);
 const content = json.choices?.[0]?.message?.content || "";
 console.log(`[AgentDiscovery] <<< API 响应 (${content.length} chars, ${elapsedSeconds}s)`);
 doResolve(content);
 return;
 } catch (_) {}
 }
 // API failed, fall through to CLI
 console.log(`[AgentDiscovery] API 返回 ${res.statusCode}, 降级到 CLI 模式`);
 doResolve(null);
 });
 });

 req.on("error", (err) => {
 console.log(`[AgentDiscovery] API 连接失败: ${err.message}, 降级到 CLI 模式`);
 doResolve(null);
 });

 req.on("timeout", () => {
 req.destroy();
 console.log(`[AgentDiscovery] API 超时 (${Math.round(timeoutMs/1000)}s), 降级到 CLI 模式`);
 doResolve(null);
 });

 req.write(body);
 req.end();
 });
 }

 /**
 * 主动询问 Agent 当前进度（防止长时间未响应导致会话丢失）
 * 这是一个独立的短超时请求，不会影响主请求
 */
 async _sendProbeRequest(url, apiKey, task) {
 const probePrompt = [
 "你正在执行音乐 API 搜索任务。",
 "如果已经有了搜索结果，请立即按指定 JSON 格式输出你目前找到的所有候选。",
 "如果还在搜索中，请回复：{\"success\":true,\"message\":\"正在搜索中，请稍等\",\"candidates\":[]}",
 "如果你遇到了困难无法完成，请回复：{\"success\":false,\"message\":\"具体困难原因\",\"candidates\":[]}",
 "重要：不要重复搜索，只汇总你目前已有结果即可。",
 ].join("\n");

 const probeBody = JSON.stringify({
 model: "hermes-agent",
 messages: [{ role: "user", content: probePrompt }],
 max_tokens: 8192,
 stream: false,
 });

 const httpModule = url.protocol === "https:" ? https : http;

 return new Promise((resolve) => {
 const req = httpModule.request({
 hostname: url.hostname,
 port: url.port,
 path: url.pathname,
 method: "POST",
 headers: {
 "Content-Type": "application/json",
 "Authorization": `Bearer ${apiKey}`,
 "Content-Length": Buffer.byteLength(probeBody),
 },
 timeout: 120000, // 2分钟超时（询问请求应该很快）
 }, (res) => {
 let data = "";
 res.on("data", (chunk) => { data += chunk.toString(); });
 res.on("end", () => {
 if (res.statusCode === 200) {
 try {
 const json = JSON.parse(data);
 const content = json.choices?.[0]?.message?.content || "";
 console.log(`[AgentDiscovery] 询问请求返回 (${content.length} chars)`);

 // 尝试从询问结果中提取有效音源
 try {
 const payload = this._extractAgentPayload(content);
 if (payload.success && payload.candidates?.length > 0) {
 console.log(`[AgentDiscovery] 询问请求获取到 ${payload.candidates.length} 个候选，保存为备用`);
 // 将结果保存到 task 作为备用（不中断主请求）
 task._probeCandidates = payload.candidates;
 if (task) {
 this._updateTask(task, {
 message: `Agent 询问返回了 ${payload.candidates.length} 个候选（等待主请求完成...）`,
 });
 }
 }
 } catch (e) {
 console.log(`[AgentDiscovery] 询问结果无法解析为音源: ${e.message}`);
 }
 } catch (_) {}
 } else {
 console.log(`[AgentDiscovery] 询问请求返回 ${res.statusCode}`);
 }
 resolve();
 });
 });

 req.on("error", (err) => {
 console.log(`[AgentDiscovery] 询问请求失败: ${err.message}`);
 resolve();
 });

 req.on("timeout", () => {
 req.destroy();
 console.log(`[AgentDiscovery] 询问请求超时`);
 resolve();
 });

 req.write(probeBody);
 req.end();
 });
 }

 async _runViaCli(task, agent, prompt) {
 const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-"));
 const promptFile = path.join(tmpDir, "prompt.txt");
 fs.writeFileSync(promptFile, prompt, "utf8");

 // Hermes CLI: hermes chat -q "$(cat promptFile)" --quiet --source tool
 // OpenClaw CLI: openclaw infer model run --prompt @file --json --local
 const isOpenClaw = agent.executable === "openclaw" || (agent.name && agent.name.toLowerCase().includes("openclaw"));
 const hermesShellArg = `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"` ;

 let command, args, options;

 if (agent.launchShellCommand) {
 const shellArgs = parseShellWords(agent.launchShellCommand);
 if (!shellArgs.length) {
 try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
 throw new Error(`Invalid ${agent.name} command override`);
 }
 command = shellArgs[0];
 if (isOpenClaw) {
 args = [...shellArgs.slice(1), "infer", "model", "run", "--prompt", `@${promptFile}`, "--json", "--local"];
 } else {
 args = [...shellArgs.slice(1), "chat", "-q", hermesShellArg, "--quiet", "--source", "tool"];
 }
 options = { cwd: process.cwd(), env: process.env, windowsHide: true, shell: true };
 } else if (agent.launchCommand === "node") {
 command = "node";
 if (isOpenClaw) {
 args = [...(agent.launchArgsPrefix || []), "infer", "model", "run", "--prompt", `@${promptFile}`, "--json", "--local"];
 } else {
 // node entry.mjs chat -q "$(cat file)" --quiet --source tool
 args = [...(agent.launchArgsPrefix || []), "chat", "-q", hermesShellArg, "--quiet", "--source", "tool"];
 }
 options = { cwd: process.cwd(), env: process.env, windowsHide: true, shell: true };
 } else {
 command = agent.launchCommand || agent.executable;
 if (isOpenClaw) {
 args = [...(agent.launchArgsPrefix || []), "infer", "model", "run", "--prompt", `@${promptFile}`, "--json", "--local"];
 } else {
 args = [...(agent.launchArgsPrefix || []), "chat", "-q", hermesShellArg, "--quiet", "--source", "tool"];
 }
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
 // 策略1：直接找最后一个合法 JSON
 const directJson = this._extractLastJsonValue(rawOutput);

 // 如果是数组（旧格式兼容），包装为标准格式
 if (Array.isArray(directJson)) {
 return {
 success: true,
 message: `解析到 ${directJson.length} 个候选`,
 manualActionRequired: false,
 manualActionMessage: "",
 dependencyStatus: [],
 agentLogs: [],
 candidates: directJson,
 };
 }

 // 如果是对象，提取标准字段
 if (directJson && typeof directJson === "object") {
 // 处理 payloads 嵌套（Hermes ACP 格式）
 if (directJson.payloads) {
 const combinedText = directJson.payloads
 .map((payload) => payload?.text || "")
 .join("\n")
 .trim();
 const nestedJson = this._extractLastJsonValue(combinedText);
 if (Array.isArray(nestedJson)) {
 return {
 success: true,
 message: `解析到 ${nestedJson.length} 个候选`,
 manualActionRequired: false,
 manualActionMessage: "",
 dependencyStatus: [],
 agentLogs: [],
 candidates: nestedJson,
 };
 }
 if (nestedJson && typeof nestedJson === "object") {
 return this._normalizePayload(nestedJson);
 }
 return {
 success: false,
 message: "Agent 返回的嵌套内容无法解析为有效音源列表",
 candidates: [],
 agentLogs: [],
 };
 }

 return this._normalizePayload(directJson);
 }

 // 策略2：从原始文本中逐行提取 URL（Agent 可能没返回 JSON，但提到了 API 地址）
 const fallbackCandidates = this._extractUrlsFromText(rawOutput);
 if (fallbackCandidates.length > 0) {
 console.log(`[AgentDiscovery] JSON 解析失败，从文本中提取到 ${fallbackCandidates.length} 个 URL`);
 return {
 success: true,
 message: `JSON 解析失败，从文本中提取到 ${fallbackCandidates.length} 个候选 URL`,
 manualActionRequired: false,
 manualActionMessage: "",
 dependencyStatus: [],
 agentLogs: [`fallback: 从原始文本提取 ${fallbackCandidates.length} 个 URL`],
 candidates: fallbackCandidates,
 };
 }

 throw new Error("Agent 返回格式无法解析，也未找到有效的 API URL。");
 }

 _normalizePayload(json) {
 const success = json.success !== false; // undefined/true 都算成功
 const candidates = Array.isArray(json.candidates) ? json.candidates : [];
 const agentLogs = Array.isArray(json.agentLogs) ? json.agentLogs : [];
 const dependencyStatus = Array.isArray(json.dependencyStatus) ? json.dependencyStatus : [];

 // 过滤非音源数据：candidates 里只保留有 searchUrl 的项
 const validCandidates = candidates.filter((item) => {
 const url = item?.searchUrl || item?.url || "";
 return url && /^https?:/i.test(url);
 });

 return {
 success: success && validCandidates.length > 0,
 message: String(json.message || "").trim() || (validCandidates.length > 0
 ? `找到 ${validCandidates.length} 个候选`
 : "Agent 未返回有效音源"),
 manualActionRequired: Boolean(json.manualActionRequired),
 manualActionMessage: String(json.manualActionMessage || "").trim(),
 dependencyStatus,
 agentLogs,
 candidates: validCandidates,
 };
 }

 _extractUrlsFromText(text) {
 // 从文本中提取可能的音乐 API URL
 const urlPattern = /https?:\/\/[^\s"'<>)\]]+/g;
 const matches = String(text || "").match(urlPattern) || [];
 const apiUrls = [];

 for (const rawUrl of matches) {
 const url = rawUrl.replace(/[.,;:!?\]}]+$/, "").replace(/\?+$/, ""); // 去除尾部标点
 // 过滤：只要 API 端点，排除仓库页面、文章等
 if (/github\.com\/[^/]+\/[^/]+$/i.test(url)) continue; // GitHub 仓库页
 if (/github\.com\/[^/]+\/[^/]+\/(blob|tree|issues|pull)/i.test(url)) continue;
 if (/npmjs\.com/i.test(url)) continue;
 if (/stackoverflow|zhihu|csdn|juejin/i.test(url)) continue;
 // 保留：可能是 API 部署的 URL
 if (/vercel\.app|onrender\.com|railway\.app|herokuapp\.com|fly\.dev|workers\.dev|netlify\.app/i.test(url)) {
 apiUrls.push({
 name: url.split("/")[2].split(".")[0],
 searchUrl: url,
 requestStyle: "server",
 needsAuth: false,
 confidence: 40,
 reason: "从 Agent 文本输出中提取的部署 URL",
 detectedFrom: "文本提取 (fallback)",
 });
 }
 }

 return apiUrls;
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
 const fileSizeBytes = bestPlayable.fileSizeBytes || 0;

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
 fileSizeBytes,
 }),
 verifiedAt: new Date().toISOString(),
 sampleSong: bestPlayable.title,
 sampleArtist: bestPlayable.artist,
 sampleDurationSec: bestPlayable.durationSec,
 samplePlayUrl: bestPlayable.playUrl,
 sampleFileSizeBytes: fileSizeBytes,
 queryCount: queryResults.length,
 detectedFrom: candidate.detectedFrom || "",
 };
 }

 async _findPlayableSong(baseUrl, requestStyle, songs) {
 const songCandidates = songs.slice(0, 8);
 const validSongs = [];

 for (const song of songCandidates) {
 const playable = await this._resolvePlayableUrl(baseUrl, requestStyle, song);
 if (!playable) continue;

 const durationSec = this._extractDurationSec(song) || this._probeDuration(playable.url);
 if (!durationSec || durationSec < MIN_FULL_DURATION_SEC) continue;

 // 探测文件大小（无损越大越好）
 const fileSizeBytes = await this._probeFileSize(playable.url);

 // 匹配目标歌曲"搁浅"
 const title = String(song.title || song.name || "").trim();
 const isTargetSong = title.includes("搁浅");

 validSongs.push({
 title: song.title || song.name || "Unknown Song",
 artist: song.author || song.artist || "Unknown Artist",
 durationSec,
 playUrl: playable.url,
 needsAuth: playable.needsAuth,
 fileSizeBytes,
 isTargetSong,
 });
 }

 if (!validSongs.length) return null;

 // 优先选择"搁浅"，其次按时长+文件大小排序（无损文件越大越好）
 validSongs.sort((a, b) => {
 if (a.isTargetSong !== b.isTargetSong) return b.isTargetSong ? 1 : -1;
 const aSize = a.fileSizeBytes || 0;
 const bSize = b.fileSizeBytes || 0;
 return (b.durationSec + bSize / 102400) - (a.durationSec + aSize / 102400);
 });

 return validSongs[0];
 }

  _extractDurationSec(song) {
    const rawDuration = song?.duration ?? song?.time ?? null;
    const numericDuration = toNumber(rawDuration);
    if (!numericDuration) return null;
    if (numericDuration > 10000) return numericDuration / 1000;
    return numericDuration;
  }

 _scoreCandidate({ averageLatency, averageResults, averageDuration, queryCount, confidence, fileSizeBytes }) {
 let score = 40;

 if (queryCount >= 1) score += 10;

 score += Math.min(averageResults, 15);
 score += Math.min(15, Math.round((confidence || 0) / 10));

 if (averageLatency < 1500) score += 15;
 else if (averageLatency < 3000) score += 8;

 // 时长越大越好，无损文件通常更长
 if (averageDuration >= 300) score += 20;
 else if (averageDuration >= 240) score += 15;
 else if (averageDuration >= 200) score += 10;
 else if (averageDuration >= 180) score += 5;

 // 文件大小加分（无损 > 10MB，高品质 > 5MB）
 if (fileSizeBytes >= 10 * 1024 * 1024) score += 15;
 else if (fileSizeBytes >= 5 * 1024 * 1024) score += 10;
 else if (fileSizeBytes >= 2 * 1024 * 1024) score += 5;

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

 async _probeFileSize(url) {
 try {
 // 方法1：HEAD 请求获取 Content-Length
 const fileSize = await this._headFileSize(url);
 if (fileSize && fileSize > 0) return fileSize;
 } catch { /* fallthrough */ }

 try {
 // 方法2：ffprobe 获取文件大小
 const output = execSync(
 `ffprobe -v error -show_entries format=size -of default=noprint_wrappers=1:nokey=1 "${url}"`,
 { timeout: 10000, encoding: "utf-8", shell: true },
 ).trim();
 const value = Number.parseInt(output, 10);
 if (Number.isFinite(value) && value > 0) return value;
 } catch { /* ignore */ }

 return 0;
 }

 async _headFileSize(url) {
 return new Promise((resolve) => {
 const client = url.startsWith("https") ? https : http;
 const req = client.request(url, { method: "HEAD" }, (res) => {
 const contentLength = Number.parseInt(res.headers["content-length"], 10);
 resolve(Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0);
 });
 req.setTimeout(8000, () => { req.destroy(); resolve(0); });
 req.on("error", () => resolve(0));
 req.end();
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
