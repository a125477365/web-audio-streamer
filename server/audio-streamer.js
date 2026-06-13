/**
 * Audio Streamer - Bit-Perfect 架构
 */

import { spawn, execFileSync } from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import { EventEmitter } from 'events';
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg-paths.js';

const CONTROL_MAGIC = Buffer.from([0xAA, 0x55]);
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;
const DEFAULT_BITS_PER_SAMPLE = 16;
// 单个 UDP 数据报上限：低于以太网/WiFi MTU(1500-IP/UDP头)，避免 IP 分片，
// 也保证不超过 ESP32 固件 2048 字节的接收缓冲
const MAX_DATAGRAM_BYTES = 1400;

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
		this.onBufLevel = null; // ESP32 缓冲水位上报回调（闭环流控）
	}

	init() {
		if (this.socket) return;
		this.socket = dgram.createSocket('udp4');
		this.socket.bind(0);
		this.socket.on('message', (msg) => {
			const parsed = parseControlPacket(msg);
			if (!parsed || !parsed.payload) return;
			if (parsed.payload.cmd === 'ack') {
				const pending = this.pendingAcks.get(parsed.seq);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingAcks.delete(parsed.seq);
					pending.resolve(parsed.payload);
				}
			} else if (parsed.payload.cmd === 'bufLevel') {
				if (this.onBufLevel) this.onBufLevel(parsed.payload);
			}
		});
	}

	async sendWithAck(payload, maxRetries = 5, timeoutMs = 500, onRetry = null) {
		this.init();
		const seq = (this.seqCounter++) & 0xFF;
		const packet = buildControlPacket(payload, seq);
		const { host, port } = this.config.esp32;
		return new Promise((resolve, reject) => {
			let attempts = 0;
			const trySend = () => {
				attempts++;
				if (onRetry) {
					onRetry(attempts, maxRetries);
				}
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
		const { sampleRate, channels, bitsPerSample, seekTime = 0, headers = {} } = options;
		const currentId = ++this.currentId;
		this.stop();

		console.log(`[Decoder#${currentId}] Starting: ${filePath}, seek=${seekTime}s`);

		const codecMap = { 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le' };
		const codec = codecMap[bitsPerSample] || 'pcm_s16le';

		// 不用 -re：解码全速进行，由 AudioSender 的闭环 P 控制器按 ESP32 实时上报的
		// 缓冲水位(bufLevel)控速（丢包时可短时 >1x 追赶、水位高时 <1x 减速防溢出），
		// 解码器 stdout 背压（flowIsFull/resumeFlow）把 Node 端内存限制在 ~5s。
		// 注意：加 -re 会把产出钳死在 1x，反而破坏控制器的追赶/预填充能力。
		const ffmpegArgs = [];

		// 注入 -headers（用于 CDN 防盗链，如 Referer/User-Agent）
		const headerEntries = Object.entries(headers);
		if (headerEntries.length > 0 && filePath.startsWith('http')) {
			const headerStr = headerEntries
				.map(([k, v]) => `${k}: ${v}`)
				.join('\r\n');
			ffmpegArgs.push('-headers', headerStr);
		}

		ffmpegArgs.push(
			'-ss', String(seekTime), // 放在 -i 前面，做 input seeking（快速跳转）
			'-i', filePath,
			'-ar', String(sampleRate),
			'-ac', String(channels),
			'-f', `s${bitsPerSample}le`,
			'-acodec', codec,
		);

		// 注意：音量不在解码端处理，由 ESP32 端统一缩放（避免双重衰减）

		ffmpegArgs.push('-');

		const proc = spawn(FFMPEG_PATH, ffmpegArgs, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		this.process = proc;

		if (onData) {
			proc.stdout.on('data', (data) => {
				if (this.currentId === currentId) {
					onData(data);
					// 背压：下游缓冲已满时暂停解码输出
					if (this.flowIsFull && this.flowIsFull()) {
						proc.stdout.pause();
					}
				}
			});
		}
		this.resumeFlow = () => {
			if (this.process === proc) {
				try { proc.stdout.resume(); } catch (e) {}
			}
		};

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
		// 闭环流控状态
		this.espBufLevel = -1;     // ESP32 上报的环形缓冲水位 (0~1)
		this.espBufAt = 0;         // 上报时间戳
		this.highWater = 0;        // 解码背压上限（字节）
		this.lowWater = 0;
		this.onDrain = null;       // 缓冲降至低水位时恢复解码
		this.onEmpty = null;       // 解码结束且缓冲清空时通知播放结束
		this.decodeDone = false;
		this._emptyFired = false;
	}

	start(sampleRate, channels, bitsPerSample) {
		this.stop();
		const chunkDurationMs = 10;
		const bytesPerSample = bitsPerSample / 8;
		const samplesPerChunk = Math.floor(sampleRate * chunkDurationMs / 1000);
		this.chunkSize = samplesPerChunk * channels * bytesPerSample;
		const bytesPerSecond = sampleRate * channels * bytesPerSample;
		// 背压水位：内存中最多缓 5 秒解码数据
		this.highWater = bytesPerSecond * 5;
		this.lowWater = bytesPerSecond * 2;
		// UDP 数据报大小：≤1400 且按采样帧对齐，丢包时不破坏帧边界
		const frameBytes = channels * bytesPerSample;
		this.datagramSize = Math.max(frameBytes, Math.floor(MAX_DATAGRAM_BYTES / frameBytes) * frameBytes);
		this.buffer = Buffer.alloc(0);
		this.bytesSent = 0;
		this.espBufLevel = -1;
		this.espBufAt = 0;
		this.decodeDone = false;
		this._emptyFired = false;
		this.isRunning = true;
		this.sendInterval = setInterval(() => {
			this._sendChunks();
		}, chunkDurationMs);
	}

	feed(data) {
		if (!this.isRunning) return;
		this.buffer = Buffer.concat([this.buffer, data]);
	}

	isFull() {
		return this.buffer.length >= this.highWater;
	}

	updateEspLevel(level) {
		this.espBufLevel = level;
		this.espBufAt = Date.now();
	}

	stop() {
		if (this.sendInterval) {
			clearInterval(this.sendInterval);
			this.sendInterval = null;
		}
		this.isRunning = false;
		this.buffer = Buffer.alloc(0);
		this.decodeDone = false;
		this._emptyFired = false;
	}

	_sendChunks() {
		if (!this.isRunning) return;

		// 闭环速率控制（P 控制，目标水位 0.6）：
		// rate = 1 + 2*(0.6 - level)，范围 [0, 2] 倍实时速率。
		// 目标定在 ESP32 起播阈值(0.5)之上，预留 ~250ms 的丢包突发余量；
		// 水位低 → 加速补偿 WiFi 丢包；水位高 → 减速防溢出。
		// 起播尚无水位反馈时按 2 倍速预填充；反馈中断超 3s 回落到 1 倍速。
		let rate;
		if (this.espBufAt === 0) {
			rate = 2; // 预填充阶段
		} else if (Date.now() - this.espBufAt < 3000) {
			const err = 0.6 - this.espBufLevel;
			rate = 1 + Math.max(-1, Math.min(1, err * 2));
		} else {
			rate = 1; // 反馈中断，保持实时速率
		}

		this._budget = Math.min((this._budget || 0) + rate, 3);
		let sentThisTick = 0;
		while (this.buffer.length >= this.chunkSize && this._budget >= 1 && sentThisTick < 3) {
			const chunk = this.buffer.subarray(0, this.chunkSize);
			this.buffer = this.buffer.subarray(this.chunkSize);
			// 拆分为 MTU 安全的数据报发送，避免 IP 分片和 ESP32 接收缓冲截断
			for (let off = 0; off < chunk.length; off += this.datagramSize) {
				const end = Math.min(off + this.datagramSize, chunk.length);
				this.controlChannel.sendAudio(chunk.subarray(off, end));
			}
			this.bytesSent += this.chunkSize;
			this._budget -= 1;
			sentThisTick++;
		}

		// 解码结束后的尾部数据（不足一个 chunk）直接发出
		if (this.decodeDone && this.buffer.length > 0 && this.buffer.length < this.chunkSize) {
			for (let off = 0; off < this.buffer.length; off += this.datagramSize) {
				const end = Math.min(off + this.datagramSize, this.buffer.length);
				this.controlChannel.sendAudio(this.buffer.subarray(off, end));
			}
			this.bytesSent += this.buffer.length;
			this.buffer = Buffer.alloc(0);
		}

		// 背压恢复：缓冲降到低水位以下，让解码器继续吐数据
		if (this.buffer.length < this.lowWater && this.onDrain) {
			this.onDrain();
		}

		// 播放结束检测：解码完成且发送缓冲已空（ESP32 端还有 ~200ms 余量播完）
		if (this.decodeDone && this.buffer.length === 0 && !this._emptyFired) {
			this._emptyFired = true;
			if (this.onEmpty) this.onEmpty();
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
		this.connectionStatus = { esp32Connecting: false, esp32RetryAttempt: 0, esp32RetryMax: 0, esp32Failed: false };
		this._setupDecoderEvents();
		this._setupFlowControl();
	}

	_setupFlowControl() {
		// ESP32 水位上报 → 发送端闭环调速
		this.controlChannel.onBufLevel = (p) => {
			if (typeof p.level === 'number') this.sender.updateEspLevel(p.level);
		};
		// 解码背压：发送缓冲满则暂停 ffmpeg stdout，降到低水位恢复
		this.decoder.flowIsFull = () => this.sender.isFull();
		this.sender.onDrain = () => { if (this.decoder.resumeFlow) this.decoder.resumeFlow(); };
		// 发送缓冲清空 + 解码结束 → 等 ESP32 播完环形缓冲余量再收尾
		this.sender.onEmpty = () => {
			setTimeout(() => {
				if (this.state === 'playing' && this.sender.decodeDone) {
					this._onPlaybackEnd();
				}
			}, 600);
		};
	}

	_setupDecoderEvents() {
		this.decoder.on('close', ({ id, code }) => {
			console.log(`[AudioStreamer] Decoder closed (id=${id}, code=${code})`);
			if (this.state === 'playing') {
				// 解码结束 ≠ 播放结束：发送缓冲可能还有数秒数据，
				// 标记后由 sender.onEmpty 触发真正的收尾
				this.sender.decodeDone = true;
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

		const probe = this._normalizeFormat(this._probeAudio(filePath));
		const { sampleRate, channels, bitsPerSample, duration } = probe;

		const needReconfig = sampleRate !== this.currentSampleRate ||
			channels !== this.currentChannels ||
			bitsPerSample !== this.currentBitsPerSample;

		if (needReconfig) {
			this._stopPlayback();
			try {
				// 必须等待 ESP32 ACK 成功才能继续播放
				await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
				this.currentSampleRate = sampleRate;
				this.currentChannels = channels;
				this.currentBitsPerSample = bitsPerSample;
			} catch (err) {
				// ESP32 无响应，重置配置以便下次重试
				this.currentSampleRate = 0;
				this.currentChannels = 0;
				this.currentBitsPerSample = 0;
				this.connectionStatus = { esp32Connecting: false, esp32RetryAttempt: 0, esp32RetryMax: 10, esp32Failed: true };
				this._updateStatus(this.connectionStatus);
				this.state = 'idle';
				throw err;
			}
		} else {
			this._stopPlayback();
		}

		this.currentTrack = { path: filePath, type: 'local' };
		this.duration = duration;
		this.seekOffset = seekTime;
		this.playStartTime = Date.now();

		this.sender.start(sampleRate, channels, bitsPerSample);
		this.decoder.decode(filePath, {
			sampleRate, channels, bitsPerSample, seekTime
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

	async playUrl(url, options = {}) {
		const { headers = {}, seekTime = 0 } = typeof options === 'number' ? { seekTime: options } : options;
		console.log(`[AudioStreamer] playUrl: ${url}`, Object.keys(headers).length > 0 ? `(headers: ${Object.keys(headers).join(',')})` : '');

		const probe = this._normalizeFormat(this._probeAudio(url, headers));
		const { sampleRate, channels, bitsPerSample, duration } = probe;

		const needReconfig = sampleRate !== this.currentSampleRate ||
			channels !== this.currentChannels ||
			bitsPerSample !== this.currentBitsPerSample;

		if (needReconfig) {
			this._stopPlayback();
			try {
				// 必须等待 ESP32 ACK 成功才能继续播放
				await this._notifyEsp32Config(sampleRate, bitsPerSample, channels);
				this.currentSampleRate = sampleRate;
				this.currentChannels = channels;
				this.currentBitsPerSample = bitsPerSample;
			} catch (err) {
				// ESP32 无响应，重置配置以便下次重试
				this.currentSampleRate = 0;
				this.currentChannels = 0;
				this.currentBitsPerSample = 0;
				this.connectionStatus = { esp32Connecting: false, esp32RetryAttempt: 0, esp32RetryMax: 10, esp32Failed: true };
				this._updateStatus(this.connectionStatus);
				this.state = 'idle';
				throw err;
			}
		} else {
			this._stopPlayback();
		}

		this.currentTrack = { url, type: 'url', headers };
		this.duration = duration;
		this.seekOffset = seekTime;
		this.playStartTime = Date.now();

		this.sender.start(sampleRate, channels, bitsPerSample);
		this.decoder.decode(url, {
			sampleRate, channels, bitsPerSample, seekTime, headers
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
			await this.playUrl(this.currentTrack.url, { headers: this.currentTrack.headers || {}, seekTime });
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
				this.playUrl(this.currentTrack.url, { headers: this.currentTrack.headers || {}, seekTime: this.pausedTime });
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
			bitsPerSample: this.currentBitsPerSample,
			...this.connectionStatus
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

	_probeAudio(input, headers = {}) {
		try {
			// 使用参数数组调用 ffprobe，避免 shell 引号/注入问题
			const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];
			const headerEntries = Object.entries(headers);
			if (headerEntries.length > 0 && input.startsWith('http')) {
				const headerStr = headerEntries
					.map(([k, v]) => `${k}: ${v}`)
					.join('\r\n');
				args.push('-headers', headerStr);
			}
			args.push(input);
			const result = execFileSync(FFPROBE_PATH, args, { timeout: 10000, encoding: 'utf-8' });
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

	/**
	 * 频率/位深协调：把任意源格式映射为 CS8406 (经 ESP32 I2S) 可稳定播放的格式
	 *
	 * 目标硬件 = CS8406 S/PDIF 发射板（光纤/同轴输出）：
	 * - 位深：统一输出 32bit I2S 帧 → BCK=64Fs，正是 CS8406 规格要求的帧格式；
	 *   16/24bit 源由 ffmpeg 升位到 32bit 容器，音频数据落在高位（CS8406 取高 24bit，无损）。
	 * - 采样率：CS8406 支持 44.1k–192k，但 ESP32 单线程 UDP 在高码率下易欠载，
	 *   故限制在 44.1k/48k：<44.1k 上采到 44.1k，>48k 按整数比降到 44.1k 或 48k。
	 * - 声道：>2 声道混缩为立体声。
	 *
	 * 注意：CS8406 必须有 MCLK(256Fs)，由固件 I2S_MCLK_PIN 提供，与此处采样率配套。
	 */
	_normalizeFormat(probe) {
		const out = { ...probe };
		// 始终 32bit 帧，匹配 CS8406 的 64Fs BCK 要求
		out.bitsPerSample = 32;
		let rate = probe.sampleRate || DEFAULT_SAMPLE_RATE;
		if (rate > 48000) {
			rate = (rate % 44100 === 0) ? 44100 : 48000; // 88.2/176.4k→44.1k，96/192k→48k
		} else if (rate < 44100) {
			rate = 44100; // CS8406 下限 44.1k，低于则上采样
		}
		out.sampleRate = rate;
		out.channels = Math.min(probe.channels || DEFAULT_CHANNELS, 2) || DEFAULT_CHANNELS;
		if (out.sampleRate !== probe.sampleRate || out.bitsPerSample !== probe.bitsPerSample || out.channels !== probe.channels) {
			console.log(`[AudioStreamer] 格式协调: ${probe.sampleRate}Hz/${probe.bitsPerSample}bit/${probe.channels}ch → ${out.sampleRate}Hz/${out.bitsPerSample}bit/${out.channels}ch`);
		}
		return out;
	}

	async _notifyEsp32Config(sampleRate, bitsPerSample, channels) {
		console.log(`[AudioStreamer] Notifying ESP32: ${sampleRate}Hz / ${bitsPerSample}bit / ${channels}ch`);
		try {
			const ack = await this.controlChannel.sendWithAck(
				{ cmd: 'setAudioConfig', sampleRate, bitsPerSample, channels },
				10, 500,
				(attempt, max) => {
					this.connectionStatus = { esp32Connecting: true, esp32RetryAttempt: attempt, esp32RetryMax: max, esp32Failed: false };
					this._updateStatus(this.connectionStatus);
				}
			);
			if (ack?.status && ack.status !== 'ok') {
				throw new Error(`ESP32 rejected audio config (status=${ack.status})`);
			}
			this.connectionStatus = { esp32Connecting: false, esp32RetryAttempt: 0, esp32RetryMax: 0, esp32Failed: false };
			this._updateStatus(this.connectionStatus);
			console.log(`[AudioStreamer] ESP32 confirmed:`, ack?.status);
			return ack;
		} catch (err) {
			console.error(`[AudioStreamer] ESP32 not responding:`, err.message);
			throw err;
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
