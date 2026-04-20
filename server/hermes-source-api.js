/**
 * 音源获取模块 v4.0
 * 
 * 架构：
 * - Prompt 负责所有业务逻辑（搜索、获取、保存、排序）
 * - 前端负责心跳检查和进度显示
 * - 后端只负责启动任务和返回结果
 */

import * as pty from 'node-pty';
import fs from 'fs';
import path from 'path';

const HERMES_VENV_PYTHON = process.env.HERMES_VENV_PYTHON || '/opt/hermes/.venv/bin/python3';
const HERMES_CLI_PATH = process.env.HERMES_CLI_PATH || '/opt/hermes/cli.py';
const RESULT_FILE = process.env.SOURCE_RESULT_FILE || '/tmp/hermes-source-results.json';
const CONFIG_FILE = process.env.SOURCE_CONFIG_PATH || path.join(process.env.HOME || '/root', '.openclaw/web-audio-streamer/source-config.json');

export class HermesSourceApi {
  constructor(options = {}) {
    this.venvPython = options.venvPython || HERMES_VENV_PYTHON;
    this.cliPath = options.cliPath || HERMES_CLI_PATH;
    this.maxTimeout = options.maxTimeout || 1800000; // 30分钟
    this.resultFile = options.resultFile || RESULT_FILE;
    this.configFile = options.configFile || CONFIG_FILE;
  }

  /**
   * 启动音源获取任务（异步，不等待结果）
   * 前端通过 checkProgress() 轮询进度
   */
  async startFetch() {
    console.log('[HermesCLI] 启动音源获取任务...');

    // 清理旧结果文件
    if (fs.existsSync(this.resultFile)) {
      fs.unlinkSync(this.resultFile);
    }

    // 写入初始状态
    this._writeProgress({
      status: 'starting',
      message: '正在启动 Hermes CLI...',
      progress: 0,
      sources: [],
      timestamp: new Date().toISOString()
    });

    // 异步启动 PTY 进程
    this._runPtyTask();

    return {
      success: true,
      message: '任务已启动，请轮询 /source/progress 检查进度'
    };
  }

  /**
   * 检查进度（前端轮询调用）
   */
  checkProgress() {
    if (fs.existsSync(this.resultFile)) {
      try {
        const content = fs.readFileSync(this.resultFile, 'utf-8');
        return JSON.parse(content);
      } catch (e) {
        return {
          status: 'error',
          message: '读取进度失败: ' + e.message,
          progress: 0
        };
      }
    }
    
    return {
      status: 'not_started',
      message: '任务未启动',
      progress: 0
    };
  }

  /**
   * 运行 PTY 任务（内部方法）
   */
  _runPtyTask() {
    const prompt = `你是洛雪音乐音源获取助手。请按以下步骤执行：

## 第一步：搜索音源仓库

1. 用 browser_navigate 访问 GitHub 搜索：
   https://github.com/search?q=lx-music-source&type=repositories&s=updated&o=desc

2. 用 browser_snapshot 获取搜索结果页面

3. 从结果中提取至少 5 个仓库的信息：
   - 仓库名（如 Macrohard0001/lx-ikun-music-sources）
   - 星数
   - 更新时间

4. 按以下公式计算评分：
   score = stars * 0.6 + max(0, 30 - days_ago) * 0.4

5. 按评分排序，取前 3 个仓库

## 第二步：获取音源文件

对每个选中的仓库：
1. 用 GitHub API 获取目录结构：
   GET https://api.github.com/repos/{owner}/{repo}/contents/{path}

2. 找到版本目录（以 V 或 v 开头，如 V260328），选择最新的

3. 按以下优先级获取 .js 文件：
   - 优先：优质-支持四平台FLAC/
   - 其次：良好-支持至少两平台FLAC/
   - 最后：一般-支持单平台FLAC或多平台320k/

4. 每个仓库最多取 5 个 .js 文件

## 第三步：保存结果

用 write_file 把结果保存到：${this.resultFile}

保存格式（JSON）：
{
  "status": "success",
  "message": "获取完成",
  "progress": 100,
  "repos_found": 5,
  "sources": [
    {
      "id": "source_001",
      "name": "念心音源 v1.0.0",
      "url": "https://raw.githubusercontent.com/...",
      "repo": "Macrohard0001/lx-ikun-music-sources",
      "quality": "优质",
      "stars": 1079
    }
  ],
  "total": 10,
  "timestamp": "2026-04-20T08:00:00Z"
}

重要：每完成一个步骤，用 write_file 更新进度文件，格式：
{
  "status": "in_progress",
  "message": "正在获取仓库 xxx 的音源...",
  "progress": 50,
  "sources": [],
  "timestamp": "..."
}`;

    const startTime = Date.now();
    let buffer = '';

    // 启动 Hermes CLI（PTY 模式）
    const proc = pty.spawn(this.venvPython, [
      this.cliPath,
      '--toolsets', 'web,browser'
    ], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: '/opt/data',
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    // 等待启动后发送 prompt
    setTimeout(() => {
      console.log('[HermesCLI] 发送搜索 prompt...');
      proc.write(prompt + '\r');
    }, 5000);

    // 接收输出
    proc.on('data', (data) => {
      buffer += data.toString();
    });

    // 超时处理
    const timeoutCheck = setTimeout(() => {
      proc.kill();
      this._writeProgress({
        status: 'timeout',
        message: `任务超时（${this.maxTimeout / 60000}分钟）`,
        progress: 0,
        sources: [],
        timestamp: new Date().toISOString()
      });
    }, this.maxTimeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutCheck);
      
      // 如果没有成功结果，标记为失败
      const progress = this.checkProgress();
      if (progress.status !== 'success') {
        this._writeProgress({
          status: 'error',
          message: `进程结束，退出码: ${code}`,
          progress: 0,
          sources: [],
          timestamp: new Date().toISOString()
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutCheck);
      this._writeProgress({
        status: 'error',
        message: `进程启动失败: ${err.message}`,
        progress: 0,
        sources: [],
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * 写入进度文件
   */
  _writeProgress(data) {
    try {
      fs.writeFileSync(this.resultFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[HermesCLI] 写入进度失败:', e.message);
    }
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath() {
    return this.configFile;
  }

  /**
   * 读取当前配置
   */
  readConfig() {
    if (fs.existsSync(this.configFile)) {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
    }
    return null;
  }

  /**
   * 保存配置
   */
  saveConfig(config) {
    const dir = path.dirname(this.configFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    return config;
  }

  /**
   * 切换音源选中状态
   */
  toggleSource(sourceId) {
    const config = this.readConfig();
    if (!config) return null;

    const source = config.sources?.find(s => s.id === sourceId);
    if (source) {
      source.selected = !source.selected;
      this.saveConfig(config);
      return source;
    }
    return null;
  }
}
