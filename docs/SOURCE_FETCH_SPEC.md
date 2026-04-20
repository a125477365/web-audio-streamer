# 洛雪音乐音源获取完整方案

> 本文档详细说明音源获取的完整流程，包括搜索、获取、保存、心跳和选择策略。

## 一、架构概述

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   前端 UI   │ ──▶ │  后端 API   │ ──▶ │ SourceManager│ ──▶ │HermesSourceApi│
│ (index.html)│     │ (index.js)  │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
      │  POST /source/    │                   │                   │
      │  fetch/start      │                   │                   │
      │ ─────────────────▶│                   │                   │
      │                   │  startFetch()     │                   │
      │                   │ ─────────────────▶│                   │
      │                   │                   │  fetchMusicSources│
      │                   │                   │ ─────────────────▶│
      │                   │                   │                   │ PTY模式
      │                   │                   │                   │ 启动Hermes
      │                   │                   │                   │ ────────▶
      │                   │                   │                   │
      │  GET /source/     │                   │                   │
      │  fetch/progress   │                   │                   │
      │ ─────────────────▶│                   │                   │
      │                   │  checkProgress()  │                   │
      │                   │ ─────────────────▶│                   │
```

## 二、搜索方案

### 2.1 搜索关键词
```
主关键词: lx-music-source
辅助关键词: 洛雪音乐音源, LX Music source, lxmusic
```

### 2.2 搜索 URL
```
https://github.com/search?q=lx-music-source&type=repositories&s=updated&o=desc
```

参数说明：
- `q=lx-music-source` - 搜索关键词
- `type=repositories` - 只搜索仓库
- `s=updated` - 按更新时间排序
- `o=desc` - 降序（最新的在前）

### 2.3 浏览器操作步骤
1. `browser_navigate` 访问搜索 URL
2. `browser_snapshot` 获取页面快照
3. 从快照中提取：
   - 仓库名（如 `Macrohard0001/lx-ikun-music-sources`）
   - 星数（如 `1.1k`）
   - 更新时间（如 `22 days ago`）
   - 描述

### 2.4 评分公式
```javascript
score = stars * 0.6 + max(0, 30 - days_ago) * 0.4

// 权重说明：
// - 星数占 60%：反映社区认可度
// - 更新新鲜度占 40%：30天内更新得满分，每超一天扣1分
```

示例计算：
```
仓库A: 1079 stars, 22 days ago
score = 1079 * 0.6 + (30 - 22) * 0.4 = 647.4 + 3.2 = 650.6

仓库B: 23 stars, 5 days ago  
score = 23 * 0.6 + (30 - 5) * 0.4 = 13.8 + 10 = 23.8
```

## 三、获取音源文件

### 3.1 GitHub API 调用
```
GET https://api.github.com/repos/{owner}/{repo}/contents/{path}
Headers: 
  User-Agent: Hermes-Source-API/1.0
  Accept: application/json
```

### 3.2 目录结构识别
优质仓库通常有以下结构：
```
/V260328/                          ← 版本目录
├── 优质-支持四平台FLAC/           ← 最高优先级
│   ├── 念心音源 v1.0.0.js
│   ├── 洛雪科技[独家音源] v4.js
│   └── ...
├── 良好-支持至少两平台FLAC/       ← 次优先级
├── 一般-支持单平台FLAC或多平台320k/
└── 较差-支持单平台320k或多平台128k/
```

### 3.3 获取流程
```javascript
// 1. 获取根目录，找最新版本目录
const rootFiles = await fetchGitHubApi(`/repos/${owner}/${repo}/contents`);
const versionDirs = rootFiles
  .filter(f => f.type === 'dir' && /^v\d+/i.test(f.name))
  .sort((a, b) => b.name.localeCompare(a.name)); // 降序
const latestDir = versionDirs[0].name; // 如 V260328

// 2. 按优先级获取音源文件
const qualityDirs = ['优质', '良好', '一般'];
for (const quality of qualityDirs) {
  const dir = files.find(f => f.name.includes(quality));
  if (dir) {
    const sourceFiles = await fetchGitHubApi(`/repos/${owner}/${repo}/contents/${dir.path}`);
    // 提取 .js 文件
  }
}
```

### 3.4 URL 编码
中文路径需要编码：
```javascript
const encodedPath = encodeURIComponent('优质-支持四平台FLAC');
const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
```

## 四、保存格式

### 4.1 中间结果文件
路径: `/tmp/hermes-source-results.json`

```json
{
  "status": "success",
  "repos_found": 5,
  "sources": [
    {
      "id": "source_001",
      "name": "念心音源 v1.0.0",
      "url": "https://raw.githubusercontent.com/Macrohard0001/lx-ikun-music-sources/main/V260328/优质-支持四平台FLAC/念心音源 v1.0.0.js",
      "repo": "Macrohard0001/lx-ikun-music-sources",
      "quality": "优质",
      "stars": 1079
    }
  ],
  "total": 10,
  "selected": 5,
  "timestamp": "2026-04-20T08:00:00Z"
}
```

### 4.2 最终配置文件
路径: `~/.openclaw/web-audio-streamer/source-config.json`

```json
{
  "version": "1.0",
  "updated": "2026-04-20T08:30:00Z",
  "candidates": [
    {
      "name": "念心音源 v1.0.0",
      "searchUrl": "https://raw.githubusercontent.com/.../念心音源 v1.0.0.js",
      "quality": "优质",
      "platforms": ["网易云", "QQ音乐", "酷狗", "酷我"],
      "features": ["FLAC", "无损"]
    }
  ],
  "selectedSource": { ... },
  "lastFetchAt": "2026-04-20T08:30:00Z"
}
```

### 4.3 字段说明
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识，格式 `source_001` |
| `name` | string | 音源名称（去掉 .js 后缀） |
| `url` | string | 下载链接（raw.githubusercontent.com） |
| `repo` | string | 来源仓库（owner/repo 格式） |
| `quality` | string | 质量等级：优质/良好/一般/较差 |
| `selected` | boolean | 是否被用户选中 |

## 五、心跳检查方案

### 5.1 架构设计
```
┌────────────────────────────────────────────────────────────┐
│                     HermesSourceApi                        │
├────────────────────────────────────────────────────────────┤
│  PTY 进程                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Hermes CLI (--toolsets web,browser)                │   │
│  │                                                      │   │
│  │  接收 prompt → 搜索 → 获取 → 保存到文件            │   │
│  └─────────────────────────────────────────────────────┘   │
│         ↑                               │                  │
│         │ 心跳询问 (每5分钟)            │ 写入结果文件    │
│         │                               ↓                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  轮询检查器 (每30秒)                                │   │
│  │                                                      │   │
│  │  if (文件存在 && JSON有效) {                        │   │
│  │    通知用户 → resolve(result)                       │   │
│  │  }                                                  │   │
│  │                                                      │   │
│  │  if (距上次心跳 >= 5分钟) {                         │   │
│  │    发送: "进度如何？请继续..."                      │   │
│  │  }                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### 5.2 时间参数
```javascript
const CHECK_INTERVAL = 30000;      // 结果文件检查间隔：30秒
const HEARTBEAT_INTERVAL = 300000; // 心跳询问间隔：5分钟
const MAX_TIMEOUT = 1800000;       // 最大超时：30分钟
const STARTUP_DELAY = 5000;        // 启动后等待：5秒
```

### 5.3 心跳消息格式
```
[心跳检查] 进度如何？如果已完成，请保存结果到文件并回复"已完成"。
```

### 5.4 进度状态
```javascript
{
  status: 'running' | 'completed' | 'timeout' | 'error',
  elapsed: 180,        // 已运行秒数
  heartbeatCount: 2,   // 心跳次数
  lastCheckTime: '2026-04-20T08:35:00Z',
  resultFileExists: false
}
```

### 5.5 通知用户
当获取完成时，输出：
```
==================================================
🎉 音源获取完成！
==================================================
找到 10 个音源，已选择前 5 个优质音源

1. [✓] 念心音源 v1.0.0 - 优质-支持四平台FLAC
2. [✓] 洛雪科技独家音源 - 优质-支持四平台FLAC
3. [✓] ...
4. [✓] ...
5. [✓] ...
6. [ ] fish-music音源 - 良好
7. [ ] ...
...

如需调整选择，请回复对应编号切换选中状态。
==================================================
```

## 六、选择最优10个源方案

### 6.1 选择流程
```
搜索 GitHub (按更新排序)
        │
        ▼
   提取仓库列表
   (至少5个，最多20个)
        │
        ▼
   计算评分并排序
   (stars * 0.6 + freshness * 0.4)
        │
        ▼
   取前3个仓库
        │
        ▼
   对每个仓库:
   ├─ 获取最新版本目录
   ├─ 按质量优先级获取 .js 文件
   └─ 每个仓库最多取 5 个文件
        │
        ▼
   合并去重
   (同名文件保留高星仓库的)
        │
        ▼
   按质量排序
   (优质 > 良好 > 一般)
        │
        ▼
   取前10个返回用户
```

### 6.2 质量优先级
```javascript
const QUALITY_PRIORITY = {
  '优质': 4,    // 支持四平台FLAC
  '良好': 3,    // 支持至少两平台FLAC
  '一般': 2,    // 支持单平台FLAC或多平台320k
  '较差': 1     // 支持单平台320k或多平台128k
};

// 排序逻辑
sources.sort((a, b) => {
  const aPriority = QUALITY_PRIORITY[a.quality] || 0;
  const bPriority = QUALITY_PRIORITY[b.quality] || 0;
  return bPriority - aPriority;
});
```

### 6.3 去重逻辑
```javascript
function deduplicateSources(sources) {
  const seen = new Map();
  
  for (const s of sources) {
    const key = s.name.toLowerCase();
    
    // 同名文件：保留高星仓库的版本
    if (!seen.has(key) || s.stars > seen.get(key).stars) {
      seen.set(key, s);
    }
  }
  
  return Array.from(seen.values());
}
```

### 6.4 默认选择
- 前5个（优质）默认 `selected: true`
- 第6-10个默认 `selected: false`
- 用户可在界面上点击切换

## 七、已知优质仓库

| 仓库 | 星数 | 更新 | 质量目录 | 说明 |
|------|------|------|----------|------|
| Macrohard0001/lx-ikun-music-sources | 1079 | 22天前 | 优质/良好/一般 | 分类清晰，更新频繁 |
| cdyUuu/lx-music-xinghai-source | 23 | 5天前 | - | 星海音乐源 |
| Qian-Ning/LX-Music-Source | 3 | 4天前 | - | 洛雪音乐源 |

## 八、错误处理

### 8.1 常见错误
| 错误 | 原因 | 处理 |
|------|------|------|
| `403 Forbidden` | GitHub API 限流 | 等待1小时，或使用备用仓库 |
| `404 Not Found` | 文件已删除 | 跳过该文件 |
| `超时` | 30分钟无响应 | 使用备用仓库列表 |
| `JSON 解析失败` | 文件写入不完整 | 继续等待或重试 |

### 8.2 备用方案
```javascript
const FALLBACK_REPOS = [
  { owner: 'Macrohard0001', repo: 'lx-ikun-music-sources', stars: 1079 },
  { owner: 'cdyUuu', repo: 'lx-music-xinghai-source', stars: 23 },
  { owner: 'Qian-Ning', repo: 'LX-Music-Source', stars: 3 }
];

// PTY 搜索失败时，直接使用备用仓库
async function useFallbackRepos() {
  const results = [];
  for (const repo of FALLBACK_REPOS) {
    const sources = await fetchFromRepo(repo.owner, repo.repo);
    results.push(...sources);
  }
  return sortAndSelect(results);
}
```

## 九、Prompt 示例

以下是发送给 Hermes CLI 的完整 prompt：

```
你是洛雪音乐音源获取助手。请按以下步骤执行：

## 第一步：搜索音源仓库

1. 用 browser_navigate 访问 GitHub 搜索：
   https://github.com/search?q=lx-music-source&type=repositories&s=updated&o=desc

2. 用 browser_snapshot 获取搜索结果页面

3. 从结果中提取至少 5 个仓库的信息：
   - 仓库名（如 Macrohard0001/lx-ikun-music-sources）
   - 星数
   - 更新时间
   - 描述

4. 按以下公式计算评分：
   score = stars * 0.6 + max(0, 30 - days_ago) * 0.4

5. 按评分排序，取前 3 个仓库

## 第二步：获取音源文件

对每个选中的仓库：
1. 用 GitHub API 获取目录结构
2. 找到版本目录（以 V 或 v 开头），选择最新的
3. 按以下优先级获取 .js 文件：
   - 优先：优质-支持四平台FLAC/
   - 其次：良好-支持至少两平台FLAC/
   - 最后：一般-支持单平台FLAC或多平台320k/

## 第三步：保存结果

用 write_file 把结果保存到：
/tmp/hermes-source-results.json

保存格式见文档第四章。

## 第四步：返回用户选择

保存成功后，输出音源列表让用户选择。
```

---

*文档版本: 1.0*
*最后更新: 2026-04-20*
