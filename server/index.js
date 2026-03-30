/**
 * Web Audio Streamer - Main Server
 * 支持播放、下载、推荐功能
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import https from 'https';

import { AudioStreamer } from './audio-streamer.js';
import { LocalMusicScanner } from './local-music.js';
import { OnlineMusicApi } from './online-music.js';
import { RadioPlayer } from './radio.js';
import { MusicDownloader } from './downloader.js';
import { RecommendationEngine } from './recommendation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载配置
const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../config/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// 确保 music 目录存在
const musicDir = path.resolve(__dirname, '../music');
if (!fs.existsSync(musicDir)) {
  fs.mkdirSync(musicDir, { recursive: true });
  console.log('[Server] Created music directory:', musicDir);
}
config.music.downloadPath = musicDir;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web-ui')));
app.use('/music', express.static(musicDir));

// 初始化模块
const audioStreamer = new AudioStreamer(config);
const localScanner = new LocalMusicScanner(config);
const onlineApi = new OnlineMusicApi(config);
const radioPlayer = new RadioPlayer(config);
const downloader = new MusicDownloader(config);
const recommender = new RecommendationEngine(config);

// ==================== 本地音乐 API ====================

/**
 * 获取音乐目录列表
 */
app.get('/api/local/directories', (req, res) => {
  try {
    const musicPath = config.music.downloadPath;
    const dirs = [{ path: musicPath, name: '默认音乐目录' }];
    
    // 扫描子目录
    if (fs.existsSync(musicPath)) {
      const items = fs.readdirSync(musicPath, { withFileTypes: true });
      items.forEach(item => {
        if (item.isDirectory()) {
          dirs.push({
            path: path.join(musicPath, item.name),
            name: item.name
          });
        }
      });
    }
    
    res.json({ success: true, directories: dirs, musicPath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 创建新目录
 */
app.post('/api/local/mkdir', (req, res) => {
  try {
    const { name, parentPath } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Missing directory name' });
    }
    
    const basePath = parentPath || config.music.downloadPath;
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
app.get('/api/local/scan', async (req, res) => {
  try {
    const { path: scanPath, sortBy = 'name', page = 1, pageSize = 50 } = req.query;
    const targetPath = scanPath || config.music.downloadPath;
    
    const result = await localScanner.scan(targetPath, { sortBy, page: +page, pageSize: +pageSize });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 删除音乐文件
 */
app.post('/api/local/delete', (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files specified' });
    }
    
    const deleted = [];
    const errors = [];
    
    files.forEach(file => {
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
app.post('/api/local/play-batch', async (req, res) => {
  try {
    const { files, shuffle = false } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files specified' });
    }
    
    let playlist = files;
    if (shuffle) {
      playlist = files.sort(() => Math.random() - 0.5);
    }
    
    // 播放第一首
    await audioStreamer.playLocalFile(playlist[0]);
    
    res.json({ success: true, playlist, currentIndex: 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 播放本地文件
 */
app.get('/api/local/play', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) {
      return res.status(400).json({ success: false, error: 'Missing file parameter' });
    }
    await audioStreamer.playLocalFile(file);
    res.json({ success: true, message: `Playing: ${file}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 在线音乐 API ====================

/**
 * 搜索歌曲
 */
app.get('/api/online/search', async (req, res) => {
  try {
    const { q, type = 'song' } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: 'Missing search query' });
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
      hint: '请把以下内容发给 OpenClaw 进行修复：',
      fixMessage: 'Web Audio Streamer 搜索失败，请自动帮我修复。'
    });
  }
});

/**
 * 获取歌曲详情
 */
app.get('/api/online/song', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing song id' });
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
app.get('/api/online/url', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing song id' });
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
app.get('/api/online/play', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing song id' });
    }
    const url = await onlineApi.getSongUrl(id);
    await audioStreamer.playUrl(url);
    res.json({ success: true, message: 'Playing online song' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 下载歌曲
 */
app.post('/api/online/download', async (req, res) => {
  try {
    const { id, title, artist, format } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing song id' });
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
app.get('/api/online/download-progress', (req, res) => {
  const progress = downloader.getProgress();
  res.json({ success: true, progress });
});

// ==================== 推荐系统 API ====================

/**
 * 开始推荐播放
 */
app.post('/api/recommend/start', async (req, res) => {
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
app.post('/api/recommend/stop', (req, res) => {
  recommender.stop();
  res.json({ success: true, message: 'Recommendation stopped' });
});

/**
 * 获取推荐状态
 */
app.get('/api/recommend/status', (req, res) => {
  const status = recommender.getStatus();
  res.json({ success: true, status });
});

// ==================== 网络电台 API ====================

app.get('/api/radio/list', (req, res) => {
  res.json({ success: true, radios: config.radio.presets });
});

app.get('/api/radio/play', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing radio url' });
    }
    await audioStreamer.playUrl(url);
    res.json({ success: true, message: 'Playing radio stream' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 控制接口 ====================

app.post('/api/control/stop', (req, res) => {
  audioStreamer.stop();
  recommender.stop();
  res.json({ success: true, message: 'Stopped' });
});

app.post('/api/control/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 100) {
    return res.status(400).json({ success: false, error: 'Invalid volume (0-100)' });
  }
  audioStreamer.setVolume(volume);
  res.json({ success: true, volume });
});

app.get('/api/status', (req, res) => {
  const status = audioStreamer.getStatus();
  const recommendStatus = recommender.getStatus();
  res.json({ success: true, status: { ...status, recommend: recommendStatus } });
});

app.post('/api/esp32/target', (req, res) => {
  const { host, port } = req.body;
  if (host) config.esp32.host = host;
  if (port) config.esp32.port = port;
  res.json({ success: true, esp32: config.esp32 });
});

// ==================== WebSocket 实时状态 ====================

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  
  ws.send(JSON.stringify({ type: 'status', data: audioStreamer.getStatus() }));
  
  const interval = setInterval(() => {
    ws.send(JSON.stringify({ type: 'status', data: { ...audioStreamer.getStatus(), recommend: recommender.getStatus() } }));
  }, 1000);
  
  ws.on('close', () => {
    clearInterval(interval);
    console.log('[WS] Client disconnected');
  });
});

audioStreamer.onStatusChange((status) => {
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: 'status', data: { ...status, recommend: recommender.getStatus() } }));
  });
});

// ==================== 启动服务 ====================

const PORT = config.server.port || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(` Web Audio Streamer v2.0`);
  console.log(`=================================`);
  console.log(` Server: http://localhost:${PORT}`);
  console.log(` Music Dir: ${config.music.downloadPath}`);
  console.log(` ESP32: ${config.esp32.host}:${config.esp32.port}`);
  console.log(` Audio: ${config.audio.sampleRate}Hz / ${config.audio.bitsPerSample}bit`);
  console.log(`=================================`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  audioStreamer.stop();
  recommender.stop();
  server.close();
  process.exit(0);
});
