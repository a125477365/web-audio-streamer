/**
 * 模拟 ESP32 的 UDP 接收端 — 用于无真机时验证后端协议与闭环流控
 *
 * 与固件一致的行为：
 *   控制包: [0xAA][0x55][seq][len_h][len_l][JSON]，对每个控制命令回 cmd=ack
 *   音频包: 其余包视为 PCM，进入模拟环形缓冲
 *   闭环反馈: 每 200ms 回报 {"cmd":"bufLevel","level":x}（同样的帧格式），
 *            后端 P 控制器据此把发送速率锁定在 ~1x（目标水位 0.6）
 *   模拟消费: 以 setAudioConfig 指定的字节率"播放"（从缓冲扣除），
 *            缓冲满则丢弃（等价固件的溢出丢包）
 *
 * 用法: node test/mock-esp32.js [port]
 */
import dgram from "dgram";

const PORT = parseInt(process.argv[2] || "8000", 10);
const socket = dgram.createSocket("udp4");

let currentConfig = null;
let bytesPerSec = 0;
let bufferBytes = 0;     // 模拟环形缓冲已用字节
let capacityBytes = 0;   // 模拟环形缓冲容量（默认 200ms）
let peer = null;         // 最近发包方 {address, port}

// 统计
let audioBytes = 0;
let audioPackets = 0;
let maxDatagram = 0;
let overflowDrops = 0;
let lastReport = Date.now();

function sendFramed(payload) {
  if (!peer) return;
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const pkt = Buffer.alloc(5 + json.length);
  pkt[0] = 0xaa; pkt[1] = 0x55; pkt[2] = 0;
  pkt.writeUInt16BE(json.length, 3);
  json.copy(pkt, 5);
  socket.send(pkt, peer.port, peer.address);
}

socket.on("message", (msg, rinfo) => {
  peer = { address: rinfo.address, port: rinfo.port };

  if (msg.length >= 5 && msg[0] === 0xaa && msg[1] === 0x55) {
    const seq = msg[2];
    const len = msg.readUInt16BE(3);
    let payload = {};
    try {
      payload = JSON.parse(msg.subarray(5, 5 + len).toString("utf-8"));
    } catch {
      console.log("[MOCK] 控制包 JSON 解析失败");
      return;
    }
    console.log(`[MOCK] 控制命令 seq=${seq}:`, JSON.stringify(payload));
    if (payload.cmd === "setAudioConfig") {
      currentConfig = payload;
      bytesPerSec = (payload.sampleRate * payload.channels * payload.bitsPerSample) / 8;
      capacityBytes = Math.round(bytesPerSec * 0.2); // 200ms 环形缓冲
      bufferBytes = 0;
      audioBytes = 0; audioPackets = 0; maxDatagram = 0; overflowDrops = 0;
    }
    // 回 ACK（与固件 sendAck 相同格式）
    sendFramed({ cmd: "ack", originalCmd: payload.cmd, status: "ok" });
    return;
  }

  // 音频数据 → 进入模拟缓冲（溢出丢弃）
  audioBytes += msg.length;
  audioPackets += 1;
  if (msg.length > maxDatagram) maxDatagram = msg.length;
  if (capacityBytes > 0) {
    if (bufferBytes + msg.length <= capacityBytes) {
      bufferBytes += msg.length;
    } else {
      bufferBytes = capacityBytes;
      overflowDrops += 1;
    }
  }
});

// 模拟"播放"：按字节率匀速从缓冲扣除（每 20ms）
setInterval(() => {
  if (bytesPerSec > 0 && bufferBytes > 0) {
    bufferBytes = Math.max(0, bufferBytes - bytesPerSec * 0.02);
  }
}, 20);

// 闭环反馈：每 200ms 回报缓冲水位（与固件一致）
setInterval(() => {
  if (currentConfig && capacityBytes > 0) {
    sendFramed({ cmd: "bufLevel", level: +(bufferBytes / capacityBytes).toFixed(2) });
  }
}, 200);

// 统计输出：实测码率应收敛到理论值（~1x），水位应稳定在 ~0.6
setInterval(() => {
  const now = Date.now();
  if (now - lastReport >= 2000 && audioPackets > 0) {
    const kbps = ((audioBytes * 8) / ((now - lastReport) / 1000) / 1000).toFixed(0);
    const expected = bytesPerSec ? ((bytesPerSec * 8) / 1000).toFixed(0) : 0;
    const level = capacityBytes ? (bufferBytes / capacityBytes).toFixed(2) : "—";
    console.log(
      `[MOCK] 音频流: ${audioPackets} 包, 最大数据报 ${maxDatagram}B, 实测 ${kbps} kbps ` +
      `(理论 ${expected} kbps), 水位 ${level}, 溢出丢包 ${overflowDrops}`
    );
    audioBytes = 0; audioPackets = 0; lastReport = now;
  }
}, 500);

socket.bind(PORT, () => {
  console.log(`[MOCK] 模拟 ESP32（含闭环反馈）正在监听 UDP :${PORT}`);
});
