/**
 * 模拟 ESP32 的 UDP 接收端 — 用于无真机时验证后端协议
 *
 * 实现与固件一致的控制协议：
 *   控制包: [0xAA][0x55][seq][len_h][len_l][JSON]，回复 cmd=ack
 *   其余包视为音频流，统计字节速率与数据报大小
 *
 * 用法: node test/mock-esp32.js [port]
 */
import dgram from "dgram";

const PORT = parseInt(process.argv[2] || "8000", 10);
const socket = dgram.createSocket("udp4");

let audioBytes = 0;
let audioPackets = 0;
let maxDatagram = 0;
let currentConfig = null;
let lastReport = Date.now();

socket.on("message", (msg, rinfo) => {
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
      audioBytes = 0;
      audioPackets = 0;
      maxDatagram = 0;
    }
    // 回 ACK（与固件 sendAck 相同格式）
    const ackJson = Buffer.from(
      JSON.stringify({ cmd: "ack", originalCmd: payload.cmd, status: "ok" }),
      "utf-8"
    );
    const ack = Buffer.alloc(5 + ackJson.length);
    ack[0] = 0xaa;
    ack[1] = 0x55;
    ack[2] = seq;
    ack.writeUInt16BE(ackJson.length, 3);
    ackJson.copy(ack, 5);
    socket.send(ack, rinfo.port, rinfo.address);
    return;
  }

  // 音频数据
  audioBytes += msg.length;
  audioPackets += 1;
  if (msg.length > maxDatagram) maxDatagram = msg.length;
  const now = Date.now();
  if (now - lastReport >= 2000) {
    const kbps = ((audioBytes * 8) / ((now - lastReport) / 1000) / 1000).toFixed(0);
    const expected = currentConfig
      ? (currentConfig.sampleRate * currentConfig.channels * currentConfig.bitsPerSample) / 1000
      : 0;
    console.log(
      `[MOCK] 音频流: ${audioPackets} 包, 最大数据报 ${maxDatagram}B, 实测 ${kbps} kbps (理论 ${expected.toFixed(0)} kbps)`
    );
    audioBytes = 0;
    audioPackets = 0;
    lastReport = now;
  }
});

socket.bind(PORT, () => {
  console.log(`[MOCK] 模拟 ESP32 正在监听 UDP :${PORT}`);
});
