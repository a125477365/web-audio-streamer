import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { HermesSourceApi } from "./hermes-source-api.js";
import { OpenClawConfig } from "./openclaw-config.js";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");
const CONFIG_VERSION = 13;

export class SourceManager {
  constructor() {
    this.config = null;
    this._ensureConfigDir();
    this.hermesApi = new HermesSourceApi();
    this._openclawConfig = null;
    this._initOpenClawConfig();
  }

  async _initOpenClawConfig() {
    try {
      this._openclawConfig = await new OpenClawConfig().init();
    } catch (err) {
      console.log("[SourceManager] OpenClawConfig init failed:", err.message);
      this._openclawConfig = null;
    }
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
    } catch (error) {
      console.error("[SourceManager] Failed to load config:", error.message);
    }
    return null;
  }

  saveConfig(data) {
    try {
      fs.writeFileSync(SOURCE_CONFIG_FILE, JSON.stringify(data, null, 2));
      this.config = data;
      return true;
    } catch (error) {
      console.error("[SourceManager] Failed to save config:", error.message);
      return false;
    }
  }

  _ensureConfigLoaded() {
    if (!this.config) {
      this.loadConfig();
    }
    if (!this.config) {
      this.config = {
        version: CONFIG_VERSION,
        candidates: [],
        selectedSource: null,
      };
    }
  }

  isFirstInstall() {
    this._ensureConfigLoaded();
    return !Array.isArray(this.config.candidates) || this.config.candidates.length === 0;
  }

  hasSelectedSource() {
    this._ensureConfigLoaded();
    return Boolean(this.config?.selectedSource?.searchUrl);
  }

  hasAvailableSource() {
    return this.hasSelectedSource();
  }

  hasCandidates() {
    this._ensureConfigLoaded();
    return Array.isArray(this.config?.candidates) && this.config.candidates.length > 0;
  }

  needsSelection() {
    return this.hasCandidates() && !this.hasSelectedSource();
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
    return {
      hasSource: this.hasSelectedSource(),
      hasCandidates: this.hasCandidates(),
      needsFetch: !this.hasCandidates(),
      needsSelection: this.needsSelection(),
      currentSource: this.getCurrentSource(),
      candidates: this.getCandidates(),
      candidateCount: this.getCandidates().length,
      lastFetchAt: this.config?.lastFetchAt || null,
      manualActionRequired: Boolean(this.config?.manualActionRequired),
      manualActionMessage: this.config?.manualActionMessage || "",
    };
  }

  selectSource(source) {
    this._ensureConfigLoaded();
    const matched = this.getCandidates().find((item) => item.searchUrl === source.searchUrl) || {
      ...source,
      selected: false,
    };

    this.config.selectedSource = matched;
    this.config.selectedAt = new Date().toISOString();
    this.saveConfig(this.config);
    return matched;
  }

  async startFetch(testSong = "Jay Chou") {
    return this.hermesApi.startFetch(testSong);
  }

  checkFetchProgress() {
    const progress = this.hermesApi.checkProgress();
    if (progress.status === "success" && progress.sources?.length > 0) {
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
      selected: false,
    }));

    this._ensureConfigLoaded();
    const previousSelectedUrl = this.config.selectedSource?.searchUrl;
    const matchedSelection = sources.find((item) => item.searchUrl === previousSelectedUrl) || null;

    this.config = {
      ...this.config,
      version: CONFIG_VERSION,
      candidates: sources,
      selectedSource: matchedSelection,
      lastFetchAt: progress.timestamp || new Date().toISOString(),
      fetchProvider: progress.provider || progress.result?.provider || null,
      manualActionRequired: Boolean(progress.manualActionRequired),
      manualActionMessage: progress.manualActionMessage || "",
      dependencyStatus: Array.isArray(progress.dependencyStatus) ? progress.dependencyStatus : [],
    };

    if (!matchedSelection) {
      delete this.config.selectedAt;
    }

    this.saveConfig(this.config);
    return sources;
  }

  async fetchSources(testSong = "Jay Chou") {
    await this.hermesApi.startFetch(testSong);

    const maxWait = 30 * 60 * 1000;
    const interval = 2 * 60 * 1000;
    let waited = 0;

    while (waited < maxWait) {
      const progress = this.hermesApi.checkProgress();
      if (progress.status === "success") {
        return this.saveSourcesFromProgress(progress);
      }
      if (progress.status === "error" || progress.status === "timeout") {
        throw new Error(progress.message);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;
    }

    throw new Error("Source discovery timed out after 30 minutes");
  }

  async autoFetchIfNeeded(testSong = "Jay Chou") {
    if (this.hasCandidates()) {
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
      dependencyStatus: [],
    };
    delete this.config.selectedAt;
    this.saveConfig(this.config);
    return this.fetchSources(testSong);
  }

  async fetchSourcesParallel(testSong = "Jay Chou") {
    const results = await Promise.allSettled([
      this._fetchSourcesWithHermes(testSong),
      this._fetchSourcesWithAI(testSong, null),
    ]);

    const allSources = [];
    for (const result of results) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        for (const s of result.value) {
          if (s?.searchUrl) allSources.push(s);
        }
      }
    }

    if (allSources.length === 0) {
      throw new Error("All AI discovery methods failed");
    }

    allSources.sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
    const deduped = [];
    const seen = new Set();
    for (const src of allSources) {
      if (!seen.has(src.searchUrl)) {
        seen.add(src.searchUrl);
        deduped.push(src);
      }
    }

    return deduped;
  }

  async _fetchSourcesWithHermes(testSong) {
    try {
      const startResult = await this.hermesApi.startFetch(testSong);
      if (!startResult?.taskId) return [];

      const maxWait = 5 * 60 * 1000;
      const interval = 5000;
      let waited = 0;

      while (waited < maxWait) {
        await new Promise((r) => setTimeout(r, interval));
        waited += interval;

        const task = this.hermesApi.getTaskStatus(startResult.taskId);
        if (!task) continue;

        if (task.status === "success" && Array.isArray(task.sources)) {
          return task.sources.map((s) => ({
            name: s.name || "Unknown",
            searchUrl: s.searchUrl || s.url || "",
            requestStyle: s.requestStyle || "server",
            needsAuth: Boolean(s.needsAuth),
            aiScore: s.aiScore || 50,
            description: s.description || "",
          }));
        }

        if (task.status === "error" || task.status === "timeout" || task.status === "cancelled") {
          console.log("[SourceManager] Hermes task failed:", task.status, task.message);
          break;
        }
      }
    } catch (err) {
      console.log("[SourceManager] Hermes fetch error:", err.message);
    }
    return [];
  }

  async _fetchSourcesWithHermesSSE(testSong, onLog) {
    try {
      const startResult = await this.hermesApi.startFetch(testSong);
      if (!startResult?.taskId) {
        onLog?.("Hermes 未返回任务 ID");
        return [];
      }

      const maxWait = 5 * 60 * 1000;
      const interval = 5000;
      let waited = 0;
      let lastProgress = 0;

      while (waited < maxWait) {
        await new Promise((r) => setTimeout(r, interval));
        waited += interval;

        const task = this.hermesApi.getTaskStatus(startResult.taskId);
        if (!task) continue;

        if (task.progress > lastProgress) {
          onLog?.(`进度: ${task.progress}%`);
          lastProgress = task.progress;
        }
        if (task.message) {
          onLog?.(task.message);
        }

        if (task.status === "success" && Array.isArray(task.sources)) {
          onLog?.(`成功! 发现 ${task.sources.length} 个音源`);
          return task.sources.map((s) => ({
            name: s.name || "Unknown",
            searchUrl: s.searchUrl || s.url || "",
            requestStyle: s.requestStyle || "server",
            needsAuth: Boolean(s.needsAuth),
            aiScore: s.aiScore || 50,
            description: s.description || "",
          }));
        }

        if (task.status === "error" || task.status === "timeout" || task.status === "cancelled") {
          onLog?.(`Hermes 任务失败: ${task.message || task.status}`, "error");
          break;
        }
      }
      onLog?.("Hermes 超时（5分钟）", "error");
    } catch (err) {
      onLog?.(`Hermes 执行异常: ${err.message}`, "error");
    }
    return [];
  }

  async _fetchSourcesWithOpenClawSSE(testSong, onLog) {
    return this._fetchSourcesWithAI(testSong, onLog);
  }

  async _fetchSourcesWithOpenClaw(testSong) {
    return this._fetchSourcesWithAI(testSong, (msg, level) => {
      if (level === "error") console.log("[SourceManager] AI:", msg);
    });
  }

  _getAvailableAIProviders() {
    const providers = [];
    const openclawCfg = this._openclawConfig;

    if (openclawCfg) {
      const llmConfig = openclawCfg.getLLMConfig();
      if (llmConfig?.apiKey) {
        providers.push({
          name: llmConfig.provider || "openclaw",
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
          apiKey: llmConfig.apiKey,
          source: "openclaw-config",
        });
      }
    }

    const envApiKeys = [
      { name: "NVIDIA_API_KEY", env: process.env.NVIDIA_API_KEY, baseUrl: "https://integrate.api.nvidia.com/v1", source: "env" },
      { name: "OPENAI_API_KEY", env: process.env.OPENAI_API_KEY, baseUrl: "https://api.openai.com/v1", source: "env" },
      { name: "OPENROUTER_API_KEY", env: process.env.OPENROUTER_API_KEY, baseUrl: "https://openrouter.ai/api/v1", source: "env" },
      { name: "DEEPSEEK_API_KEY", env: process.env.DEEPSEEK_API_KEY, baseUrl: "https://api.deepseek.com/v1", source: "env" },
      { name: "GEMINI_API_KEY", env: process.env.GEMINI_API_KEY, baseUrl: "https://generativelanguage.googleapis.com/v1", source: "env" },
    ];

    for (const { name, env, baseUrl, source } of envApiKeys) {
      if (env && !providers.some((p) => p.apiKey === env)) {
        providers.push({ name, baseUrl, model: null, apiKey: env, source });
      }
    }

    return providers;
  }

  async _fetchSourcesWithAI(testSong, onLog) {
    const providers = this._getAvailableAIProviders();

    if (providers.length === 0) {
      onLog?.("未检测到任何 AI API Key，跳过 AI 发现", "error");
      return [];
    }

    for (const provider of providers) {
      const keyPreview = provider.apiKey.substring(0, 8) + "...";
      onLog?.(`尝试 AI 提供商: ${provider.name} (${provider.source}) key=${keyPreview}`);

      try {
        const result = await this._callAIProvider(provider, testSong, onLog);
        if (result.length > 0) {
          onLog?.(`${provider.name} 返回 ${result.length} 个候选音源`);
          return result;
        }
      } catch (err) {
        onLog?.(`${provider.name} 调用失败: ${err.message}`, "error");
      }
    }

    onLog?.("所有 AI 提供商均失败", "error");
    return [];
  }

  async _callAIProvider(provider, testSong, onLog) {
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const model = provider.model || this._getDefaultModelForProvider(provider.name);

    if (!model) {
      onLog?.(`无法确定 ${provider.name} 的默认模型，跳过`, "error");
      return [];
    }

    const chatPath = baseUrl.includes("/chat/completions") ? "" : "/chat/completions";
    const url = baseUrl + chatPath;

    const prompt = `You are a music source discovery agent. Your task is to find PUBLIC music streaming API endpoints that support song search and playback URL retrieval.

CRITICAL REQUIREMENTS:
1. Search for PUBLIC music source APIs (free, no auth required)
2. Only return URLs that are publicly reachable right now
3. Exclude: GitHub repos, dead endpoints, login-only, 403/404/5xx, preview-only sources
4. Target: APIs that provide full songs, not 30-second previews

Test keyword to use: ${testSong}

Return ONLY valid JSON. No markdown, no explanation. Shape:
{"manualActionRequired":false,"manualActionMessage":"","candidates":[{"name":"Display name","searchUrl":"https://api.example.com/search","requestStyle":"server","needsAuth":false,"reason":"Why this is a good source"}]}

Find at least 8 candidate music source APIs with live search endpoints.`;

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    };

    if (provider.name === "GEMINI_API_KEY" || provider.baseUrl.includes("generativelanguage.googleapis")) {
      headers["x-goog-api-key"] = provider.apiKey;
      delete headers["Authorization"];
    }

    const body = {
      model: model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0.3,
    };

    if (provider.baseUrl.includes("openrouter.ai")) {
      body.model = model.split("/").pop();
      body.route = "fallback";
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ||
                    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!content) {
      throw new Error("Empty response from AI");
    }

    return this._parseAIResponse(content, onLog);
  }

  _getDefaultModelForProvider(providerName) {
    const defaults = {
      "nvidia-openai-qwen3-5": "nvidia/nemotron-3-super-120b-a12b",
      "nvidia": "nvidia/nemotron-3-super-120b-a12b",
      "openai": "gpt-4o-mini",
      "NVIDIA_API_KEY": "nvidia/nemotron-3-super-120b-a12b",
      "OPENAI_API_KEY": "gpt-4o-mini",
      "DEEPSEEK_API_KEY": "deepseek-chat",
      "GEMINI_API_KEY": "gemini-2.0-flash",
      "OPENROUTER_API_KEY": "openai/gpt-4o-mini",
    };
    return defaults[providerName] || null;
  }

  _parseAIResponse(content, onLog) {
    let stripped = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/im, "")
      .replace(/\s*```$/im, "")
      .trim();

    let parsed = null;

    try {
      parsed = JSON.parse(stripped);
    } catch {
      const firstBrace = stripped.indexOf("{");
      if (firstBrace >= 0) {
        try {
          parsed = JSON.parse(stripped.substring(firstBrace));
        } catch {}
      }
    }

    if (!parsed) {
      onLog?.("AI 返回中未找到有效 JSON", "error");
      return [];
    }

    const candidates = Array.isArray(parsed) ? parsed : (parsed?.candidates || []);
    onLog?.(`解析成功，共 ${candidates.length} 个候选音源`);
    return candidates.map((s, i) => ({
      name: s.name || `Source ${i + 1}`,
      searchUrl: s.searchUrl || s.url || "",
      requestStyle: s.requestStyle || "server",
      needsAuth: Boolean(s.needsAuth),
      aiScore: 50,
      description: s.reason || s.description || "Found via AI",
    }));
  }

  probeSearchResults(items, probeLimit = 10) {
    const results = [];
    const toProbe = items.slice(0, probeLimit);

    for (const item of toProbe) {
      const url = item?.playUrl || item?.url;
      if (!url) {
        results.push({ ...item, durationSec: null, isPreview: null });
        continue;
      }

      const durationSec = this._probeDuration(url);
      const isPreview = typeof durationSec === "number" && durationSec > 0 && durationSec < 90;
      results.push({ ...item, durationSec, isPreview });
    }

    for (const item of items.slice(probeLimit)) {
      results.push({ ...item, durationSec: null, isPreview: null });
    }

    return results;
  }

  _probeDuration(url) {
    try {
      const output = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`,
        { timeout: 8000, encoding: "utf-8", shell: true },
      ).trim();
      const value = Number.parseFloat(output);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {}

    return null;
  }
}

export default SourceManager;
