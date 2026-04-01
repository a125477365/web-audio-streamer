/**
 * Audio Streamer - 使用 FFmpeg 转码并通过 UDP 发送到 ESP32
 * Bit-Perfect 方案：按源文件原采样率输出，控制包带 ACK 确认机制
 */

import { spawn, execSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';

// ==================== 控制包协议 ====================
// 
// 控制包格式:
// [0xAA][0x55][seq(1字节)][length(2字节,大端)][JSON payload]
//
// seq: 序列号，用于匹配 ACK
// 
// ACK 包格式:
// [0xAA][0x55][seq(1字节)]['A']['C']['K'][length(2字节,大端)][JSON payload]
//

const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const ACK_TIMEOUT_MS = 500;   // ACK 超时时间

let seqCounter = 0;

function buildControlPacket(payload, seq) {
  const json = JSON.stringify(payload);
  const jsonBuf = Buffer.from(json, 'utf-8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(jsonBuf.length);
  const seqBuf = Buffer.from([seq & 0xFF]);
  return Buffer.concat([CONTROL_MAGIC, seqBuf, lenBuf, jsonBuf]);
}

function parseControlPacket(buffer) {
  if (buffer.length < 6) return null;
  if (buffer[0] !== 0xAA || buffer[1] !== 0x55) return null;
  const seq = buffer[2];
  const len = buffer.readUInt16BE(3);
  if (buffer.length < 5 + len) return null;
  try {
    const json = buffer.slice(5, 5 + len).toString('utf-8');
    return { seq, payload: JSON.parse(json) };
  } catch {
    return null;
  }
}

function isAckPacket(parsed, expectedSeq) {
  return parsed &&
         parsed.seq === expectedSeq &&
         parsed.payload &&
         parsed.payload.cmd === 'ack';
}

export class AudioStreamer {
  constructor(config) {
    this.config = config;
    this.ffmpegProcess = null;
    this.udpSocket = null;
    this.isPlaying = false;
    this.shouldStop = false;  // 用户停止标志
    this.currentSource = null;
    this.currentSampleRate = null;
    this.volume = 100;
    this.statusCallbacks = [];

    // 创建 UDP socket
    this.udpSocket = dgram.createSocket('udp4');
    
    // 绑定接收端口（用于接收 ACK）
    this.udpSocket.bind(0);
  }

  /**
   * 播放本地文件
   */
  async playLocalFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    this.stop();
    this.shouldStop = false;
    this.currentSource = { type: 'local', path: filePath };
    await this._startFFmpeg(filePath);
  }

  /**
   * 播放在线 URL
   */
  async playUrl(url) {
    this.stop();
    this.shouldStop = false;
    this.currentSource = { type: 'url', url };
    await this._startFFmpeg(url);
  }

  /**
   * 用 ffprobe 探测音频信息
   */
  _probeAudio(input) {
    try {
      const cmd = input.startsWith('http')
        ? `ffprobe -v quiet -print_format json -show_streams -select_streams a "${input}"`
        : `ffprobe -v quiet -print_format json -show_streams -select_streams a "${input}"`;
      const result = execSync(cmd, {
        timeout: 10000,
        encoding: 'utf-8',
        shell: true
      });
      const info = JSON.parse(result);
      if (info.streams && info.streams.length > 0) {
        const stream = info.streams[0];
        return {
          sampleRate: parseInt(stream.sample_rate) || 44100,
          channels: parseInt(stream.channels) || 2,
          bitsPerSample: parseInt(stream.bits_per_raw_sample) ||
                         parseInt(stream.bits_per_sample) || 16
        };
      }
    } catch (err) {
      console.warn('[AudioStreamer] ffprobe failed, using defaults:', err.message);
    }
    return { sampleRate: 44100, channels: 2, bitsPerSample: 16 };
  }

  /**
   * 发送控制包并等待 ACK（一直重试，直到收到ACK或用户停止）
   */
  async _sendControlWithAck(payload) {
    const { host, port } = this.config.esp32;
    const seq = (seqCounter++) & 0xFF;
    
    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let resolved = false;
      let attemptCount = 0;
      
      const packet = buildControlPacket(payload, seq);
      
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        this.udpSocket.removeAllListeners('message');
      };
      
      const onMessage = (msg, rinfo) => {
        const parsed = parseControlPacket(msg);
        if (isAckPacket(parsed, seq)) {
          if (!resolved) {
            resolved = true;
            cleanup();
            console.log(`[AudioStreamer] ACK received for seq=${seq} after ${attemptCount} attempts`);
            resolve(parsed.payload);
          }
        }
      };
      
      this.udpSocket.on('message', onMessage);
      
      const sendAndWait = () => {
        // 检查用户是否已停止
        if (this.shouldStop) {
          cleanup();
          reject(new Error('User stopped playback'));
          return;
        }
        
        attemptCount++;
        if (attemptCount % 5 === 1) {
          console.log(`[AudioStreamer] Sending control packet seq=${seq}, attempt ${attemptCount}`);
        }
        
        this.udpSocket.send(packet, port, host, (err) => {
          if (err) {
            cleanup();
            reject(err);
          }
        });
        
        // 设置超时等待 ACK，然后重试
        timeoutId = setTimeout(() => {
          if (!resolved && !this.shouldStop) {
            sendAndWait(); // 继续重试
          }
        }, ACK_TIMEOUT_MS);
      };
      
      sendAndWait();
    });
  }

  /**
   * 发送控制包给 ESP32（无 ACK，用于 stop 等非关键命令）
   */
  async _sendControlNoAck(payload) {
    const { host, port } = this.config.esp32;
    const seq = (seqCounter++) & 0xFF;
    const packet = buildControlPacket(payload, seq);
    
    return new Promise((resolve, reject) => {
      this.udpSocket.send(packet, port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 通知 ESP32 切换音频配置（带 ACK 确认，一直重试直到收到）
   */
  async _notifyEsp32Config(sampleRate, bitsPerSample, channels) {
    console.log(`[AudioStreamer] Notifying ESP32: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
    
    const ack = await this._sendControlWithAck({
      cmd: 'setAudioConfig',
      sampleRate,
      bitsPerSample,
      channels
    });
    
    console.log(`[AudioStreamer] ESP32 confirmed:`, ack.status);
    // 等待一小段时间让 I2S 稳定
    await new Promise(r => setTimeout(r, 50));
  }

  /**
   * 停止播放（静音通知，不需要 ACK）
   */
  async _notifyEsp32Stop() {
    this.shouldStop = true;  // 标记停止，中断重试
    try {
      await this._sendControlNoAck({ cmd: 'stop' });
    } catch (e) {
      // 忽略错误
    }
  }

  /**
   * 启动 FFmpeg 进程
   */
  async _startFFmpeg(input) {
    const { bitsPerSample, channels: configChannels } = this.config.audio;

    // 探测源文件的实际音频参数
    const probe = this._probeAudio(input);
    const actualSampleRate = probe.sampleRate;
    const actualChannels = configChannels || probe.channels;
    this.currentSampleRate = actualSampleRate;

    console.log(`[AudioStreamer] Source probe: ${actualSampleRate}Hz / ${actualChannels}ch / ${probe.bitsPerSample}bit`);

    // 编码器映射
    const codecMap = {
      16: 'pcm_s16le',
      24: 'pcm_s24le',
      32: 'pcm_s32le'
    };
    const codec = codecMap[bitsPerSample] || 'pcm_s16le';

    // 1. 先通知 ESP32 切换采样率（等待 ACK，一直重试）
    try {
      await this._notifyEsp32Config(actualSampleRate, bitsPerSample, actualChannels);
    } catch (err) {
      console.error('[AudioStreamer] Failed to notify ESP32:', err.message);
      // 用户停止了，不继续播放
      return;
    }

    // 2. FFmpeg 按原采样率输出，不重采样
    const ffmpegArgs = [
      '-i', input,
      '-ar', String(actualSampleRate),
      '-ac', String(actualChannels),
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

    console.log('[AudioStreamer] FFmpeg:', 'ffmpeg', ffmpegArgs.join(' '));

    // 3. 启动 FFmpeg
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[AudioStreamer] FFmpeg error:', err);
      this._updateStatus({ isPlaying: false, error: err.message });
    });

    // 错误输出
    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[FFmpeg]', msg);
      }
    });

    // 4. 音频数据流 → UDP 发送（按实时速率控制）
    this.isPlaying = true;
    this._updateStatus({ isPlaying: true, source: this.currentSource, sampleRate: actualSampleRate });

    // 按实际采样率计算 chunk 大小和发送间隔
    const chunkDurationMs = this.config.audio.bufferMs || 50;
    const bytesPerSample = bitsPerSample / 8;
    const samplesPerChunk = Math.floor(actualSampleRate * chunkDurationMs / 1000);
    const chunkSize = samplesPerChunk * actualChannels * bytesPerSample;

    console.log(`[AudioStreamer] Rate control: ${actualSampleRate}Hz, chunk=${chunkSize}B, interval=${chunkDurationMs}ms`);

    let buffer = Buffer.alloc(0);
    let sendTimer = null;
    const prefillChunks = 4; // 预填充 ~200ms
    let sentChunks = 0;

    const sendLoop = () => {
      if (buffer.length >= chunkSize) {
        const chunk = buffer.subarray(0, chunkSize);
        buffer = buffer.subarray(chunkSize);
        this._sendUdpChunk(chunk);
        sentChunks++;
      }
      if (this.isPlaying && this.ffmpegProcess) {
        sendTimer = setTimeout(sendLoop, chunkDurationMs);
      }
    };

    this.ffmpegProcess.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      // 预填充阶段：快速发送前几个 chunk 填满 ESP32 缓冲
      while (sentChunks < prefillChunks && buffer.length >= chunkSize) {
        const chunk = buffer.subarray(0, chunkSize);
        buffer = buffer.subarray(chunkSize);
        this._sendUdpChunk(chunk);
        sentChunks++;
      }
      // 预填充完成后启动按实时速率发送
      if (sentChunks >= prefillChunks && !sendTimer) {
        sendTimer = setTimeout(sendLoop, chunkDurationMs);
      }
    });

    // FFmpeg 结束时，继续发送剩余缓冲数据
    this.ffmpegProcess.on('close', (code) => {
      console.log('[AudioStreamer] FFmpeg closed with code:', code);
      const drainBuffer = () => {
        if (buffer.length >= chunkSize) {
          const chunk = buffer.subarray(0, chunkSize);
          buffer = buffer.subarray(chunkSize);
          this._sendUdpChunk(chunk);
          setTimeout(drainBuffer, chunkDurationMs);
        } else if (buffer.length > 0) {
          this._sendUdpChunk(buffer);
          buffer = Buffer.alloc(0);
          this._updateStatus({ isPlaying: false });
          if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
        } else {
          this._updateStatus({ isPlaying: false });
          if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
        }
      };
      if (buffer.length > 0) {
        drainBuffer();
      } else {
        this._updateStatus({ isPlaying: false });
        if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      }
    });
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
    this.shouldStop = true;  // 标记停止
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    this._notifyEsp32Stop();
    this.isPlaying = false;
    this.currentSource = null;
    this.currentSampleRate = null;
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
      currentSampleRate: this.currentSampleRate,
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
