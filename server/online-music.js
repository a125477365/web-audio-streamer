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

    const keywordParams = ["keywords", "keyword", "msg", "q", "name", "search_query", "wd", "w"];
    const idParams = ["id", "mid", "songid", "track_id"];

    const applyValue = (urlObj, paramNames, replacementValue) => {
      for (const p of paramNames) {
        if (urlObj.searchParams.has(p)) {
          urlObj.searchParams.set(p, replacementValue);
          return;
        }
      }
      urlObj.searchParams.append(paramNames[0], replacementValue);
    };

    let urlObj;
    try {
      urlObj = new URL(base);
    } catch {
      return null;
    }

    if (style === "server-keyword" || style === "server") {
      if (action === "search") {
        applyValue(urlObj, keywordParams, value);
      } else {
        applyValue(urlObj, keywordParams, value);
        applyValue(urlObj, idParams, value);
      }
      if (!urlObj.searchParams.has("server")) {
        urlObj.searchParams.set("server", this.provider);
      }
      if (action !== "search" && !urlObj.searchParams.has("type")) {
        urlObj.searchParams.set("type", action);
      }
      if (auth) urlObj.searchParams.set("auth", auth);
      return urlObj.toString();
    }

    if (style === "media") {
      if (action !== "search") {
        applyValue(urlObj, idParams, value);
      } else {
        applyValue(urlObj, keywordParams, value);
      }
      if (!urlObj.searchParams.has("media")) urlObj.searchParams.set("media", this.provider);
      if (!urlObj.searchParams.has("type")) urlObj.searchParams.set("type", action);
      return urlObj.toString();
    }

    if (style === "type-only") {
      if (action !== "search") {
        applyValue(urlObj, idParams, value);
      } else {
        applyValue(urlObj, keywordParams, value);
      }
      if (!urlObj.searchParams.has("type")) urlObj.searchParams.set("type", action);
      return urlObj.toString();
    }

    if (style === "q" || style === "keyword") {
      if (action !== "search") {
        return null;
      }
      applyValue(urlObj, keywordParams, value);
      return urlObj.toString();
    }

    return null;
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

      const rawResults = Array.isArray(data)
        ? data
        : (data?.result?.songs || data?.result || data?.data || data?.songs || []);
      if (!Array.isArray(rawResults)) {
        return {
          success: false,
          error: "Search returned an unexpected payload",
        };
      }

      const songs = rawResults.map((item, index) => {
        const idMatch = item.playUrl?.match(/id=(\d+)/);
        const songId = item.id || (idMatch ? idMatch[1] : `unknown_${index}`);

        const artistName = Array.isArray(item.artists)
          ? item.artists.map((a) => a.name || a).join(", ")
          : (item.artist || item.author || item.singer || "Unknown");

        const albumName = item.album?.name || item.al || item.albumName || "";

        const coverUrl = item.album?.picUrl || item.picUrl || item.pic || item.cover || "";

        const playUrl = item.url || item.playUrl || item.mp3 || item.sourceUrl || "";

        const duration = item.duration || item.time || item.dt || null;
        const durationSec = duration ? (duration > 10000 ? duration / 1000 : duration) : null;

        return {
          id: String(songId),
          title: item.name || item.title || item.songName || "Unknown",
          artist: artistName,
          album: albumName,
          cover: coverUrl,
          playUrl,
          duration: durationSec,
          durationMs: item.duration || null,
          size: item.size || null,
          sizeText: item.sizeText || (item.size ? `${Math.round((item.size / 1024 / 1024) * 10) / 10}MB` : "Unknown"),
          sampleRate: item.sampleRate || null,
          bitsPerSample: item.bitsPerSample || null,
          channels: item.channels || null,
          bitrate: item.bitrate || item.br || "Unknown",
          qualityScore: item.qualityScore || 50,
        };
      });

      return songs.filter((song) => {
        if (!song.duration) {
          return true;
        }
        return !(song.duration > 0 && song.duration < 90);
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
      const item = data?.data || data?.song || data?.songs?.[0] || data;
      if (item && (item.title || item.name)) {
        return {
          id,
          title: item.name || item.title,
          artist: Array.isArray(item.artists) ? item.artists.map(a => a.name || a).join(", ") : (item.artist || item.author || "Unknown"),
          album: item.album?.name || item.al || "",
          cover: item.album?.picUrl || item.picUrl || item.pic || "",
          url: item.url || item.playUrl || "",
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
