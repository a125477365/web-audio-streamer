/**
 * Music Search SDK — 独立的音乐搜索模块
 * 
 * 架构对齐洛雪音乐 musicSdk：
 * - 搜索由客户端内置实现，不依赖 JS 音源插件
 * - 每个平台（网易云/酷我/酷狗）独立实现搜索API
 * - 搜索结果标准化为统一格式
 * - 播放链接获取由 LxPluginRuntime 负责（不在本模块）
 * 
 * 与洛雪的关键区别：
 * - 洛雪运行在浏览器端，使用 httpFetch（基于 XMLHttpRequest）
 * - 我们运行在 Node.js 端，使用原生 http/https
 * - 洛雪的网易云搜索使用 eapi 加密，我们用开放的 API
 */

import https from "https";
import http from "http";
import crypto from "crypto";

// ============================================================
// 工具函数
// ============================================================

const formatPlayTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
};

const sizeFormate = (bytes) => {
  if (!bytes || isNaN(bytes)) return "0B";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
};

const decodeName = (str) => {
  if (typeof str !== "string") return String(str || "");
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
};

// ============================================================
// 通用 HTTP 请求
// ============================================================

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    // 不再二次编码：调用方已用 encodeURIComponent 处理查询参数
    // encodeURI 会把 %XX 再次编码为 %25XX，导致双重编码 bug
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: options.accept || "*/*",
        Referer: options.referer || "",
        ...options.headers,
      },
      timeout: options.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ body: JSON.parse(raw), statusCode: res.statusCode, headers: res.headers });
        } catch {
          resolve({ body: raw, statusCode: res.statusCode, headers: res.headers });
        }
      });
    }).on("error", reject)
      .on("timeout", function () { this.destroy(); reject(new Error("Request timeout")); });
  });
}

function httpPost(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    // 不再二次编码，同 httpGet
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const postData = typeof body === "string" ? body : JSON.stringify(body);

    const req = lib.request(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": options.contentType || "application/json",
        "Content-Length": Buffer.byteLength(postData),
        Referer: options.referer || "",
        ...options.headers,
      },
      timeout: options.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ body: JSON.parse(raw), statusCode: res.statusCode, headers: res.headers });
        } catch {
          resolve({ body: raw, statusCode: res.statusCode, headers: res.headers });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(postData);
    req.end();
  });
}

// ============================================================
// 网易云音乐搜索 (wy)
// ============================================================

const wySearch = {
  name: "网易音乐",
  id: "wy",

  /**
   * 网易云搜索 — 使用官方开放 API
   * 洛雪用 eapi 加密，我们用 /api/search/get 开放接口
   */
  async search(str, page = 1, limit = 30) {
    const offset = (page - 1) * limit;

    // 方案1：网易云开放搜索API
    const url = `https://music.163.com/api/search/get/?s=${encodeURIComponent(str)}&type=1&limit=${limit}&offset=${offset}`;

    try {
      const { body, statusCode } = await httpGet(url, {
        referer: "https://music.163.com",
      });

      if (statusCode !== 200 || body?.code !== 200) {
        throw new Error(`网易云搜索失败: code=${body?.code}, status=${statusCode}`);
      }

      const songs = body?.result?.songs || [];
      if (songs.length === 0) return { list: [], total: 0, source: "wy" };

      const list = songs.map((item) => {
        const types = [];
        const _types = {};

        // 解析可用音质
        if (item.privilege) {
          switch (item.privilege.maxbr) {
            case 999000:
              types.push({ type: "flac", size: sizeFormate(item.sq?.size) });
              _types.flac = { size: sizeFormate(item.sq?.size) };
            case 320000:
              types.push({ type: "320k", size: sizeFormate(item.h?.size) });
              _types["320k"] = { size: sizeFormate(item.h?.size) };
            case 192000:
            case 128000:
              types.push({ type: "128k", size: sizeFormate(item.l?.size) });
              _types["128k"] = { size: sizeFormate(item.l?.size) };
          }
          if (item.privilege.maxBrLevel === "hires") {
            types.push({ type: "flac24bit", size: sizeFormate(item.hr?.size) });
            _types.flac24bit = { size: sizeFormate(item.hr?.size) };
          }
        }
        types.reverse();

        return {
          singer: Array.isArray(item.artists)
            ? item.artists.map((a) => a.name || a).join("、")
            : (item.artist || ""),
          name: item.name || "",
          albumName: item.album?.name || "",
          albumId: item.album?.id || "",
          source: "wy",
          interval: formatPlayTime(item.duration ? item.duration / 1000 : 0),
          songmid: String(item.id),
          img: item.album?.picUrl || "",
          lrc: null,
          types,
          _types,
          typeUrl: {},
        };
      });

      return {
        list,
        total: body.result.songCount || 0,
        source: "wy",
      };
    } catch (err) {
      console.warn(`[MusicSearchSdk:wy] 搜索失败: ${err.message}`);
      return { list: [], total: 0, source: "wy", error: err.message };
    }
  },
};

// ============================================================
// 酷我音乐搜索 (kw)
// ============================================================

const kwSearch = {
  name: "酷我音乐",
  id: "kw",

  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/,
  },

  /**
   * 酷我搜索 — 与洛雪完全一致的API
   * http://search.kuwo.cn/r.s?client=kt&all=...&pn=...&rn=...
   */
  async search(str, page = 1, limit = 30) {
    const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;

    try {
      const { body } = await httpGet(url);

      if (!body || (body.TOTAL !== "0" && body.SHOW === "0")) {
        throw new Error("酷我搜索返回空结果");
      }

      const rawData = body.abslist || [];
      const list = this.handleResult(rawData);

      return {
        list,
        total: parseInt(body.TOTAL) || 0,
        source: "kw",
      };
    } catch (err) {
      console.warn(`[MusicSearchSdk:kw] 搜索失败: ${err.message}`);
      return { list: [], total: 0, source: "kw", error: err.message };
    }
  },

  handleResult(rawData) {
    const result = [];
    if (!rawData) return result;

    for (const info of rawData) {
      const songId = (info.MUSICRID || "").replace("MUSIC_", "");
      if (!songId) continue;

      const types = [];
      const _types = {};

      // 解析音质信息（N_MINFO 字段）
      if (info.N_MINFO) {
        const infoArr = info.N_MINFO.split(";");
        for (const mInfoStr of infoArr) {
          const match = mInfoStr.match(this.regExps.mInfo);
          if (match) {
            switch (match[2]) {
              case "4000":
                types.push({ type: "flac24bit", size: match[4] });
                _types.flac24bit = { size: match[4] };
                break;
              case "2000":
                types.push({ type: "flac", size: match[4] });
                _types.flac = { size: match[4] };
                break;
              case "320":
                types.push({ type: "320k", size: match[4] });
                _types["320k"] = { size: match[4] };
                break;
              case "128":
                types.push({ type: "128k", size: match[4] });
                _types["128k"] = { size: match[4] };
                break;
            }
          }
        }
      }
      types.reverse();

      const interval = parseInt(info.DURATION);
      result.push({
        name: decodeName(info.SONGNAME),
        singer: decodeName(info.ARTIST),
        source: "kw",
        songmid: songId,
        albumId: decodeName(info.ALBUMID || ""),
        interval: Number.isNaN(interval) ? "0:00" : formatPlayTime(interval),
        albumName: info.ALBUM ? decodeName(info.ALBUM) : "",
        lrc: null,
        img: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {},
      });
    }

    return result;
  },
};

// ============================================================
// 酷狗音乐搜索 (kg)
// ============================================================

const kgSearch = {
  name: "酷狗音乐",
  id: "kg",

  /**
   * 酷狗搜索 — 与洛雪完全一致的API
   * https://songsearch.kugou.com/song_search_v2?keyword=...&page=...&pagesize=...
   */
  async search(str, page = 1, limit = 30) {
    const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;

    try {
      const { body } = await httpGet(url);

      if (!body || body.error_code !== 0) {
        throw new Error(`酷狗搜索失败: error_code=${body?.error_code}`);
      }

      const list = this.handleResult(body.data?.lists || []);

      return {
        list,
        total: body.data?.total || 0,
        source: "kg",
      };
    } catch (err) {
      console.warn(`[MusicSearchSdk:kg] 搜索失败: ${err.message}`);
      return { list: [], total: 0, source: "kg", error: err.message };
    }
  },

  filterData(rawData) {
    const types = [];
    const _types = {};

    if (rawData.FileSize !== 0) {
      const size = sizeFormate(rawData.FileSize);
      types.push({ type: "128k", size, hash: rawData.FileHash });
      _types["128k"] = { size, hash: rawData.FileHash };
    }
    if (rawData.HQFileSize !== 0) {
      const size = sizeFormate(rawData.HQFileSize);
      types.push({ type: "320k", size, hash: rawData.HQFileHash });
      _types["320k"] = { size, hash: rawData.HQFileHash };
    }
    if (rawData.SQFileSize !== 0) {
      const size = sizeFormate(rawData.SQFileSize);
      types.push({ type: "flac", size, hash: rawData.SQFileHash });
      _types.flac = { size, hash: rawData.SQFileHash };
    }
    if (rawData.ResFileSize !== 0) {
      const size = sizeFormate(rawData.ResFileSize);
      types.push({ type: "flac24bit", size, hash: rawData.ResFileHash });
      _types.flac24bit = { size, hash: rawData.ResFileHash };
    }

    const singerName = Array.isArray(rawData.Singers)
      ? rawData.Singers.map((s) => s.name).join("、")
      : (rawData.SingerName || "");

    return {
      singer: decodeName(singerName),
      name: decodeName(rawData.SongName),
      albumName: decodeName(rawData.AlbumName),
      albumId: rawData.AlbumID,
      songmid: rawData.Audioid || rawData.FileHash,
      source: "kg",
      interval: formatPlayTime(rawData.Duration),
      _interval: rawData.Duration,
      img: null,
      lrc: null,
      otherSource: null,
      hash: rawData.FileHash,
      types,
      _types,
      typeUrl: {},
    };
  },

  handleResult(rawData) {
    const ids = new Set();
    const list = [];

    rawData.forEach((item) => {
      const key = (item.Audioid || "") + (item.FileHash || "");
      if (ids.has(key)) return;
      ids.add(key);

      list.push(this.filterData(item));

      // 酷狗搜索结果包含 Grp（同歌不同版本）
      if (Array.isArray(item.Grp)) {
        for (const childItem of item.Grp) {
          const childKey = (childItem.Audioid || "") + (childItem.FileHash || "");
          if (ids.has(childKey)) continue;
          ids.add(childKey);
          list.push(this.filterData(childItem));
        }
      }
    });

    return list;
  },
};

// ============================================================
// Music Search SDK — 主入口
// ============================================================

export class MusicSearchSdk {
  constructor() {
    this.providers = { wy: wySearch, kw: kwSearch, kg: kgSearch };
    this.defaultProvider = "wy";
  }

  /**
   * 单平台搜索
   * @param {string} query - 搜索关键词
   * @param {object} options - { limit, page, source }
   * @returns {Promise<{list: Array, total: number, source: string}>}
   */
  async search(query, options = {}) {
    const { limit = 30, page = 1, source } = options;
    const providerKey = source || this.defaultProvider;
    const provider = this.providers[providerKey];

    if (!provider) {
      throw new Error(`不支持的搜索平台: ${providerKey}`);
    }

    return provider.search(query, page, limit);
  }

  /**
   * 多平台并行搜索（与洛雪 musicSdk.searchMusic 一致）
   * 同时搜索 网易云 + 酷我 + 酷狗，结果合并去重
   * 
   * @param {string} query - 搜索关键词
   * @param {object} options - { limit }
   * @returns {Promise<Array>} 合并后的标准化歌曲列表
   */
  async searchMulti(query, options = {}) {
    const { limit = 20 } = options;

    const tasks = Object.values(this.providers).map((provider) =>
      provider.search(query, 1, limit).catch((err) => {
        console.warn(`[MusicSearchSdk] ${provider.name} 搜索失败: ${err.message}`);
        return { list: [], total: 0, source: provider.id };
      })
    );

    const results = await Promise.all(tasks);

    // 合并所有平台的结果
    const allSongs = [];
    const seen = new Set();

    for (const result of results) {
      if (!result.list || result.list.length === 0) continue;

      for (const song of result.list) {
        // 去重：同一平台同一歌曲只保留一次
        const key = `${song.source}:${song.songmid}`;
        if (seen.has(key)) continue;
        seen.add(key);

        allSongs.push(song);
      }
    }

    return allSongs;
  }

  /**
   * 将洛雪格式的搜索结果转为前端显示格式
   * { singer, name, albumName, songmid, source, interval, img, types }
   * →
   * { id, songmid, title, artist, album, cover, duration, source, sourceName, types, qualityScore }
   */
  static toDisplayFormat(lxSongList) {
    const sourceNames = {
      wy: "网易云音乐",
      kw: "酷我音乐",
      kg: "酷狗音乐",
      tx: "QQ音乐",
      mg: "咪咕音乐",
    };

    return lxSongList.map((song) => {
      // 计算时长秒数
      let duration = 0;
      if (song._interval) {
        duration = song._interval;
      } else if (song.interval) {
        const parts = String(song.interval).split(":");
        if (parts.length === 2) {
          duration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        } else if (parts.length === 3) {
          duration = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        }
      }

      // 计算最高可用音质
      const bestType = song.types?.[0]?.type || "128k";
      const qualityMap = { flac24bit: 95, flac: 85, "320k": 70, "128k": 50 };
      const qualityScore = qualityMap[bestType] || 50;

      return {
        id: String(song.songmid),
        songmid: String(song.songmid),
        title: song.name || "",
        artist: song.singer || "",
        album: song.albumName || "",
        albumId: song.albumId || "",
        cover: song.img || "",
        duration,
        durationMs: duration * 1000,
        source: song.source,
        sourceName: sourceNames[song.source] || song.source,
        qualityScore,
        types: song.types || [],
        _types: song._types || {},
        hash: song.hash || "",  // 酷狗需要 hash
        playUrl: "", // 延迟到播放时获取
      };
    });
  }

  /**
   * 获取可用平台列表
   */
  getProviders() {
    return Object.values(this.providers).map((p) => ({
      id: p.id,
      name: p.name,
    }));
  }

  /**
   * 检查指定平台是否可用
   */
  hasProvider(sourceId) {
    return !!this.providers[sourceId];
  }
}

export default MusicSearchSdk;
