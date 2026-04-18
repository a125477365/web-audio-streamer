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

## 音源获取 (v6 新功能)

### 自动获取音源

首次安装时，系统会自动通过 **Hermes API** 获取5个可靠优质的非试听洛雪音乐源：
- 无需手动配置
- 自动筛选完整歌曲（时长 > 90秒）
- 排除试听版本

### 搜索失败自动重试

如果搜索失败或无结果，系统会自动：
1. 重新获取可用音源
2. 使用新音源重新搜索

### 手动获取音源

在设置界面点击「获取音源(Hermes)」按钮，或调用 API：

```bash
# 手动获取音源
curl -X POST "http://localhost:3010/api/source/fetch" -d '{"testSong":"周杰伦"}'

# 查看当前音源
curl "http://localhost:3010/api/source/current"

# 查看候选音源列表
curl "http://localhost:3010/api/source/candidates"

# 切换音源
curl -X POST "http://localhost:3010/api/source/select" -d '{"source":{"name":"洛雪音乐API","searchUrl":"https://..."}}'
```

## 使用方法

### 启动服务

```bash
cd ~/web-audio-streamer && npm run dev
```

### API 调用

OpenClaw 可以通过 API 控制播放：

```bash
# 播放本地文件
curl "http://localhost:3010/api/local/play?file=/path/to/music.mp3"

# 搜索并播放在线歌曲（首次搜索会自动获取音源）
curl "http://localhost:3010/api/online/search?q=周杰伦"
curl "http://localhost:3010/api/online/play?id=SONG_ID"

# 播放网络电台
curl "http://localhost:3010/api/radio/play?url=https://example.com/stream.mp3"

# 停止播放
curl -X POST "http://localhost:3010/api/control/stop"

# 设置音量
curl -X POST "http://localhost:3010/api/control/volume" -d '{"volume":80}'
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
music stop # 停止
music volume 80 # 设置音量
music status # 查看状态
```

## 环境变量

音源获取模块支持以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_API_URL` | Hermes API 地址 | `http://127.0.0.1:8642` |
| `HERMES_API_KEY` | Hermes API 密钥 | `hermes-open-webui-2024` |
| `HERMES_MODEL` | 使用的模型 | `hermes-agent` |
