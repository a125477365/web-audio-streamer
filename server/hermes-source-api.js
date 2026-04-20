/**
 * 音源获取模块 v4.0
 * 
 * 架构：
 * - 前端发起请求 → 后端创建任务 → 前端轮询进度
 * - 后端只执行，不发心跳
 * - 心跳轮询由前端控制
 */

import * as pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import https from 'https';

const HERMES_VENV_PYTHON = process.env.HERMES_VENV_PYTHON || '/opt/hermes/.venv/bin/python3';
const HERMES_CLI_PATH = process.env.HERMES_CLI_PATH || '/opt/hermes/cli.py';
const TASKS_DIR = '/tmp/hermes-source-tasks';

// 任务状态存储
const tasks = new Map();

export class HermesSourceApi {
  constructor(options = {}) {
    this.venvPython = options.venvPython || HERMES_VENV_PYTHON;
    this.cliPath = options.cliPath || HERMES_CLI_PATH;
    
    // 确保任务目录存在
    if (!fs.existsSync(TASKS_DIR)) {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    }
  }

  /**
   * 创建获取任务（前端调用）
   * @returns {string} 任务ID
   */
  createTask() {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskFile = path.join(TASKS_DIR, `${taskId}.json`);
    
    const task = {
      id: taskId,
      status: 'pending', // pending, running, completed, failed
      progress: 0,
      message: '任务已创建',
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null
    };
    
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
    tasks.set(taskId, task);
    
    console.log(`[TaskManager] 创建任务: ${taskId}`);
    return taskId;
  }

  /**
   * 启动任务执行
   */
  async startTask(taskId) {
    const task = this._loadTask(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    if (task.status === 'running') {
      return task; // 已在运行
    }

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.message = '正在启动 Hermes...';
    task.progress = 5;
    this._saveTask(task);

    // 异步执行，不阻塞
    this._executeTask(task).catch(err => {
      task.status = 'failed';
      task.error = err.message;
      task.completedAt = new Date().toISOString();
      this._saveTask(task);
    });

    return task;
  }

  /**
   * 执行任务（异步）
   */
  async _executeTask(task) {
    const taskId = task.id;
    
    // 更新状态：搜索中
    this._updateTask(taskId, {
      progress: 10,
      message: '正在搜索音源仓库...'
    });

    // 构建搜索 prompt
    const prompt = this._buildSearchPrompt(taskId);

    // 启动 PTY 进程
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

    let buffer = '';

    // 发送 prompt
    setTimeout(() => {
      this._updateTask(taskId, { progress: 15, message: '已发送搜索请求' });
      proc.write(prompt + '\r');
    }, 3000);

    // 接收输出
    proc.on('data', (data) => {
      buffer += data.toString();
      
      // 检测进度标记
      if (buffer.includes('第一步完成') || buffer.includes('已找到')) {
        this._updateTask(taskId, { progress: 40, message: '已找到仓库，正在获取音源文件...' });
      }
      if (buffer.includes('第二步完成') || buffer.includes('正在获取')) {
        this._updateTask(taskId, { progress: 60, message: '正在获取音源文件...' });
      }
      if (buffer.includes('第三步完成') || buffer.includes('已保存')) {
        this._updateTask(taskId, { progress: 80, message: '正在保存结果...' });
      }
    });

    // 等待完成或超时
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('任务超时（30分钟）'));
      }, 1800000);

      // 定期检查结果文件
      const checkInterval = setInterval(() => {
        const resultFile = this._getResultFile(taskId);
        if (fs.existsSync(resultFile)) {
          try {
            const content = fs.readFileSync(resultFile, 'utf-8');
            const result = JSON.parse(content);
            
            if (result.status === 'success' && result.sources?.length >= 5) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              proc.kill();
              
              this._updateTask(taskId, {
                status: 'completed',
                progress: 100,
                message: `成功获取 ${result.sources.length} 个音源`,
                result: result,
                completedAt: new Date().toISOString()
              });
              
              resolve(result);
            }
          } catch (e) {
            // 文件不完整，继续等待
          }
        }
      }, 5000);

      proc.on('close', (code) => {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        
        // 最后检查结果
        const resultFile = this._getResultFile(taskId);
        if (fs.existsSync(resultFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
            if (result.sources?.length >= 1) {
              this._updateTask(taskId, {
                status: 'completed',
                progress: 100,
                message: `成功获取 ${result.sources.length} 个音源`,
                result: result,
                completedAt: new Date().toISOString()
              });
              resolve(result);
              return;
            }
          } catch (e) {}
        }
        
        reject(new Error(`进程异常退出: ${code}`));
      });

      proc.on('error', (err) => {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * 构建搜索 prompt
   */
  _buildSearchPrompt(taskId) {
    const resultFile = this._getResultFile(taskId);
    
    return `你是洛雪音乐音源获取助手。请按步骤执行：

## 第一步：搜索仓库（进度10%→40%）

1. 用 browser_navigate 访问：
   https://github.com/search?q=lx-music-source&type=repositories&s=updated&o=desc

2. 用 browser_snapshot 获取搜索结果

3. 提取前5个仓库：仓库名、星数、更新时间

4. 计算评分并排序：
   score = stars * 0.6 + max(0, 30 - days_ago) * 0.4

找到仓库后输出："第一步完成，已找到X个仓库"

## 第二步：获取音源文件（进度40%→70%）

对每个仓库：
1. 用 GitHub API 获取最新版本目录
2. 按优先级获取 .js 文件：优质 > 良好 > 一般

获取时输出："第二步完成，正在获取音源文件"

## 第三步：保存结果（进度70%→100%）

用 write_file 保存到：${resultFile}

格式：
{
  "status": "success",
  "sources": [
    {"id": "source_001", "name": "音源名", "url": "下载链接", "repo": "仓库", "quality": "优质"}
  ],
  "total": 10,
  "timestamp": "2026-04-20T08:00:00Z"
}

保存后输出："第三步完成，已保存结果"

重要：
- 每完成一步输出进度标记
- 至少返回5个有效音源
- URL 必须是 raw.githubusercontent.com 格式`;
  }

  /**
   * 获取任务状态（前端轮询调用）
   */
  getTaskStatus(taskId) {
    return this._loadTask(taskId);
  }

  /**
   * 取消任务
   */
  cancelTask(taskId) {
    const task = this._loadTask(taskId);
    if (task && task.status === 'running') {
      // 标记为取消（实际进程会在下次检查时退出）
      task.status = 'cancelled';
      task.message = '任务已取消';
      task.completedAt = new Date().toISOString();
      this._saveTask(task);
    }
    return task;
  }

  /**
   * 加载任务
   */
  _loadTask(taskId) {
    if (tasks.has(taskId)) {
      return tasks.get(taskId);
    }
    
    const taskFile = path.join(TASKS_DIR, `${taskId}.json`);
    if (fs.existsSync(taskFile)) {
      const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      tasks.set(taskId, task);
      return task;
    }
    
    return null;
  }

  /**
   * 保存任务
   */
  _saveTask(task) {
    const taskFile = path.join(TASKS_DIR, `${task.id}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
    tasks.set(task.id, task);
  }

  /**
   * 更新任务状态
   */
  _updateTask(taskId, updates) {
    const task = this._loadTask(taskId);
    if (task) {
      Object.assign(task, updates);
      this._saveTask(task);
    }
  }

  /**
   * 获取结果文件路径
   */
  _getResultFile(taskId) {
    return path.join(TASKS_DIR, `${taskId}_result.json`);
  }
}
