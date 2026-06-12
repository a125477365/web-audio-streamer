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

### 1. 安装依赖

```bash
npm install
```

依赖里已包含 `ffmpeg-static` / `ffprobe-static`，**无需单独安装系统 FFmpeg**。
若系统已安装 FFmpeg，会自动优先使用系统版本（见 `server/ffmpeg-paths.js`）。

### 2. 配置 ESP32 地址

编辑 `config/config.json`（`server.port` 默认 3010）：

```json
{
  "server": { "port": 3010 },
  "esp32":  { "host": "192.168.x.x", "port": 8000 },
  "music":  { "path": "./music" }
}
```

`esp32.host` 填 ESP32 的局域网 IP（见下方"ESP32 配置"获取 IP 的方法），
也可以启动后在网页「设置」页填写并保存。

> 音频格式无需手动设置：后端会自动探测每首歌的采样率/位深，
> 并协调为 ESP32 可稳定播放的格式（>48kHz 降为 44.1/48kHz，24/32bit 统一为 32bit），
> 再通过控制包通知 ESP32 切换，等待 ACK 确认后才推流。

### 3. 启动服务

```bash
npm run dev          # 或 npm start
```

打开浏览器访问：http://localhost:3010

### 无真机自测（可选）

没有连接 ESP32 时，可用内置模拟接收端验证后端协议与推流：

```bash
node test/mock-esp32.js 8000     # 终端1：模拟 ESP32（会回 ACK 并打印码率）
# 把 config.json 的 esp32.host 改成 127.0.0.1，再 npm start（终端2）
```

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

**连接 WiFi 并获取 IP，二选一：**

1. **USB 串口配网（推荐，已连电脑时最快）**
   ```bash
   cd ../esp32-audio-bridge
   python3 tools/provision.py --port /dev/cu.usbmodemXXXX --ssid "你的WiFi" --password "密码"
   ```
   命令会让设备保存 WiFi 并重启，连上后自动打印设备 IP；
   也可只查状态：`python3 tools/provision.py --status`。

2. **配置热点（AP）配网**
   设备首次启动会开热点 `ESP32_Audio_Setup`，连接后浏览器打开
   `http://192.168.4.1` 填写 WiFi 即可。

拿到 IP 后填入后端 `config.json` 的 `esp32.host`（或网页设置页）。

ESP32 运行参数：
- UDP 端口: 8000（默认）
- 采样率/位深: 由后端按歌曲自动协调并通知，无需手动设置
- 长按 BOOT 键 5 秒清除配置

## 许可证

MIT License
