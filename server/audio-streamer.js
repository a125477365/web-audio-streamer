/**
 * Audio Streamer - Bit-Perfect 架构
 * 
 * 核心原则：保持原始音质，不做重采样
 * - 保留原始采样率（44.1kHz/48kHz/96kHz 等）
 * - 保留原始位深（16/24/32 bit）
 * - 保留原始声道数
 */

import { spawn, execSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import { EventEmitter } from 'events';

// ==================== 常量 ====================
const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;
const DEFAULT_BITS_PER_SAMPLE = 16;

// ==================== 工具函数 ====================
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function buildControlPacket(payload, seq) {
  const json = JSON.stringify(payload);
  const jsonBuf = Buffer.from(json, 'utf-8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(jsonBuf.length);
  const seqBuf = Buffer.from([seq & 0xFF]);
  return Buffer.concat([CONTROL_MAGIC, seqBuf, lenBuf, jsonBuf]);
}

function parseControlPacket(buffer) {
  if (buffer.length < 5) return null;
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

// ==================== UDP 控制通道 ====================
class UDPControlChannel {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.seqCounter = 0;
    this.pendingAcks = new Map();
  }
  
  init() {
    if (this.socket) return;
    
    this.socket = dgram.createSocket('udp4');
    this.socket.bind(0);
    
    this.socket.on('message', (msg) => {
      const parsed = parseControlPacket(msg);
      if (parsed && parsed.payload && parsed.payload.cmd === 'ack') {
        const pending = this.pendingAcks.get(parsed.seq);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingAcks.delete(parsed.seq);
          pending.resolve(parsed.payload);
        }
      }
    });
  }
  
  async sendWithAck(payload, maxRetries = 5, timeoutMs = 500) {
    this.init();
    
    const seq = (this.seqCounter++) & 0xFF;
    const packet = buildControlPacket(payload, seq);
    const { host, port } = this.config.esp32;
    
    return new Promise((resolve, reject) => {
      let attempts = 0;
      
      const trySend = () => {
        attempts++;
        if (attempts > maxRetries) {
          this.pendingAcks.delete(seq);
          reject(new Error(`No ACK after ${maxRetries} attempts`));
          return;
        }
        
        this.socket.send(packet, port, host, (err) => {
          if (err) {
            this.pendingAcks.delete(seq);
            reject(err);
          }
        });
        
        const timeout = setTimeout(() => {
          if (this.pendingAcks.has(seq)) {
            trySend();
          }
        }, timeoutMs);
        
        this.pendingAcks.set(seq, { resolve, timeout });
      };
      
      trySend();
    });
  }
  
  sendNoAck(payload) {
    this.init();
    const seq = (this.seqCounter++) & 0xFF;
    const packet = buildControlPacket(payload, seq);
    const { host, port } = this.config.esp32;
    return new Promise((resolve, reject) => {
      this.socket.send(packet, port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  
  sendAudio(chunk) {
    if (!this.socket) return;
    const { host, port } = this.config.esp32;
    this.socket.send(chunk, port, host);
  }
}

// ==================== FFmpeg 解码器 ====================
class FFmpegDecoder extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.currentId = 0;
  }
  
  stop() {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
        }, 100);
      } catch (e) {}
    }
  }
  
  decode(filePath, options, onData) {
    const { sampleRate, channels, bitsPerSample, seekTime = 0, volume = 100 } = options;
    const currentId = ++this.currentId;
    
    this.stop();
    
    console.log(`[Decoder#${currentId}] Starting: ${filePath}`);
    console.log(`[Decoder#${currentId}] Original: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
    
    const codecMap = { 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le' };
    const codec = codecMap[bitsPerSample] || 'pcm_s16le';
    
    const ffmpegArgs = [
      '-re',  // 按实时速度输出
      '-i', filePath,
      '-ss', String(seekTime),
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-f', `s${bitsPerSample}le`,
      '-acodec', codec,
    ];
    
    if (volume !== 100) {
      ffmpegArgs.push('-af', `volume=${volume / 100}`);
    }
    
    ffmpegArgs.push('-');
    
    console.log(`[Decoder#${currentId}] FFmpeg:`, 'ffmpeg', ffmpegArgs.join(' '));
    
    const proc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    this.process = proc;
    
    // 收集 stderr 用于调试
    let stderrData = '';
    proc.stderr.on('data', (data) => {
      stderrData += data.toString();
    });
    
    if (onData) {
      proc.stdout.on('data', (data) => {
        if (this.currentId === currentId) {
          onData(data);
        }
      });
    }
    
    proc.on('error', (err) => {
      console.error(`[Decoder#${currentId}] Error:`, err.message);
      if (this.process === proc) {
        this.process = null;
      }
    });
    
    proc.on('close', (code) => {
      console.log(`[Decoder#${currentId}] Closed:`, code);
      if (this.process === proc) {
        this.process = null;
        // 发射 close 事件，通知 AudioStreamer
        this.emit('close', { id: currentId, code });
      }
    });
    
    return {
      id: currentId,
      isCurrent: () => this.currentId === currentId
    };
  }
  
  isRunning() {
    return this.process !== null;
  }
}

// ==================== 音频发送器 ====================
class AudioSender {
  constructor(controlChannel) {
    this.controlChannel = controlChannel;
    this.sendInterval = null;
    this.buffer = Buffer.alloc(0);
    this.chunkSize = 0;
    this.bytesSent = 0;
    this.isRunning = false;
  }
  
  start(sampleRate, channels, bitsPerSample) {
    this.stop();
    
    const chunkDurationMs = 10;
    const bytesPerSample = bitsPerSample / 8;
    const samplesPerChunk = Math.floor(sampleRate * chunkDurationMs / 1000);
    this.chunkSize = samplesPerChunk * channels * bytesPerSample;
    
    this.buffer = Buffer.alloc(0);
    this.bytesSent = 0;
    this.isRunning = true;
    
    console.log(`[AudioSender] Started: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch, chunk=${this.chunkSize}B`);
    
    this.sendInterval = setInterval(() => {
      this._sendChunks();
    }, chunkDurationMs);
  }
  
  feed(data) {
    if (!this.isRunning) return;
    this.buffer = Buffer.concat([this.buffer, data]);
  }
  
  stop() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
    this.isRunning = false;
    this.buffer = Buffer.alloc(0);
  }
  
  _sendChunks() {
    if (!this.isRunning) return;
    
    const prefillChunks = 4;
    
    while (this.bytesSent < prefillChunks * this.chunkSize && this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.subarray(0, this.chunkSize);
      this.buffer = this.buffer.subarray(this.chunkSize);
      this.controlChannel.sendAudio(chunk);
      this.bytesSent += this.chunkSize;
    }
    
    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.subarray(0, this.chunkSize);
      this.buffer = this.buffer.subarray(this.chunkSize);
      this.controlChannel.sendAudio(chunk);
    }
  }
}

// ==================== 主播放器类 ====================
export class AudioStreamer {
  constructor(config) {
    this.config = config;
    
    this.state = 'idle';
    this.currentTrack = null;
    this.duration = 0;
    this.playStartTime = 0;
    this.volume = 100;
    
    this.currentSampleRate = 0;
    this.currentChannels = 0;
    this.currentBitsPerSample = 0;
    
    this.controlChannel = new UDPControlChannel(config);
    this.decoder = new FFmpegDecoder();
    this.sender = new AudioSender(this.controlChannel);
    
    this.progressTimer = null;
    this.statusCallbacks = [];
    
    this._setupDecoderEvents();
  }
  
  _setupDecoderEvents() {
    // 监听 FFmpeg close 事件
    this.decoder.on('close', ({ id, code }) => {
      console.log(`[AudioStreamer] Decoder closed (id=${id}, code=${code})`);
      if (this.state === 'playing') {
        this._onPlaybackEnd();
      }
    });
    
    this.decoder.on('error', ({ id, error }) => {
      console.error(`[AudioStreamer] Decoder error:`, error.message);
      this._updateStatus({ error: error.message });
    });
  }
  
  async playLocalFile(filePath, seekTime = 0) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    console.log(`[AudioStreamer] playLocalFile: ${filePath}`);
    
    const probe = this._probeAudio(filePath);
    const sampleRate = probe.sampleRate;
    const channels = probe.channels;
    const bitsPerSample = probe.bitsPerSample;
    const duration = probe.duration;
    
    console.log(`[AudioStreamer] Original: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
    
    const needReconfig = sampleRate !== this.currentSampleRate || 
                         channels !== this.currentChannels || 
                         bitsPerSample !== this.currentBitsPerSample;
    
    if (needReconfig) {
      console.log(`[AudioStreamer] Config changed: ${this.currentSampleRate}Hz → ${sampleRate}Hz`);
      this._stopPlayback();
      try {
        await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
      } catch (err) {
        console.warn('[AudioStreamer] ESP32 config failed, continuing:', err.message);
      }
      this.currentSampleRate = sampleRate;
      this.currentChannels = channels;
      this.currentBitsPerSample = bitsPerSample;
    } else {
      this._stopPlayback();
    }
    
    this.currentTrack = { path: filePath, type: 'local' };
    this.duration = duration;
    this.playStartTime = Date.now() - seekTime * 1000;
    
    this.sender.start(sampleRate, channels, bitsPerSample);
    
    this.decoder.decode(filePath, {
      sampleRate, channels, bitsPerSample, seekTime,
      volume: this.volume
    }, (data) => {
      this.sender.feed(data);
    });
    
    this.state = 'playing';
    this._startProgressTimer();
    
    this._updateStatus({
      isPlaying: true,
      source: this.currentTrack,
      duration: duration,
      durationText: formatTime(duration),
      currentTime: seekTime,
      currentTimeText: formatTime(seekTime),
      sampleRate,
      channels,
      bitsPerSample
    });
    
    console.log(`[AudioStreamer] Playing: ${filePath} (${duration.toFixed(1)}s)`);
  }
  
  async playUrl(url, seekTime = 0) {
    console.log(`[AudioStreamer] playUrl: ${url}`);
    
    const probe = this._probeAudio(url);
    const sampleRate = probe.sampleRate;
    const channels = probe.channels;
    const bitsPerSample = probe.bitsPerSample;
    const duration = probe.duration;
    
    const needReconfig = sampleRate !== this.currentSampleRate || 
                         channels !== this.currentChannels || 
                         bitsPerSample !== this.currentBitsPerSample;
    
    if (needReconfig) {
      this._stopPlayback();
      try {
        await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
      } catch (err) {
        console.warn('[AudioStreamer] ESP32 config failed, continuing:', err.message);
      }
      this.currentSampleRate = sampleRate;
      this.currentChannels = channels;
      this.currentBitsPerSample = bitsPerSample;
    } else {
      this._stopPlayback();
    }
    
    this.currentTrack = { url, type: 'url' };
    this.duration = duration;
    this.playStartTime = Date.now() - seekTime * 1000;
    
    this.sender.start(sampleRate, channels, bitsPerSample);
    
    this.decoder.decode(url, {
      sampleRate, channels, bitsPerSample, seekTime,
      volume: this.volume
    }, (data) => {
      this.sender.feed(data);
    });
    
    this.state = 'playing';
    this._startProgressTimer();
    
    this._updateStatus({
      isPlaying: true,
      source: this.currentTrack,
      duration: duration,
      durationText: formatTime(duration),
      currentTime: seekTime,
      currentTimeText: formatTime(seekTime)
    });
  }
  
  async seek(seconds) {
    if (!this.currentTrack) return;
    
    const seekTime = Math.max(0, Math.min(seconds, this.duration));
    console.log(`[AudioStreamer] Seeking to ${seekTime}s`);
    
    if (this.currentTrack.type === 'local') {
      await this.playLocalFile(this.currentTrack.path, seekTime);
    } else {
      await this.playUrl(this.currentTrack.url, seekTime);
    }
  }
  
  stop() {
    console.log('[AudioStreamer] Stopping');
    this._stopPlayback();
    this.controlChannel.sendNoAck({ cmd: 'stop' }).catch(() => {});
    this.state = 'idle';
    this.currentTrack = null;
    
    this._updateStatus({
      isPlaying: false,
      currentTime: 0,
      currentTimeText: '0:00',
      progress: 0
    });
  }
  
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(100, volume));
    if (this.state === 'playing' && this.currentTrack) {
      const currentTime = (Date.now() - this.playStartTime) / 1000;
      if (this.currentTrack.type === 'local') {
        this.playLocalFile(this.currentTrack.path, currentTime);
      } else {
        this.playUrl(this.currentTrack.url, currentTime);
      }
    }
  }
  
  getStatus() {
    const currentTime = this.state === 'playing' && this.playStartTime
      ? (Date.now() - this.playStartTime) / 1000
      : 0;
    
    return {
      isPlaying: this.state === 'playing',
      volume: this.volume,
      source: this.currentTrack,
      duration: this.duration,
      durationText: formatTime(this.duration),
      currentTime: currentTime,
      currentTimeText: formatTime(currentTime),
      progress: this.duration > 0 ? Math.min(Math.round((currentTime / this.duration) * 100), 100) : 0,
      state: this.state,
      esp32: this.config.esp32,
      audio: this.config.audio,
      sampleRate: this.currentSampleRate,
      channels: this.currentChannels,
      bitsPerSample: this.currentBitsPerSample
    };
  }
  
  onStatusChange(callback) {
    this.statusCallbacks.push(callback);
  }
  
  _stopPlayback() {
    // 发送 stop 报文给 ESP32
    if (this.state === 'playing') {
      this.controlChannel.sendNoAck({ cmd: 'stop' }).catch(() => {});
    }
    this.decoder.stop();
    this.sender.stop();
  }
  
  _probeAudio(input) {
    try {
      const cmd = `ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`;
      const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8', shell: true });
      const info = JSON.parse(result);
      
      let duration = 0;
      if (info.format?.duration) {
        duration = parseFloat(info.format.duration);
      } else if (info.streams?.[0]?.duration) {
        duration = parseFloat(info.streams[0].duration) || 0;
      }
      
      if (info.streams?.length > 0) {
        const stream = info.streams.find(s => s.codec_type === 'audio') || info.streams[0];
        return {
          sampleRate: parseInt(stream.sample_rate) || DEFAULT_SAMPLE_RATE,
          channels: parseInt(stream.channels) || DEFAULT_CHANNELS,
          bitsPerSample: parseInt(stream.bits_per_raw_sample || stream.bits_per_sample) || DEFAULT_BITS_PER_SAMPLE,
          duration
        };
      }
    } catch (err) {
      console.warn('[AudioStreamer] ffprobe failed:', err.message);
    }
    
    return { sampleRate: DEFAULT_SAMPLE_RATE, channels: DEFAULT_CHANNELS, bitsPerSample: DEFAULT_BITS_PER_SAMPLE, duration: 0 };
  }
  
  async _notifyEsp32Config(sampleRate, bitsPerSample, channels) {
    console.log(`[AudioStreamer] Notifying ESP32: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
    
    try {
      const ack = await this.controlChannel.sendWithAck({ 
        cmd: 'setAudioConfig', 
        sampleRate, 
        bitsPerSample, 
        channels 
      }, 5, 500);
      console.log(`[AudioStreamer] ESP32 confirmed:`, ack?.status);
    } catch (err) {
      console.warn('[AudioStreamer] ESP32 not responding, continuing in offline mode:', err.message);
    }
  }
  
  _startProgressTimer() {
    this._stopProgressTimer();
    
    // 业界标准：250ms 更新一次
    this.progressTimer = setInterval(() => {
      if (this.state !== 'playing') return;
      
      // 计算当前时间，限制在 duration 范围内
      const currentTime = Math.min((Date.now() - this.playStartTime) / 1000, this.duration);
      const progress = this.duration > 0 ? Math.min(currentTime / this.duration, 1) : 0;
      
      this._updateStatus({ 
        currentTime, 
        currentTimeText: formatTime(currentTime), 
        progress: Math.round(progress * 100) 
      });
    }, 250);
  }
  
  _stopProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
  
  _onPlaybackEnd() {
    if (this.state === 'playing') {
      console.log('[AudioStreamer] Playback ended');
      this.state = 'idle';
      this._stopProgressTimer();
      // 发送 stop 报文给 ESP32
      this.controlChannel.sendNoAck({ cmd: 'stop' }).catch(() => {});
      this._updateStatus({
        isPlaying: false,
        progress: 100
      });
    }
  }
  
  _updateStatus(partial) {
    const status = this.getStatus();
    Object.assign(status, partial);
    this.statusCallbacks.forEach(cb => cb(status));
  }
}
