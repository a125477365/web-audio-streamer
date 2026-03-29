/**
 * Web Audio Streamer - Main Server
 * 
 * 提供音乐播放、转码、UDP 流发送功能
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { AudioStreamer } from './audio-streamer.js';
import { LocalMusicScanner } from './local-music.js';
import { OnlineMusicApi } from './online-music.js';
import { RadioPlayer } from './radio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载配置
const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../config/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web-ui')));

// 初始化模块
const audioStreamer = new AudioStreamer(config);
const localScanner = new LocalMusicScanner(config);
const onlineApi = new OnlineMusicApi(config);
const radioPlayer = new RadioPlayer(config);

// ==================== 本地音乐 API ====================

/**
 * 扫描本地音乐文件夹
 */
app.get('/api/local/scan', async (req, res) => {
  try {
    const { path: scanPath } = req.query;
    const files = await localScanner.scan(scanPath);
    res.json({ success: true, files, count: files.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取已扫描的音乐文件列表
 */
app.get('/api/local/files', (req, res) => {
  try {
    const files = localScanner.getFiles();
    res.json({ success: true, files });
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
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

// ==================== 网络电台 API ====================

/**
 * 获取预设电台列表
 */
app.get('/api/radio/list', (req, res) => {
  res.json({ success: true, radios: config.radio.presets });
});

/**
 * 播放网络电台
 */
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

/**
 * 停止播放
 */
app.post('/api/control/stop', (req, res) => {
  audioStreamer.stop();
  res.json({ success: true, message: 'Stopped' });
});

/**
 * 设置音量 (0-100)
 */
app.post('/api/control/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 100) {
    return res.status(400).json({ success: false, error: 'Invalid volume (0-100)' });
  }

  audioStreamer.setVolume(volume);
  res.json({ success: true, volume });
});

/**
 * 获取当前状态
 */
app.get('/api/status', (req, res) => {
  const status = audioStreamer.getStatus();
  res.json({ success: true, status });
});

/**
 * 设置 ESP32 目标地址
 */
app.post('/api/esp32/target', (req, res) => {
  const { host, port } = req.body;
  if (host) config.esp32.host = host;
  if (port) config.esp32.port = port;
  
  res.json({ success: true, esp32: config.esp32 });
});

// ==================== WebSocket 实时状态 ====================

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  
  // 发送当前状态
  ws.send(JSON.stringify({ type: 'status', data: audioStreamer.getStatus() }));

  // 定期发送状态更新
  const interval = setInterval(() => {
    ws.send(JSON.stringify({ type: 'status', data: audioStreamer.getStatus() }));
  }, 1000);

  ws.on('close', () => {
    clearInterval(interval);
    console.log('[WS] Client disconnected');
  });
});

// 广播状态更新
audioStreamer.onStatusChange((status) => {
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: 'status', data: status }));
  });
});

// ==================== 启动服务 ====================

const PORT = config.server.port || 3000;

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  Web Audio Streamer v1.0`);
  console.log(`=================================`);
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  ESP32:  ${config.esp32.host}:${config.esp32.port}`);
  console.log(`  Audio:  ${config.audio.sampleRate}Hz / ${config.audio.bitsPerSample}bit`);
  console.log(`=================================`);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  audioStreamer.stop();
  server.close();
  process.exit(0);
});
