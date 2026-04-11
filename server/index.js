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
const onlineApi = new OnlineMusicApi(config);
const radioPlayer = new RadioPlayer(config);
const downloader = new MusicDownloader(config);
const recommender = new RecommendationEngine(config);
const smartSourceFinder = new SmartSourceFinder(config);
const sourceManager = new SourceManager();

// 启动时注入已保存的音源，确保重启后搜索立即生效
try {
	const saved = sourceManager.getCurrentSource();
	if (saved) {
		onlineApi.setSource(saved);
		console.log('[Source] Loaded saved source on boot:', saved.name);
	}
} catch (e) {
	console.warn('[Source] Failed to load saved source on boot:', e.message);
}

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
    res
      .status(500)
      .json({
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
    res
      .status(500)
      .json({
        success: false,
        error: error.message,
        errorType: isEsp32Error ? "ESP32_CONNECTION_FAILED" : "PLAYBACK_ERROR",
      });
  }
});

// ==================== 在线音乐 API ====================

/**
 * 搜索歌曲
 */
app.get("/api/online/search", async (req, res) => {
  try {
    const { q, type = "song" } = req.query;
    if (!q) {
      return res
        .status(400)
        .json({ success: false, error: "Missing search query" });
    }
    const results = await onlineApi.search(q, type);
    // 检查是否返回了错误提示
    if (results && results.success === false) {
      return res.json(results);
    }
    res.json({ success: true, results });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      hint: "请把以下内容发给 OpenClaw 进行修复：",
      fixMessage: "Web Audio Streamer 搜索失败，请自动帮我修复。",
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

/**
 * 智能测试所有音源，返回前5个最佳（使用AI评分）
 * POST /api/source/test
 * Body: { testSong: "周杰伦" }
 */
app.post("/api/source/test", async (req, res) => {
	try {
		const { testSong = "周杰伦" } = req.body;
		console.log(`[Source] Testing sources with "${testSong}"...`);
		let results = await sourceManager.testAndRankSources(testSong);
		// 行业标准策略：候选必须“可用且完整”，再剔除试听/短片段
		results = (results || [])
			.filter(r => r.success !== false)
			.filter(r => r.resultCount > 0)
			.filter(r => r.hasFullUrl)
			.filter(r => !r.isPreview);
		res.json({ success: true, results });
	} catch (error) {
		console.error("[Source] Test failed:", error.message);
		res.status(500).json({ success: false, error: error.message });
	}
});

/**
 * 保存用户选择的音源
 * POST /api/source/select
 * Body: { source: {...} }
 */
app.post("/api/source/select", async (req, res) => {
	try {
		const { source } = req.body;
		if (!source || !source.name) {
			return res.status(400).json({ success: false, error: "Missing source info" });
		}
		const saved = sourceManager.saveSource(source);
		// 立即注入 OnlineMusicApi，使本次进程立刻生效
		onlineApi.setSource(source);
		if (saved) {
			res.json({ success: true, message: `已选择音源: ${source.name}` });
		} else {
			res.status(500).json({ success: false, error: "Failed to save source" });
		}
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

/**
 * 获取上次测试得到的 Top5 音源（长期保存）
 */
app.get('/api/source/top', (req, res) => {
	try {
		const top = sourceManager.getTopSources();
		res.json({ success: true, results: top });
	} catch (e) {
		res.status(500).json({ success: false, error: e.message });
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
 * 使用已保存的音源进行搜索
 * GET /api/source/search?q=xxx
 */
app.get("/api/source/search", async (req, res) => {
	try {
		const { q } = req.query;
		if (!q) {
			return res.status(400).json({ success: false, error: "Missing search query" });
		}

		// 获取当前音源
		let currentSource = sourceManager.getCurrentSource();
		
		// 如果没有保存的音源，先测试
		if (!currentSource) {
			console.log("[Source] No saved source, testing...");
			const results = await sourceManager.testAndRankSources(q);
			if (results.length > 0) {
				currentSource = results[0].sourceInfo;
				sourceManager.saveSource(currentSource);
				onlineApi.setSource(currentSource);
			}
		}

		// 确保 OnlineMusicApi 使用的是当前音源
		onlineApi.setSource(currentSource);

		// 使用当前音源搜索
		const results = await onlineApi.search(q);
		
		res.json({ 
			success: true, 
			source: currentSource,
			results 
		});
	} catch (error) {
		res.json({ success: false, error: error.message });
	}
});

// ==================== 旧的智能音源搜索（保留兼容） ====================
/**
 * 自动检测并测试音源
 */
app.get("/api/smart-source/test", async (req, res) => {
  try {
    const { song = "周杰伦" } = req.query;
    const results = await smartSourceFinder.testAndRankSources(song);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取最佳音源
 */
app.get("/api/smart-source/best", (req, res) => {
  const best = smartSourceFinder.getBestSource();
  res.json({ success: true, bestSource: best });
});

/**
 * 使用最佳音源搜索
 */
app.get("/api/smart-source/search", async (req, res) => {
  try {
    const { q, type = "song" } = req.query;
    if (!q) {
      return res
        .status(400)
        .json({ success: false, error: "Missing search query" });
    }

    // 先测试音源（如果还没有测试过）
    if (smartSourceFinder.testResults.length === 0) {
      await smartSourceFinder.testAndRankSources(q);
    }

    const best = smartSourceFinder.getBestSource();
    if (!best) {
      return res
        .status(500)
        .json({ success: false, error: "No available source" });
    }

    // 使用最佳音源搜索
    const results = await onlineApi.search(q, type);

    // 附加音源信息
    res.json({
      success: true,
      source: best.source,
      sourceScore: best.score,
      results,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

/**
 * 手动检测OpenClaw配置
 */
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
		console.error(`[Server] Port ${PORT} is already in use. Is another instance running?`);
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
