import https from "https";
import http from "http";
import crypto from "crypto";

const QUALITY_RANK = {
  hires: 100,
  flac: 90,
  ape: 85,
  wav: 80,
  sq: 70,
  320: 70,
  "320kbps": 70,
  hq: 50,
  192: 50,
  standard: 30,
  128: 30,
  low: 10,
};

const NXVAV_TOKEN = "nxvav";

export class OnlineMusicApi {
  constructor(config) {
    this.config = config;
    this.provider = config.online?.provider || "netease";
    this.source = null;
  }

  setSource(source) {
    this.source = source && source.searchUrl ? { ...source } : null;
  }

  _requireSource() {
    if (!this.source?.searchUrl) {
      throw new Error("No music source selected");
    }
    return this.source;
  }

  _getBaseUrl() {
    return this._requireSource().searchUrl;
  }

  _getRequestStyle() {
    return this.source?.requestStyle || "server";
  }

  _buildApiUrl(action, value, auth) {
    const base = this._getBaseUrl();
    const style = this._getRequestStyle();

    if (style === "server-keyword") {
      if (action === "search") {
        return `${base}?server=${this.provider}&type=search&id=0&keyword=${encodeURIComponent(value)}`;
      }
      return `${base}?server=${this.provider}&type=${action}&id=${encodeURIComponent(value)}${auth ? `&auth=${auth}` : ""}`;
    }

    if (style === "media") {
      return `${base}?media=${this.provider}&type=${action}&id=${encodeURIComponent(value)}`;
    }

    if (style === "type-only") {
      return `${base}?type=${action}&id=${encodeURIComponent(value)}`;
    }

    if (style === "q") {
      if (action !== "search") {
        return null;
      }
      return `${base}?q=${encodeURIComponent(value)}`;
    }

    if (style === "keyword") {
      if (action !== "search") {
        return null;
      }
      return `${base}?keyword=${encodeURIComponent(value)}`;
    }

    const authQuery = auth ? `&auth=${auth}` : "";
    return `${base}?server=${this.provider}&type=${action}&id=${encodeURIComponent(value)}${authQuery}`;
  }

  _generateAuth(id, type = "url") {
    const message = `${this.provider}${type}${id}`;
    return crypto.createHmac("sha1", NXVAV_TOKEN).update(message).digest("hex");
  }

  async search(query) {
    try {
      this._requireSource();
      const url = this._buildApiUrl("search", query);
      if (!url) {
        throw new Error("Selected source does not support search");
      }

      const data = await this._fetchWithRedirect(url);
      if (!Array.isArray(data)) {
        return {
          success: false,
          error: "Search returned an unexpected payload",
        };
      }

      const songs = data.map((item, index) => {
        const idMatch = item.url?.match(/id=(\d+)/);
        const id = item.id || (idMatch ? idMatch[1] : `unknown_${index}`);

        return {
          id,
          title: item.title || item.name || "Unknown",
          artist: item.author || item.artist || "Unknown",
          album: item.album || "",
          cover: item.pic || item.cover || "",
          playUrl: item.url || item.playUrl || "",
          duration: item.duration || item.time || null,
          size: item.size || null,
          sizeText: item.sizeText || (item.size ? `${Math.round((item.size / 1024 / 1024) * 10) / 10}MB` : "Unknown"),
          sampleRate: item.sampleRate || null,
          bitsPerSample: item.bitsPerSample || null,
          channels: item.channels || null,
          bitrate: item.bitrate || "Unknown",
          qualityScore: item.qualityScore || 50,
        };
      });

      return songs.filter((song) => {
        if (!song.duration) {
          return true;
        }
        const seconds = song.duration > 10000 ? song.duration / 1000 : song.duration;
        return !(seconds > 0 && seconds < 90);
      });
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getSongDetail(id) {
    try {
      this._requireSource();
      const url = this._buildApiUrl("song", id);
      if (!url) {
        return null;
      }

      const data = await this._fetchWithRedirect(url);
      if (data && data.title) {
        return {
          id,
          title: data.title,
          artist: data.author || "Unknown",
          album: data.album || "",
          cover: data.pic || "",
          url: data.url,
        };
      }
    } catch {}

    return null;
  }

  async getSongUrl(id) {
    try {
      this._requireSource();
      const auth = this.source?.needsAuth ? this._generateAuth(id, "url") : null;
      const url = this._buildApiUrl("url", id, auth);
      if (!url) {
        throw new Error("Selected source does not support playback URL lookup");
      }

      return await this._getRedirectUrl(url);
    } catch (error) {
      throw new Error(`Unable to get song URL: ${error.message}`);
    }
  }

  _getRedirectUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error("Too many redirects"));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const options = { method: "GET", timeout: 10000 };

      const req = lib.request(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, parsedUrl.origin).href;
          resolve(this._getRedirectUrl(nextUrl, maxRedirects - 1));
          return;
        }

        if (res.statusCode === 200) {
          resolve(url);
          return;
        }

        reject(new Error(`HTTP ${res.statusCode}`));
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.end();
    });
  }

  async getLyric(id) {
    try {
      this._requireSource();
      const auth = this.source?.needsAuth ? this._generateAuth(id, "lrc") : null;
      const url = this._buildApiUrl("lrc", id, auth);
      if (!url) {
        return "";
      }
      return await this._fetchWithRedirect(url);
    } catch {
      return "";
    }
  }

  _fetchWithRedirect(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error("Too many redirects"));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const options = {
        headers: {
          Accept: "*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: 15000,
      };

      lib
        .get(url, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = res.headers.location.startsWith("http")
              ? res.headers.location
              : new URL(res.headers.location, parsedUrl.origin).href;
            resolve(this._fetchWithRedirect(nextUrl, maxRedirects - 1));
            return;
          }

          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          });
        })
        .on("error", reject);
    });
  }
}
