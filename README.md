# Web Audio Streamer

基于 Web 的音乐播放器，支持将音频流发送到 ESP32 设备。

## 一键安装

### OpenClaw 自动安装

直接告诉 OpenClaw：

```
请安装 web-audio-streamer
```

### 命令行安装

```bash
curl -fsSL https://raw.githubusercontent.com/a125477365/web-audio-streamer/main/install.sh | bash
```

安装脚本会自动：
- ✅ 检查并安装 Node.js
- ✅ 检查并安装 FFmpeg
- ✅ 克隆项目
- ✅ 安装所有依赖
- ✅ 启动服务

## 功能特性

### 1. 本地音乐播放
- 扫描指定文件夹中的音乐文件
- 支持格式：MP3, FLAC, WAV, AAC, OGG, M4A
- 自动提取元数据（艺术家、专辑、封面）
- 播放列表管理

### 2. 在线音乐（网易云音乐）
- 搜索歌曲、专辑、艺术家
- 获取歌曲播放链接
- 播放热门歌单

### 3. 网络电台
- 支持流媒体 URL（HLS, ICY）
- 预设热门电台列表
- 自定义添加电台

### 4. ESP32 音频流发送
- FFmpeg 实时转码为 PCM
- UDP 发送到 ESP32
- 支持采样率：44.1kHz - 192kHz
- 支持位深：16bit, 24bit, 32bit

## 系统架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────┐
│  Web 播放器 UI  │ ←→  │   后端服务      │ →→  │    ESP32    │
│  (浏览器)       │     │   (Node.js)     │ UDP │  S/PDIF输出 │
└─────────────────┘     └─────────────────┘     └─────────────┘
                               │
              ┌────────────────┼────────────────┐
              ↓                ↓                ↓
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ 本地音乐 │    │ 在线API  │    │ 网络电台 │
        │ 文件扫描 │    │ 网易云等 │    │ 流媒体   │
        └──────────┘    └──────────┘    └──────────┘
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 安装 FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

**Windows:**
从 https://ffmpeg.org 下载并添加到 PATH。

### 配置

编辑 `config/config.json`：

```json
{
  "server": {
    "port": 3000
  },
  "esp32": {
    "host": "192.168.6.89",
    "port": 8000
  },
  "audio": {
    "sampleRate": 192000,
    "bitsPerSample": 32,
    "channels": 2
  },
  "music": {
    "localPaths": ["/path/to/music"]
  }
}
```

### 启动服务

```bash
npm run dev
```

打开浏览器访问：http://localhost:3000

## API 接口

### 本地音乐

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/local/scan` | GET | 扫描音乐文件夹 |
| `/api/local/files` | GET | 获取音乐文件列表 |
| `/api/local/play?file=xxx` | GET | 播放本地文件 |

### 在线音乐

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/online/search?q=xxx` | GET | 搜索歌曲 |
| `/api/online/song?id=xxx` | GET | 获取歌曲详情 |
| `/api/online/play?id=xxx` | GET | 播放在线歌曲 |

### 网络电台

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/radio/list` | GET | 获取电台列表 |
| `/api/radio/play?url=xxx` | GET | 播放电台流 |

### 控制

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/control/stop` | POST | 停止播放 |
| `/api/control/volume` | POST | 设置音量 |

## ESP32 配置

确保 ESP32 已烧录音频接收固件（esp32-audio-bridge 项目）。

ESP32 配置：
- IP: 通过 Web 配置连接 WiFi
- UDP 端口: 8000（默认）
- 采样率: 192000 Hz
- 位深: 32 bit

## 许可证

MIT License
