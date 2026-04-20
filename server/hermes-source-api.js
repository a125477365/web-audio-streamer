/**
 * 音源获取模块 v3.0
 * 
 * 架构：
 * - Prompt 负责所有业务逻辑（搜索、获取、保存、排序）
 * - 代码负责心跳检查（5分钟）+ 通知用户
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
    this.heartbeatInterval = options.heartbeatInterval || 300000; // 5分钟
    this.resultFile = options.resultFile || RESULT_FILE;
    this.configFile = options.configFile || CONFIG_FILE;
    this.onProgress = options.onProgress || null; // 进度回调
  }

  /**
   * 获取音源列表
   */
  async fetchMusicSources() {
    console.log('[SourceAPI] 开始获取音源...');

    // 清理旧结果文件
    if (fs.existsSync(this.resultFile)) {
      fs.unlinkSync(this.resultFile);
    }

    // 执行交互式搜索
    const result = await this._interactiveSearch();
    return result;
  }

  /**
   * 交互式搜索
   * - Prompt 包含完整业务逻辑
   * - 代码只负责心跳和结果检测
   */
  async _interactiveSearch() {
    console.log('[HermesCLI] 启动交互式搜索...');
    console.log(`[HermesCLI] 心跳间隔: ${this.heartbeatInterval / 60000}分钟`);
    console.log(`[HermesCLI] 结果文件: ${this.resultFile}`);

    const prompt = `你是洛雪音乐音源获取助手。请按以下步骤执行：

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
   
   其中 days_ago 从更新时间推算（如"5 days ago"则为5）

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
  "repos_found": 5,
  "sources": [
    {
      "id": "source_001",
      "name": "念心音源 v1.0.0",
      "url": "https://raw.githubusercontent.com/Macrohard0001/lx-ikun-music-sources/main/V260328/优质-支持四平台FLAC/念心音源 v1.0.0.js",
      "repo": "Macrohard0001/lx-ikun-music-sources",
      "quality": "优质",
      "stars": 1079
    },
    ...
  ],
  "total": 10,
  "selected": 5,
  "timestamp": "2026-04-20T08:00:00Z"
}

## 第四步：返回用户选择

保存成功后，输出以下内容让用户选择：

=== 音源获取完成 ===
找到 {total} 个音源，已选择前 5 个（优质）：

1. [✓] 念心音源 v1.0.0 - 支持四平台FLAC
2. [✓] 洛雪科技独家音源 - 支持四平台FLAC
3. [✓] ...
4. [✓] ...
5. [✓] ...
6. [ ] fish-music音源 - 良好
...

请告诉用户：
"音源已保存，默认选择前5个优质音源。如需调整，请回复对应编号切换选中状态。"

重要提示：
- 如果 GitHub API 限流（403），等待几秒后重试
- 确保下载链接格式正确（raw.githubusercontent.com）
- 至少返回 5 个有效音源`;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let buffer = '';
      let lastHeartbeatTime = startTime;
      let heartbeatCount = 0;

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

      // 轮询检查结果文件（每30秒）
      const checkInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        
        console.log(`[HermesCLI] 已运行 ${minutes}分钟，检查结果文件...`);

        if (fs.existsSync(this.resultFile)) {
          try {
            const content = fs.readFileSync(this.resultFile, 'utf-8');
            const result = JSON.parse(content);
            
            if (result.status === 'success' && result.sources && result.sources.length >= 5) {
              console.log(`[HermesCLI] 发现 ${result.sources.length} 个音源`);
              clearInterval(checkInterval);
              clearTimeout(timeoutCheck);
              proc.kill();
              
              // 通知用户
              this._notifyUser(result);
              resolve(result);
              return;
            }
          } catch (e) {
            // 文件内容不完整，继续等待
          }
        }

        // 心跳检查（每5分钟）
        const timeSinceLastHeartbeat = Date.now() - lastHeartbeatTime;
        if (timeSinceLastHeartbeat >= this.heartbeatInterval) {
          heartbeatCount++;
          lastHeartbeatTime = Date.now();
          
          console.log(`[HermesCLI] 发送第 ${heartbeatCount} 次心跳询问...`);
          proc.write('\r\n[心跳检查] 进度如何？如果已完成，请保存结果到文件并回复"已完成"。\r');
          
          // 进度回调
          if (this.onProgress) {
            this.onProgress({
              type: 'heartbeat',
              count: heartbeatCount,
              elapsed: minutes
            });
          }
        }
      }, 30000); // 每30秒检查一次

      // 最大超时
      const timeoutCheck = setTimeout(() => {
        clearInterval(checkInterval);
        proc.kill();
        
        // 最后检查一次
        if (fs.existsSync(this.resultFile)) {
          try {
            const content = fs.readFileSync(this.resultFile, 'utf-8');
            const result = JSON.parse(content);
            if (result.sources && result.sources.length >= 1) {
              this._notifyUser(result);
              resolve(result);
              return;
            }
          } catch (e) {}
        }
        
        reject(new Error(`搜索超时（${this.maxTimeout / 60000}分钟）`));
      }, this.maxTimeout);

      proc.on('close', (code) => {
        clearInterval(checkInterval);
        clearTimeout(timeoutCheck);
        
        if (fs.existsSync(this.resultFile)) {
          try {
            const content = fs.readFileSync(this.resultFile, 'utf-8');
            const result = JSON.parse(content);
            if (result.sources && result.sources.length >= 1) {
              console.log(`[HermesCLI] 进程结束，获取到 ${result.sources.length} 个音源`);
              this._notifyUser(result);
              resolve(result);
              return;
            }
          } catch (e) {}
        }
        
        reject(new Error('进程结束但未找到结果'));
      });

      proc.on('error', (err) => {
        clearInterval(checkInterval);
        clearTimeout(timeoutCheck);
        reject(new Error(`进程启动失败: ${err.message}`));
      });
    });
  }

  /**
   * 通知用户
   */
  _notifyUser(result) {
    console.log('\n' + '='.repeat(50));
    console.log('🎉 音源获取完成！');
    console.log('='.repeat(50));
    console.log(`找到 ${result.total || result.sources.length} 个音源`);
    console.log(`已选择前 ${result.selected || 5} 个优质音源\n`);
    
    result.sources.forEach((s, i) => {
      const selected = i < 5 ? '[✓]' : '[ ]';
      console.log(`${i + 1}. ${selected} ${s.name} - ${s.quality || '未知质量'}`);
    });
    
    console.log('\n如需调整选择，请回复对应编号切换选中状态。');
    console.log('='.repeat(50));
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
   * 切换音源选中状态
   */
  toggleSource(sourceId) {
    const config = this.readConfig();
    if (!config) return null;

    const source = config.sources.find(s => s.id === sourceId);
    if (source) {
      source.selected = !source.selected;
      fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
      return source;
    }
    return null;
  }
}
