/**
 * 音源管理器 — 整合 LX Plugin Runtime
 * 
 * 职责：
 * 1. 管理 LX 插件的发现、加载和生命周期
 * 2. 维护音源配置（兼容旧格式 + LX 插件格式）
 * 3. 自动从 GitHub 仓库加载 LX 插件
 * 4. 提供 LX Runtime 实例给 OnlineMusicApi 和 MusicDownloader
 */

import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { LxPluginRuntime } from "./lx-plugin-runtime.js";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");
const PLUGIN_CACHE_DIR = path.join(CONFIG_DIR, "plugins");
const CONFIG_VERSION = 15;

export class SourceManager {
  constructor() {
    this.config = null;
    this._ensureConfigDir();
    this.lxRuntime = new LxPluginRuntime();
    this._pluginsLoaded = false;
  }

  _ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(PLUGIN_CACHE_DIR)) {
      fs.mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
    }
  }

  // ==========================================================
  //  配置管理（兼容旧格式）
  // ==========================================================

  loadConfig() {
    try {
      if (fs.existsSync(SOURCE_CONFIG_FILE)) {
        this.config = JSON.parse(fs.readFileSync(SOURCE_CONFIG_FILE, "utf-8"));
        return this.config;
      }
    } catch (error) {
      console.error("[SourceManager] 加载配置失败:", error.message);
    }
    return null;
  }

  saveConfig(data) {
    try {
      fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(data, null, 2));
      this.config = data;
      return true;
    } catch (error) {
      console.error("[SourceManager] 保存配置失败:", error.message);
      return false;
    }
  }

  _ensureConfigLoaded() {
    if (!this.config) this.loadConfig();
    if (!this.config) {
      this.config = {
        version: CONFIG_VERSION,
        candidates: [],
        selectedSource: null,
        lxPlugins: [],
      };
    }
  }

  // ==========================================================
  //  状态查询
  // ==========================================================

  isFirstInstall() {
    this._ensureConfigLoaded();
    return (
      (!Array.isArray(this.config.candidates) || this.config.candidates.length === 0) &&
      (!Array.isArray(this.config.lxPlugins) || this.config.lxPlugins.length === 0)
    );
  }

  hasSelectedSource() {
    this._ensureConfigLoaded();
    return Boolean(this.config?.selectedSource?.searchUrl);
  }

  hasAvailableSource() {
    return this.hasSelectedSource() || this.lxRuntime.plugins.length > 0;
  }

  hasCandidates() {
    this._ensureConfigLoaded();
    return (
      (Array.isArray(this.config?.candidates) && this.config.candidates.length > 0) ||
      (Array.isArray(this.config?.lxPlugins) && this.config.lxPlugins.length > 0)
    );
  }

  needsSelection() {
    return this.hasCandidates() && !this.hasSelectedSource() && !this._pluginsLoaded;
  }

  getCurrentSource() {
    this._ensureConfigLoaded();
    return this.config?.selectedSource || null;
  }

  getCandidates() {
    this._ensureConfigLoaded();
    return this.config?.candidates || [];
  }

  getStatus() {
    this._ensureConfigLoaded();
    const runtimeStatus = this.lxRuntime.getStatus();

    return {
      hasSource: this.hasAvailableSource(),
      hasCandidates: this.hasCandidates(),
      needsFetch: !this.hasCandidates(),
      needsSelection: this.needsSelection(),
      currentSource: this.getCurrentSource(),
      candidates: this.getCandidates(),
      candidateCount: this.getCandidates().length,
      lastFetchAt: this.config?.lastFetchAt || null,
      manualActionRequired: Boolean(this.config?.manualActionRequired),
      manualActionMessage: this.config?.manualActionMessage || "",
      // LX 插件状态
      lxRuntime: runtimeStatus,
      pluginsLoaded: this._pluginsLoaded,
      supportedPlatforms: runtimeStatus.allSources,
    };
  }

  selectSource(source) {
    this._ensureConfigLoaded();
    const matched = this.getCandidates().find(
      (item) => item.searchUrl === source.searchUrl
    ) || {
      ...source,
      selected: false,
    };

    this.config.selectedSource = matched;
    this.config.selectedAt = new Date().toISOString();
    this.saveConfig(this.config);
    return matched;
  }

  /**
   * 获取 LX Runtime 实例（供 OnlineMusicApi / Downloader 使用）
   */
  getLxRuntime() {
    return this.lxRuntime;
  }

  // ==========================================================
  //  LX 插件加载（核心新功能）
  // ==========================================================

  /**
   * 从预配置的 GitHub 仓库加载 LX 插件
   * 这是启动时自动调用的主要入口
   * 
   * @param {object} options - { maxPlugins, timeout }
   * @returns {Promise<{loaded: number, failed: number, plugins: Array}>}
   */
 async loadLxPlugins(options = {}) {
 const { maxPlugins = 10, onLog = null } = options;

 if (this._pluginsLoaded) {
 return {
 loaded: this.lxRuntime.plugins.length,
 failed: 0,
 plugins: this.lxRuntime.plugins.map((p) => ({
 name: p.name,
 sources: Object.keys(p.supportedSources),
 })),
 };
 }

 const log = (msg) => {
 console.log(`[SourceManager] ${msg}`);
 if (onLog) onLog(msg);
 };

 log("开始发现 LX 音源仓库...");

 // ====== 优先级：1.GitHub Search API → 2.Hermes Agent → 3.配置缓存 ======
 let repos = [];
 let needAgentFallback = false; // 标记是否需要 Agent 搜索

 // ── 优先级1：GitHub Search API ──
 log("① 通过 GitHub Search API 搜索最新音源仓库...");
 try {
 const searched = await this._searchGithubRepos(log);
 if (searched.length > 0) {
 repos = searched;
 log(`GitHub 搜索发现 ${searched.length} 个仓库`);
 // 持久化到配置
 this._ensureConfigLoaded();
 this.config.discoveredRepos = repos;
 this.saveConfig(this.config);
 } else {
 log("GitHub Search API 未找到仓库");
 needAgentFallback = true;
 }
 } catch (e) {
 log(`GitHub Search API 搜索失败: ${e.message}`);
 needAgentFallback = true;
 }

 // ── 优先级2：从 GitHub 仓库加载 JS 插件 ──
 const allLoaded = [];
 const allFailed = [];

 if (repos.length > 0) {
 log(`从 ${repos.length} 个 GitHub 仓库加载插件...`);
 for (const repo of repos) {
 try {
 if (onLog) log(`从 ${repo.owner}/${repo.repo} 加载插件...`);
 const plugins = await this._loadFromRepo(repo);
 allLoaded.push(...plugins.loaded);
 allFailed.push(...plugins.failed);
 if (allLoaded.length >= maxPlugins) break;
 } catch (err) {
 log(`仓库 ${repo.owner}/${repo.repo} 加载失败: ${err.message}`);
 allFailed.push({ repo: `${repo.owner}/${repo.repo}`, error: err.message });
 }
 }
 }

 // 如果 GitHub 仓库的 JS 都不能用，标记需要 Agent
 if (repos.length > 0 && allLoaded.length === 0) {
 log("⚠️ GitHub 仓库中的 JS 插件均不可用，需要 Hermes Agent 搜索");
 needAgentFallback = true;
 }

 // ── 优先级3（延后处理）：Hermes Agent 搜索 ──
 // 注意：Agent 搜索是异步的，需要调用方(index.js)轮询结果
 // 这里只设置标记，实际 Agent 逻辑在 index.js SSE 流中处理
 if (needAgentFallback) {
 this._needAgentSearch = true;
 } else {
 this._needAgentSearch = false;
 }

 log(`共加载 ${allLoaded.length} 个插件（${needAgentFallback ? '需要 Agent 搜索' : '无需 Agent'}）`);

 // 更新配置
 this._ensureConfigLoaded();
 this.config.lxPlugins = allLoaded.map((p) => ({
 name: p.name,
 version: p.version,
 sources: Object.keys(p.supportedSources),
 scriptUrl: p.scriptUrl,
 }));

 this.config.lastPluginLoadAt = new Date().toISOString();
 this.saveConfig(this.config);

 this._pluginsLoaded = true;

 log(`✅ LX 插件加载完成: ${allLoaded.length} 成功, ${allFailed.length} 失败`);

 return {
 loaded: allLoaded.length,
 failed: allFailed.length,
 plugins: allLoaded.map((p) => ({
 name: p.name,
 sources: Object.keys(p.supportedSources),
 })),
 errors: allFailed,
 };
 }

 /**
 * 从指定仓库列表加载 LX 插件（不搜索 GitHub，用于配置缓存兜底）
 */
 async loadLxPluginsFromRepos(repos, { onLog } = {}) {
 const maxPlugins = this.maxPlugins || 20;
 const log = (msg) => {
 console.log(`[SourceManager] ${msg}`);
 if (onLog) onLog(msg);
 };

 const allLoaded = [];
 const allFailed = [];

 for (const repo of repos) {
 try {
 if (onLog) log(`从 ${repo.owner}/${repo.repo} 加载插件...`);
 const plugins = await this._loadFromRepo(repo);
 allLoaded.push(...plugins.loaded);
 allFailed.push(...plugins.failed);
 if (allLoaded.length >= maxPlugins) break;
 } catch (err) {
 log(`仓库 ${repo.owner}/${repo.repo} 加载失败: ${err.message}`);
 allFailed.push({ repo: `${repo.owner}/${repo.repo}`, error: err.message });
 }
 }

 // 更新配置
 this._ensureConfigLoaded();
 this.config.lxPlugins = allLoaded.map((p) => ({
 name: p.name,
 version: p.version,
 sources: Object.keys(p.supportedSources),
 scriptUrl: p.scriptUrl,
 }));
 this.config.lastPluginLoadAt = new Date().toISOString();
 this.saveConfig(this.config);
 this._pluginsLoaded = true;

 log(`✅ 缓存仓库插件加载完成: ${allLoaded.length} 成功, ${allFailed.length} 失败`);

 return {
 loaded: allLoaded.length,
 failed: allFailed.length,
 plugins: allLoaded.map((p) => ({
 name: p.name,
 sources: Object.keys(p.supportedSources),
 })),
 errors: allFailed,
 };
 }

 /**
 * 通过 GitHub Search API 动态搜索洛雪音源仓库
 * 不依赖硬编码地址，实时搜索最新可用仓库
 */
 async _searchGithubRepos(log = null) {
 const searchQueries = [
 "lx-music-source",
 "lx-music-sources",
 "lxmusic source",
 "洛雪音乐 音源",
 ];

 const allRepos = [];
 const seen = new Set();

 for (const query of searchQueries) {
 try {
 if (log) log(`搜索: "${query}"...`);
 const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;
 const data = await this._githubFetchJson(url);

 if (!data.items || data.items.length === 0) continue;

 for (const item of data.items) {
 const key = `${item.full_name}`;
 if (seen.has(key)) continue;
 if (item.archived || item.disabled) continue;
 seen.add(key);

 allRepos.push({
 owner: item.owner.login,
 repo: item.name,
 branch: item.default_branch || "main",
 distPath: "",
 description: item.description || "",
 stars: item.stargazers_count || 0,
 url: item.html_url,
 updatedAt: item.updated_at,
 });
 }
 } catch (err) {
 if (log) log(`GitHub 搜索 "${query}" 失败: ${err.message}`);
 }
 }

 // 挸星数降序排列
 allRepos.sort((a, b) => (b.stars || 0) - (a.stars || 0));

 if (log && allRepos.length > 0) {
 log(`搜索到 ${allRepos.length} 个仓库: ${allRepos.slice(0, 5).map(r => `${r.owner}/${r.repo}(★${r.stars})`).join(", ")}`);
 }

 return allRepos.slice(0, 10);
 }

 /**
 * GitHub API 专用 JSON 请求（独立于 lxRuntime）
 */
 async _githubFetchJson(url, timeoutMs = 10000) {
 return new Promise((resolve, reject) => {
 const req = https.get(url, {
 headers: { "User-Agent": "Web-Audio-Streamer/1.0" },
 timeout: timeoutMs,
 }, (res) => {
 let data = "";
 res.on("data", (chunk) => { data += chunk.toString(); });
 res.on("end", () => {
 if (res.statusCode !== 200) {
 reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
 return;
 }
 try { resolve(JSON.parse(data)); }
 catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
 });
 });
 req.on("error", reject);
 req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
 });
 }

 /**
 * 从单个 GitHub 仓库加载插件
 */
  async _loadFromRepo(repo) {
    const { owner, repo: repoName, branch = "main", distPath = "" } = repo;

    // 获取 JS 文件列表
    let jsFiles;
    if (distPath) {
      // 有 dist 目录的仓库（如 ZxwyWebSite）
      const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${distPath}?ref=${branch}`;
      jsFiles = await this._listJsFiles(apiUrl);
    } else {
      // 根目录的仓库（如 TZB679）
      const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents`;
      jsFiles = await this._listJsFiles(apiUrl);

      // 也扫描子目录
      const subdirs = jsFiles.filter((f) => f.type === "dir" && !f.name.startsWith("."));
      for (const dir of subdirs.slice(0, 5)) {
        try {
          const subUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${dir.name}?ref=${branch}`;
          const subFiles = await this._listJsFiles(subUrl);
          jsFiles.push(...subFiles.filter((f) => f.type === "file"));
        } catch {}
      }

      // 过滤只保留 .js 文件
      jsFiles = jsFiles.filter((f) => f.name?.endsWith(".js") && f.type === "file");
    }

    // 限制数量，避免太多
    jsFiles = jsFiles.slice(0, 15);

    const loaded = [];
    const failed = [];

    for (const file of jsFiles) {
      const downloadUrl = file.download_url;
      if (!downloadUrl) continue;

      try {
        // 先检查缓存
        const cachePath = path.join(PLUGIN_CACHE_DIR, `${owner}_${repoName}_${file.name}`);
        let code;

        if (fs.existsSync(cachePath)) {
          const stat = fs.statSync(cachePath);
          // 缓存不超过 24 小时
          if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
            code = fs.readFileSync(cachePath, "utf-8");
          }
        }

        if (!code) {
          code = await this.lxRuntime._downloadScript(downloadUrl);
          if (!code) {
            failed.push({ file: file.name, error: "下载失败" });
            continue;
          }
          // 写入缓存
          fs.writeFileSync(cachePath, code, "utf-8");
        }

        const plugin = await this.lxRuntime.loadPlugin(downloadUrl, code);
        if (plugin) {
          loaded.push(plugin);
        } else {
          failed.push({ file: file.name, error: "初始化失败" });
        }
      } catch (err) {
        failed.push({ file: file.name, error: err.message });
      }
    }

    return { loaded, failed };
  }

  /**
   * 列出 GitHub API 目录中的 JS 文件
   */
  async _listJsFiles(apiUrl) {
    const data = await this.lxRuntime._fetchJson(apiUrl, {
      "User-Agent": "Web-Audio-Streamer/1.0",
    });

    if (!Array.isArray(data)) return [];

    return data.filter((f) => {
      if (f.type === "dir") return true; // 保留目录，后面再扫描
      return f.name?.endsWith(".js") && (f.size || 0) < 200000;
    });
  }

  // ==========================================================
  //  兼容旧 Hermes API 音源发现
  // ==========================================================

  async startFetch(testSong = "Jay Chou") {
    // 如果已有 LX 插件在运行，不再需要 Hermes API 发现
    if (this.lxRuntime.plugins.length > 0) {
      return {
        status: "success",
        message: "LX 插件已加载，无需额外发现",
        pluginCount: this.lxRuntime.plugins.length,
      };
    }

    // 回退到 Hermes API
    if (!this.hermesApi) {
      const { HermesSourceApi } = await import("./hermes-source-api.js");
      this.hermesApi = new HermesSourceApi();
    }
    return this.hermesApi.startFetch(testSong);
  }

 checkFetchProgress() {
 if (!this.hermesApi) return { status: "no-fetch", message: "未启动发现" };
 const progress = this.hermesApi.checkProgress();
 if (progress.status === "success" && progress.sources?.length > 0) {
 // 检查是否为仓库格式（_isLxRepo）
 const lxRepos = progress.sources.filter(s => s._isLxRepo);
 if (lxRepos.length > 0) {
 // 仓库格式：直接用这些仓库加载 LX 插件
 console.log(`[SourceManager] Agent 返回 ${lxRepos.length} 个仓库，开始加载插件...`);
 this._ensureConfigLoaded();
 this.config.discoveredRepos = lxRepos.map(r => ({
 owner: r.owner,
 repo: r.repo,
 branch: r.branch || "main",
 distPath: r.distPath || "",
 description: r.description || r.name,
 }));
 this.saveConfig(this.config);
 return { ...progress, _needsLxLoad: true, repos: lxRepos };
 }
 // 旧格式：API 端点
 this.saveSourcesFromProgress(progress);
 }
 return progress;
 }

  saveSourcesFromProgress(progress) {
    const sources = progress.sources.map((source, index) => ({
      id: source.id || `source_${String(index + 1).padStart(3, "0")}`,
      name: source.name,
      searchUrl: source.searchUrl || source.url,
      requestStyle: source.requestStyle,
      needsAuth: Boolean(source.needsAuth),
      repo: source.repo,
      aiScore: source.aiScore,
      description: source.description,
      verifiedAt: source.verifiedAt,
      sampleSong: source.sampleSong || null,
      sampleArtist: source.sampleArtist || null,
      sampleDurationSec: source.sampleDurationSec || null,
      samplePlayUrl: source.samplePlayUrl || null,
      queryCount: source.queryCount || 0,
      detectedFrom: source.detectedFrom || "",
      _isLxPlugin: source._isLxPlugin || false,
      _apiUrl: source._apiUrl || "",
      _apiReachable: source._apiReachable || false,
      _supportedSources: source._supportedSources || [],
      _version: source._version || "",
      selected: false,
    }));

    this._ensureConfigLoaded();
    const previousSelectedUrl = this.config.selectedSource?.searchUrl;
    const matchedSelection =
      sources.find((item) => item.searchUrl === previousSelectedUrl) || null;

    this.config = {
      ...this.config,
      version: CONFIG_VERSION,
      candidates: sources,
      selectedSource: matchedSelection,
      lastFetchAt: progress.timestamp || new Date().toISOString(),
      fetchProvider: progress.provider || progress.result?.provider || null,
      manualActionRequired: Boolean(progress.manualActionRequired),
      manualActionMessage: progress.manualActionMessage || "",
    };

    if (!matchedSelection) delete this.config.selectedAt;
    this.saveConfig(this.config);
    return sources;
  }

  async fetchSources(testSong = "Jay Chou") {
    // 优先尝试加载 LX 插件
    const result = await this.loadLxPlugins();
    if (result.loaded > 0) {
      return result.plugins.map((p) => ({
        name: p.name,
        sources: p.sources,
        type: "lx-plugin",
      }));
    }

    // 回退到 Hermes API
    if (!this.hermesApi) {
      const { HermesSourceApi } = await import("./hermes-source-api.js");
      this.hermesApi = new HermesSourceApi();
    }

    await this.hermesApi.startFetch(testSong);
    const maxWait = 5 * 60 * 1000;
    const interval = 10 * 1000;
    let waited = 0;

    while (waited < maxWait) {
      const progress = this.hermesApi.checkProgress();
      if (progress.status === "success") return this.saveSourcesFromProgress(progress);
      if (progress.status === "error" || progress.status === "timeout") {
        throw new Error(progress.message);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;
    }

    throw new Error("音源发现超时");
  }

  async autoFetchIfNeeded(testSong = "Jay Chou") {
    if (this.hasCandidates() || this.lxRuntime.plugins.length > 0) {
      return this.getCandidates();
    }
    return this.fetchSources(testSong);
  }

  async refreshSourcesOnFailure(testSong = "Jay Chou") {
    this._ensureConfigLoaded();
    this.config = {
      ...this.config,
      candidates: [],
      selectedSource: null,
      manualActionRequired: false,
      manualActionMessage: "",
    };
    delete this.config.selectedAt;
    this.saveConfig(this.config);

    // 清除插件缓存，重新加载
    this._pluginsLoaded = false;
    this.lxRuntime = new LxPluginRuntime();
    return this.fetchSources(testSong);
  }

  // ==========================================================
  //  工具方法
  // ==========================================================

  probeSearchResults(items, probeLimit = 10) {
    const results = [];
    const toProbe = items.slice(0, probeLimit);

    for (const item of toProbe) {
      const url = item?.playUrl || item?.url;
      if (!url) {
        results.push({ ...item, durationSec: null, isPreview: null });
        continue;
      }
      // 使用 LX Runtime 获取播放链接后探测时长
      // 暂时跳过 ffprobe（太慢）
      results.push({ ...item, durationSec: null, isPreview: null });
    }

    for (const item of items.slice(probeLimit)) {
      results.push({ ...item, durationSec: null, isPreview: null });
    }

    return results;
  }
}

export default SourceManager;
