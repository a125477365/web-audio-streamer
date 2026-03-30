/**
 * Audio Streamer - 使用 FFmpeg 转码并通过 UDP 发送到 ESP32
 */

import { spawn } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';

export class AudioStreamer {
  constructor(config) {
    this.config = config;
    this.ffmpegProcess = null;
    this.udpSocket = null;
    this.isPlaying = false;
    this.currentSource = null;
    this.volume = 100;
    this.statusCallbacks = [];

    // 创建 UDP socket
    this.udpSocket = dgram.createSocket('udp4');
  }

  /**
   * 播放本地文件
   */
  async playLocalFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    this.stop();
    this.currentSource = { type: 'local', path: filePath };
    await this._startFFmpeg(filePath);
  }

  /**
   * 播放在线 URL
   */
  async playUrl(url) {
    this.stop();
    this.currentSource = { type: 'url', url };
    await this._startFFmpeg(url);
  }

  /**
   * 启动 FFmpeg 进程
   */
  async _startFFmpeg(input) {
    const { sampleRate, bitsPerSample, channels } = this.config.audio;
    const { host, port } = this.config.esp32;

    // FFmpeg 参数
    // 正确的编码器名称: pcm_s16le, pcm_s24le, pcm_s32le
    const codecMap = {
      16: 'pcm_s16le',
      24: 'pcm_s24le',
      32: 'pcm_s32le'
    };
    const codec = codecMap[bitsPerSample] || 'pcm_s16le';

    const ffmpegArgs = [
      '-i', input,
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-f', `s${bitsPerSample}le`,
      '-acodec', codec,
    ];

    // 音量调节
    if (this.volume !== 100) {
      const volumeFilter = `volume=${this.volume / 100}`;
      ffmpegArgs.push('-af', volumeFilter);
    }

    // 输出到 stdout
    ffmpegArgs.push('-');

    console.log('[AudioStreamer] Starting FFmpeg:', 'ffmpeg', ffmpegArgs.join(' '));

    // 启动 FFmpeg
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[AudioStreamer] FFmpeg error:', err);
      this._updateStatus({ isPlaying: false, error: err.message });
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log('[AudioStreamer] FFmpeg closed with code:', code);
      this.isPlaying = false;
      this._updateStatus({ isPlaying: false });
    });

    // 错误输出
    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[FFmpeg]', msg);
      }
    });

    // 音频数据流 → UDP 发送
    this.isPlaying = true;
    this._updateStatus({ isPlaying: true, source: this.currentSource });

    // 缓冲区管理
    const chunkSize = this._calculateChunkSize();
    let buffer = Buffer.alloc(0);

    this.ffmpegProcess.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= chunkSize) {
        const chunk = buffer.subarray(0, chunkSize);
        buffer = buffer.subarray(chunkSize);
        this._sendUdpChunk(chunk);
      }
    });
  }

  /**
   * 计算每个 UDP 包的大小
   */
  _calculateChunkSize() {
    const { sampleRate, bitsPerSample, channels } = this.config.audio;
    const bufferMs = this.config.audio.bufferMs || 50;

    const bytesPerSample = bitsPerSample / 8;
    const samplesPerMs = sampleRate / 1000;
    const chunkSize = Math.floor(samplesPerMs * bufferMs * channels * bytesPerSample);

    return Math.min(chunkSize, 65000);
  }

  /**
   * 发送 UDP 数据包到 ESP32
   */
  _sendUdpChunk(chunk) {
    const { host, port } = this.config.esp32;
    this.udpSocket.send(chunk, port, host, (err) => {
      if (err) {
        console.error('[AudioStreamer] UDP send error:', err);
      }
    });
  }

  /**
   * 停止播放
   */
  stop() {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    this.isPlaying = false;
    this.currentSource = null;
    this._updateStatus({ isPlaying: false, source: null });
  }

  /**
   * 设置音量 (0-100)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(100, volume));
    if (this.isPlaying && this.currentSource) {
      if (this.currentSource.type === 'local') {
        this.playLocalFile(this.currentSource.path);
      } else {
        this.playUrl(this.currentSource.url);
      }
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      isPlaying: this.isPlaying,
      volume: this.volume,
      source: this.currentSource,
      esp32: this.config.esp32,
      audio: this.config.audio,
    };
  }

  /**
   * 注册状态变化回调
   */
  onStatusChange(callback) {
    this.statusCallbacks.push(callback);
  }

  /**
   * 更新状态并通知回调
   */
  _updateStatus(partial) {
    const status = this.getStatus();
    Object.assign(status, partial);
    this.statusCallbacks.forEach(cb => cb(status));
  }
}
