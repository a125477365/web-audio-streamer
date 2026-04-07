/**
 * Audio Streamer - Bit-Perfect 架构
 */

import { spawn, execSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import { EventEmitter } from 'events';

const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;
const DEFAULT_BITS_PER_SAMPLE = 16;

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

		console.log(`[Decoder#${currentId}] Starting: ${filePath}, seek=${seekTime}s`);

		const codecMap = { 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le' };
		const codec = codecMap[bitsPerSample] || 'pcm_s16le';

		const ffmpegArgs = [
			'-re',
			'-ss', String(seekTime),  // 放在 -i 前面，做 input seeking（快速跳转）
			'-i', filePath,
			'-ar', String(sampleRate),
			'-ac', String(channels),
			'-f', `s${bitsPerSample}le`,
			'-acodec', codec,
		];

		if (volume !== 100) {
			ffmpegArgs.push('-af', `volume=${volume / 100}`);
		}

		ffmpegArgs.push('-');

		const proc = spawn('ffmpeg', ffmpegArgs, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		this.process = proc;

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
			// 只有当前进程结束时才发射事件
			if (this.currentId === currentId) {
				this.process = null;
				this.emit('close', { id: currentId, code });
			}
		});

		return { id: currentId };
	}

	isRunning() {
		return this.process !== null;
	}
}

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

export class AudioStreamer {
	constructor(config) {
		this.config = config;
		this.state = 'idle';
		this.currentTrack = null;
		this.duration = 0;
		this.seekOffset = 0;
		this.playStartTime = 0;
		this.pausedTime = 0; // 暂停时记录的时间
		this.volume = 100;
		this.currentSampleRate = 0;
		this.currentChannels = 0;
		this.currentBitsPerSample = 0;
		this.controlChannel = new UDPControlChannel(config);
		this.decoder = new FFmpegDecoder();
		this.sender = new AudioSender(this.controlChannel);
		this.statusCallbacks = [];
		this._setupDecoderEvents();
	}

	_setupDecoderEvents() {
		this.decoder.on('close', ({ id, code }) => {
			console.log(`[AudioStreamer] Decoder closed (id=${id}, code=${code})`);
			if (this.state === 'playing') {
				this._onPlaybackEnd();
			}
		});

		this.decoder.on('error', ({ id, error }) => {
			console.error(`[AudioStreamer] Decoder error:`, error.message);
		});
	}

	async playLocalFile(filePath, seekTime = 0) {
		if (!fs.existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		console.log(`[AudioStreamer] playLocalFile: ${filePath}, seek=${seekTime}s`);

		const probe = this._probeAudio(filePath);
		const { sampleRate, channels, bitsPerSample, duration } = probe;

		const needReconfig = sampleRate !== this.currentSampleRate ||
			channels !== this.currentChannels ||
			bitsPerSample !== this.currentBitsPerSample;

		if (needReconfig) {
			this._stopPlayback();
			try {
				await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
			} catch (err) {
				console.warn('[AudioStreamer] ESP32 config failed:', err.message);
			}
			this.currentSampleRate = sampleRate;
			this.currentChannels = channels;
			this.currentBitsPerSample = bitsPerSample;
		} else {
			this._stopPlayback();
		}

		this.currentTrack = { path: filePath, type: 'local' };
		this.duration = duration;
		this.seekOffset = seekTime; // 记录 seek 偏移
		this.playStartTime = Date.now();

		this.sender.start(sampleRate, channels, bitsPerSample);
		this.decoder.decode(filePath, {
			sampleRate, channels, bitsPerSample, seekTime, volume: this.volume
		}, (data) => {
			this.sender.feed(data);
		});

		this.state = 'playing';

		this._updateStatus({
			isPlaying: true,
			source: this.currentTrack,
			duration,
			durationText: formatTime(duration),
			currentTime: seekTime,
			currentTimeText: formatTime(seekTime),
			sampleRate, channels, bitsPerSample
		});
	}

	async playUrl(url, seekTime = 0) {
		console.log(`[AudioStreamer] playUrl: ${url}`);

		const probe = this._probeAudio(url);
		const { sampleRate, channels, bitsPerSample, duration } = probe;

		const needReconfig = sampleRate !== this.currentSampleRate ||
			channels !== this.currentChannels ||
			bitsPerSample !== this.currentBitsPerSample;

		if (needReconfig) {
			this._stopPlayback();
			try {
				await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
			} catch (err) {
				console.warn('[AudioStreamer] ESP32 config failed:', err.message);
			}
			this.currentSampleRate = sampleRate;
			this.currentChannels = channels;
			this.currentBitsPerSample = bitsPerSample;
		} else {
			this._stopPlayback();
		}

		this.currentTrack = { url, type: 'url' };
		this.duration = duration;
		this.seekOffset = seekTime;
		this.playStartTime = Date.now();

		this.sender.start(sampleRate, channels, bitsPerSample);
		this.decoder.decode(url, {
			sampleRate, channels, bitsPerSample, seekTime, volume: this.volume
		}, (data) => {
			this.sender.feed(data);
		});

		this.state = 'playing';

		this._updateStatus({
			isPlaying: true,
			source: this.currentTrack,
			duration,
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
		this.duration = 0;
		this.seekOffset = 0;
		this.playStartTime = 0;
		this._sendIdleStatus();
	}

	pause() {
		if (this.state !== 'playing') return;
		console.log('[AudioStreamer] Pausing');
		// 记录当前播放时间
		this.pausedTime = this._calcCurrentTime();
		this._stopPlayback();
		this.state = 'paused';
		this._updateStatus({
			isPlaying: false,
			currentTime: this.pausedTime,
			currentTimeText: formatTime(this.pausedTime)
		});
	}

	resume() {
		if (this.state !== 'paused') return;
		console.log('[AudioStreamer] Resuming from', this.pausedTime);
		// 从暂停位置继续播放
		if (this.currentTrack) {
			if (this.currentTrack.type === 'local') {
				this.playLocalFile(this.currentTrack.path, this.pausedTime);
			} else {
				this.playUrl(this.currentTrack.url, this.pausedTime);
			}
		}
	}

	async setVolume(volume) {
		this.volume = Math.max(0, Math.min(100, volume));
		console.log(`[AudioStreamer] Setting volume to ${this.volume}%`);

		// 发送音量命令给 ESP32，等待 ACK 确认
		try {
			const ack = await this.controlChannel.sendWithAck(
				{ cmd: 'setVolume', volume: this.volume },
				10,  // 最多重试 10 次
				500  // 每次超时 500ms
			);
			console.log(`[AudioStreamer] ESP32 volume confirmed:`, ack?.status);
		} catch (err) {
			console.warn('[AudioStreamer] ESP32 volume set failed:', err.message);
		}

		// 更新状态
		this._updateStatus({ volume: this.volume });
	}

	// 计算当前播放时间（基于 seekOffset + 实际播放时长）
	_calcCurrentTime() {
		if (this.state === 'paused') {
			return this.pausedTime || 0;
		}
		if (this.state !== 'playing' || !this.playStartTime) return 0;
		const elapsed = (Date.now() - this.playStartTime) / 1000;
		return Math.min(this.seekOffset + elapsed, this.duration);
	}

	getStatus() {
		const currentTime = this._calcCurrentTime();
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
		return {
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: DEFAULT_CHANNELS,
			bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
			duration: 0
		};
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
			console.warn('[AudioStreamer] ESP32 not responding:', err.message);
		}
	}

	_onPlaybackEnd() {
		console.log('[AudioStreamer] Playback ended');
		this.state = 'idle';
		this.currentTrack = null;
		this.duration = 0;
		this.seekOffset = 0;
		this.playStartTime = 0;
		this.controlChannel.sendNoAck({ cmd: 'stop' }).catch(() => {});
		this._sendIdleStatus();
	}

	_sendIdleStatus() {
		this._updateStatus({
			isPlaying: false,
			currentTime: 0,
			currentTimeText: '0:00',
			progress: 0,
			duration: 0,
			durationText: '0:00'
		});
	}

	_updateStatus(partial) {
		const status = this.getStatus();
		Object.assign(status, partial);
		this.statusCallbacks.forEach(cb => cb(status));
	}
}
