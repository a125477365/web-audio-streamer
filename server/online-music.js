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

// Always use Netease Direct for search - it's free and always available
const NETEASE_SEARCH_URL = "https://music.163.com/api/search/get/";

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

    // Meting.js with type=name (for song name search)
    if (style === "meting-name" || style === "meting-play") {
      if (action === "search") {
        // Use type=name for searching by song name
        applyValue(urlObj, keywordParams, value);
        if (!urlObj.searchParams.has("server")) {
          urlObj.searchParams.set("server", this.provider);
        }
        if (!urlObj.searchParams.has("type")) {
          urlObj.searchParams.set("type", "name");
        }
        return urlObj.toString();
      } else {
        // Use type=url for getting play URL
        applyValue(urlObj, idParams, value);
        if (!urlObj.searchParams.has("server")) {
          urlObj.searchParams.set("server", this.provider);
        }
        if (!urlObj.searchParams.has("type")) {
          urlObj.searchParams.set("type", action);
        }
        if (auth) urlObj.searchParams.set("auth", auth);
        return urlObj.toString();
      }
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
      // Always use Netease Direct for search - it's free and always works
      const searchUrl = `${NETEASE_SEARCH_URL}?s=${encodeURIComponent(query)}&type=1&limit=30`;
      const data = await this._fetchJson(searchUrl);

      const rawResults = Array.isArray(data)
        ? data
        : (data?.result?.songs || []);
      if (!Array.isArray(rawResults)) {
        return {
          success: false,
          error: "Search returned an unexpected payload",
        };
      }

      // If we have a configured source for play URL resolution, validate the first few results
      const hasPlayUrlSource = this.source?.searchUrl;

      const songs = await Promise.all(
        rawResults.map(async (item, index) => {
          const songId = item.id || `unknown_${index}`;
          const artistName = Array.isArray(item.artists)
            ? item.artists.map((a) => a.name || a).join(", ")
            : (item.artist || item.author || item.singer || "Unknown");
          const albumName = item.album?.name || item.al || "";
          const coverUrl = item.album?.picUrl || item.picUrl || "";
          const duration = item.duration ? item.duration / 1000 : null;

          let playUrl = "";
          if (hasPlayUrlSource) {
            try {
              playUrl = await this._resolvePlayUrlFromSource(songId, item.name || query);
            } catch {}
          }

          return {
            id: String(songId),
            title: item.name || "Unknown",
            artist: artistName,
            album: albumName,
            cover: coverUrl,
            playUrl,
            duration: duration,
            durationMs: item.duration || null,
            size: item.size || null,
            sizeText: item.size
              ? `${Math.round((item.size / 1024 / 1024) * 10) / 10}MB`
              : null,
            qualityScore: item.qualityScore || 50,
          };
        })
      );

      // Filter out very short previews (< 90s)
      return songs.filter((song) => {
        if (!song.duration) return true;
        return !(song.duration > 0 && song.duration < 90);
      });
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Resolve a playable URL using the configured source (e.g., Injahow Meting API)
   */
  async _resolvePlayUrlFromSource(songId, songTitle) {
    if (!this.source?.searchUrl) return "";

    const baseUrl = this.source.searchUrl;
    const style = this.source.requestStyle || "server";
    const auth = this._generateAuth(String(songId), "url");

    // Try multiple URL formats
    const urls = [
      `${baseUrl}?server=netease&type=url&id=${songId}&auth=${auth}`,
      `${baseUrl}?server=netease&type=url&id=${songId}`,
      `${baseUrl}?media=netease&type=url&id=${songId}`,
      `${baseUrl}?type=url&id=${songId}`,
    ];

    for (const url of urls) {
      try {
        const redirectUrl = await this._getRedirectUrl(url);
        if (redirectUrl) return redirectUrl;
      } catch {}
    }

    return "";
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
    });
  }

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      lib.get(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
