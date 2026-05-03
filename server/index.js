/**
 * Web Audio Streamer - Main Server
 * 支持播放、下载、推荐功能
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import https from "https";

import { AudioStreamer } from "./audio-streamer.js";
import { LocalMusicScanner } from "./local-music.js";
import { OnlineMusicApi } from "./online-music.js";
import { RadioPlayer } from "./radio.js";
import { MusicDownloader } from "./downloader.js";
import { RecommendationEngine } from "./recommendation.js";
import { SmartSourceFinder } from "./smart-source.js";
import { SourceManager } from "./source-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载配置
const configPath =
 process.env.CONFIG_PATH || path.join(__dirname, "../config/config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// 确保 music 目录存在
const musicDir = path.resolve(__dirname, "../music");
if (!fs.existsSync(musicDir)) {
 fs.mkdirSync(musicDir, { recursive: true });
 console.log("[Server] Created music directory:", musicDir);
}
config.music.path = musicDir;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../web-ui")));
app.use("/music", express.static(musicDir));

// 初始化模块
const audioStreamer = new AudioStreamer(config);
const localScanner = new LocalMusicScanner(config);
const sourceManager = new SourceManager();
const onlineApi = new OnlineMusicApi(config, sourceManager.getLxRuntime());
const radioPlayer = new RadioPlayer(config);
const downloader = new MusicDownloader(config, sourceManager.getLxRuntime());
const recommender = new RecommendationEngine(config);
const smartSourceFinder = new SmartSourceFinder(config);

// Startup: 加载 LX 插件（仅用于获取播放链接，搜索由内置 MusicSearchSdk 实现）
const startupPromise = (async () => {
 console.log("[Startup] 正在初始化...");

 try {
   // 加载 LX 插件（用于获取播放链接）
   const pluginResult = await sourceManager.loadLxPlugins();
   if (pluginResult.loaded > 0) {
     console.log(`[Startup] ✅ LX 插件加载成功: ${pluginResult.loaded} 个, 支持平台: ${sourceManager.getLxRuntime().getStatus().allSources.join(", ")}`);
     // 同步 runtime 到 onlineApi
     onlineApi.setLxRuntime(sourceManager.getLxRuntime());
   } else {
     console.log("[Startup] ⚠️ LX 插件加载失败，播放将回退到直连API");
   }

   // 报告状态
   const runtimeStatus = sourceManager.getLxRuntime().getStatus();
   console.log(`[Startup] 🎵 搜索就绪: 网易云+酷我+酷狗 (内置 MusicSearchSdk)`);
   if (runtimeStatus.pluginCount > 0) {
     console.log(`[Startup] 🎵 播放就绪: ${runtimeStatus.pluginCount} 个插件, ${runtimeStatus.allSources.length} 个平台`);
   } else {
     console.log("[Startup] ⚠️ 无 LX 插件，播放将使用直连回退");
   }
 } catch (e) {
   console.warn("[Startup] 插件初始化失败:", e.message);
 }
})();

// ==================== 本地音乐 API ====================

/**
 * 获取音乐目录列表
 */
app.get("/api/local/directories", (req, res) => {
  try {
    const musicPath = config.music.path;
    const dirs = [{ path: musicPath, name: "默认音乐目录" }];

    // 扫描子目录
    if (fs.existsSync(musicPath)) {
      const items = fs.readdirSync(musicPath, { withFileTypes: true });
      items.forEach((item) => {
        if (item.isDirectory()) {
          dirs.push({ path: path.join(musicPath, item.name), name: item.name });
        }
      });
    }

    res.json({
      success: true,
      directories: dirs,
      musicPath,
      lastBrowse: config.music.lastBrowse || "",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 浏览目录树（支持从根目录浏览）
 */
app.get("/api/local/browse", (req, res) => {
  try {
    const { path: browsePath, root } = req.query;

    // 如果没有指定路径，根据操作系统显示根目录
    let targetPath;
    let basePath;

    if (!browsePath) {
      // 首次加载：显示根目录
      if (process.platform === "win32") {
        // Windows: 返回盘符列表
        const drives = [];
        // 常见盘符
        for (let letter of "CDEFGH".split("")) {
          const drivePath = letter + ":\\";
          try {
            fs.accessSync(drivePath, fs.constants.R_OK);
            drives.push({
              name: drivePath,
              path: drivePath,
              hasChildren: true,
              writable: false,
            });
          } catch (e) {}
        }
        return res.json({
          success: true,
          directories: drives,
          path: "root",
          isRoot: true,
          platform: "win32",
        });
      } else {
        // Linux/macOS: 显示根目录
        targetPath = "/";
        basePath = "/";
      }
    } else {
      targetPath = browsePath;
      basePath = root || "/";
    }

    if (!fs.existsSync(targetPath)) {
      return res.json({ success: true, directories: [], path: targetPath });
    }

    const items = fs.readdirSync(targetPath, { withFileTypes: true });
    const directories = items
      .filter((item) => item.isDirectory())
      .map((item) => {
        const fullPath = path.join(targetPath, item.name);
        let hasChildren = false;
        let writable = false;
        try {
          const subItems = fs.readdirSync(fullPath, { withFileTypes: true });
          hasChildren = subItems.some((sub) => sub.isDirectory());
          fs.accessSync(fullPath, fs.constants.W_OK);
          writable = true;
        } catch (e) {}
        return { name: item.name, path: fullPath, hasChildren, writable };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    res.json({
      success: true,
      directories,
      path: targetPath,
      parent: targetPath !== "/" ? path.dirname(targetPath) : null,
      platform: process.platform,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 保存最后浏览的目录路径
 */
app.post("/api/local/save-path", (req, res) => {
  try {
    const { path } = req.body;
    config.music.lastBrowse = path || "";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    res.json({ success: true, path: config.music.lastBrowse });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 创建新目录
 */
app.post("/api/local/mkdir", (req, res) => {
  try {
    const { name, parentPath } = req.body;
    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "Missing directory name" });
    }
    const basePath = parentPath || config.music.path;
    const newPath = path.join(basePath, name);
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }
    res.json({ success: true, path: newPath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 扫描目录获取音乐列表
 */
app.get("/api/local/scan", async (req, res) => {
  try {
    const {
      path: scanPath,
      sortBy = "name",
      page = 1,
      pageSize = 50,
    } = req.query;
    const targetPath = scanPath || config.music.path;
    const result = await localScanner.scan(targetPath, {
      sortBy,
      page: +page,
      pageSize: +pageSize,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 删除音乐文件
 */
app.post("/api/local/delete", (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No files specified" });
    }
    const deleted = [];
    const errors = [];
    files.forEach((file) => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          deleted.push(file);
        }
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    });
    res.json({ success: true, deleted, errors });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 批量播放本地文件
 */
app.post("/api/local/play-batch", async (req, res) => {
  try {
    const { files, shuffle = false } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No files specified" });
    }
    let playlist = files;
    if (shuffle) {
      playlist = files.sort(() => Math.random() - 0.5);
    }
    // 播放第一首
    await audioStreamer.playLocalFile(playlist[0]);
    res.json({ success: true, playlist, currentIndex: 0 });
  } catch (error) {
    const isEsp32Error =
      error.message && error.message.includes("No ACK after");
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: isEsp32Error ? "ESP32_CONNECTION_FAILED" : "PLAYBACK_ERROR",
    });
  }
});

/**
 * 播放本地文件
 */
app.get("/api/local/play", async (req, res) => {
  try {
    const { file, seek } = req.query;
    if (!file) {
      return res
        .status(400)
        .json({ success: false, error: "Missing file parameter" });
    }
    const seekTime = seek ? parseFloat(seek) : 0;
    await audioStreamer.playLocalFile(file, seekTime);
    res.json({ success: true, message: `Playing: ${file}` });
  } catch (error) {
    const isEsp32Error =
      error.message && error.message.includes("No ACK after");
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: isEsp32Error ? "ESP32_CONNECTION_FAILED" : "PLAYBACK_ERROR",
    });
  }
});

// ==================== 在线音乐 API ====================

/**
 * 搜索歌曲（新架构：搜索不依赖音源插件，由内置 MusicSearchSdk 实现）
 * 
 * 流程：
 * 1. MusicSearchSdk 多平台并行搜索（网易云+酷我+酷狗）
 * 2. 返回标准化歌曲列表（含 source 字段标识平台）
 * 3. 播放时通过 LX 插件获取 URL（搜索与播放解耦）
 */
app.get("/api/online/search", async (req, res) => {
  try {
    const { q, source, limit, page } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: "Missing search query" });
    }

    const options = {};
    if (source) options.source = source;
    if (limit) options.limit = parseInt(limit) || 30;
    if (page) options.page = parseInt(page) || 1;

    const results = await onlineApi.search(q, options);

    // 检查是否返回了错误对象
    if (results && results.success === false) {
      return res.json(results);
    }

    res.json({
      success: true,
      results,
      source: source || "multi",
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

/**
 * 获取可用搜索平台列表
 */
app.get("/api/online/providers", (req, res) => {
  const providers = onlineApi.searchSdk.getProviders();
  res.json({ success: true, providers, default: "multi" });
});

/**
 * 获取歌曲详情
 */
app.get("/api/online/song", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }
    const song = await onlineApi.getSongDetail(id);
    res.json({ success: true, song });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取歌曲播放链接
 * 优先通过 LX 插件获取（多源并发），其次 fallback 到旧 API
 */
app.get("/api/online/url", async (req, res) => {
  try {
    const { id, source, quality } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }

    const songInfo = { source: source || "wy", id: String(id) };
    const url = await onlineApi.getSongUrl(id, songInfo, quality || "320k");
    res.json({ success: true, url });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 播放在线歌曲
 */
app.get("/api/online/play", async (req, res) => {
  try {
    const { id, url } = req.query;
    // 优先使用直接传入的URL（搜索结果中已包含auth）
    let playUrl = url;
    if (!playUrl && id) {
      playUrl = await onlineApi.getSongUrl(id);
    }
    if (!playUrl) {
      return res
        .status(400)
        .json({ success: false, error: "Missing song url or id" });
    }
    await audioStreamer.playUrl(playUrl);
    res.json({ success: true, message: "Playing online song" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 下载歌曲
 * 通过 LX 插件获取下载链接，支持多源并发
 */
app.post("/api/online/download", async (req, res) => {
  try {
    const { id, title, artist, format, source, quality } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }
    const songInfo = { source: source || "wy" };
    const result = await downloader.download(id, {
      title, artist, format, quality: quality || "320k", songInfo,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取下载进度
 */
app.get("/api/online/download-progress", (req, res) => {
  const progress = downloader.getProgress();
  res.json({ success: true, progress });
});

// ==================== 推荐系统 API ====================

/**
 * 开始推荐播放
 */
app.post("/api/recommend/start", async (req, res) => {
  try {
    const { options } = req.body;
    const result = await recommender.start(options);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 停止推荐播放
 */
app.post("/api/recommend/stop", (req, res) => {
  recommender.stop();
  res.json({ success: true, message: "Recommendation stopped" });
});

/**
 * 获取推荐状态
 */
app.get("/api/recommend/status", (req, res) => {
  const status = recommender.getStatus();
  res.json({ success: true, status });
});

// ==================== 网络电台 API ====================

app.get("/api/radio/list", (req, res) => {
  res.json({ success: true, radios: config.radio.presets });
});

app.get("/api/radio/play", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res
        .status(400)
        .json({ success: false, error: "Missing radio url" });
    }
    await audioStreamer.playUrl(url);
    res.json({ success: true, message: "Playing radio stream" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 音源管理 ====================

// 检测可用的代理（Hermes/OpenClaw）和 LLM 配置
app.get("/api/source/agents", async (req, res) => {
  try {
    const { spawn } = await import("child_process");

    const checkAgent = (name, cmd) =>
      new Promise((resolve) => {
        const child = spawn(
          process.platform === "win32" ? "where" : "which",
          [cmd],
          { stdio: ["ignore", "pipe", "ignore"] }
        );
        let found = false;
        child.stdout.on("data", (chunk) => {
          if (!found && chunk.toString().trim()) found = true;
        });
        child.on("close", (code) =>
          resolve({
            name,
            command: cmd,
            available: found || code === 0,
            note: "CLI agent command may not support 'agent' subcommand",
          })
        );
        child.on("error", () =>
          resolve({ name, command: cmd, available: false, note: "Not found in PATH" })
        );
      });

    const [hermes, openclaw] = await Promise.all([
      checkAgent("Hermes", "hermes"),
      checkAgent("OpenClaw", process.platform === "win32" ? "openclaw.cmd" : "openclaw"),
    ]);

    const primary = hermes.available
      ? "Hermes"
      : openclaw.available
      ? "OpenClaw"
      : null;

    res.json({
      success: true,
      agents: [hermes, openclaw],
      primary,
      recommendation: hermes.available
        ? "Hermes CLI 可用"
        : openclaw.available
        ? "OpenClaw CLI 可用"
        : "未检测到 Hermes 或 OpenClaw CLI Agent。请安装并确保已加入 PATH。",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 实时日志 SSE ====================

// 广播日志到所有 WebSocket 客户端
function broadcastLog(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// ── 优先级3：配置缓存兜底函数 ──
// 从 source-config.json 加载上次成功的仓库，尝试加载 JS 插件
async function _tryConfigCache(sendLog, sendEvent, clientClosed) {
 sourceManager._ensureConfigLoaded();
 const cachedRepos = sourceManager.config.discoveredRepos;
 if (!Array.isArray(cachedRepos) || cachedRepos.length === 0) {
 sendLog("③ 配置缓存中也没有已知仓库", "warn");
 return false;
 }

 sendLog(`③ 从配置缓存加载 ${cachedRepos.length} 个已知仓库...`);
 sendEvent("progress", { progress: 85 });

 sourceManager._pluginsLoaded = false;
 const lxResult = await sourceManager.loadLxPluginsFromRepos(cachedRepos, {
 onLog: (msg) => { if (!clientClosed) sendLog(msg); },
 });

 if (lxResult.loaded > 0) {
 const platforms = sourceManager.getLxRuntime().getStatus().allSources;
 sendLog(`✅ 配置缓存插件加载成功: ${lxResult.loaded} 个，支持: ${platforms.join(", ")}`, "success");
 sendEvent("done", { success: true, sourceCount: lxResult.loaded, platforms, plugins: lxResult.plugins });
 return true;
 }

 sendLog("③ 配置缓存的仓库也没有可用插件", "warn");
 return false;
}

// SSE 流式加载 LX 插件（实时显示加载进度）
app.get("/api/source/fetch/stream", async (req, res) => {
 res.setHeader("Content-Type", "text/event-stream");
 res.setHeader("Cache-Control", "no-cache");
 res.setHeader("Connection", "keep-alive");
 res.setHeader("X-Accel-Buffering", "no");
 res.flushHeaders();
 let clientClosed = false;

 req.on("close", () => { clientClosed = true; });

 const sendEvent = (event, data) => {
 if (clientClosed) return;
 try {
 res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 } catch (e) { clientClosed = true; }
 };

 const sendLog = (msg, level = "info") => {
 console.log(`[Fetch-Stream] [${level}] ${msg}`);
 sendEvent("log", { message: msg, level, time: new Date().toLocaleTimeString() });
 };

 sendLog("🔄 开始刷新音源插件...");

 try {
 // 重置插件状态，重新加载
 sourceManager._pluginsLoaded = false;
 sourceManager.lxRuntime = new (await import("./lx-plugin-runtime.js")).LxPluginRuntime();
 onlineApi.lxRuntime = sourceManager.lxRuntime;
 downloader.setLxRuntime(sourceManager.lxRuntime);

 sendLog("① 通过 GitHub Search API 搜索最新音源仓库...");
 sendEvent("progress", { progress: 10 });

 // ── 优先级1：GitHub Search API + 加载 JS ──
 const result = await sourceManager.loadLxPlugins({
 onLog: (msg) => { if (!clientClosed) sendLog(msg); },
 });

 if (result.loaded > 0) {
 const platforms = sourceManager.getLxRuntime().getStatus().allSources;
 sendLog(`✅ GitHub 插件加载成功: ${result.loaded} 个，支持: ${platforms.join(", ")}`, "success");
 sendEvent("done", {
 success: true,
 sourceCount: result.loaded,
 platforms,
 plugins: result.plugins,
 });
 } else if (sourceManager._needAgentSearch) {
 // ── 优先级2：Hermes Agent 搜索 ──
 sendLog("② GitHub 插件不可用，尝试 Hermes Agent 搜索...", "warn");

 try {
 const fetchResult = await sourceManager.startFetch("Jay Chou");
 if (fetchResult.pluginCount) {
 sendLog(`✅ LX 插件已加载 (${fetchResult.pluginCount} 个)`, "success");
 sendEvent("done", { success: true, sourceCount: fetchResult.pluginCount });
 } else if (fetchResult.taskId) {
 sendLog(`🤖 Hermes Agent 正在搜索音源... (${fetchResult.taskId})`);
 const maxWait = 5 * 60 * 1000;
 const interval = 5000;
 let waited = 0;
 while (waited < maxWait && !clientClosed) {
 await new Promise((r) => setTimeout(r, interval));
 waited += interval;
 const progress = sourceManager.checkFetchProgress();
 if (progress.status === "success" && progress.sources?.length > 0) {
 // 仓库格式：Agent 返回的是仓库地址，需要加载插件
 if (progress._needsLxLoad && progress.repos?.length > 0) {
 sendLog(`✅ Agent 发现 ${progress.repos.length} 个仓库，正在加载插件...`, "success");
 sourceManager._pluginsLoaded = false;
 const lxResult = await sourceManager.loadLxPlugins({
 onLog: (msg) => { if (!clientClosed) sendLog(msg); },
 });
 if (lxResult.loaded > 0) {
 const platforms = sourceManager.getLxRuntime().getStatus().allSources;
 sendLog(`✅ Agent 插件加载成功: ${lxResult.loaded} 个，支持: ${platforms.join(", ")}`, "success");
 sendEvent("done", { success: true, sourceCount: lxResult.loaded, platforms, plugins: lxResult.plugins });
 } else {
 // Agent 返回的仓库 JS 也不能用 → 尝试配置缓存
 sendLog("⚠️ Agent 返回的仓库插件也不可用，尝试配置缓存...", "warn");
 const cacheResult = await _tryConfigCache(sendLog, sendEvent, clientClosed);
 if (cacheResult) { break; }
 sendEvent("done", { success: false, error: "所有来源均未加载出可用插件" });
 }
 } else {
 sendLog(`✅ Agent 发现 ${progress.sources.length} 个音源`, "success");
 sendEvent("done", { success: true, sourceCount: progress.sources.length, sources: progress.sources.slice(0, 5) });
 }
 break;
 }
 if (progress.status === "error") {
 // Agent 搜索失败 → 尝试配置缓存
 sendLog(`⚠️ Agent 搜索失败: ${progress.message}，尝试配置缓存...`, "warn");
 const cacheResult = await _tryConfigCache(sendLog, sendEvent, clientClosed);
 if (cacheResult) { break; }
 sendEvent("done", { success: false, error: progress.message });
 break;
 }
 sendEvent("progress", { progress: 10 + Math.round((waited / maxWait) * 60) });
 }
 // Agent 超时 → 尝试配置缓存
 if (!clientClosed) {
 sendLog("⚠️ Agent 搜索超时，尝试配置缓存...", "warn");
 const cacheResult = await _tryConfigCache(sendLog, sendEvent, clientClosed);
 if (!cacheResult) {
 sendEvent("done", { success: false, error: "Agent 搜索超时且配置缓存无可用仓库" });
 }
 }
 } else {
 sendEvent("done", { success: true, ...fetchResult });
 }
 } catch (agentErr) {
 // Agent 异常 → 尝试配置缓存
 sendLog(`⚠️ Agent 搜索异常: ${agentErr.message}，尝试配置缓存...`, "warn");
 const cacheResult = await _tryConfigCache(sendLog, sendEvent, clientClosed);
 if (!cacheResult) {
 sendEvent("done", { success: false, error: `Agent 异常: ${agentErr.message}` });
 }
 }
 } else {
 // GitHub 没搜到仓库且不需要 Agent → 尝试配置缓存
 sendLog("② GitHub 未找到仓库，尝试配置缓存...", "warn");
 const cacheResult = await _tryConfigCache(sendLog, sendEvent, clientClosed);
 if (!cacheResult) {
 sendEvent("done", { success: false, error: "未找到任何可用音源仓库" });
 }
 }
 } catch (err) {
 sendLog(`加载失败: ${err.message}`, "error");
 sendEvent("done", { success: false, error: err.message });
 }

  try { res.end(); } catch (e) {}
});

/**
 * 音源获取 API（新架构：任务模式）
 */

// 创建获取任务
app.post("/api/source/task/create", async (req, res) => {
  try {
    // 确保加载 LX 插件
    const result = await sourceManager.loadLxPlugins();
    res.json({ success: true, taskId: `lx-${Date.now()}`, pluginResult: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 启动任务执行
app.post("/api/source/task/:taskId/start", async (req, res) => {
  try {
    const result = await sourceManager.loadLxPlugins();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取任务状态（前端轮询）
app.get("/api/source/task/:taskId/status", (req, res) => {
  try {
    const status = sourceManager.getStatus();
    res.json({ success: true, task: { status: "completed", ...status } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 取消任务
app.post("/api/source/task/:taskId/cancel", (req, res) => {
  res.json({ success: true, task: { status: "cancelled" } });
});

// 新版接口：启动获取任务（优先 LLM Direct，回退 Hermes/OpenClaw CLI Agent）
app.post("/api/source/fetch/start", async (req, res) => {
try {
console.log('[Source] 启动音源获取任务...');
const { testSong = "周杰伦" } = req.body || {};

const result = await sourceManager.startFetch(testSong);

// Handle LLM Direct result (synchronous, sources already validated)
if (result.sources && Array.isArray(result.sources)) {
  const sources = result.sources;
  console.log(`[Source] LLM Direct 发现 ${sources.length} 个音源`);

  if (sources.length > 0) {
    onlineApi.setSource(sources[0]);
    console.log("[Source] 自动选择最佳音源:", sources[0].name);
  }

  return res.json({
    success: true,
    provider: result.provider || "LLM Direct",
    sourceCount: sources.length,
    sources: sources,
    message: result.message || `发现 ${sources.length} 个已验证音源`,
    isDirect: true,
  });
}

// Handle Hermes-style async result
res.json({ success: true, ...result });
} catch (error) {
console.error('[Source] 获取失败:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

// 新版接口：检查获取进度（前端轮询）
app.get("/api/source/fetch/progress", (req, res) => {
try {
const progress = sourceManager.checkFetchProgress();
res.json({ success: true, progress });
} catch (error) {
res.status(500).json({ success: false, error: error.message });
}
});

// 兼容旧接口：直接获取音源（阻塞式）
app.post("/api/source/fetch", async (req, res) => {
  try {
    const { testSong = "\u5468\u6770\u4f26" } = req.body || {};
    console.log('[Source] Agent fetching sources with "' + testSong + '"...');

    const sources = await sourceManager.fetchSources(testSong);
    return res.json({
      success: true,
      results: sources,
      message: "发现 " + sources.length + " 个可用音源"
    });
  } catch (error) {
    console.error("[Source] Fetch failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/source/candidates", (req, res) => {
  try {
    const candidates = sourceManager.getCandidates();
    res.json({ success: true, results: candidates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 保存用户选择的音源
 * POST /api/source/select
 */
app.post("/api/source/select", async (req, res) => {
  try {
    const { source } = req.body;
    if (!source || !source.searchUrl) {
      return res.status(400).json({ success: false, error: "Missing source info" });
    }
    
    const selected = sourceManager.selectSource(source);
    onlineApi.setSource(selected);
    
    res.json({ 
      success: true, 
      message: '已选择音源: ' + source.name,
      source
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取当前使用的音源
 * GET /api/source/current
 */
app.get("/api/source/current", (req, res) => {
  try {
    const source = sourceManager.getCurrentSource();
    res.json({ success: true, source });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 检查是否已有可用音源
 * GET /api/source/status
 * 包含 LX 插件状态
 */
app.get("/api/source/status", (req, res) => {
  try {
    const status = sourceManager.getStatus();

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== LX 插件 API ====================

/**
 * 获取 LX 插件信息
 * GET /api/lx/plugins
 */
app.get("/api/lx/plugins", (req, res) => {
  try {
    const runtime = sourceManager.getLxRuntime();
    const status = runtime.getStatus();
 res.json({
 success: true,
 pluginCount: status.pluginCount,
 allSources: status.allSources,
 plugins: status.plugins,
 preferredPlugin: status.preferredPlugin,
 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 重新加载 LX 插件
 * POST /api/lx/plugins/reload
 */
app.post("/api/lx/plugins/reload", async (req, res) => {
  try {
    sourceManager._pluginsLoaded = false;
    sourceManager.lxRuntime = new (await import("./lx-plugin-runtime.js")).LxPluginRuntime();
    // 更新 onlineApi 和 downloader 的 runtime 引用
    onlineApi.lxRuntime = sourceManager.lxRuntime;
    downloader.setLxRuntime(sourceManager.lxRuntime);

    const result = await sourceManager.loadLxPlugins();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 设置优先使用的 LX 插件
 * POST /api/lx/plugins/prefer
 */
app.post("/api/lx/plugins/prefer", (req, res) => {
 try {
 const { name } = req.body;
 const runtime = sourceManager.getLxRuntime();
 runtime.setPreferredPlugin(name || null);
 res.json({ success: true, preferredPlugin: name || null });
 } catch (error) {
 res.status(500).json({ success: false, error: error.message });
 }
});

/**
 * 切换 LX 插件启用/禁用
 * POST /api/lx/plugins/toggle
 */
app.post("/api/lx/plugins/toggle", (req, res) => {
 try {
 const { name, enabled } = req.body;
 if (!name) return res.status(400).json({ success: false, error: "Missing plugin name" });
 const runtime = sourceManager.getLxRuntime();
 const ok = runtime.togglePlugin(name, enabled);
 if (!ok) return res.status(404).json({ success: false, error: `Plugin "${name}" not found` });
 res.json({ success: true, name, enabled });
 } catch (error) {
 res.status(500).json({ success: false, error: error.message });
 }
});

/**
 * 通过 LX 插件获取播放链接
 * GET /api/lx/play-url?id=xxx&source=wy&quality=320k
 */
app.get("/api/lx/play-url", async (req, res) => {
  try {
    const { id, source = "wy", quality = "320k" } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }

    const runtime = sourceManager.getLxRuntime();
    const url = await runtime.getMusicUrl(
      { id: String(id), songmid: String(id), source },
      quality
    );
    res.json({ success: true, url, source, quality });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 旧搜索入口兼容 — 重定向到 /api/online/search
 * GET /api/source/search?q=xxx  →  /api/online/search?q=xxx
 * 
 * 新架构下搜索不依赖音源，直接由 MusicSearchSdk 实现
 */
app.get("/api/source/search", async (req, res) => {
  const { q, source, limit, page } = req.query;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (source) params.set("source", source);
  if (limit) params.set("limit", limit);
  if (page) params.set("page", page);
  res.redirect(301, `/api/online/search?${params.toString()}`);
});

app.get("/api/smart-source/config", async (req, res) => {
  try {
    const config = await smartSourceFinder.detectOpenClawConfig();
    res.json({
      success: true,
      config: {
        hasConfig: config.hasConfig || false,
        defaultModel: config.defaultModel || null,
        llmProvider: config.llmProvider || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 控制接口 ====================

app.post("/api/control/stop", (req, res) => {
 audioStreamer.stop();
 recommender.stop();
 res.json({ success: true, message: "Stopped" });
});

app.post("/api/control/pause", (req, res) => {
 audioStreamer.pause();
 res.json({ success: true });
});
app.post("/api/control/resume", (req, res) => {
 audioStreamer.resume();
 res.json({ success: true });
});
app.post("/api/control/volume", (req, res) => {
 const { volume } = req.body;
 if (typeof volume !== "number" || volume < 0 || volume > 100) {
 return res
 .status(400)
 .json({ success: false, error: "Invalid volume (0-100)" });
 }
 audioStreamer.setVolume(volume);
 res.json({ success: true, volume });
});

app.post("/api/control/seek", async (req, res) => {
 const { time } = req.body;
 if (typeof time !== "number" || time < 0) {
 return res.status(400).json({ success: false, error: "Invalid time" });
 }
 try {
 await audioStreamer.seek(time);
 res.json({ success: true, time });
 } catch (err) {
 res.status(500).json({ success: false, error: err.message });
 }
});

/**
 * 获取完整播放状态
 * GET /api/control/status
 */
app.get("/api/control/status", (req, res) => {
 const status = audioStreamer.getStatus();
 const recommendStatus = recommender.getStatus();
 const currentSource = sourceManager.getCurrentSource();
 
 res.json({
 success: true,
 status: {
 playing: status.playing || false,
 paused: status.paused || false,
 volume: status.volume || 100,
 currentTime: status.currentTime || 0,
 duration: status.duration || 0,
 track: status.track || null,
 recommend: recommendStatus,
 },
 source: currentSource,
 });
});

/**
 * 上一曲 (需要配合播放列表使用)
 * POST /api/control/prev
 */
app.post("/api/control/prev", async (req, res) => {
 try {
 // 检查是否有推荐播放列表
 const recommendStatus = recommender.getStatus();
 if (recommendStatus.running && recommendStatus.currentIndex > 0) {
 // 如果正在推荐播放，切换到上一首
 await recommender.prev();
 return res.json({ success: true, message: "Previous track" });
 }
 
 // 否则返回错误（需要客户端实现播放列表逻辑）
 res.json({ 
 success: false, 
 error: "No playlist available",
 hint: "Use recommendation mode for playlist navigation"
 });
 } catch (err) {
 res.status(500).json({ success: false, error: err.message });
 }
});

/**
 * 下一曲
 * POST /api/control/next
 */
app.post("/api/control/next", async (req, res) => {
 try {
 // 检查是否有推荐播放列表
 const recommendStatus = recommender.getStatus();
 if (recommendStatus.running) {
 await recommender.next();
 return res.json({ success: true, message: "Next track" });
 }
 
 res.json({ 
 success: false, 
 error: "No playlist available",
 hint: "Use recommendation mode for playlist navigation"
 });
 } catch (err) {
 res.status(500).json({ success: false, error: err.message });
 }
});

app.get("/api/status", (req, res) => {
 const status = audioStreamer.getStatus();
 const recommendStatus = recommender.getStatus();
 res.json({
 success: true,
 status: { ...status, recommend: recommendStatus },
 });
});

app.post("/api/esp32/target", (req, res) => {
  const { host, port } = req.body;
  if (host) config.esp32.host = host;
  if (port) config.esp32.port = port;
  res.json({ success: true, esp32: config.esp32 });
});

// ==================== WebSocket 实时状态 ====================

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");
  ws.send(JSON.stringify({ type: "status", data: audioStreamer.getStatus() }));
  const interval = setInterval(() => {
    ws.send(
      JSON.stringify({
        type: "status",
        data: {
          ...audioStreamer.getStatus(),
          recommend: recommender.getStatus(),
        },
      }),
    );
  }, 1000);
  ws.on("close", () => {
    clearInterval(interval);
    console.log("[WS] Client disconnected");
  });
});

audioStreamer.onStatusChange((status) => {
  wss.clients.forEach((client) => {
    client.send(
      JSON.stringify({
        type: "status",
        data: { ...status, recommend: recommender.getStatus() },
      }),
    );
  });
});

// ==================== 启动服务 ====================
const PORT = config.server.port || 3000;

// 处理端口占用错误
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[Server] Port ${PORT} is already in use. Is another instance running?`,
    );
    console.error(`[Server] Try: lsof -i :${PORT} or kill existing process`);
    process.exit(1);
  } else {
    console.error("[Server] Error:", err.message);
    throw err;
  }
});

// 处理 WebSocket 服务器错误
wss.on("error", (err) => {
  console.error("[WS] WebSocket Server error:", err.message);
});

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(` Web Audio Streamer v2.0`);
  console.log(`=================================`);
  console.log(` Server: http://localhost:${PORT}`);
  console.log(` Music Dir: ${config.music.path}`);
  console.log(` ESP32: ${config.esp32.host}:${config.esp32.port}`);
  console.log(
    ` Audio: ${config.audio.sampleRate}Hz / ${config.audio.bitsPerSample}bit`,
  );
  console.log(`=================================`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  audioStreamer.stop();
  recommender.stop();
  server.close();
  process.exit(0);
});

// 处理未捕获的异常
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught Exception:", err.message);
  console.error(err.stack);
  // Don't exit - log and continue for better resilience
  // process.exit(1);
});

// Only catch unhandled rejections that are actual errors, not benign ones
let unhandledRejectionCount = 0;
const MAX_UNHANDLED_REJECTIONS = 10;
process.on("unhandledRejection", (reason, promise) => {
  unhandledRejectionCount++;

  // Log details for debugging
  const reasonStr = reason instanceof Error
    ? `${reason.message}\n${reason.stack}`
    : String(reason);
  console.error(`[Server] Unhandled Rejection #${unhandledRejectionCount}:`, reasonStr);

  // Only exit if we hit too many unhandled rejections (suggests a systemic issue)
  if (unhandledRejectionCount > MAX_UNHANDLED_REJECTIONS) {
    console.error("[Server] Too many unhandled rejections, exiting...");
    process.exit(1);
  }
});
