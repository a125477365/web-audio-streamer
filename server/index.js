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
import { HermesSourceApi } from "./hermes-source-api.js";

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
const onlineApi = new OnlineMusicApi(config);
const radioPlayer = new RadioPlayer(config);
const downloader = new MusicDownloader(config);
const recommender = new RecommendationEngine(config);
const smartSourceFinder = new SmartSourceFinder(config);
const sourceManager = new SourceManager();
const hermesSourceApi = new HermesSourceApi();
sourceManager.isFirstInstall = () => false;

// Auto-detect and configure best available source on startup
const DETECTION_TIMEOUT = 30000;
const startupPromise = (async () => {
  try {
    const status = sourceManager.getStatus();

    if (status.currentSource) {
      onlineApi.setSource(status.currentSource);
      console.log("[Source] Loaded saved source:", status.currentSource.name);
      return;
    }

    if (status.candidates?.length > 0) {
      const best = status.candidates.reduce((a, b) =>
        (a.aiScore || 0) > (b.aiScore || 0) ? a : b
      );
      sourceManager.selectSource(best);
      onlineApi.setSource(best);
      console.log("[Source] Auto-selected best candidate:", best.name);
      return;
    }

    console.log("[Source] No saved source found. Will auto-fetch on first search.");
  } catch (e) {
    console.warn("[Source] Startup source detection failed:", e.message);
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
 * 搜索歌曲
 * 如果搜索失败，自动通过 Hermes API 重新获取音源
 */
app.get("/api/online/search", async (req, res) => {
 try {
 const { q, type = "song" } = req.query;
 if (!q) {
 return res
 .status(400)
 .json({ success: false, error: "Missing search query" });
 }

 // 检查是否有可用音源
 if (!sourceManager.hasAvailableSource()) {
 console.log("[Search] 无可用音源，自动获取中...");
 const sources = await sourceManager.fetchSources(q);
 if (sources && sources.length > 0) {
 const firstSource = sources[0];
 onlineApi.setSource(firstSource);
 console.log("[Search] 自动选择音源:", firstSource.name);
 }
 }

 let results;
 let searchError = null;

 try {
 results = await onlineApi.search(q, type);
 } catch (err) {
 searchError = err;
 console.log("[Search] 搜索失败:", err.message);
 }

 // 如果搜索失败或结果为空，尝试重新获取音源后再搜索一次
 if (searchError || (Array.isArray(results) && results.length === 0)) {
 console.log("[Search] 搜索失败或无结果，重新获取音源后重试...");
 
 try {
 const sources = await sourceManager.refreshSourcesOnFailure(q);
 if (sources && sources.length > 0) {
 const firstSource = sources[0];
 onlineApi.setSource(firstSource);
 console.log("[Search] 重新获取音源:", firstSource.name);
 
 // 重新搜索
 results = await onlineApi.search(q, type);
 searchError = null;
 }
 } catch (refreshErr) {
 console.log("[Search] 重新获取音源失败:", refreshErr.message);
 }
 }

 // 返回结果
 if (searchError) {
 return res.json({
 success: false,
 error: searchError.message,
 hint: "搜索失败，已尝试重新获取音源",
 });
 }

 // 检查是否返回了错误提示
 if (results && results.success === false) {
 return res.json(results);
 }

 res.json({ success: true, results });
 } catch (error) {
 res.json({
 success: false,
 error: error.message,
 hint: "请把以下内容发给管理员：",
 fixMessage: "Web Audio Streamer 搜索失败。",
 });
 }
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
 */
app.get("/api/online/url", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }
    const url = await onlineApi.getSongUrl(id);
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
 */
app.post("/api/online/download", async (req, res) => {
  try {
    const { id, title, artist, format } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: "Missing song id" });
    }
    const result = await downloader.download(id, { title, artist, format });
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

// 检测可用的代理（Hermes/OpenClaw）
app.get("/api/source/agents", async (req, res) => {
  try {
    const { spawn } = await import("child_process");
    const results = {};

    const checkAgent = (name, cmd) =>
      new Promise((resolve) => {
        const child = spawn(process.platform === "win32" ? "where" : "which", [cmd], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let found = false;
        child.stdout.on("data", (chunk) => {
          if (!found && chunk.toString().trim()) found = true;
        });
        child.on("close", (code) => resolve({ name, command: cmd, available: found || code === 0 }));
        child.on("error", () => resolve({ name, command: cmd, available: false }));
      });

    const [hermes, openclaw] = await Promise.all([
      checkAgent("Hermes", "hermes"),
      checkAgent("OpenClaw", "openclaw"),
    ]);

    res.json({
      success: true,
      agents: [hermes, openclaw],
      primary: hermes.available ? "Hermes" : openclaw.available ? "OpenClaw" : null,
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

// SSE 流式获取音源（实时显示 Agent 交互日志）
app.get("/api/source/fetch/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sendLog = (msg, level = "info") => {
    sendEvent("log", { message: msg, level, time: new Date().toLocaleTimeString() });
    console.log(`[Fetch-Stream] [${level}] ${msg}`);
  };

  sendLog("开始检测可用 AI Provider...");

  const providers = sourceManager._getAvailableAIProviders();
  const hermesAvailable = false;
  const aiAvailable = providers.length > 0;

  if (providers.length > 0) {
    const names = providers.map(p => p.name).join(", ");
    sendLog(`发现 ${providers.length} 个 AI Provider: ${names}`);
  } else {
    sendLog("未检测到任何 AI API Key");
  }

  if (!hermesAvailable && !aiAvailable) {
    sendLog("无可用 AI Provider，无法获取音源！", "error");
    sendEvent("done", { success: false, error: "No AI provider available" });
    res.end();
    return;
  }

  sendLog(`将使用 ${hermesAvailable && aiAvailable ? "Hermes + AI 并行" : hermesAvailable ? "Hermes" : "AI"} 获取音源...`);

  const allSources = [];

  if (hermesAvailable) {
    sendLog("正在调用 Hermes...");
    try {
      const hermesResult = await sourceManager._fetchSourcesWithHermesSSE(
        "周杰伦",
        (msg, level) => { sendLog(`[Hermes] ${msg}`, level); }
      );
      sendLog(`Hermes 返回 ${hermesResult?.length || 0} 个候选音源`);
      sendEvent("hermesResult", { sources: hermesResult || [] });
      if (Array.isArray(hermesResult)) allSources.push(...hermesResult);
    } catch (err) {
      sendLog(`Hermes 执行失败: ${err.message}`, "error");
    }
  }

  if (aiAvailable) {
    sendLog("正在调用 AI 发现...");
    try {
      const openclawResult = await sourceManager._fetchSourcesWithOpenClawSSE(
        "Jay Chou",
        (msg, level) => { sendLog(`[AI] ${msg}`, level); }
      );
      sendLog(`AI 返回 ${openclawResult?.length || 0} 个候选音源`);
      sendEvent("openclawResult", { sources: openclawResult || [] });
      if (Array.isArray(openclawResult)) allSources.push(...openclawResult);
    } catch (err) {
      sendLog(`AI 执行失败: ${err.message}`, "error");
    }
  }

  // 合并去重并保存
  if (allSources.length > 0) {
    allSources.sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
    const seen = new Set();
    const deduped = allSources.filter((s) => {
      if (!s.searchUrl || seen.has(s.searchUrl)) return false;
      seen.add(s.searchUrl);
      return true;
    });
    sourceManager.saveSourcesFromProgress({
      status: "success",
      sources: deduped,
      timestamp: new Date().toISOString(),
      provider: hermesAvailable && aiAvailable ? "Hermes+AI" : hermesAvailable ? "Hermes" : "AI"
    });
    sendLog(`共发现 ${deduped.length} 个有效音源，已保存`);
    sendEvent("done", { success: true, sourceCount: deduped.length });
  } else {
    sendLog("Hermes 和 AI 均未返回有效音源", "error");
    sendEvent("done", { success: false, error: "No sources returned from any provider" });
  }
  res.end();
});

/**
 * 音源获取 API（新架构：任务模式）
 */

// 创建获取任务
app.post("/api/source/task/create", (req, res) => {
  try {
    const taskId = hermesSourceApi.createTask();
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 启动任务执行
app.post("/api/source/task/:taskId/start", async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await hermesSourceApi.startTask(taskId);
    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取任务状态（前端轮询）
app.get("/api/source/task/:taskId/status", (req, res) => {
  try {
    const { taskId } = req.params;
    const task = hermesSourceApi.getTaskStatus(taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: "任务不存在" });
    }
    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 取消任务
app.post("/api/source/task/:taskId/cancel", (req, res) => {
  try {
    const { taskId } = req.params;
    const task = hermesSourceApi.cancelTask(taskId);
    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 新版接口：启动获取任务（异步，支持并行获取）
app.post("/api/source/fetch/start", async (req, res) => {
try {
console.log('[Source] 启动音源获取任务...');
const { testSong = "周杰伦", useParallel = true } = req.body || {};

let result;
if (useParallel) {
  try {
    const sources = await sourceManager.fetchSourcesParallel(testSong);
      if (sources.length > 0) {
        const topSources = sources.slice(0, 10).map((s, i) => ({ ...s, id: `source_${String(i+1).padStart(3,"0")}` }));
        sourceManager.saveSourcesFromProgress({ status: "success", sources: topSources, timestamp: new Date().toISOString(), provider: "Hermes+AI" });
        return res.json({ success: true, taskId: "parallel", provider: "Hermes+AI", sources: topSources, message: `通过 Hermes + AI 并行获取发现 ${sources.length} 个音源` });
    }
  } catch (parallelErr) {
    console.log('[Source] Parallel fetch failed, falling back to Hermes:', parallelErr.message);
  }
}

result = await sourceManager.hermesApi.startFetch(testSong);
res.json({ success: true, ...result });
} catch (error) {
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
 */
app.get("/api/source/status", (req, res) => {
  try {
    const status = sourceManager.getStatus();
    
    res.json({ 
      success: true, 
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 使用已保存的音源进行搜索
 * GET /api/source/search?q=xxx
 */
app.get("/api/source/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: "Missing search query" });
    }

    if (!sourceManager.hasCandidates()) {
      return res.json({ 
        success: false, 
        needFetch: true,
        message: "No realtime-discovered source list found. Run source discovery first."
      });
    }

    if (!sourceManager.hasAvailableSource()) {
      return res.json({
        success: false,
        needSelect: true,
        candidates: sourceManager.getCandidates(),
        message: "Please choose one of the discovered sources before searching."
      });
      return res.json({ 
        success: false, 
        needFetch: true,
        message: "请先点击'智能获取音源'按钮获取可用音源"
      });
    }

    const currentSource = sourceManager.getCurrentSource();
    onlineApi.setSource(currentSource);
    
    let results = await onlineApi.search(q);
    if (results && results.success === false) {
      return res.json(results);
    }
    
    if (Array.isArray(results) && results.length > 0) {
      results = sourceManager.probeSearchResults(results, 10);
    }
    
    if (Array.isArray(results) && results.length === 0) {
      return res.json({
        success: false,
        needRefresh: true,
        message: "The selected source returned no playable results. Refresh the source list and choose again."
      });
    }

    res.json({ 
      success: true, 
      source: currentSource, 
      results 
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
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
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Server] Unhandled Rejection:", reason);
});
