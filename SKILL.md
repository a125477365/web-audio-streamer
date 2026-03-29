# Web Audio Streamer - OpenClaw Skill

使用此 Skill 可以让 OpenClaw 一键安装和管理 Web Audio Streamer。

## 安装方法

### 方法一：让 OpenClaw 自动安装

直接告诉 OpenClaw：

```
请安装 web-audio-streamer
```

或：

```
帮我部署音乐播放系统到 ESP32
```

### 方法二：手动安装

在 OpenClaw 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/a125477365/web-audio-streamer/main/install.sh | bash
```

### 方法三：指定安装目录

```bash
curl -fsSL https://raw.githubusercontent.com/a125477365/web-audio-streamer/main/install.sh | bash -s -- --dir /opt/audio-streamer
```

## 配置

安装完成后，编辑配置文件：

```bash
nano ~/web-audio-streamer/config/config.json
```

主要配置项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `esp32.host` | ESP32 的 IP 地址 | 192.168.6.89 |
| `esp32.port` | UDP 端口 | 8000 |
| `audio.sampleRate` | 采样率 | 192000 |
| `audio.bitsPerSample` | 位深 | 32 |
| `music.localPaths` | 本地音乐路径 | [] |

## 使用方法

### 启动服务

```bash
cd ~/web-audio-streamer && npm run dev
```

### API 调用

OpenClaw 可以通过 API 控制播放：

```bash
# 播放本地文件
curl "http://localhost:3000/api/local/play?file=/path/to/music.mp3"

# 搜索并播放在线歌曲
curl "http://localhost:3000/api/online/search?q=周杰伦"
curl "http://localhost:3000/api/online/play?id=SONG_ID"

# 播放网络电台
curl "http://localhost:3000/api/radio/play?url=https://example.com/stream.mp3"

# 停止播放
curl -X POST "http://localhost:3000/api/control/stop"

# 设置音量
curl -X POST "http://localhost:3000/api/control/volume" -d '{"volume":80}'
```

## 与 OpenClaw 集成

可以在 OpenClaw 中创建 Skill 来控制播放：

```yaml
# skills/music-control/SKILL.md
name: music-control
description: 控制音乐播放（本地、在线、电台）
---

## 播放音乐

```bash
# 播放指定歌曲
music play "歌曲名"

# 播放本地文件
music local "/path/to/file.mp3"

# 播放电台
music radio "BBC World Service"
```

## 控制播放

```bash
music stop      # 停止
music volume 80 # 设置音量
music status    # 查看状态
```
