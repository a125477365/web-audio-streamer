/**
 * ESP32 I2S 音频接收器 - Bit-Perfect 方案
 * 
 * 协议说明：
 * 
 * UDP 端口: 8000
 * 
 * 数据包类型：
 * 1. 控制包: 以 [0xAA, 0x55] 开头，格式: [0xAA][0x55][seq][len_h][len_l][JSON]
 *    - 收到后必须回复 ACK: [0xAA][0x55][seq]['A']['C']['K'][len_h][len_l][JSON]
 *    - JSON payload 示例:
 *      请求: {"cmd":"setAudioConfig","sampleRate":96000,"bitsPerSample":32,"channels":2}
 *      应答: {"cmd":"ack","originalCmd":"setAudioConfig","status":"ok"}
 * 
 * 2. 音频数据包: PCM 裸数据，不以 [0xAA, 0x55] 开头
 *    数据直接写入 I2S DMA 缓冲区
 * 
 * 流程:
 *   1. ESP32 启动，I2S 初始化为默认采样率
 *   2. 收到 setAudioConfig 控制包 → 回复 ACK → 停止 I2S → 重新配置采样率/位深 → 重启 I2S
 *   3. 收到音频数据 → 写入 I2S → DAC 输出
 *   4. 收到 stop 控制包 → 停止 I2S
 * 
 * 依赖: ESP-IDF 4.4+ 或 Arduino ESP32 核心 2.x+
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>

// ==================== 配置 ====================
const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "你的密码";
const int UDP_PORT = 8000;

// I2S 引脚定义（根据实际硬件修改）
#define I2S_BCK_PIN   14
#define I2S_WS_PIN    15
#define I2S_DATA_PIN  32

// DMA 缓冲配置
#define DMA_BUF_COUNT 8
#define DMA_BUF_LEN   1024

// 控制包魔术字
#define CTRL_MAGIC_0  0xAA
#define CTRL_MAGIC_1  0x55

// ==================== 全局变量 ====================
WiFiUDP udp;
SemaphoreHandle_t i2sMutex = NULL;

// 当前音频配置
typedef struct {
  uint32_t sampleRate;
  uint8_t  bitsPerSample;
  uint8_t  channels;
  bool     active;
} AudioConfig;

AudioConfig currentConfig = {
  .sampleRate = 44100,
  .bitsPerSample = 32,
  .channels = 2,
  .active = false
};

// ==================== ACK 回复 ====================

/**
 * 发送 ACK 控制包
 */
void sendAck(IPAddress remoteIP, uint16_t remotePort, uint8_t seq, const char* originalCmd, const char* status) {
  // 构建 ACK payload
  char json[128];
  snprintf(json, sizeof(json), "{\"cmd\":\"ack\",\"originalCmd\":\"%s\",\"status\":\"%s\"}", originalCmd, status);
  
  uint16_t len = strlen(json);
  
  // ACK 包: [0xAA][0x55][seq]['A']['C']['K'][len_h][len_l][json]
  uint8_t packet[256];
  int pos = 0;
  packet[pos++] = CTRL_MAGIC_0;
  packet[pos++] = CTRL_MAGIC_1;
  packet[pos++] = seq;
  packet[pos++] = 'A';
  packet[pos++] = 'C';
  packet[pos++] = 'K';
  packet[pos++] = (len >> 8) & 0xFF;
  packet[pos++] = len & 0xFF;
  memcpy(packet + pos, json, len);
  pos += len;
  
  udp.beginPacket(remoteIP, remotePort);
  udp.write(packet, pos);
  udp.endPacket();
  
  Serial.printf("[ACK] Sent ACK for seq=%d, cmd=%s\n", seq, originalCmd);
}

// ==================== I2S 管理 ====================

/**
 * 安装/重新配置 I2S 驱动
 */
bool i2sReconfig(uint32_t sampleRate, uint8_t bitsPerSample, uint8_t channels) {
  // 先卸载旧的 I2S 驱动
  i2s_driver_uninstall(I2S_NUM_0);
  delay(10);

  // I2S 配置
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = sampleRate,
    .bits_per_sample = (i2s_bits_per_sample_t)bitsPerSample,
    .channel_format = channels == 1 ? I2S_CHANNEL_FMT_ONLY_LEFT : I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = DMA_BUF_COUNT,
    .dma_buf_len = DMA_BUF_LEN,
    .use_apll = true,   // 使用 APLL 获得更精确的时钟（发烧友好）
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_DATA_PIN,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[I2S] Install failed: %d\n", err);
    return false;
  }

  err = i2s_set_pin(I2S_NUM_0, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("[I2S] Set pin failed: %d\n", err);
    return false;
  }

  // 设置 I2S 时钟（精确采样率）
  i2s_set_sample_rates(I2S_NUM_0, sampleRate);

  Serial.printf("[I2S] Configured: %luHz / %dbit / %dch (APLL: true)\n", 
                sampleRate, bitsPerSample, channels);
  return true;
}

/**
 * 停止 I2S 并静音
 */
void i2sStop() {
  size_t bytesWritten;
  uint8_t silence[4] = {0}; // 静音数据
  // 写入足够的静音数据排空 DMA 缓冲
  for (int i = 0; i < DMA_BUF_COUNT * DMA_BUF_LEN; i += 4) {
    i2s_write(I2S_NUM_0, silence, 4, &bytesWritten, portMAX_DELAY);
  }
}

/**
 * 写入音频数据到 I2S
 */
void i2sWrite(const uint8_t* data, size_t len) {
  size_t bytesWritten;
  // I2S 写入（非阻塞，满时丢弃避免阻塞 UDP 接收）
  i2s_write(I2S_NUM_0, data, len, &bytesWritten, 0);
  
  // 如果缓冲满导致没写完，丢弃溢出数据（避免延迟累积）
  if (bytesWritten < len) {
    Serial.printf("[I2S] Buffer overflow, dropped %d bytes\n", len - bytesWritten);
  }
}

// ==================== 控制包处理 ====================

/**
 * 解析控制包，返回 seq 和 JSON payload
 */
bool parseControlPacket(const uint8_t* data, size_t len, uint8_t* seq, char* json, size_t jsonMaxLen) {
  // 验证格式: [0xAA][0x55][seq][len_h][len_l][json]
  if (len < 5) return false;
  if (data[0] != CTRL_MAGIC_0 || data[1] != CTRL_MAGIC_1) return false;
  
  *seq = data[2];
  uint16_t payloadLen = (data[3] << 8) | data[4];
  
  if (len < 5 + payloadLen) return false;
  if (payloadLen >= jsonMaxLen) return false;
  
  memcpy(json, data + 5, payloadLen);
  json[payloadLen] = '\0';
  return true;
}

/**
 * 解析并执行控制包，返回是否需要回复 ACK
 */
bool handleControlPacket(const uint8_t* data, size_t len, IPAddress remoteIP, uint16_t remotePort) {
  uint8_t seq;
  char json[256];
  
  if (!parseControlPacket(data, len, &seq, json, sizeof(json))) {
    return false;
  }

  Serial.printf("[CTRL] Received seq=%d: %s\n", seq, json);

  // 简单 JSON 解析（生产环境可用 ArduinoJson 库）
  
  // 解析 cmd: "setAudioConfig"
  if (strstr(json, "\"setAudioConfig\"")) {
    uint32_t sr = 44100;
    uint8_t bps = 32;
    uint8_t ch = 2;

    // 解析 sampleRate
    char* p = strstr(json, "\"sampleRate\"");
    if (p) {
      p = strchr(p, ':');
      if (p) sr = atol(p + 1);
    }
    // 解析 bitsPerSample
    p = strstr(json, "\"bitsPerSample\"");
    if (p) {
      p = strchr(p, ':');
      if (p) bps = atoi(p + 1);
    }
    // 解析 channels
    p = strstr(json, "\"channels\"");
    if (p) {
      p = strchr(p, ':');
      if (p) ch = atoi(p + 1);
    }

    Serial.printf("[CTRL] Switching to %luHz / %dbit / %dch\n", sr, bps, ch);

    // 先回复 ACK（让后端知道我们收到了）
    sendAck(remoteIP, remotePort, seq, "setAudioConfig", "ok");

    // 然后切换 I2S 配置
    xSemaphoreTake(i2sMutex, portMAX_DELAY);
    bool ok = i2sReconfig(sr, bps, ch);
    if (ok) {
      currentConfig.sampleRate = sr;
      currentConfig.bitsPerSample = bps;
      currentConfig.channels = ch;
      currentConfig.active = true;
    }
    xSemaphoreGive(i2sMutex);
    
    return true;
  }
  // 解析 cmd: "stop"
  else if (strstr(json, "\"stop\"")) {
    Serial.println("[CTRL] Stop command received");
    
    // 回复 ACK
    sendAck(remoteIP, remotePort, seq, "stop", "ok");
    
    xSemaphoreTake(i2sMutex, portMAX_DELAY);
    i2sStop();
    currentConfig.active = false;
    xSemaphoreGive(i2sMutex);
    
    return true;
  }
  
  return false;
}

/**
 * 判断是否是控制包
 */
bool isControlPacket(const uint8_t* data, size_t len) {
  return len >= 2 && data[0] == CTRL_MAGIC_0 && data[1] == CTRL_MAGIC_1;
}

// ==================== 主程序 ====================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=================================");
  Serial.println(" ESP32 I2S Audio Receiver v2.1");
  Serial.println(" Bit-Perfect Mode + ACK Protocol");
  Serial.println("=================================");

  // 创建 I2S 互斥锁
  i2sMutex = xSemaphoreCreateMutex();

  // 连接 WiFi
  Serial.printf("[WiFi] Connecting to %s...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.printf("[WiFi] Connected, IP: %s\n", WiFi.localIP().toString().c_str());

  // 初始化 I2S（默认配置）
  i2sReconfig(currentConfig.sampleRate, currentConfig.bitsPerSample, currentConfig.channels);

  // 启动 UDP
  udp.begin(UDP_PORT);
  Serial.printf("[UDP] Listening on port %d\n", UDP_PORT);
  Serial.println("=================================");
  Serial.println("Ready. Waiting for control/audio stream...");
}

void loop() {
  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    uint8_t buffer[1500]; // 最大 UDP 包大小
    int len = udp.read(buffer, sizeof(buffer));

    if (len > 0) {
      if (isControlPacket(buffer, len)) {
        // 控制包：处理并回复 ACK
        handleControlPacket(buffer, len, udp.remoteIP(), udp.remotePort());
      } else if (currentConfig.active) {
        // 音频数据：写入 I2S
        xSemaphoreTake(i2sMutex, portMAX_DELAY);
        i2sWrite(buffer, len);
        xSemaphoreGive(i2sMutex);
      }
    }
  }

  // WiFi 保活
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Reconnecting...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(5000);
  }
}
