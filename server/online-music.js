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
import { qqSearch } from "./qq-music-search.js";
import { getQQMusicUrl } from "./qq-music-search.js";

export class OnlineMusicApi {
  /**
   * @param {object} config - 配置
   * @param {import('./lx-plugin-runtime.js').LxPluginRuntime} lxRuntime - LX 插件运行时
   */
  constructor(config, lxRuntime = null) {
    this.config = config;
    this.lxRuntime = lxRuntime;
    this.searchSdk = new MusicSearchSdk();
 // 注册QQ音乐搜索
 this.searchSdk.addProvider("tx", qqSearch);

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

 // 搜索排序：1.关键词匹配度 > 2.原唱优先 > 3.无损音质 > 4.文件大小
 const queryTerms = query.toLowerCase().trim().split(/\s+/);
 const isSingleTerm = queryTerms.length === 1;
 const hasArtistTerm = queryTerms.length >= 2;

 // 关键词匹配得分
 const matchScore = (song) => {
 const artistLower = song.artist.toLowerCase();
 const titleLower = song.title.toLowerCase();
 const albumLower = (song.album || '').toLowerCase();
 let score = 0;
 let artistMatched = false;

 for (const term of queryTerms) {
   if (!term) continue;
   // 标题精确匹配（最重要，搜歌名就是找这首歌）
   if (titleLower === term) score += 1000;
   // 标题包含关键词
   else if (titleLower.includes(term)) score += 200;
   // 歌手名匹配（只有明确搜歌手名时才高分，单关键词时降低权重避免误判）
   if (artistLower === term) { score += (isSingleTerm ? 200 : 1000); artistMatched = true; }
   else if (artistLower.includes(term)) { score += (isSingleTerm ? 50 : 500); artistMatched = true; }
 }

 // 如果用户输入了歌手名关键词，但本歌歌手名不匹配，大幅降权
 if (hasArtistTerm && !artistMatched) {
   score -= 2000;
 }

 // 翻唱/伴奏等降权
 if (/翻唱|cover|伴奏|beat|dj|remix|吉他版|和声版|演唱会|live|纯音乐|女声版|男声版|R&B版/i.test(song.title + song.artist)) {
   score -= 300;
 }
 // 串烧/合集降权
 if (song.title.length > 15 && /[+＋]/.test(song.title)) {
   score -= 500;
 }

 // 原唱信号：专辑名=歌曲名通常是翻唱单曲
 if (albumLower && titleLower && albumLower === titleLower) {
   score -= 50;
 }

 return score;
 };


 // 最高音质得分（无损 > 320k > 128k）—— 取 types 数组中的最高音质
 // 但注意：只有128k的可能是免VIP完整版，有flac/320k的可能是VIP试听
 const qualityScore = (song) => {
 const map = { flac24bit: 400, flac: 300, "320k": 200, "128k": 100 };
 let best = 0;
 if (song.types && song.types.length > 0) {
 for (const t of song.types) {
 const s = map[t.type] || 50;
 if (s > best) best = s;
 }
 }
 return best || 50;
 };

 // 试听风险得分：只有128k的更可能是完整版（+200），有高音质的可能VIP试听（-100）
 // QQ音乐的 isVip 字段提供更精确的判断
 const trialRiskScore = (song) => {
 // QQ音乐直接标记了 isVip
 if (song.isVip === false) return 300; // QQ音乐确认免费，最高优先
 if (song.isVip === true) return -200; // QQ音乐确认VIP

 if (!song.types || song.types.length === 0) return 0;
 const typeNames = song.types.map(t => t.type);
 const hasOnly128k = typeNames.length === 1 && typeNames[0] === '128k';
 if (hasOnly128k) return 200; // 免费层完整版可能性高
 const hasHighQuality = typeNames.some(t => t === 'flac' || t === 'flac24bit' || t === '320k');
 if (hasHighQuality) return -100; // VIP歌曲，可能获取到试听版
 return 0;
 };

 // 文件大小得分（取最高音质的文件大小，越大越好）
 const sizeScore = (song) => {
   const map = { flac24bit: 400, flac: 300, "320k": 200, "128k": 100 };
   let bestSize = "0B";
   let bestQ = 0;
   if (song.types && song.types.length > 0) {
     for (const t of song.types) {
       const q = map[t.type] || 50;
       if (q > bestQ) { bestQ = q; bestSize = t.size || "0B"; }
     }
   }
   const match = bestSize.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
   if (!match) return 0;
   const num = parseFloat(match[1]);
   const unit = match[2].toUpperCase();
   const multiplier = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
   return Math.round((num * (multiplier[unit] || 1)) / 1048576); // MB 为单位
 };

 // 记录原始顺序 + 计算跨平台出现次数（多源出现=热门原唱）
 for (let i = 0; i < displayResults.length; i++) {
   displayResults[i]._originalIndex = i;
 }
 const songAppearMap = {};
 for (const s of displayResults) {
   const key = s.title.toLowerCase().replace(/[\s（）()]/g,'') + '||' + s.artist.toLowerCase().replace(/[\s（）()]/g,'');
   songAppearMap[key] = (songAppearMap[key] || 0) + 1;
 }

 displayResults.sort((a, b) => {
   // 第一优先：关键词匹配度
   const aMatch = matchScore(a);
   const bMatch = matchScore(b);
   if (aMatch !== bMatch) return bMatch - aMatch;

   // 第二优先：原唱优先（跨平台出现次数 + 原始顺序）
   const aKey = a.title.toLowerCase().replace(/[\s（）()]/g,'') + '||' + a.artist.toLowerCase().replace(/[\s（）()]/g,'');
   const bKey = b.title.toLowerCase().replace(/[\s（）()]/g,'') + '||' + b.artist.toLowerCase().replace(/[\s（）()]/g,'');
   const aAppear = songAppearMap[aKey] || 1;
   const bAppear = songAppearMap[bKey] || 1;
   if (aAppear !== bAppear) return bAppear - aAppear; // 多源出现优先

   // 原始顺序（各平台已按热度排好，靠前优先）
   const aOrig = a._originalIndex || 0;
   const bOrig = b._originalIndex || 0;
   if (aOrig !== bOrig) return aOrig - bOrig;

 // 第三优先：试听风险（完整版优先于试听版）
 const aTrial = trialRiskScore(a);
 const bTrial = trialRiskScore(b);
 if (aTrial !== bTrial) return bTrial - aTrial;

 // 第四优先：无损音质
 const aQ = qualityScore(a);
 const bQ = qualityScore(b);
 if (aQ !== bQ) return bQ - aQ;

 // 第五优先：文件大小（同音质下越大越好）
 const aSize = sizeScore(a);
 const bSize = sizeScore(b);
 return bSize - aSize;
 });

 // 清理临时字段
 for (const s of displayResults) {
   delete s._originalIndex;
 }

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
 * @returns {Promise<{url: string, headers: object}>} 播放链接 + 必需的请求头
 */
 async getSongUrl(id, songInfo = {}, quality = "320k") {
 // QQ音乐：直接使用 vkey 接口获取（无需LX插件）
 if (songInfo.source === "tx") {
 console.log(`[OnlineMusicApi] 🎵 QQ音乐直连获取: ${id}/${quality}`);
 try {
 const qqResult = await getQQMusicUrl(id, songInfo.strMediaMid || id, quality);
 if (qqResult.url) {
 return {
 url: qqResult.url,
 headers: {},
 isTrial: qqResult.isTrial,
 actualSize: qqResult.actualSize,
 };
 }
 } catch (e) {
 console.warn(`[OnlineMusicApi] QQ音乐vkey获取失败: ${e.message}`);
 }
 // vkey失败，回退到LX插件
 }

 // 尝试所有音质降级：flac → 320k → 128k
 const qualityOrder = ["flac", "320k", "128k"];
 const startIdx = qualityOrder.indexOf(quality);
 const qualities = startIdx >= 0 ? qualityOrder.slice(startIdx) : [quality, ...qualityOrder.filter(q => q !== quality)];

 let lastTrialResult = null; // 缓存最后一个试听版结果

 for (const q of qualities) {
 try {
 const result = await this._getSongUrlSingle(id, songInfo, q);
 // 试听检测：HEAD 检查实际文件大小
 const trialCheck = await this._checkTrialUrl(result.url, result.headers);
 if (trialCheck.isTrial) {
 console.warn(`[OnlineMusicApi] ⚠️ 试听版检测: ${songInfo.source}/${id} ${q} → ${trialCheck.actualSizeMB.toFixed(1)}MB (预期更大)`);
 result.isTrial = true;
 result.actualSize = trialCheck.actualSize;
 lastTrialResult = result; // 缓存
 // 如果是试听版，尝试下一个音质
 continue;
 }
 result.isTrial = false;
 result.actualSize = trialCheck.actualSize;
 console.log(`[OnlineMusicApi] ✅ 获取播放链接成功: ${songInfo.source}/${id} ${q} → ${trialCheck.actualSizeMB.toFixed(1)}MB`);
 return result;
 } catch (err) {
 console.warn(`[OnlineMusicApi] 获取 ${q} 失败: ${err.message}`);
 }
    }

    // 所有音质都是试听版 → 尝试跨源重试
    const crossSourceResult = await this._crossSourceRetry(id, songInfo);
    if (crossSourceResult) return crossSourceResult;

 // 最终回退：返回缓存中最后一个试听版链接
 if (lastTrialResult) {
 console.warn(`[OnlineMusicApi] ⚠️ 所有音质均为试听版，返回缓存结果: ${songInfo.source}/${id}`);
 return lastTrialResult;
 }
 // 没有缓存，再尝试获取一次128k
 try {
 const lastResult = await this._getSongUrlSingle(id, songInfo, "128k");
 lastResult.isTrial = true;
 try {
 const trialCheck = await this._checkTrialUrl(lastResult.url, lastResult.headers);
 lastResult.actualSize = trialCheck.actualSize;
 } catch {}
 console.warn(`[OnlineMusicApi] ⚠️ 所有音质均为试听版，返回128k: ${songInfo.source}/${id}`);
 return lastResult;
    } catch {}

    throw new Error(`无法获取播放链接: ${songInfo.title || id} (${songInfo.source || "wy"})`);
  }

  /**
   * 单次获取播放链接（不含试听检测）
   */
  async _getSongUrlSingle(id, songInfo = {}, quality = "320k") {
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
        const result = await this.lxRuntime.getMusicUrl(info, quality);
        console.log(`[OnlineMusicApi] ✅ LX Runtime 获取播放链接成功: ${info.source}/${id}`);
        return result;
      } catch (err) {
        console.warn(`[OnlineMusicApi] LX Runtime 失败: ${err.message}，尝试直连回退...`);
      }
    }

    // 回退1：网易云直连（无特殊headers）
    if (songInfo.source === "wy" || (!songInfo.source && this.provider === "wy")) {
      try {
        const url = await this._neteaseDirectUrl(id);
        if (url) return { url, headers: {} };
      } catch {}
    }

    // 回退2：酷我直连（需要token/convert_api）
    if (songInfo.source === "kw") {
      try {
        const url = await this._kuwoDirectUrl(id);
        if (url) return { url, headers: {} };
      } catch {}
    }

    // 回退3：酷狗直连
    if (songInfo.source === "kg") {
      try {
        const url = await this._kugouDirectUrl(id, songInfo.hash);
        if (url) return { url, headers: {} };
      } catch {}
    }

    // 回退4：第三方代理
    try {
      const url = await this._fallbackProxy(id, songInfo.source);
      if (url) return { url, headers: {} };
    } catch {}

    throw new Error(`无法获取播放链接: ${id} (${songInfo.source || "wy"}, ${quality})`);
  }

  /**
   * 试听版检测：HEAD 请求检查文件实际大小
   * 规则：< 300KB 视为试听版（约18秒128k mp3）
   */
  async _checkTrialUrl(url, headers = {}) {
    if (!url) return { isTrial: true, actualSize: 0, actualSizeMB: 0 };
    try {
      const size = await this._headContentSize(url, headers);
      const sizeMB = size / 1024 / 1024;
      return {
        isTrial: size > 0 && size < 300000, // < 300KB = 试听
        actualSize: size,
        actualSizeMB: sizeMB,
      };
    } catch (err) {
      // HEAD 失败时无法判断，假设非试听
      console.warn(`[OnlineMusicApi] HEAD 检测失败: ${err.message}`);
      return { isTrial: false, actualSize: -1, actualSizeMB: -1 };
    }
  }

  /**
   * HEAD 请求获取 Content-Length
   */
  _headContentSize(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const req = lib.request(url, {
        method: "HEAD",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...headers,
        },
        timeout: 8000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, parsedUrl.origin).href;
          resolve(this._headContentSize(nextUrl, headers));
          return;
        }
        if (res.statusCode === 200) {
          const cl = parseInt(res.headers["content-length"] || "0", 10);
          resolve(cl);
        } else {
          reject(new Error(`HEAD ${url} → HTTP ${res.statusCode}`));
        }
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("HEAD timeout")); });
      req.end();
    });
  }

  /**
   * 跨源重试：用相同歌名在不同源搜索并获取完整版
   */
  async _crossSourceRetry(id, songInfo) {
    const title = songInfo.title;
    const artist = songInfo.artist;
    if (!title) return null;

    // 搜索关键词
    const keyword = artist ? `${artist} ${title}` : title;
    const otherSources = ["wy", "kw", "kg"].filter(s => s !== songInfo.source);

    console.log(`[OnlineMusicApi] 🔄 跨源重试: "${keyword}" 在 ${otherSources.join("/")}`);

    try {
      const searchResults = await this.searchSdk.searchMulti(keyword, { limit: 5 });
      // 找同歌名不同源的版本
      const candidates = searchResults.filter(s =>
        String(s.id) !== String(id) &&
        s.source !== songInfo.source &&
        s.title && title &&
        (s.title.includes(title.substring(0, 4)) || title.includes(s.title.substring(0, 4)))
      );

      for (const candidate of candidates.slice(0, 3)) {
        try {
          const result = await this._getSongUrlSingle(candidate.id, {
            ...candidate,
            source: candidate.source,
          }, "320k");
          const trialCheck = await this._checkTrialUrl(result.url, result.headers);
          if (!trialCheck.isTrial && trialCheck.actualSize > 300000) {
            result.isTrial = false;
            result.actualSize = trialCheck.actualSize;
            result.crossSource = candidate.source;
            console.log(`[OnlineMusicApi] ✅ 跨源重试成功: ${candidate.source}/${candidate.id} → ${trialCheck.actualSizeMB.toFixed(1)}MB`);
            return result;
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`[OnlineMusicApi] 跨源重试失败: ${err.message}`);
    }
    return null;
  }

  /**
   * 酷我直连获取播放链接
   */
  async _kuwoDirectUrl(songId) {
    // 方法1: kuwo.cn convert_url3 API
    try {
      const url = `http://www.kuwo.cn/api/v1/www/music/playInfo?mid=${songId}&type=music&httpsStatus=1`;
      const data = await this._fetchJson(url);
      if (data?.data?.url) return data.data.url;
    } catch {}

    // 方法2: kuwo.cn anti 渠道
    try {
      const url = `https://kuwo.cn/api/v1/www/music/playInfo?mid=${songId}&type=convert_url3&httpsStatus=1`;
      const data = await this._fetchJson(url);
      if (data?.data?.url) return data.data.url;
    } catch {}

    return null;
  }

  /**
   * 酷狗直连获取播放链接
   */
  async _kugouDirectUrl(songId, hash = "") {
    if (!hash) return null;
    try {
      // 酷狗需要 hash 获取播放链接
      const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}`;
      const data = await this._fetchJson(url);
      if (data?.data?.play_url) return data.data.play_url;
    } catch {}
    return null;
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
