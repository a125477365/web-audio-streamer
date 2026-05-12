/**
 * QQ音乐搜索模块 — 直接调用QQ音乐公开API
 * 
 * 使用 c.y.qq.com 的搜索接口，无需Cookie
 * 搜索结果包含 pay.payplay 字段，可区分免费/VIP歌曲
 * 免费(payplay=0)歌曲可通过 vkey 接口获取完整版链接
 */
import https from "https";

// ============================================================
// QQ音乐搜索实现
// ============================================================

const qqSearch = {
 id: "tx",
 name: "QQ音乐",

 /**
  * 搜索QQ音乐（直接调用公开API）
  * @param {string} query - 搜索关键词
  * @param {number} page - 页码(1-based)
  * @param {number} limit - 每页数量
  * @returns {Promise<{list: Array, total: number, source: string}>}
  */
 async search(query, page = 1, limit = 30) {
 try {
 const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&p=${page}&n=${limit}&cr=1`;
 const data = await _httpGet(url, { Referer: "https://y.qq.com/" });
 
 const songList = data?.data?.song?.list || [];
 const total = data?.data?.song?.totalnum || songList.length;

 const list = songList.map((song) => {
 const types = [];
 if (song.size128 > 0) types.push({ type: "128k", size: _formatSize(song.size128), hash: song.media_mid || song.strMediaMid });
 if (song.size320 > 0) types.push({ type: "320k", size: _formatSize(song.size320), hash: song.media_mid || song.strMediaMid });
 if (song.sizeflac > 0) types.push({ type: "flac", size: _formatSize(song.sizeflac), hash: song.media_mid || song.strMediaMid });
 if (song.sizeape > 0) types.push({ type: "ape", size: _formatSize(song.sizeape), hash: song.media_mid || song.strMediaMid });
 if (types.length === 0) types.push({ type: "128k", size: "", hash: song.media_mid || song.strMediaMid });

 const isVip = song.pay?.payplay === 1;

 return {
 id: String(song.songmid || song.songid),
 songmid: song.songmid,
 strMediaMid: song.strMediaMid || song.media_mid,
 source: "tx",
 title: _stripHighlight(song.songname || ""),
 artist: (song.singer || []).map((s) => s.name).join("/"),
 album: _stripHighlight(song.albumname || ""),
 albumId: song.albummid || "",
 duration: song.interval || 0,
 types,
 isVip,
 };
 });

 return { list, total, source: "tx" };
 } catch (err) {
 console.warn(`[QQSearch] 搜索失败: ${err.message}`);
 return { list: [], total: 0, source: "tx" };
 }
 },
};

/**
 * 获取QQ音乐播放链接(vkey)
 * @param {string} songmid - 歌曲mid
 * @param {string} strMediaMid - 媒体mid
 * @param {string} quality - 音质 128k/320k/flac
 * @returns {Promise<{url: string, isTrial: boolean, actualSize: number}>}
 */
async function getQQMusicUrl(songmid, strMediaMid, quality = "128k") {
 const qualityMap = { "128k": "M500", "320k": "M800", flac: "F000" };
 const prefix = qualityMap[quality] || "M500";

 try {
 const payload = JSON.stringify({
 req_0: {
 module: "vkey.GetVkey",
 method: "CgiGetVkey",
 param: {
 filename: [`${prefix}${strMediaMid}.mp3`],
 songmid: songmid,
 songtype: [0],
 uin: "0",
 loginflag: 0,
 platform: "23",
 h5to: "speed",
 },
 },
 });

 const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?g_tk=5381&data=${encodeURIComponent(payload)}`;
 const data = await _httpGet(url, { Referer: "https://y.qq.com/" });

 const vkeyData = data?.req_0?.data;
 if (!vkeyData || !vkeyData.midurlinfo?.length) {
 return { url: "", isTrial: true, actualSize: -1 };
 }

 const info = vkeyData.midurlinfo[0];
 if (!info.purl) {
 // purl为空 = 需要VIP/版权限制
 return { url: "", isTrial: true, actualSize: -1 };
 }

 const playUrl = `https://dl.stream.qqmusic.qq.com/${info.purl}`;
 
 // 检测文件大小
 const actualSize = await _getContentLength(playUrl);
 const isTrial = actualSize > 0 && actualSize < 500000; // <500KB = 试听版

 return { url: playUrl, isTrial, actualSize };
 } catch (err) {
 console.warn(`[QQSearch] getVkey失败: ${err.message}`);
 return { url: "", isTrial: true, actualSize: -1 };
 }
}

// ============================================================
// 工具函数
// ============================================================

function _httpGet(url, headers = {}) {
 return new Promise((resolve, reject) => {
 const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } }, (res) => {
 let body = "";
 res.on("data", (chunk) => (body += chunk));
 res.on("end", () => {
 try { resolve(JSON.parse(body)); }
 catch { resolve({}); }
 });
 });
 req.on("error", reject);
 req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
 });
}

async function _getContentLength(url) {
 return new Promise((resolve) => {
 const req = https.get(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
 const cl = parseInt(res.headers["content-length"] || "0", 10);
 resolve(cl || -1);
 req.destroy();
 });
 req.on("error", () => resolve(-1));
 req.setTimeout(8000, () => { req.destroy(); resolve(-1); });
 });
}

function _formatSize(bytes) {
 if (!bytes || bytes <= 0) return "";
 const mb = bytes / 1024 / 1024;
 return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

function _stripHighlight(str) {
 return str.replace(/<\/?em>/g, "");
}

export { qqSearch, getQQMusicUrl };
