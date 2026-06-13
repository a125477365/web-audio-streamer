/**
 * 在线音乐 API — 重构后架构
 * 
 * 职责分离（与洛雪音乐完全一致）：
 * - 搜索：委托给 MusicSearchSdk（与洛雪类似，搜索层由应用内置平台接口完成）
 * - 播放链接：委托给 LxPluginRuntime（自定义音源脚本的 musicUrl action）
 * - 本模块只做协调和格式转换
 * 
 * 流程：
 * 1. 用户搜索 → search() → MusicSearchSdk.searchMulti() → 返回标准化歌曲列表
 * 2. 若已安装最新音源，搜索阶段可额外验证可播/非试听并排序
 * 3. 用户播放 → getSongUrl() → LxPluginRuntime.getMusicUrl() → 返回mp3链接
 * 4. 前端拿到mp3链接 → 传给 AudioStreamer 播放
 */

import https from "https";
import http from "http";
import { MusicSearchSdk } from "./music-search-sdk.js";
import { qqSearch } from "./qq-music-search.js";

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
    this.urlCache = new Map();
    this.urlCacheTtlMs = 10 * 60 * 1000;

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

 // 平台可靠性（免费音源解析成功率经验值）：网易云接口最开放最易解析；
 // 酷狗次之；QQ/咪咕需 cookie/地域；酷我高音质多为 VIP 试听，最不易拿到完整版。
 // 用作排序偏置：让"大概率能播"的平台靠前，减少用户点到打不开的几率。
 const platformReliability = { wy: 100, local: 120, kg: 60, mg: 40, tx: 40, kw: 0 };
 const relScore = (s) => platformReliability[s.source] ?? 30;

 displayResults.sort((a, b) => {
   // 第一优先：关键词匹配度（分桶，容忍同等相关下的细微差异）
   const aMatch = matchScore(a);
   const bMatch = matchScore(b);
   // 当两者匹配度接近（同一相关性档位，差距 < 600）时，先按平台可靠性排，
   // 避免"酷我歌手名干净 +500"把不可播的结果顶到网易云可播结果之前。
   if (Math.abs(aMatch - bMatch) < 600) {
     const aRel = relScore(a);
     const bRel = relScore(b);
     if (aRel !== bRel) return bRel - aRel;
   }
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
  const relevant = filtered.filter((song) => this._matchesQuery(song, queryTerms));
  const candidates = relevant.length > 0 ? relevant : filtered;

      const parsedLimit = Number.parseInt(options.limit, 10) || 30;

      if (options.fullOnly === false) {
        return candidates.slice(0, parsedLimit);
      }

      const verifyMode = String(options.verify ?? "").toLowerCase();

      // verify=full/1：严格全量预验证（慢、最准，丢弃不可播）。仅在用户显式要求时用。
      if ((verifyMode === "full" || verifyMode === "1" || options.verify === true) && this._hasLatestSourcePlugins()) {
        return await this._filterPlayableFullResults(candidates, {
          limit: parsedLimit,
          verifyLimit: Number.parseInt(options.verifyLimit, 10) || Math.max(parsedLimit * 2, 24),
          concurrency: Number.parseInt(options.verifyConcurrency, 10) || 8,
          timeBudgetMs: Number.parseInt(options.verifyTimeBudgetMs, 10) || 12000,
          fallbackCandidates: candidates,
        });
      }

      // verify=light：轻量探测重排（对前若干条单次解析+HEAD，不降级/不跨源）。
      // 注意：免费音源多为单一可用源且限流严重，验证本身会刷爆配额导致随后播放失败，
      // 故不作为默认。仅在显式 verify=light 时启用。
      if (verifyMode === "light" && this._hasLatestSourcePlugins()) {
        return await this._lightReorderByPlayable(candidates, parsedLimit);
      }

      // 默认：搜索零网络调用、瞬时返回。可播放性由排序里的平台可靠性偏置 + 元数据提示体现，
      // 真正解析留到点播放时（getSongUrl：音质降级 + 跨源回退 + URL 校验），
      // 把稀缺的音源配额全部留给单首播放，避免搜索阶段的批量验证把它耗尽。
      return candidates.slice(0, parsedLimit);
    } catch (error) {
      console.error("[OnlineMusicApi] 搜索失败:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  _matchesQuery(song, queryTerms) {
    const terms = (queryTerms || []).filter(Boolean);
    if (terms.length === 0) return true;
    const haystack = `${song.title || ""} ${song.artist || ""} ${song.album || ""}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  }

  /**
   * 快速可播放探测：单次解析 + HEAD 试听检测，不做音质降级/跨源回退（失败即止）。
   * 用于搜索阶段轻量重排，必须快——慢的全量回退留给真正点播放时的 getSongUrl。
   * @returns {Promise<boolean|null>} true=可播放完整版, false=试听/失败, null=异常无法判断
   */
  async _quickPlayableProbe(song) {
    try {
      const quality = this._desiredVerifyQuality(song);
      const result = this._normalizeSongUrlResult(await this._getSongUrlSingle(song.id, song, quality));
      if (!result?.url) return false;
      const trial = await this._checkTrialUrl(result.url, result.headers);
      if (trial.actualSize === -1) return null; // HEAD 失败，无法判断
      return !trial.isTrial;
    } catch {
      return false;
    }
  }

  /**
   * 轻量重排：对前若干条候选做快速探测，把确认可播放的排到最前（稳定排序，不丢弃任何结果）。
   * 受总时间预算约束，超时则返回当前已探测结果 + 其余按原序。
   */
  async _lightReorderByPlayable(candidates, limit, options = {}) {
    const probeCount = Math.min(candidates.length, Math.max(limit, 10));
    const toProbe = candidates.slice(0, probeCount);
    const rest = candidates.slice(probeCount);
    const concurrency = options.concurrency || 3;
    const deadline = Date.now() + (options.timeBudgetMs || 8000);

    let cursor = 0;
    const flags = new Map();
    const worker = async () => {
      while (cursor < toProbe.length && Date.now() < deadline) {
        const song = toProbe[cursor++];
        flags.set(song, await this._quickPlayableProbe(song));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toProbe.length || 1) }, () => worker()));

    for (const song of toProbe) {
      const f = flags.get(song);
      if (f === true) { song.playable = true; song.isTrial = false; }
      else if (f === false) { song.playable = false; song.isTrial = true; }
      // null / 未探测：保持 undefined，前端按元数据给提示
    }

    // 稳定排序：确认可播放(0) > 未知(1) > 确认不可播(2)，同级保持原序
    const rank = (s) => (s.playable === true ? 0 : s.playable === false ? 2 : 1);
    const ordered = toProbe
      .map((s, i) => [s, i])
      .sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1]))
      .map((x) => x[0]);

    return [...ordered, ...rest].slice(0, limit);
  }

  _hasLatestSourcePlugins() {
    return Boolean(this.lxRuntime && Array.isArray(this.lxRuntime.plugins) && this.lxRuntime.plugins.length > 0);
  }

  _qualityRank(type = "") {
    const normalized = String(type || "").toLowerCase();
    const map = { flac24bit: 5, flac: 4, ape: 4, wav: 4, "320k": 3, "128k": 1 };
    return map[normalized] || 0;
  }

  _bestQualityRank(song = {}) {
    let best = this._qualityRank(song.resolvedQuality || song.quality || "");
    for (const item of song.types || []) {
      best = Math.max(best, this._qualityRank(item?.type));
    }
    return best;
  }

  _parseSizeToBytes(sizeText) {
    if (typeof sizeText === "number" && Number.isFinite(sizeText)) return sizeText;
    const match = String(sizeText || "").match(/([\d.]+)\s*(B|KB|K|MB|M|GB|G)/i);
    if (!match) return 0;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = match[2].toUpperCase();
    const multiplier = { B: 1, K: 1024, KB: 1024, M: 1024 ** 2, MB: 1024 ** 2, G: 1024 ** 3, GB: 1024 ** 3 };
    return Math.round(value * (multiplier[unit] || 1));
  }

  _bestDeclaredSize(song = {}) {
    let best = 0;
    for (const item of song.types || []) {
      best = Math.max(best, this._parseSizeToBytes(item?.size));
    }
    return best;
  }

  _verifiedSize(song = {}) {
    const actual = Number(song.actualSize || 0);
    if (Number.isFinite(actual) && actual > 0) return actual;
    return this._bestDeclaredSize(song);
  }

  _desiredVerifyQuality(song = {}) {
    const best = this._bestQualityRank(song);
    if (best >= 4) return "flac";
    if (best >= 3) return "320k";
    return "128k";
  }

  _isStrongCandidate(song = {}) {
    return this._bestQualityRank(song) >= 4 && this._verifiedSize(song) > 0;
  }

  _sortPlayableResults(results = []) {
    // 保留 search() 已计算好的相关性排序（_rankIndex）。
    // 验证阶段只负责过滤掉试听版，不按音质重排——否则高音质翻唱会盖过原唱。
    // search() 的排序已综合了：关键词匹配 > 原唱优先 > 完整版 > 无损 > 文件大小。
    return [...results].sort((a, b) => (a._rankIndex || 0) - (b._rankIndex || 0));
  }

  async _filterPlayableFullResults(results, options = {}) {
    const limit = options.limit || 30;
    const verifyLimit = options.verifyLimit || Math.max(limit * 3, 60);
    const concurrency = Math.max(1, options.concurrency || 6);
    const timeBudgetMs = options.timeBudgetMs || 12000;
    const deadline = Date.now() + timeBudgetMs;
    const candidates = results
      .map((song, index) => ({ ...song, _rankIndex: index }))
      .filter((song) => song && song.id && song.title && song.artist && song.source)
      .slice(0, verifyLimit);
    const accepted = [];
    const batchSize = Math.max(limit, 12);

    const verifyBatch = async (batch) => {
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          if (Date.now() > deadline) return; // 超出时间预算，停止验证
          const song = batch[cursor++];
          try {
            const quality = this._desiredVerifyQuality(song);
            const result = await this.getSongUrl(song.id, song, quality, { allowTrial: false, skipCrossSource: true });
            if (!result?.url || result.isTrial) { song._verifiedTrial = true; continue; }
            accepted.push({
              ...song,
              playable: true,
              isTrial: false,
              actualSize: result.actualSize || this._bestDeclaredSize(song) || -1,
              resolvedQuality: result.quality || quality,
              crossSource: result.crossSource || null,
            });
          } catch (err) {
            // 明确是试听版 → 标记排除；其他失败（网络/解析）保留为未验证，仍展示
            if (/试听/.test(err.message || "")) song._verifiedTrial = true;
            console.warn(`[OnlineMusicApi] 跳过不可播放/试听结果: ${song.source}/${song.id} ${song.title} - ${err.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length || 1) }, () => worker()));
    };

    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      await verifyBatch(candidates.slice(offset, offset + batchSize));
      const topResults = this._sortPlayableResults(accepted).slice(0, limit);
      const strongCount = topResults.filter((song) => this._isStrongCandidate(song)).length;
      if (topResults.length >= limit && (strongCount >= Math.min(3, limit) || offset + batchSize >= candidates.length)) {
        break;
      }
      if (Date.now() > deadline) {
        console.warn(`[OnlineMusicApi] 验证超出时间预算(${timeBudgetMs}ms)，已验证 ${accepted.length} 首，其余返回未验证候选`);
        break;
      }
    }

    // 已验证为完整版的歌曲（按 source:id 建索引）
    const acceptedByKey = new Map(accepted.map((s) => [`${s.source}:${s.id}`, s]));

    // 按原始相关性顺序（candidates 已是 _rankIndex 升序）输出：
    // - 验证为完整版 → 用验证结果（含 actualSize/resolvedQuality）
    // - 验证确认为试听版（_verifiedTrial）→ 排除
    // - 未验证（时间预算内没轮到）→ 标记 unverified，播放时再做试听检测+跨源重试
    const output = [];
    for (const song of candidates) {
      if (output.length >= limit) break;
      const key = `${song.source}:${song.id}`;
      const full = acceptedByKey.get(key);
      if (full) {
        output.push(full);
      } else if (song._verifiedTrial) {
        continue; // 验证确认为试听版，排除
      } else {
        output.push({ ...song, playable: null, isTrial: null, unverified: true });
      }
    }

    return output.map(({ _rankIndex, _verifiedTrial, ...song }) => song);
  }

  // ==========================================================
  // 播放链接获取 — 委托给 LxPluginRuntime
  // ==========================================================

  /**
   * 获取歌曲播放链接
   * 
   * 使用 LX Runtime（多插件并发），不走平台直连兜底。
   * 
   * @param {string} id - 歌曲ID (songmid)
   * @param {object} songInfo - 歌曲完整信息
   * @param {string} quality - 音质 (128k/320k/flac)
 * @returns {Promise<{url: string, headers: object}>} 播放链接 + 必需的请求头
 */
 async getSongUrl(id, songInfo = {}, quality = "320k", options = {}) {
 if (!this.lxRuntime || this.lxRuntime.plugins.length === 0) {
 throw new Error("尚未安装最新音源，请先在设置中执行“搜索最新音源”并成功加载后再播放");
 }
 const allowTrial = options.allowTrial === true;
 const cacheKey = this._urlCacheKey(id, songInfo, quality);
 const cached = this._getCachedUrl(cacheKey);
 if (cached && (allowTrial || !cached.isTrial)) {
 return cached;
 }
 // 尝试所有音质降级：flac → 320k → 128k
 const qualityOrder = ["flac", "320k", "128k"];
 const startIdx = qualityOrder.indexOf(quality);
 const qualities = startIdx >= 0 ? qualityOrder.slice(startIdx) : [quality, ...qualityOrder.filter(q => q !== quality)];

 let lastTrialResult = null; // 缓存最后一个试听版结果

 for (const q of qualities) {
 try {
  const result = this._normalizeSongUrlResult(await this._getSongUrlSingle(id, songInfo, q));
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
 result.quality = q;
 result.actualSize = trialCheck.actualSize;
 this._setCachedUrl(this._urlCacheKey(id, songInfo, q), result);
 this._setCachedUrl(cacheKey, result);
 console.log(`[OnlineMusicApi] ✅ 获取播放链接成功: ${songInfo.source}/${id} ${q} → ${trialCheck.actualSizeMB.toFixed(1)}MB`);
 return result;
 } catch (err) {
 console.warn(`[OnlineMusicApi] 获取 ${q} 失败: ${err.message}`);
 }
    }

    // 所有音质都是试听版 → 尝试跨源重试（批量验证时跳过，避免每首歌触发全平台搜索拖慢响应）
    if (!options.skipCrossSource) {
      const crossSourceResult = await this._crossSourceRetry(id, songInfo);
      if (crossSourceResult) {
        this._setCachedUrl(cacheKey, crossSourceResult);
        return crossSourceResult;
      }
    }

 // 最终回退：返回缓存中最后一个试听版链接
 if (lastTrialResult) {
 if (!allowTrial) {
 throw new Error(`所有音质均为试听版: ${songInfo.title || id} (${songInfo.source || "wy"})`);
 }
 console.warn(`[OnlineMusicApi] ⚠️ 所有音质均为试听版，返回缓存结果: ${songInfo.source}/${id}`);
 return lastTrialResult;
 }
 // 没有缓存，再尝试获取一次128k
 try {
 const lastResult = await this._getSongUrlSingle(id, songInfo, "128k");
 lastResult.isTrial = true;
 if (!allowTrial) {
 throw new Error(`仅获取到试听链接: ${songInfo.title || id} (${songInfo.source || "wy"})`);
 }
 try {
 const trialCheck = await this._checkTrialUrl(lastResult.url, lastResult.headers);
 lastResult.actualSize = trialCheck.actualSize;
 } catch {}
 console.warn(`[OnlineMusicApi] ⚠️ 所有音质均为试听版，返回128k: ${songInfo.source}/${id}`);
 return lastResult;
    } catch {}

    throw new Error(`无法获取播放链接: ${songInfo.title || id} (${songInfo.source || "wy"})`);
  }

  _urlCacheKey(id, songInfo = {}, quality = "320k") {
    return [
      songInfo.source || "wy",
      id || songInfo.id || songInfo.songmid || "",
      songInfo.title || "",
      songInfo.artist || "",
      songInfo.hash || "",
      songInfo.strMediaMid || "",
      quality || "320k",
    ].join("|");
  }

  _getCachedUrl(key) {
    const cached = this.urlCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > this.urlCacheTtlMs) {
      this.urlCache.delete(key);
      return null;
    }
    return { ...cached.value };
  }

  _setCachedUrl(key, value) {
    if (!value?.url) return;
    this.urlCache.set(key, {
      cachedAt: Date.now(),
      value: { ...value },
    });
  }

  /**
   * 单次获取播放链接（不含试听检测）
   */
  async _getSongUrlSingle(id, songInfo = {}, quality = "320k") {
    if (!this.lxRuntime || this.lxRuntime.plugins.length === 0) {
      throw new Error("尚未安装最新音源，请先在设置中执行“搜索最新音源”并成功加载后再播放");
    }

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
      const result = this._normalizeSongUrlResult(await this.lxRuntime.getMusicUrl(info, quality));
      console.log(`[OnlineMusicApi] ✅ LX Runtime 获取播放链接成功: ${info.source}/${id}`);
      return result;
    } catch (err) {
      throw new Error(`最新音源未能获取播放链接: ${err.message}`);
    }

  }

  _normalizeSongUrlResult(result = {}) {
    if (!result?.url) return result;
    return {
      ...result,
      headers: this._normalizeMediaHeaders(result.headers || {}, result.url),
    };
  }

  _normalizeMediaHeaders(headers = {}, url = "") {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (value === undefined || value === null || value === "") continue;
      normalized[key] = String(value);
    }
    const hasHeader = (name) => Object.keys(normalized).some((key) => key.toLowerCase() === name.toLowerCase());
    if (!hasHeader("User-Agent")) {
      normalized["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    }
    if (!hasHeader("Accept")) {
      normalized.Accept = "*/*";
    }
    if (!hasHeader("Connection")) {
      normalized.Connection = "keep-alive";
    }
    if (!hasHeader("Referer") && url) {
      try {
        const parsed = new URL(url);
        if (/qq\.com|gtimg\.com|kuwo\.cn|kugou\.com|music\.163\.com|126\.net/i.test(parsed.hostname)) {
          normalized.Referer = `${parsed.protocol}//${parsed.hostname}/`;
        }
      } catch {}
    }
    return normalized;
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
        isTrial: size > 0 && size < 1024 * 1024, // < 1MB usually means a short preview clip.
        actualSize: size,
        actualSizeMB: sizeMB,
      };
    } catch (err) {
      // HEAD 失败时无法判断，假设非试听
      console.warn(`[OnlineMusicApi] HEAD 检测失败: ${err.message}`);
      return { isTrial: true, actualSize: -1, actualSizeMB: -1 };
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
      const searchResults = MusicSearchSdk.toDisplayFormat(await this.searchSdk.searchMulti(keyword, { limit: 5 }));
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
          if (!trialCheck.isTrial && (trialCheck.actualSize < 0 || trialCheck.actualSize >= 1024 * 1024)) {
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
