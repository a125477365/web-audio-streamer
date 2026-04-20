import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { HermesSourceApi } from "./hermes-source-api.js";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw", "web-audio-streamer");
const SOURCE_CONFIG_FILE = path.join(CONFIG_DIR, "source-config.json");
const CONFIG_VERSION = 12;

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
      this._saveSourcesFromProgress(progress);
    }
    return progress;
  }

  _saveSourcesFromProgress(progress) {
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
        return this._saveSourcesFromProgress(progress);
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
