/**
 * Audio Streamer - 使用 FFmpeg 转码并通过 UDP 发送到 ESP32
 * Bit-Perfect 方案：按源文件原采样率输出，控制包带 ACK 确认机制
 */

import { spawn, execSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';

const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const ACK_TIMEOUT_MS = 500;
const ACK_MAX_RETRIES = 10;

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
 this.sendTimer = null;
 this._lock = false;

 this.udpSocket = dgram.createSocket('udp4');
 this.udpSocket.bind(0);
 }

 async playLocalFile(filePath, seekTime = 0) {
 if (!fs.existsSync(filePath)) {
 throw new Error(`File not found: ${filePath}`);
 }
 
 if (this.isPlaying || this._lock) {
 this.stop();
 await new Promise(r => setTimeout(r, 100));
 }
 
 this._lock = true;
 try {
 this.stop();
 this.shouldStop = false;
 this.currentSource = { type: 'local', path: filePath };
 await this._startFFmpeg(filePath, seekTime);
 } finally {
 this._lock = false;
 }
 }

 async playUrl(url, seekTime = 0) {
 if (this.isPlaying || this._lock) {
 this.stop();
 await new Promise(r => setTimeout(r, 100));
 }
 
 this._lock = true;
 try {
 this.stop();
 this.shouldStop = false;
 this.currentSource = { type: 'url', url };
 await this._startFFmpeg(url, seekTime);
 } finally {
 this._lock = false;
 }
 }

 /**
 * 跳转到指定时间点
 */
 async seek(seconds) {
 if (!this.currentSource) return;
 
 console.log(`[AudioStreamer] Seeking to ${seconds}s`);
 
 const seekTime = Math.max(0, Math.min(seconds, this.currentDuration));
 
 if (this.currentSource.type === 'local') {
 await this.playLocalFile(this.currentSource.path, seekTime);
 } else {
 await this.playUrl(this.currentSource.url, seekTime);
 }
 }

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

 async _notifyEsp32Stop() {
 this.shouldStop = true;
 try {
 await this._sendControlNoAck({ cmd: 'stop' });
 } catch (e) {}
 }

 _startProgressTimer(seekTime = 0) {
 this._stopProgressTimer();
 this.playStartTime = Date.now() - seekTime * 1000; // 考虑跳转时间
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

 _stopProgressTimer() {
 if (this.progressTimer) {
 clearInterval(this.progressTimer);
 this.progressTimer = null;
 }
 }

 async _startFFmpeg(input, seekTime = 0) {
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

 try {
 await this._notifyEsp32Config(actualSampleRate, bitsPerSample, actualChannels);
 } catch (err) {
 console.error('[AudioStreamer] Failed to notify ESP32:', err.message);
 return;
 }

 const ffmpegArgs = [
 '-i', input,
 '-ss', String(seekTime || 0),  // 跳转时间点（秒）
 '-ar', String(actualSampleRate),
 '-ac', String(actualChannels),
 '-f', `s${bitsPerSample}le`,
 '-acodec', codec,
 ];

 if (this.volume !== 100) {
 ffmpegArgs.push('-af', `volume=${this.volume / 100}`);
 }

 ffmpegArgs.push('-');

 console.log('[AudioStreamer] FFmpeg:', 'ffmpeg', ffmpegArgs.join(' '));

 this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
 stdio: ['ignore', 'pipe', 'pipe']
 });

 this.ffmpegProcess.on('error', (err) => {
 console.error('[AudioStreamer] FFmpeg error:', err);
 this._stopAll();
 this._updateStatus({ isPlaying: false, error: err.message });
 });

 this.ffmpegProcess.stderr.on('data', (data) => {
 // FFmpeg 日志，可以忽略
 });

 this.isPlaying = true;
 this._startProgressTimer(seekTime);
 this._updateStatus({
 isPlaying: true,
 source: this.currentSource,
 sampleRate: actualSampleRate,
 duration: duration,
 durationText: formatTime(duration),
 currentTime: seekTime,
 currentTimeText: formatTime(seekTime),
 progress: duration > 0 ? Math.round((seekTime / duration) * 100) : 0
 });

 // 计算发送参数
 const chunkDurationMs = this.config.audio.bufferMs || 10;
 const bytesPerSample = bitsPerSample / 8;
 const samplesPerChunk = Math.floor(actualSampleRate * chunkDurationMs / 1000);
 const chunkSize = samplesPerChunk * actualChannels * bytesPerSample;

 console.log(`[AudioStreamer] Rate control: ${actualSampleRate}Hz, chunk=${chunkSize}B, interval=${chunkDurationMs}ms`);

 // 缓冲区和发送状态
 let buffer = Buffer.alloc(0);
 let sentChunks = 0;
 const prefillChunks = 4;

 // 发送单个 chunk
 const sendChunk = () => {
 if (!this.isPlaying || this.shouldStop) return false;
 if (buffer.length >= chunkSize) {
 const chunk = buffer.subarray(0, chunkSize);
 buffer = buffer.subarray(chunkSize);
 this._sendUdpChunk(chunk);
 sentChunks++;
 return true;
 }
 return false;
 };

 // FFmpeg 数据到达
 this.ffmpegProcess.stdout.on('data', (data) => {
 buffer = Buffer.concat([buffer, data]);

 // 预填充：快速发送前几个 chunk
 while (sentChunks < prefillChunks && buffer.length >= chunkSize && this.isPlaying) {
 sendChunk();
 }
 });

 // FFmpeg 结束
 this.ffmpegProcess.on('close', (code) => {
 console.log('[AudioStreamer] FFmpeg closed with code:', code);
 // 发送剩余数据
 while (buffer.length >= chunkSize) {
 sendChunk();
 }
 if (buffer.length > 0) {
 this._sendUdpChunk(buffer);
 buffer = Buffer.alloc(0);
 }
 this._stopAll();
 });

 // 启动定时发送（预填充后）
 this.sendTimer = setInterval(() => {
 if (!this.isPlaying || this.shouldStop) return;
 if (sentChunks >= prefillChunks) {
 sendChunk();
 }
 }, chunkDurationMs);
 }

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

 _sendUdpChunk(chunk) {
 const { host, port } = this.config.esp32;
 this.udpSocket.send(chunk, port, host, (err) => {
 if (err) {
 console.error('[AudioStreamer] UDP send error:', err);
 }
 });
 }

 stop() {
 this.shouldStop = true;
 this._notifyEsp32Stop();
 this._stopAll();
 }

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

 onStatusChange(callback) {
 this.statusCallbacks.push(callback);
 }

 _updateStatus(partial) {
 const status = this.getStatus();
 Object.assign(status, partial);
 this.statusCallbacks.forEach(cb => cb(status));
 }
}
