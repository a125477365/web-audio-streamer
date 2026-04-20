# 洛雪音乐音源获取完整方案

## 一、搜索方案

### 1.1 搜索关键词
- 主关键词: `lx-music-source`
- 辅助关键词: `洛雪音乐音源`, `LX Music source`, `lxmusic`
- 排序: 按最近更新排序 (`s=updated&o=desc`)

### 1.2 搜索 URL
```
https://github.com/search?q=lx-music-source&type=repositories&s=updated&o=desc
```

### 1.3 质量评估标准
| 指标 | 权重 | 说明 |
|------|------|------|
| 星数 | 60% | 反映社区认可度 |
| 更新时间 | 40% | 30天内更新得满分，每超一天扣1分 |

评分公式: `score = stars * 0.6 + max(0, 30 - days_ago) * 0.4`

## 二、获取流程

### 2.1 步骤
1. 浏览器访问 GitHub 搜索结果页
2. 提取仓库名、星数、更新时间
3. 按评分排序，取前10个仓库
4. 对每个仓库:
   - 用 GitHub API 获取目录结构
   - 找到 `.js` 音源文件
   - 记录下载链接

### 2.2 目录结构识别
优质仓库通常有以下目录结构:
```
/V260328/
├── 优质-支持四平台FLAC/     ← 最高优先级
├── 良好-支持至少两平台FLAC/
├── 一般-支持单平台FLAC或多平台320k/
└── 较差-支持单平台320k或多平台128k/
```

### 2.3 GitHub API 调用
```
GET https://api.github.com/repos/{owner}/{repo}/contents/{path}
Headers: User-Agent: Hermes-Source-API/1.0
```

注意: 中文路径需要 URL 编码

## 三、保存格式

### 3.1 音源配置文件格式 (JSON)
```json
{
  "version": "1.0",
  "updated": "2026-04-20T08:30:00Z",
  "sources": [
    {
      "id": "source_001",
      "name": "念心音源 v1.0.0",
      "url": "https://raw.githubusercontent.com/.../念心音源.js",
      "quality": "优质",
      "platforms": ["网易云", "QQ音乐", "酷狗", "酷我"],
      "features": ["FLAC", "无损"],
      "repo": "Macrohard0001/lx-ikun-music-sources",
      "stars": 1079,
      "last_update": "2026-03-28"
    }
  ],
  "total": 10,
  "selected": []
}
```

### 3.2 文件保存路径
- 默认: `~/.openclaw/web-audio-streamer/source-config.json`
- 环境变量: `SOURCE_CONFIG_PATH`

## 四、心跳检查方案

### 4.1 PTY 模式限制
- GLM5 在 PTY 模式下输出的是 TUI 渲染数据（ANSI 控制序列）
- 无法直接从输出解析搜索结果

### 4.2 解决方案
让 AI 把搜索结果写入本地文件，然后轮询检查:

```javascript
// 检查间隔
const CHECK_INTERVAL = 30000; // 30秒

// 心跳消息（发送到 PTY stdin）
const HEARTBEAT_MSG = "进度如何？如果已完成搜索，请把结果保存到文件。";

// 超时设置
const MAX_TIMEOUT = 1800000; // 30分钟
```

### 4.3 心跳策略
| 阶段 | 时间 | 动作 |
|------|------|------|
| 启动 | 0s | 发送初始 prompt |
| 心跳1 | 30s | 检查输出，无响应则发送询问 |
| 心跳2 | 60s | 同上 |
| ... | ... | ... |
| 超时 | 30min | 强制结束，尝试提取已有结果 |

## 五、最优10个源选择方案

### 5.1 选择流程
1. 搜索 GitHub，获取前 20 个仓库
2. 计算评分，取前 10 个
3. 对每个仓库:
   - 优先选择"优质"目录
   - 检查 `.js` 文件数量
   - 验证文件内容（包含 `music`、`source` 等关键词）

### 5.2 优先级
1. **优质目录** - 支持四平台 FLAC
2. **良好目录** - 支持至少两平台 FLAC
3. **一般目录** - 支持单平台 FLAC 或多平台 320k
4. **其他** - 根据星数和时间综合判断

### 5.3 去重与验证
- 同名文件只保留一个（选星数高的仓库）
- 验证下载链接有效性（HEAD 请求）
- 排除空文件和损坏文件

## 六、已知优质仓库

| 仓库 | 星数 | 更新 | 说明 |
|------|------|------|------|
| Macrohard0001/lx-ikun-music-sources | 1079 | 22天前 | 音源收集，分类清晰 |
| cdyUuu/lx-music-xinghai-source | 23 | 5天前 | 星海音乐源 |
| Qian-Ning/LX-Music-Source | 3 | 4天前 | 洛雪音乐源 |

## 七、错误处理

### 7.1 常见错误
- `403 Forbidden`: GitHub API 限流，等待 1 小时
- `404 Not Found`: 文件已删除，跳过
- `超时`: 30分钟无响应，使用备用仓库列表

### 7.2 备用方案
如果 PTY 模式失败，直接使用已知仓库:
```javascript
const FALLBACK_REPOS = [
  "Macrohard0001/lx-ikun-music-sources",
  "cdyUuu/lx-music-xinghai-source"
];
```
