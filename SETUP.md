# Web Audio Streamer - 部署和使用指南

## 快速开始

### 1. 安装依赖

```bash
# 克隆项目
git clone https://github.com/a125477365/web-audio-streamer.git
cd web-audio-streamer

# 安装 Node.js 依赖
npm install

# 安装 FFmpeg (如果未安装)
# macOS:
brew install ffmpeg

# Ubuntu/Debian:
sudo apt install ffmpeg

# Windows: 从 https://ffmpeg.org 下载
```

### 2. 配置

编辑 `config/config.json`：

```json
{
  "server": {
    "port": 3000
  },
  "esp32": {
    "host": "192.168.6.89",  // 改为你的 ESP32 IP
    "port": 8000
  },
  "audio": {
    "sampleRate": 192000,    // 与 ESP32 配置匹配
    "bitsPerSample": 32,
    "channels": 2
  },
  "music": {
    "localPaths": ["/path/to/your/music"]  // 添加音乐文件夹路径
  }
}
```

### 3. 启动服务

```bash
npm run dev
```

打开浏览器访问：http://localhost:3000

## 使用方法

### 本地音乐

1. 点击「本地音乐」标签
2. 输入音乐文件夹路径
3. 点击「扫描」按钮
4. 点击歌曲播放

### 在线音乐

1. 点击「在线搜索」标签
2. 输入歌曲名或歌手名
3. 点击「搜索」
4. 点击搜索结果播放

### 网络电台

1. 点击「网络电台」标签
2. 选择预设电台或输入自定义 URL
3. 点击播放

### 设置

- 可以修改 ESP32 IP 地址和端口
- 可以调整采样率、位深等参数

## 与 OpenClaw 集成

可以通过 API 与 OpenClaw 集成：

```bash
# 在 OpenClaw 中配置
curl -X POST http://localhost:3000/api/online/play?id=SONG_ID

# 或播放本地文件
curl -X POST "http://localhost:3000/api/local/play?file=/path/to/music.mp3"
```

## 常见问题

### Q: 没有声音？

1. 检查 ESP32 是否连接
2. 检查 ESP32 IP 是否正确
3. 检查音频配置是否与 ESP32 匹配

### Q: 播放卡顿？

1. 降低采样率（从 192kHz 降到 96kHz）
2. 检查网络延迟
3. 增加 ESP32 缓冲区大小

### Q: FFmpeg 报错？

1. 确保已安装 FFmpeg
2. 检查音频文件格式是否支持
3. 查看终端错误日志
