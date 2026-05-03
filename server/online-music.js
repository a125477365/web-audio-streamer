/**
 * 在线音乐 API — 重构后架构
 * 
 * 职责分离（与洛雪音乐完全一致）：
 * - 搜索：委托给 MusicSearchSdk（内置网易云/酷我/酷狗搜索实现）
 * - 播放链接：委托给 LxPluginRuntime（通过JS音源脚本获取）
 * - 本模块只做协调和格式转换
 * 
 * 流程：
 * 1. 用户搜索 → search() → MusicSearchSdk.searchMulti() → 返回标准化歌曲列表
 * 2. 用户播放 → getSongUrl() → LxPluginRuntime.getMusicUrl() → 返回mp3链接
 * 3. 前端拿到mp3链接 → 传给 AudioStreamer 播放
 */

import https from "https";
import http from "http";
import { MusicSearchSdk } from "./music-search-sdk.js";

export class OnlineMusicApi {
  /**
   * @param {object} config - 配置
   * @param {import('./lx-plugin-runtime.js').LxPluginRuntime} lxRuntime - LX 插件运行时
   */
  constructor(config, lxRuntime = null) {
    this.config = config;
    this.lxRuntime = lxRuntime;
    this.searchSdk = new MusicSearchSdk();

    // 向后兼容
    this.source = null;
    this.provider = config.online?.provider || "wy";
  }

  /** 设置 LX Plugin Runtime 实例 */
  setLxRuntime(runtime) {
    this.lxRuntime = runtime;
  }

  /** 兼容旧接口 */
  setSource(source) {
    this.source = source && source.searchUrl ? { ...source } : null;
  }

  // ==========================================================
  // 搜索 — 委托给 MusicSearchSdk
  // ==========================================================

  /**
   * 搜索音乐
   * 
   * @param {string} query - 搜索关键词
   * @param {object} options - { limit, page, source }
   *   source: 'wy'|'kw'|'kg' — 单平台搜索
   *   不传 source — 多平台并行搜索
   * @returns {Promise<Array>} 标准化歌曲列表（前端显示格式）
   */
  async search(query, options = {}) {
    try {
      let lxResults;

      if (options.source) {
        // 单平台搜索
        const result = await this.searchSdk.search(query, options);
        lxResults = result.list || [];
      } else {
        // 多平台并行搜索（默认）
        lxResults = await this.searchSdk.searchMulti(query, options);
      }

      // 转换为前端显示格式
      const displayResults = MusicSearchSdk.toDisplayFormat(lxResults);

      // 过滤掉过短的试听（< 90秒）
      const filtered = displayResults.filter((song) => {
        if (!song.duration) return true;
        return song.duration >= 90;
      });

      return filtered;
    } catch (error) {
      console.error("[OnlineMusicApi] 搜索失败:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==========================================================
  // 播放链接获取 — 委托给 LxPluginRuntime
  // ==========================================================

  /**
   * 获取歌曲播放链接
   * 
   * 优先使用 LX Runtime（多插件并发），回退到直连
   * 
   * @param {string} id - 歌曲ID (songmid)
   * @param {object} songInfo - 歌曲完整信息
   * @param {string} quality - 音质 (128k/320k/flac)
   * @returns {Promise<string>} mp3 播放链接
   */
  async getSongUrl(id, songInfo = {}, quality = "320k") {
    // 优先：LX Runtime 多源并发
    if (this.lxRuntime && this.lxRuntime.plugins.length > 0) {
      const info = {
        id: String(id),
        songmid: String(id),
        source: songInfo.source || "wy",
        title: songInfo.title || "",
        hash: songInfo.hash || "",
        albumId: songInfo.albumId || "",
        strMediaMid: songInfo.strMediaMid || "",
        ...songInfo,
      };

      try {
        const url = await this.lxRuntime.getMusicUrl(info, quality);
        console.log(`[OnlineMusicApi] ✅ LX Runtime 获取播放链接成功: ${info.source}/${id}`);
        return url;
      } catch (err) {
        console.warn(`[OnlineMusicApi] LX Runtime 失败: ${err.message}，尝试直连回退...`);
      }
    }

    // 回退1：网易云直连
    if (songInfo.source === "wy" || (!songInfo.source && this.provider === "wy")) {
      try {
        const url = await this._neteaseDirectUrl(id);
        if (url) return url;
      } catch {}
    }

    // 回退2：忆音源代理
    try {
      const url = await this._fallbackProxy(id, songInfo.source);
      if (url) return url;
    } catch {}

    throw new Error(`无法获取播放链接: ${songInfo.title || id} (${songInfo.source || "wy"})`);
  }

  // ==========================================================
  // 歌词获取
  // ==========================================================

  async getLyric(id, source = "wy") {
    if (source === "wy") {
      try {
        const url = `https://music.163.com/api/song/lyric?id=${id}&lv=1`;
        const data = await this._fetchJson(url);
        if (data?.lrc?.lyric) return data.lrc.lyric;
      } catch {}
    }
    return "";
  }

  // ==========================================================
  // 内部回退方法
  // ==========================================================

  /**
   * 网易云直连获取播放链接
   */
  async _neteaseDirectUrl(songId) {
    const url = `https://music.163.com/api/song/enhance/player/url?id=${songId}&ids=[${songId}]&br=320000`;
    const data = await this._fetchJson(url);
    if (data?.data?.[0]?.url) {
      return data.data[0].url;
    }
    return null;
  }

  /**
   * 代理回退（忆音源等第三方代理）
   */
  async _fallbackProxy(songId, source = "netease") {
    const sourceMap = { wy: "netease", kw: "kuwo", kg: "kugou" };
    const server = sourceMap[source] || "netease";

    const proxyUrls = [
      `https://music.3e0.cn/?server=${server}&type=url&id=${songId}`,
    ];

    for (const url of proxyUrls) {
      try {
        const result = await this._getRedirectUrl(url);
        if (result) return result;
      } catch {}
    }
    return null;
  }

  // ==========================================================
  // HTTP 工具方法
  // ==========================================================

  _getRedirectUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error("Too many redirects"));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      const req = lib.get(url, {
        headers: {
          Accept: "*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, parsedUrl.origin).href;
          resolve(this._getRedirectUrl(nextUrl, maxRedirects - 1));
          return;
        }

        if (res.statusCode === 200) {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              if (json?.url) {
                resolve(json.url);
                return;
              }
            } catch {}
            resolve(url);
          });
          return;
        }

        reject(new Error(`HTTP ${res.statusCode}`));
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
    });
  }

  _fetchJson(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      lib.get(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...extraHeaders,
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      }).on("error", reject);
    });
  }
}

export default OnlineMusicApi;
