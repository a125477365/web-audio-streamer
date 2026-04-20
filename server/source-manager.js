/**
 * 音源管理器 v11
 *
 * 核心原则：
 * 1. 通过 Hermes 实时搜索最新洛雪音源
 * 2. 异步启动任务，前端轮询进度
 * 3. 搜索结果永久保存，用户可切换音源
 * 4. 获取5个可靠优质的非试听音乐源
 */

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { spawn, execSync } from "child_process";
import { HermesSourceApi } from "./hermes-source-api.js";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");

export class SourceManager {
  constructor() {
    this.config = null;
    this._ensureConfigDir();
    this.hermesApi = new HermesSourceApi();
  }

  _ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(SOURCE_CONFIG_FILE)) {
        this.config = JSON.parse(fs.readFileSync(SOURCE_CONFIG_FILE, "utf-8"));
        return this.config;
      }
    } catch (e) {
      console.error("[SourceManager] Failed to load config:", e.message);
    }
    return null;
  }

  saveConfig(data) {
    try {
      fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(data, null, 2));
      this.config = data;
      console.log("[SourceManager] Config saved");
      return true;
    } catch (e) {
      console.error("[SourceManager] Failed to save config:", e.message);
      return false;
    }
  }

  /**
   * 检查是否为首次安装（无音源配置）
   */
  isFirstInstall() {
    if (!this.config) this.loadConfig();
    return !this.config || 
      !this.config.candidates || 
      this.config.candidates.length === 0 ||
      !this.config.selectedSource;
  }

  /** 是否已有可用音源 */
  hasAvailableSource() {
    if (!this.config) this.loadConfig();
    return !!this.config?.selectedSource?.searchUrl;
  }

  /** 获取当前选中的音源 */
  getCurrentSource() {
    if (!this.config) this.loadConfig();
    return this.config?.selectedSource || null;
  }

  /** 获取已保存的候选列表 */
  getCandidates() {
    if (!this.config) this.loadConfig();
    return this.config?.candidates || [];
  }

  /** 用户从候选中选择一个源 */
  selectSource(source) {
    this.config = this.config || {};
    this.config.selectedSource = source;
    this.config.selectedAt = new Date().toISOString();
    this.saveConfig(this.config);
    console.log("[SourceManager] User selected:", source.name);
  }

  /**
   * 启动音源获取任务（异步）
   * 前端通过 checkFetchProgress() 轮询进度
   */
  async startFetch() {
    console.log("[SourceManager] 启动音源获取任务...");
    return await this.hermesApi.startFetch();
  }

  /**
   * 检查获取进度
   */
  checkFetchProgress() {
    const progress = this.hermesApi.checkProgress();
    
    // 如果成功完成，保存到配置
    if (progress.status === 'success' && progress.sources?.length > 0) {
      this._saveSourcesFromProgress(progress);
    }
    
    return progress;
  }

  /**
   * 从进度结果保存音源
   */
  _saveSourcesFromProgress(progress) {
    const sources = progress.sources.map((s, i) => ({
      id: s.id || `source_${String(i + 1).padStart(3, '0')}`,
      name: s.name,
      searchUrl: s.url,
      repo: s.repo,
      quality: s.quality,
      stars: s.stars,
      selected: i < 5 // 默认选中前5个
    }));

    this.config = this.config || {};
    this.config.candidates = sources;
    this.config.lastFetchAt = progress.timestamp;
    this.config.version = 11;
    this.saveConfig(this.config);

    if (!this.config.selectedSource && sources.length > 0) {
      this.selectSource(sources[0]);
    }

    console.log("[SourceManager] 保存了", sources.length, "个音源");
  }

  /**
   * 旧版同步获取方法（已弃用，保留兼容）
   */
  async fetchSources(testSong = "周杰伦") {
    console.log("[SourceManager] 使用旧版同步获取方法...");
    
    // 启动任务
    await this.hermesApi.startFetch();
    
    // 等待完成（最长30分钟）
    const maxWait = 1800000;
    const interval = 5000;
    let waited = 0;
    
    while (waited < maxWait) {
      const progress = this.hermesApi.checkProgress();
      if (progress.status === 'success') {
        return this._saveSourcesFromProgress(progress);
      }
      if (progress.status === 'error' || progress.status === 'timeout') {
        throw new Error(progress.message);
      }
      
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
    }
    
    throw new Error("获取超时");
  }

    /**
     * 自动获取音源（用于首次安装和搜索失败时）
     * @returns {Promise<boolean>} - 是否成功获取
     */
    async autoFetchIfNeeded() {
        // 检查是否需要自动获取
        if (!this.isFirstInstall() && this.hasAvailableSource()) {
            console.log("[SourceManager] 已有可用音源，无需自动获取");
            return true;
        }

        console.log("[SourceManager] 首次安装或无可用音源，自动获取中...");

        try {
            const sources = await this.fetchSources("周杰伦");
            return sources && sources.length > 0;
        } catch (error) {
            console.error("[SourceManager] 自动获取失败:", error.message);
            return false;
        }
    }

    /**
     * 搜索失败时重新获取音源
     * @param {string} testSong - 测试歌曲
     * @returns {Promise<Array>} - 新的音源列表
     */
    async refreshSourcesOnFailure(testSong = "周杰伦") {
        console.log("[SourceManager] 搜索失败，重新获取音源...");

        // 清空当前配置
        this.config = this.config || {};
        this.config.candidates = [];
        this.config.selectedSource = null;
        this.saveConfig(this.config);

        // 重新获取
        return await this.fetchSources(testSong);
    }

    /**
     * 批量探测搜索结果的 duration（标记试听）
     */
    probeSearchResults(items, probeLimit = 10) {
        const results = [];
        const toProbe = items.slice(0, probeLimit);
        for (const item of toProbe) {
            const url = item?.playUrl || item?.url;
            if (!url) {
                results.push({ ...item, durationSec: null, isPreview: null });
                continue;
            }
            const dur = this._probeDuration(url);
            const isPreview = typeof dur === "number" && dur > 0 && dur < 90;
            results.push({ ...item, durationSec: dur, isPreview });
        }
        for (const item of items.slice(probeLimit)) {
            results.push({ ...item, durationSec: null, isPreview: null });
        }
        return results;
    }

    _probeDuration(url) {
        try {
            const out = execSync(
                `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`,
                { timeout: 8000, encoding: "utf-8", shell: true },
            ).trim();
            const v = parseFloat(out);
            if (Number.isFinite(v) && v > 0) return v;
        } catch {}
        return null;
    }
}

export default SourceManager;
