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
// ACK 包格式 (与控制包相同，JSON 中 cmd="ack"):
// [0xAA][0x55][seq(1字节)][length(2字节,大端)][JSON payload]
//

const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const ACK_TIMEOUT_MS = 500; // ACK 超时时间
const ACK_MAX_RETRIES = 10; // 最大重试次数

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

function isAckPacket(parsed, expectedSeq) {
 return parsed && parsed.seq === expectedSeq && parsed.payload && parsed.payload.cmd === 'ack';
}

function formatTime(seconds) {
 const mins = Math.floor(seconds / 60);
 const secs = Math.floor(seconds % 60);
 return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export class AudioStreamer {
 constructor(config) {
 this.config = config;
 this.ffmpegProcess = null;
 this.udpSocket = null;
 this.isPlaying = false;
 this.shouldStop = false;
 this.currentSource = null;
 this.currentSampleRate = null;
 this.currentDuration = 0;
 this.playStartTime = null;
 this.volume = 100;
 this.statusCallbacks = [];
 this.progressTimer = null;
 this.sendTimer = null; // 发送定时器
 this._lock = false; // 播放锁

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
 
 // 如果正在播放，先停止
 if (this.isPlaying || this._lock) {
 this.stop();
 await new Promise(r => setTimeout(r, 100)); // 等待停止完成
 }
 
 this._lock = true;
 try {
 this.stop();
 this.shouldStop = false;
 this.currentSource = { type: 'local', path: filePath };
 await this._startFFmpeg(filePath);
 } finally {
 this._lock = false;
 }
 }

 /**
 * 播放在线 URL
 */
 async playUrl(url) {
 // 如果正在播放，先停止
 if (this.isPlaying || this._lock) {
 this.stop();
 await new Promise(r => setTimeout(r, 100));
 }
 
 this._lock = true;
 try {
 this.stop();
 this.shouldStop = false;
 this.currentSource = { type: 'url', url };
 await this._startFFmpeg(url);
 } finally {
 this._lock = false;
 }
 }

 /**
 * 用 ffprobe 探测音频信息（包括时长）
 */
 _probeAudio(input) {
 try {
 const cmd = input.startsWith('http')
 ? `ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`
 : `ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`;
 const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8', shell: true });
 const info = JSON.parse(result);

 let duration = 0;
 if (info.format && info.format.duration) {
 duration = parseFloat(info.format.duration);
 } else if (info.streams && info.streams.length > 0) {
 duration = parseFloat(info.streams[0].duration) || 0;
 }

 if (info.streams && info.streams.length > 0) {
 const stream = info.streams.find(s => s.codec_type === 'audio') || info.streams[0];
 return {
 sampleRate: parseInt(stream.sample_rate) || 44100,
 channels: parseInt(stream.channels) || 2,
 bitsPerSample: parseInt(stream.bits_per_raw_sample) || parseInt(stream.bits_per_sample) || 16,
 duration: duration
 };
 }
 } catch (err) {
 console.warn('[AudioStreamer] ffprobe failed, using defaults:', err.message);
 }
 return { sampleRate: 44100, channels: 2, bitsPerSample: 16, duration: 0 };
 }

 /**
 * 发送控制包并等待 ACK（最多重试 ACK_MAX_RETRIES 次）
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
 if (this.shouldStop) {
 cleanup();
 reject(new Error('User stopped playback'));
 return;
 }

 attemptCount++;
 console.log(`[AudioStreamer] Sending control packet seq=${seq}, attempt ${attemptCount}/${ACK_MAX_RETRIES}`);

 this.udpSocket.send(packet, port, host, (err) => {
 if (err) {
 cleanup();
 reject(err);
 }
 });

 if (attemptCount > ACK_MAX_RETRIES) {
 cleanup();
 reject(new Error(`No ACK received after ${ACK_MAX_RETRIES} attempts`));
 return;
 }

 timeoutId = setTimeout(() => {
 if (!resolved && !this.shouldStop) {
 sendAndWait();
 }
 }, ACK_TIMEOUT_MS);
 };

 sendAndWait();
 });
 }

 /**
 * 发送控制包给 ESP32（无 ACK）
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
 * 通知 ESP32 切换音频配置
 */
 async _notifyEsp32Config(sampleRate, bitsPerSample, channels) {
 console.log(`[AudioStreamer] Notifying ESP32: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
 try {
 const ack = await this._sendControlWithAck({
 cmd: 'setAudioConfig',
 sampleRate,
 bitsPerSample,
 channels
 });
 console.log(`[AudioStreamer] ESP32 confirmed:`, ack.status);
 await new Promise(r => setTimeout(r, 50));
 } catch (err) {
 console.error('[AudioStreamer] Failed to get ACK from ESP32:', err.message);
 throw err;
 }
 }

 /**
 * 停止播放（通知 ESP32）
 */
 async _notifyEsp32Stop() {
 this.shouldStop = true;
 try {
 await this._sendControlNoAck({ cmd: 'stop' });
 } catch (e) {
 // 忽略错误
 }
 }

 /**
 * 启动进度更新定时器
 */
 _startProgressTimer() {
 this._stopProgressTimer();
 this.playStartTime = Date.now();
 this.progressTimer = setInterval(() => {
 if (this.isPlaying && this.currentDuration > 0) {
 const elapsed = (Date.now() - this.playStartTime) / 1000;
 const progress = Math.min(elapsed / this.currentDuration, 1);
 this._updateStatus({
 currentTime: elapsed,
 duration: this.currentDuration,
 currentTimeText: formatTime(elapsed),
 durationText: formatTime(this.currentDuration),
 progress: Math.round(progress * 100)
 });
 }
 }, 1000);
 }

 /**
 * 停止进度更新定时器
 */
 _stopProgressTimer() {
 if (this.progressTimer) {
 clearInterval(this.progressTimer);
 this.progressTimer = null;
 }
 }

 /**
 * 启动 FFmpeg 进程
 */
 async _startFFmpeg(input) {
 const { bitsPerSample, channels: configChannels } = this.config.audio;

 const probe = this._probeAudio(input);
 const actualSampleRate = probe.sampleRate;
 const actualChannels = configChannels || probe.channels;
 const duration = probe.duration;

 this.currentSampleRate = actualSampleRate;
 this.currentDuration = duration;

 console.log(`[AudioStreamer] Source probe: ${actualSampleRate}Hz / ${actualChannels}ch / ${probe.bitsPerSample}bit / ${duration.toFixed(1)}s`);

 const codecMap = {
 16: 'pcm_s16le',
 24: 'pcm_s24le',
 32: 'pcm_s32le'
 };
 const codec = codecMap[bitsPerSample] || 'pcm_s16le';

 // 先通知 ESP32 切换采样率
 try {
 await this._notifyEsp32Config(actualSampleRate, bitsPerSample, actualChannels);
 } catch (err) {
 console.error('[AudioStreamer] Failed to notify ESP32:', err.message);
 return;
 }

 // FFmpeg 参数
 const ffmpegArgs = [
 '-i', input,
 '-ar', String(actualSampleRate),
 '-ac', String(actualChannels),
 '-f', `s${bitsPerSample}le`,
 '-acodec', codec,
 ];

 if (this.volume !== 100) {
 const volumeFilter = `volume=${this.volume / 100}`;
 ffmpegArgs.push('-af', volumeFilter);
 }

 ffmpegArgs.push('-');

 console.log('[AudioStreamer] FFmpeg:', 'ffmpeg', ffmpegArgs.join(' '));

 // 启动 FFmpeg
 this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
 stdio: ['ignore', 'pipe', 'pipe']
 });

 this.ffmpegProcess.on('error', (err) => {
 console.error('[AudioStreamer] FFmpeg error:', err);
 this._stopAll();
 this._updateStatus({ isPlaying: false, error: err.message });
 });

 this.ffmpegProcess.stderr.on('data', (data) => {
 const msg = data.toString();
 if (msg.includes('error') || msg.includes('Error')) {
 console.error('[FFmpeg]', msg);
 }
 });

 // 开始播放
 this.isPlaying = true;
 this._startProgressTimer();
 this._updateStatus({
 isPlaying: true,
 source: this.currentSource,
 sampleRate: actualSampleRate,
 duration: duration,
 durationText: formatTime(duration),
 currentTime: 0,
 currentTimeText: '0:00',
 progress: 0
 });

 // 计算发送参数
 const chunkDurationMs = this.config.audio.bufferMs || 10;
 const bytesPerSample = bitsPerSample / 8;
 const samplesPerChunk = Math.floor(actualSampleRate * chunkDurationMs / 1000);
 const chunkSize = samplesPerChunk * actualChannels * bytesPerSample;

 console.log(`[AudioStreamer] Rate control: ${actualSampleRate}Hz, chunk=${chunkSize}B, interval=${chunkDurationMs}ms`);

 let buffer = Buffer.alloc(0);
 const prefillChunks = 4;
 let sentChunks = 0;
 let lastSendTime = Date.now();

 const sendChunk = () => {
 if (!this.isPlaying || this.shouldStop) return;
 
 if (buffer.length >= chunkSize) {
 const chunk = buffer.subarray(0, chunkSize);
 buffer = buffer.subarray(chunkSize);
 this._sendUdpChunk(chunk);
 sentChunks++;
 }
 };

 this.ffmpegProcess.stdout.on('data', (data) => {
 buffer = Buffer.concat([buffer, data]);

 // 预填充
 while (sentChunks < prefillChunks && buffer.length >= chunkSize && this.isPlaying) {
 const chunk = buffer.subarray(0, chunkSize);
 buffer = buffer.subarray(chunkSize);
 this._sendUdpChunk(chunk);
 sentChunks++;
 }

 // 预填充完成后，按时间间隔发送
 if (sentChunks >= prefillChunks && this.isPlaying && !this.shouldStop) {
 const now = Date.now();
 const elapsed = now - lastSendTime;
 if (elapsed >= chunkDurationMs) {
 sendChunk();
 lastSendTime = now;
 }
 }
 });

 this.ffmpegProcess.on('close', (code) => {
 console.log('[AudioStreamer] FFmpeg closed with code:', code);
 this._stopAll();
 });

 // 使用 setInterval 替代递归 setTimeout，避免阻塞事件循环
 this.sendTimer = setInterval(() => {
 if (this.isPlaying && !this.shouldStop && sentChunks >= prefillChunks) {
 sendChunk();
 }
 }, chunkDurationMs);
 }

 /**
 * 停止所有定时器和进程
 */
 _stopAll() {
 this._stopProgressTimer();
 if (this.sendTimer) {
 clearInterval(this.sendTimer);
 this.sendTimer = null;
 }
 if (this.ffmpegProcess) {
 this.ffmpegProcess.kill('SIGTERM');
 this.ffmpegProcess = null;
 }
 this.isPlaying = false;
 this._updateStatus({
 isPlaying: false,
 source: null,
 currentTime: 0,
 currentTimeText: '0:00',
 progress: 0
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
 this.shouldStop = true;
 this._notifyEsp32Stop();
 this._stopAll();
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
 const currentTime = this.playStartTime && this.isPlaying
 ? (Date.now() - this.playStartTime) / 1000
 : 0;
 
 return {
 isPlaying: this.isPlaying,
 volume: this.volume,
 source: this.currentSource,
 currentSampleRate: this.currentSampleRate,
 duration: this.currentDuration,
 durationText: formatTime(this.currentDuration),
 currentTime: currentTime,
 currentTimeText: formatTime(currentTime),
 progress: this.playStartTime && this.currentDuration > 0 && this.isPlaying
 ? Math.min(Math.round((currentTime / this.currentDuration) * 100), 100)
 : 0,
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
