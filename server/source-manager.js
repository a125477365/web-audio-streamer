/**
 * 音源管理器 v10
 *
 * 核心原则：
 * 1. 通过 Hermes 实时搜索最新洛雪音源
 * 2. 使用 setsid 后台执行，支持长时间任务（30分钟超时）
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
        // 首次安装：没有配置文件，或者 candidates 为空，或者 selectedSource 为空
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

    /** 获取已保存的候选列表（最多5个） */
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
 * 通过 Hermes CLI 实时搜索音源仓库
 * 流程：Hermes 搜索 → 返回仓库 URL → GitHub API 获取文件
 */
 async fetchSources(testSong = "周杰伦") {
 console.log("[SourceManager] === 开始实时获取音源 ===");

 const hermesAvailable = await this.hermesApi.checkAvailability();
 if (!hermesAvailable) {
 throw new Error("Hermes CLI 不可用，请确保 Hermes Agent 正在运行");
 }

 console.log("[SourceManager] Hermes CLI 可用，开始搜索仓库...");

 try {
 const sources = await this.hermesApi.fetchMusicSources();
 if (sources && sources.length > 0) {
 return this._saveSources(sources, "hermes-search");
 }
 throw new Error("Hermes 未返回有效音源");
 } catch (error) {
 console.error("[SourceManager] Hermes 搜索失败:", error.message);
 throw error;
 }
 }

 /**
 * 保存音源到配置
 */
  _saveSources(sources, source) {
  const validSources = sources.filter(s => {
    if (!s || !s.searchUrl || !s.searchUrl.startsWith("http")) return false;
    return true;
  }).slice(0, 10);

 if (validSources.length === 0) {
 throw new Error("没有找到有效的音源");
 }

 this.config = this.config || {};
 this.config.candidates = validSources;
 this.config.lastFetchAt = new Date().toISOString();
 this.config.version = 11;
 this.config.source = source;
 this.saveConfig(this.config);

 if (!this.config.selectedSource) {
 this.selectSource(validSources[0]);
 }

 console.log("[SourceManager] === 成功获取", validSources.length, "个音源:", validSources.map(s => s.name));
 return validSources;
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
