# Web Audio Streamer - 双向 Skill

这是一个"双向 Skill"——既是一个独立应用，有自己的 Web UI，可被 Hermes/OpenClaw 安装管理；又内置调用 Hermes CLI 的能力，用于 AI 任务（如自动获取音源）。

## 架构说明

```
┌─────────────────────────────────────────────────────────────┐
│                    Hermes / OpenClaw                        │
│                   (AI Agent 宿主环境)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ 安装/管理
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Web Audio Streamer (本 Skill)                  │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Web UI    │    │  REST API   │    │ Hermes CLI  │     │
│  │  (端口3010) │◄──►│   Server    │◄──►│  Caller     │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                            │                    │            │
│                            ▼                    ▼            │
│                    ┌─────────────────────────────────┐      │
│                    │     音源管理 / 播放控制          │      │
│                    └─────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
                      │
                      ▼
              ┌──────────────┐
              │    ESP32     │
              │  (UDP 音频)  │
              └──────────────┘
```

## 安装方法

### 方法一：通过 Hermes/OpenClaw 自动安装

直接告诉 Hermes 或 OpenClaw：

```
请安装 web-audio-streamer
```

或：

```
帮我部署音乐播放系统
```

### 方法二：一键脚本安装

```bash
curl -fsSL https://raw.githubusercontent.com/a125477365/web-audio-streamer/main/install.sh | bash
```

### 方法三：指定安装目录

```bash
curl -fsSL https://raw.githubusercontent.com/a125477365/web-audio-streamer/main/install.sh | bash -s -- --dir /opt/audio-streamer
```

## 首次安装自动配置

### 自动安装依赖

首次启动时，系统会自动检测并安装以下依赖：

1. **Node.js 依赖**: `npm install`（项目依赖）
2. **FFmpeg**: 音频解码必需
   - macOS: `brew install ffmpeg`
   - Linux: `apt-get install ffmpeg` 或 `yum install ffmpeg`
   - Windows: 提示手动安装

### 自动获取音源

首次安装时，系统会自动通过 **Hermes CLI** 获取5个可靠优质的非试听洛雪音乐源：

- 无需手动配置 API Key
- 自动筛选完整歌曲（时长 > 90秒）
- 排除试听版本
- 支持网易云、QQ音乐、酷狗等多平台

## 环境变量配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_VENV_PYTHON` | Hermes Python 路径 | `/opt/hermes/.venv/bin/python3` |
| `HERMES_CLI_PATH` | Hermes CLI 脚本路径 | `/opt/hermes/cli.py` |
| `HERMES_CLI_TIMEOUT` | CLI 调用超时时间(ms) | `120000` (2分钟) |

**注意**：如果 Hermes 安装在非标准路径，需要设置这些环境变量。

## 与 Hermes/OpenClaw 集成

### Hermes 可调用的控制接口

Web Audio Streamer 提供以下 REST API，Hermes/OpenClaw 可以直接调用：

#### 播放控制

```bash
# 播放在线歌曲（搜索并播放）
curl "http://localhost:3010/api/online/search?q=周杰伦"
curl "http://localhost:3010/api/online/play?id=SONG_ID"

# 播放本地文件
curl "http://localhost:3010/api/local/play?file=/path/to/music.mp3"

# 播放网络电台
curl "http://localhost:3010/api/radio/play?url=https://example.com/stream.mp3"

# 停止播放
curl -X POST "http://localhost:3010/api/control/stop"

# 暂停播放
curl -X POST "http://localhost:3010/api/control/pause"

# 恢复播放
curl -X POST "http://localhost:3010/api/control/resume"

# 设置音量 (0-100)
curl -X POST "http://localhost:3010/api/control/volume" -d '{"volume":80}'

# 上一曲/下一曲
curl -X POST "http://localhost:3010/api/control/prev"
curl -X POST "http://localhost:3010/api/control/next"

# 获取播放状态
curl "http://localhost:3010/api/control/status"
```

#### 音源管理

```bash
# 手动获取音源（通过 Hermes CLI）
curl -X POST "http://localhost:3010/api/source/fetch" -d '{"testSong":"周杰伦"}'

# 查看当前音源
curl "http://localhost:3010/api/source/current"

# 查看候选音源列表
curl "http://localhost:3010/api/source/candidates"

# 切换音源
curl -X POST "http://localhost:3010/api/source/select" -d '{"source":{"name":"洛雪音乐API","searchUrl":"https://..."}}'
```

### 在 Hermes 中创建控制 Skill

Hermes 可以通过以下方式控制音乐播放：

```yaml
# skills/music-control/SKILL.md
name: music-control
description: 控制音乐播放（本地、在线、电台）
---

## 播放音乐

```bash
# 播放指定歌曲（搜索并播放）
curl "http://localhost:3010/api/online/search?q=歌曲名" | jq -r '.results[0].id' | xargs -I {} curl "http://localhost:3010/api/online/play?id={}"

# 播放本地文件
curl "http://localhost:3010/api/local/play?file=/path/to/file.mp3"

# 播放电台
curl "http://localhost:3010/api/radio/play?url=https://..."
```

## 控制播放

```bash
# 停止
curl -X POST "http://localhost:3010/api/control/stop"

# 暂停
curl -X POST "http://localhost:3010/api/control/pause"

# 恢复
curl -X POST "http://localhost:3010/api/control/resume"

# 音量
curl -X POST "http://localhost:3010/api/control/volume" -d '{"volume":80}'

# 下一曲
curl -X POST "http://localhost:3010/api/control/next"

# 状态
curl "http://localhost:3010/api/control/status"
```
```

### OpenClaw 集成

OpenClaw 通过相同的 REST API 控制播放。如果 OpenClaw 运行在同一环境，可直接访问 `http://localhost:3010`。

## 配置文件

编辑配置文件（首次启动后自动创建）：

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
| `server.port` | 服务端口 | 3010 |

## 音源获取详解

### 自动获取流程

1. **首次安装检测**: 启动时检查 `~/.openclaw/web-audio-streamer/source-config.json`
2. **无配置时自动获取**: 调用 Hermes CLI 搜索并测试可用音源
3. **保存候选列表**: 永久保存5个可用音源
4. **自动选择**: 默认使用第一个音源

### 搜索失败自动重试

如果搜索失败或无结果，系统会自动：
1. 清空当前音源配置
2. 重新通过 Hermes CLI 获取新音源
3. 使用新音源重新搜索

### 手动获取音源

在 Web UI 设置界面点击「获取音源」按钮，或调用 API：

```bash
curl -X POST "http://localhost:3010/api/source/fetch" -d '{"testSong":"周杰伦"}'
```

## 启动服务

```bash
cd ~/web-audio-streamer && npm run dev
```

服务启动后：
- Web UI: http://localhost:3010
- API: http://localhost:3010/api/*

## 故障排除

### Hermes CLI 不可用

错误：`Hermes CLI 不可用。请检查路径...`

解决：
1. 确认 Hermes Agent 正在运行
2. 检查环境变量：
   ```bash
   export HERMES_VENV_PYTHON=/opt/hermes/.venv/bin/python3
   export HERMES_CLI_PATH=/opt/hermes/cli.py
   ```
3. 手动测试：
   ```bash
   /opt/hermes/.venv/bin/python3 /opt/hermes/cli.py --help
   ```

### FFmpeg 未安装

错误：播放失败，无音频输出

解决：
```bash
# macOS
brew install ffmpeg

# Linux (Ubuntu/Debian)
sudo apt-get install ffmpeg

# Linux (CentOS/RHEL)
sudo yum install ffmpeg
```

### ESP32 连接失败

错误：`No ACK after...`

解决：
1. 确认 ESP32 已启动并连接网络
2. 检查 IP 配置是否正确
3. 确认 UDP 端口未被防火墙阻止

## 项目结构

```
web-audio-streamer/
├── server/
│   ├── index.js              # 主服务器
│   ├── audio-streamer.js     # 音频流处理
│   ├── source-manager.js     # 音源管理 (v6)
│   ├── hermes-source-api.js  # Hermes CLI 调用
│   ├── online-music.js       # 在线音乐 API
│   ├── local-music.js        # 本地音乐扫描
│   ├── radio.js              # 网络电台
│   └── ...
├── web-ui/
│   ├── index.html            # Web 界面
│   └── ...
├── config/
│   └── config.json           # 配置文件
├── music/                    # 音乐目录
├── install.sh                # 一键安装脚本
├── package.json              # Node.js 项目配置
└── SKILL.md                  # 本文档
```

## 版本历史

- **v1.0.0** - 初始版本
- **v6** - 添加 Hermes CLI 集成，自动获取音源

## 许可证

MIT License

## 作者

谭坚
