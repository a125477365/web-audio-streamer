/**
 * 音乐下载器 — 基于 LX Plugin Runtime
 * 
 * 下载流程：
 * 1. 通过 LX Runtime 获取播放链接（多源并发）
 * 2. 流式下载到本地文件
 * 3. 支持进度回调
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

export class MusicDownloader {
  /**
   * @param {object} config - 配置
   * @param {import('./lx-plugin-runtime.js').LxPluginRuntime} lxRuntime - LX 插件运行时
   */
  constructor(config, lxRuntime = null) {
    this.config = config;
    this.path = config.music?.path || "./music";
    this.progress = {};
    this.lxRuntime = lxRuntime;
  }

  /**
   * 设置 LX Runtime
   */
  setLxRuntime(runtime) {
    this.lxRuntime = runtime;
  }

  /**
   * 下载歌曲
   * 
   * @param {string} songId - 歌曲ID
   * @param {object} options - { title, artist, format, source, quality, songInfo }
   * @returns {Promise<{filepath, filename, size}>}
   */
  async download(songId, options = {}) {
    const {
      title = "unknown",
      artist = "unknown",
      format = "mp3",
      quality = "320k",
      songInfo = {},
    } = options;

    // 确保下载目录存在
    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path, { recursive: true });
    }

    // 生成文件名
    const safeName = this._sanitizeFileName(`${artist} - ${title}`);
    const ext = this._getExtension(format);
    const filename = `${safeName}.${ext}`;
    const filepath = path.join(this.path, filename);

    // 如果文件已存在，直接返回
    if (fs.existsSync(filepath)) {
      return { filepath, filename, skipped: true };
    }

    // 获取播放/下载链接（优先 LX Runtime，其次 fallback）
    const playUrl = await this._getDownloadUrl(songId, songInfo, quality);

    // 流式下载
    this.progress[filename] = { percent: 0, status: "downloading" };

    await this._downloadFile(playUrl, filepath, (percent) => {
      this.progress[filename].percent = percent;
    });

    this.progress[filename] = { percent: 100, status: "completed" };

    return { filepath, filename, size: fs.statSync(filepath).size };
  }

  /**
   * 获取下载进度
   */
  getProgress() {
    return this.progress;
  }

  /**
   * 获取下载 URL
   * 优先使用 LX Runtime（多源并发），否则 fallback 到忆音源
   */
  async _getDownloadUrl(songId, songInfo = {}, quality = "320k") {
    // 1. 优先：LX Runtime 多源并发
    if (this.lxRuntime) {
      const info = {
        id: String(songId),
        songmid: String(songId),
        source: songInfo.source || "wy",
        title: songInfo.title || "",
        strMediaMid: songInfo.strMediaMid || "",
        hash: songInfo.hash || "",
        ...songInfo,
      };

      try {
        return await this.lxRuntime.getMusicUrl(info, quality);
      } catch (err) {
        console.warn(`[Downloader] LX Runtime 失败: ${err.message}`);
      }
    }

    // 2. Fallback: 忆音源 API
    const platform = songInfo.source === "kw" ? "kuwo"
      : songInfo.source === "kg" ? "kugou"
      : songInfo.source === "tx" ? "tencent"
      : "netease";

    const url = `https://music.3e0.cn/?server=${platform}&type=url&id=${songId}`;
    const redirectUrl = await this._getRedirectUrl(url);
    if (redirectUrl) return redirectUrl;

    // 3. Fallback: Meting API
    try {
      const metingUrl = `https://api.injahow.cn/meting/?server=netease&type=url&id=${songId}`;
      const data = await this._fetchJson(metingUrl);
      if (data?.url) return data.url;
    } catch {}

    throw new Error("所有下载源均不可用");
  }

  /**
   * 流式下载文件（支持重定向跟踪）
   */
  async _downloadFile(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      const doRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"));
          return;
        }

        const parsed = new URL(requestUrl);
        const lib = parsed.protocol === "https:" ? https : http;
        const file = redirectCount === 0
          ? fs.createWriteStream(filepath)
          : fs.createWriteStream(filepath, { flags: "a" });

        lib.get(requestUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "*/*",
            Referer: "",
          },
          timeout: 30000,
        }, (res) => {
          // 跟踪重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = res.headers.location.startsWith("http")
              ? res.headers.location
              : new URL(res.headers.location, parsed.origin).href;
            file.close();
            doRequest(nextUrl, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const totalSize = parseInt(res.headers["content-length"], 10);
          let downloaded = 0;

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            const percent = totalSize
              ? Math.round((downloaded / totalSize) * 100)
              : 0;
            onProgress(percent);
          });

          res.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });

          file.on("error", (err) => {
            file.close();
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            reject(err);
          });
        }).on("error", (err) => {
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
          reject(err);
        });
      };

      doRequest(url);
    });
  }

  /**
   * 获取重定向 URL
   */
  async _getRedirectUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error("Too many redirects"));
        return;
      }

      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;

      lib.get(url, {
        headers: {
          Accept: "*/*",
          "User-Agent": "Mozilla/5.0",
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, parsed.origin).href;
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
      }).on("error", reject);
    });
  }

  /**
   * JSON HTTP 请求
   */
  async _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;

      lib.get(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
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

  /**
   * 清理文件名
   */
  _sanitizeFileName(name) {
    return name
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
  }

  /**
   * 获取文件扩展名
   */
  _getExtension(format) {
    const extMap = {
      flac: "flac",
      mp3: "mp3",
      wav: "wav",
      aac: "aac",
      ogg: "ogg",
      m4a: "m4a",
    };
    return extMap[format?.toLowerCase()] || "mp3";
  }
}

export default MusicDownloader;
