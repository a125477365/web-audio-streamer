/**
 * LX Plugin Runtime — 洛雪音乐插件运行环境（精简版）
 * 
 * 职责明确：只负责「播放链接获取」，不负责搜索！
 * 搜索由独立的 MusicSearchSdk 实现（与洛雪架构一致）。
 * 
 * 架构对齐洛雪音乐：
 * - 搜索：客户端内置 musicSdk 实现（我们用 MusicSearchSdk）
 * - 播放：通过 JS 音源脚本的 handleRequest('musicUrl') 获取 URL
 * 
 * 本模块实现：
 * 1. VM 沙盒隔离运行第三方 JS 音源脚本
 * 2. 注入 lx.sdk 依赖（EVENT_NAMES, on, send, request 等）
 * 3. 多源并发：同时加载多个插件，谁先返回正确的 URL 就用谁的
 */

import vm from "vm";
import https from "https";
import http from "http";
import crypto from "crypto";
import zlib from "zlib";
import { EventEmitter } from "events";

// ============================================================
// LX 接口规范常量
// ============================================================

const EVENT_NAMES = {
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
};

// ============================================================
// 单个插件沙盒
// ============================================================

class LxPluginSandbox {
  constructor(scriptUrl, scriptCode, options = {}) {
    this.scriptUrl = scriptUrl;
    this.scriptCode = scriptCode;
    this.name = "未知音源";
    this.version = "";
 this.supportedSources = {}; // { wy: { name, type, actions, qualitys }, ... }
 this.initialized = false;
 this.initError = null;
 this.requestHandler = null;
 this.enabled = true; // 用户可禁用单个插件
 this.timeout = options.timeout || 15000;
  }

  /**
   * 在 VM 沙盒中运行插件脚本
   * 完全模拟洛雪音乐 preload.js 的 lx 全局对象
   */
  async init() {
    try {
      const eventHandlers = {};
      let initResolve, initReject;
      const initPromise = new Promise((resolve, reject) => {
        initResolve = resolve;
        initReject = reject;
      });

      const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];
      const supportQualitys = {
        kw: ['128k', '320k', 'flac', 'flac24bit'],
        kg: ['128k', '320k', 'flac', 'flac24bit'],
        tx: ['128k', '320k', 'flac', 'flac24bit'],
        wy: ['128k', '320k', 'flac', 'flac24bit'],
        mg: ['128k', '320k', 'flac', 'flac24bit'],
        local: [],
      };
      const supportActions = {
        kw: ['musicUrl'],
        kg: ['musicUrl'],
        tx: ['musicUrl'],
        wy: ['musicUrl'],
        mg: ['musicUrl'],
        xm: ['musicUrl'],
        local: ['musicUrl', 'lyric', 'pic'],
      };

      const handleInit = (context, info) => {
        if (!info) {
          this.initError = 'Missing required parameter init info';
          this.initialized = false;
          initResolve(false);
          return;
        }
        const sourceInfo = { sources: {} };
        try {
          for (const source of allSources) {
            const userSource = info.sources?.[source];
            if (!userSource || userSource.type !== 'music') continue;
            const qualitys = supportQualitys[source] || [];
            const actions = supportActions[source] || [];
            sourceInfo.sources[source] = {
              type: 'music',
              actions: actions.filter(a => userSource.actions?.includes(a)),
              qualitys: qualitys.filter(q => userSource.qualitys?.includes(q)),
            };
          }
        } catch (error) {
          this.initError = error.message;
          this.initialized = false;
          initResolve(false);
          return;
        }
        this.supportedSources = sourceInfo.sources;
        this.initialized = true;
        initResolve(true);
      };

      const handleRequest = (context, { source, action, info }) => {
        if (!this.requestHandler) return Promise.reject(new Error('Request event is not defined'));
        return this.requestHandler.call(context, { source, action, info });
      };

      // === 依赖注入：完全模拟 globalThis.lx ===
      const self = this;
      const lxSdk = {
        EVENT_NAMES,

        request(url, options, callback) {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          const method = (options.method || 'get').toUpperCase();
          const timeout = typeof options.timeout === 'number' && options.timeout > 0
            ? Math.min(options.timeout, 60000) : 60000;

          const parsedUrl = new URL(url);
          const lib = parsedUrl.protocol === 'https:' ? https : http;

          const reqOpts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': '*/*',
              ...(options.headers || {}),
            },
            timeout,
          };

          let postData = null;
          let contentType = null;
          if (options.body) {
            postData = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
            contentType = 'application/json';
          } else if (options.form) {
            const params = new URLSearchParams(options.form);
            postData = params.toString();
            contentType = 'application/x-www-form-urlencoded';
          } else if (options.formData) {
            postData = options.formData;
            contentType = 'multipart/form-data';
          }
          if (contentType && !reqOpts.headers['Content-Type']) {
            reqOpts.headers['Content-Type'] = contentType;
          }

          const req = lib.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              const rawStr = raw.toString();
              let body;
              try { body = JSON.parse(rawStr); } catch { body = rawStr; }
              if (callback) {
                callback(null, {
                  statusCode: res.statusCode,
                  statusMessage: res.statusMessage,
                  headers: res.headers,
                  bytes: raw.length,
                  raw,
                  body,
                }, body);
              }
            });
          });

          req.on('error', (err) => { if (callback) callback(err, null, null); });
          req.on('timeout', () => { req.destroy(); if (callback) callback(new Error('Request timeout'), null, null); });

          if (postData) req.write(postData);
          req.end();

          return () => { req.destroy(); };
        },

        send(eventName, data) {
          return new Promise((resolve, reject) => {
            if (!Object.values(EVENT_NAMES).includes(eventName)) {
              return reject(new Error('The event is not supported: ' + eventName));
            }
            switch (eventName) {
              case EVENT_NAMES.inited:
                if (self.initialized) return reject(new Error('Script is inited'));
                handleInit(this, data);
                resolve();
                break;
              case EVENT_NAMES.updateAlert:
                resolve();
                break;
              default:
                reject(new Error('Unknown event name: ' + eventName));
            }
          });
        },

        on(eventName, handler) {
          if (!Object.values(EVENT_NAMES).includes(eventName)) {
            return Promise.reject(new Error('The event is not supported: ' + eventName));
          }
          switch (eventName) {
            case EVENT_NAMES.request:
              self.requestHandler = handler;
              eventHandlers.request = handler;
              break;
          }
          return Promise.resolve();
        },

        utils: {
          crypto: {
            aesEncrypt(buffer, mode, key, iv) {
              const cipher = crypto.createCipheriv(mode, key, iv);
              return Buffer.concat([cipher.update(buffer), cipher.final()]);
            },
            rsaEncrypt(buffer, key) {
              buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
              return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
            },
            randomBytes(size) { return crypto.randomBytes(size); },
            md5(str) { return crypto.createHash('md5').update(str).digest('hex'); },
            createHmac(alg, key) { return crypto.createHmac(alg, key); },
            createHash(alg) { return crypto.createHash(alg); },
          },
          buffer: {
            from(...args) { return Buffer.from(...args); },
            bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format); },
          },
          zlib: {
            inflate(buf) {
              return new Promise((resolve, reject) => {
                zlib.inflate(buf, (err, data) => {
                  if (err) reject(new Error(err.message));
                  else resolve(data);
                });
              });
            },
            deflate(data) {
              return new Promise((resolve, reject) => {
                zlib.deflate(data, (err, buf) => {
                  if (err) reject(new Error(err.message));
                  else resolve(buf);
                });
              });
            },
          },
        },

        currentScriptInfo: {
          name: self.name || '',
          description: '',
          version: self.version || '',
          author: '',
          homepage: '',
          rawScript: self.scriptCode || '',
        },

        version: '2.0.0',
        env: 'node',
      };

      // === 注入全局环境 ===
      const injectedGlobals = {
        globalThis: { lx: lxSdk },
        window: { lx: lxSdk },
        lx: lxSdk,

        __lx_init_error_handler__: {
          sendError(errorMessage) {
            if (self.initialized) return;
            self.initError = typeof errorMessage === 'string'
              ? errorMessage.substring(0, 1024) : String(errorMessage);
            self.initialized = false;
            initResolve(false);
          },
        },

        httpGet: (url, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          lxSdk.request(url, { ...options, method: 'GET' }, callback);
        },
        httpPost: (url, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          lxSdk.request(url, { ...options, method: 'POST' }, callback);
        },

        console: {
          log: (...args) => console.log(`[LX:${self.name}]`, ...args),
          error: (...args) => console.error(`[LX:${self.name}]`, ...args),
          warn: (...args) => console.warn(`[LX:${self.name}]`, ...args),
          info: (...args) => console.info(`[LX:${self.name}]`, ...args),
          group: (...args) => { if (console.group) console.group(`[LX:${self.name}]`, ...args); else console.log(`[LX:${self.name}] ┌─`, ...args); },
          groupEnd: () => { if (console.groupEnd) console.groupEnd(); },
          dir: (obj) => console.dir(obj),
          table: (data) => console.table ? console.table(data) : console.log(data),
          trace: (...args) => console.trace ? console.trace(`[LX:${self.name}]`, ...args) : console.log(`[LX:${self.name}] [TRACE]`, ...args),
          time: (label) => { if (console.time) console.time(`[LX:${self.name}] ${label}`); },
          timeEnd: (label) => { if (console.timeEnd) console.timeEnd(`[LX:${self.name}] ${label}`); },
          assert: (condition, ...args) => { if (console.assert) console.assert(condition, `[LX:${self.name}]`, ...args); },
          count: (label) => { if (console.count) console.count(`[LX:${self.name}] ${label}`); },
        },

        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,

        Buffer,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),

        JSON,
        Object, Array, String, Number, Boolean, Date, RegExp,
        Error, TypeError, RangeError, URIError, SyntaxError, ReferenceError,
        Math, parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
        Promise,
        encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,

        fetch: async (url, opts) => { return self._fetch(url, opts); },

        XMLHttpRequest: class {
          constructor() { this._headers = {}; }
          open(method, url) { this._method = method; this._url = url; }
          setRequestHeader(k, v) { this._headers[k] = v; }
          send(body) {
            lxSdk.request(this._url, {
              method: this._method,
              headers: this._headers,
              body,
            }, (err, resp, respBody) => {
              this.status = resp?.statusCode || 0;
              this.responseText = typeof respBody === 'string' ? respBody : JSON.stringify(respBody);
              this.responseURL = this._url;
              if (this.onload) this.onload();
              if (this.onreadystatechange) this.onreadystatechange();
            });
          }
        },
      };

      const context = vm.createContext(injectedGlobals);

      const wrappedCode = `
(() => {
try {
${this.scriptCode}
} catch (err) {
globalThis.__lx_init_error_handler__.sendError(err.message);
}
})()
`;
      const wrappedScript = new vm.Script(wrappedCode, {
        filename: this.scriptUrl || 'lx-plugin.js',
      });
      wrappedScript.runInContext(context);

      await Promise.race([
        initPromise,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);

      // 从脚本头部注释提取 @name
      const nameMatch = this.scriptCode.match(/\*\s*@name\s+(.+)/);
      if (nameMatch) this.name = nameMatch[1].trim();

      const verMatch = this.scriptCode.match(/\*\s*@version\s+(.+)/);
      if (verMatch) this.version = verMatch[1].trim();

      if (!this.initialized && this.requestHandler) {
        this.initialized = true;
        this._extractSourcesFromCode();
      }

      if (!this.requestHandler) {
        this.initError = "插件未注册 request 事件处理器";
        this.initialized = false;
      }

      return this.initialized;
    } catch (err) {
      this.initError = err.message;
      this.initialized = false;
      return false;
    }
  }

  /**
   * 通过插件的 request handler 获取播放链接
   * 与洛雪的 handleRequest({action: 'musicUrl'}) 完全一致
   */
  async getMusicUrl(source, musicInfo, quality = "320k") {
    if (!this.requestHandler) {
      throw new Error(`插件 ${this.name} 未初始化`);
    }

    try {
      const result = await this.requestHandler({
        source,
        action: "musicUrl",
        info: { musicInfo, type: quality },
      });

      if (typeof result === "string") return result;
      if (result?.url) return result.url;
      if (result?.data?.url) return result.data.url;

      throw new Error("插件返回了无法识别的格式");
    } catch (err) {
      throw new Error(`[${this.name}] ${err.message}`);
    }
  }

  _extractSourcesFromCode() {
    const sourcesMatch = this.scriptCode.match(
      /sources\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/
    );
    if (sourcesMatch) {
      const sourceKeys = sourcesMatch[1].match(/(\w+)\s*:\s*\{/g);
      if (sourceKeys) {
        for (const sk of sourceKeys) {
          const key = sk.match(/(\w+)/)[1];
          if (!this.supportedSources[key]) {
            this.supportedSources[key] = {
              name: `来源-${key}`,
              type: "music",
              actions: ["musicUrl"],
              qualitys: ["320k"],
            };
          }
        }
      }
    }

    if (Object.keys(this.supportedSources).length === 0) {
      const sourceMatch = this.scriptCode.match(/source\s*===?\s*['"](\w+)['"]/g);
      if (sourceMatch) {
        for (const sm of sourceMatch) {
          const key = sm.match(/['"](\w+)['"]/)[1];
          this.supportedSources[key] = {
            name: `来源-${key}`,
            type: "music",
            actions: ["musicUrl"],
            qualitys: ["320k"],
          };
        }
      }
    }
  }

  async _fetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const method = (opts.method || "GET").toUpperCase();
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      const reqOpts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
          ...(opts.headers || {}),
        },
        timeout: this.timeout,
      };

      const req = lib.request(reqOpts, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Fetch timeout")); });

      if (opts.body) {
        req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
      }

      req.end();
    });
  }
}

// ============================================================
// LX Plugin Runtime — 管理多个插件，只负责播放链接获取
// ============================================================

export class LxPluginRuntime {
  constructor() {
    this.plugins = []; // LxPluginSandbox[]
  }

  /**
   * 加载并初始化一个插件
   */
  async loadPlugin(scriptUrl, scriptCode) {
    const sandbox = new LxPluginSandbox(scriptUrl, scriptCode);
    const ok = await sandbox.init();

    if (ok && sandbox.requestHandler) {
      this.plugins.push(sandbox);
      console.log(
        `[LxRuntime] ✅ 加载成功: ${sandbox.name} ` +
        `(支持: ${Object.keys(sandbox.supportedSources).join(",")})`
      );
      return sandbox;
    } else {
      console.warn(
        `[LxRuntime] ❌ 加载失败: ${scriptUrl} — ${sandbox.initError || "未知错误"}`
      );
      return null;
    }
  }

  /**
   * 从 URL 下载并加载插件
   */
  async loadPluginFromUrl(url) {
    const code = await this._downloadScript(url);
    if (!code) return null;
    return this.loadPlugin(url, code);
  }

  /**
   * 从 GitHub 仓库批量加载插件
   */
  async loadPluginsFromGitHub(owner, repo, branch = "main") {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    const files = await this._fetchJson(apiUrl);

    if (!Array.isArray(files)) return [];

    const jsFiles = files.filter(
      (f) => f.name.endsWith(".js") && f.size < 200000
    );

    const loaded = [];
    for (const f of jsFiles) {
      const plugin = await this.loadPluginFromUrl(f.download_url);
      if (plugin) loaded.push(plugin);
    }

    return loaded;
  }

  // ==========================================================
  // 播放链接获取 — 核心功能：多源并发
  // ==========================================================

  /**
   * 获取歌曲播放链接（与洛雪 apis(source).getMusicUrl() 一致）
   * 多源并发：同时向所有支持该平台的插件请求，谁先返回就用谁的
   * 
   * @param {object} songInfo - 标准化歌曲信息（必须含 source + songmid）
   * @param {string} quality - 音质 (128k/320k/flac)
   * @returns {Promise<string>} mp3 播放链接
   */
 async getMusicUrl(songInfo, quality = "320k") {
 const source = songInfo.source || "wy";
 const musicInfo = {
 songmid: songInfo.songmid || songInfo.id,
 id: songInfo.id || songInfo.songmid,
 name: songInfo.title,
 strMediaMid: songInfo.strMediaMid || "",
 hash: songInfo.hash || songInfo.songmid,
 albumId: songInfo.albumId || "",
 };

 // 找到所有支持该平台且已启用的插件
 const compatiblePlugins = this.plugins.filter(
 (p) => p.initialized && p.enabled && p.supportedSources[source]
 );

 if (compatiblePlugins.length === 0) {
 throw new Error(`没有可用插件支持 ${source} 平台，请启用更多音源插件`);
 }

 // 如果有优先插件且兼容，优先使用
 if (this.preferredPluginName) {
 const preferred = compatiblePlugins.find(
 (p) => p.name === this.preferredPluginName
 );
 if (preferred) {
 console.log(`[LxRuntime] 优先使用插件: ${preferred.name}`);
 try {
 const url = await preferred.getMusicUrl(source, musicInfo, quality);
 return url;
 } catch (err) {
 console.warn(`[LxRuntime] 优先插件 ${preferred.name} 失败: ${err.message}，回退到并发模式`);
 }
 }
 }

 // 多源并发！Promise.any: 谁先成功用谁的
 const attempts = compatiblePlugins.map((plugin) =>
 plugin
 .getMusicUrl(source, musicInfo, quality)
 .catch((err) => {
 console.warn(`[LxRuntime] ${plugin.name} 失败: ${err.message}`);
 throw err;
 })
 );

 try {
 const url = await Promise.any(attempts);
 return url;
 } catch (aggregateError) {
 const errors = aggregateError?.errors?.map(e => e?.message).filter(Boolean).join('; ') || '未知错误';
 throw new Error(`所有音源均无法获取播放链接: ${songInfo.title} (${errors})`);
 }
 }

 /**
 * 设置优先插件
 */
 setPreferredPlugin(pluginName) {
 this.preferredPluginName = pluginName || null;
 console.log(`[LxRuntime] 优先插件设置为: ${pluginName || '无（并发模式）'}`);
 }

 /**
 * 切换插件启用/禁用
 */
 togglePlugin(pluginName, enabled) {
 const plugin = this.plugins.find(p => p.name === pluginName);
 if (!plugin) return false;
 plugin.enabled = enabled;
 // 如果禁用的是优先插件，清除优先设置
 if (!enabled && this.preferredPluginName === pluginName) {
 this.preferredPluginName = null;
 }
 console.log(`[LxRuntime] 插件 ${pluginName} ${enabled ? '已启用' : '已禁用'}`);
 return true;
 }

  /**
   * 检查是否有插件支持指定平台
   */
  hasSourceSupport(source) {
    return this.plugins.some(p => p.initialized && p.supportedSources[source]);
  }

  /**
   * 获取所有已加载插件支持的平台列表
   */
  getSupportedSources() {
    const sources = new Set();
    for (const plugin of this.plugins) {
      for (const key of Object.keys(plugin.supportedSources)) {
        sources.add(key);
      }
    }
    return [...sources];
  }

  // ==========================================================
  // 下载 — 获取播放链接 + 流式下载到文件
  // ==========================================================

  async download(songInfo, savePath, onProgress) {
    const fs = await import("fs");
    const path = await import("path");

    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const playUrl = await this.getMusicUrl(songInfo);

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(playUrl);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      const file = fs.createWriteStream(savePath);

      const doRequest = (url) => {
        const p = new URL(url);
        const l = p.protocol === "https:" ? https : http;

        l.get(url, {
          headers: { "User-Agent": "Mozilla/5.0", Referer: "" },
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = res.headers.location.startsWith("http")
              ? res.headers.location
              : new URL(res.headers.location, p.origin).href;
            doRequest(nextUrl);
            return;
          }

          const totalSize = parseInt(res.headers["content-length"], 10);
          let downloaded = 0;

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0;
            if (onProgress) onProgress(percent);
          });

          res.pipe(file);

          file.on("finish", () => {
            file.close();
            const size = fs.statSync(savePath).size;
            resolve({ filepath: savePath, size });
          });
        }).on("error", (err) => {
          if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
          reject(err);
        });
      };

      doRequest(playUrl);
    });
  }

  // ==========================================================
  // 状态
  // ==========================================================

 getStatus() {
 return {
 pluginCount: this.plugins.length,
 plugins: this.plugins.map((p) => ({
 name: p.name,
 version: p.version,
 sources: Object.keys(p.supportedSources),
 initialized: p.initialized,
 enabled: p.enabled,
 })),
 allSources: this.getSupportedSources(),
 preferredPlugin: this.preferredPluginName || null,
 };
 }

  // ==========================================================
  // 工具方法
  // ==========================================================

  async _downloadScript(url) {
    return new Promise((resolve) => {
      const safeUrl = this._encodeUrl(url);
      const parsed = new URL(safeUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      lib.get(safeUrl, {
        headers: { "User-Agent": "Web-Audio-Streamer/1.0" },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, parsed.origin).href;
          this._downloadScript(nextUrl).then(resolve);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }).on("error", (err) => {
        console.warn(`[LxRuntime] 下载脚本失败: ${url} — ${err.message}`);
        resolve(null);
      });
    });
  }

  _encodeUrl(url) {
    try {
      if (!/[() \[\]{}]/.test(url) && !/[\u4e00-\u9fff]/.test(url)) return url;
      const urlObj = new URL(url);
      const safePath = urlObj.pathname
        .split("/")
        .map((seg) => {
          if (!seg) return seg;
          if (/%[0-9A-Fa-f]{2}/.test(seg) && !/[() \[\]{}]/.test(seg)) return seg;
          const decoded = decodeURIComponent(seg);
          return encodeURIComponent(decoded)
            .replace(/\(/g, "%28")
            .replace(/\)/g, "%29")
            .replace(/\[/g, "%5B")
            .replace(/\]/g, "%5D");
        })
        .join("/");
      return `${urlObj.origin}${safePath}${urlObj.search}`;
    } catch {
      return url;
    }
  }

  async _fetchJson(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const safeUrl = this._encodeUrl(url);
      const parsed = new URL(safeUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      lib.get(safeUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
          ...extraHeaders,
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      }).on("error", reject);
    });
  }
}

export default LxPluginRuntime;
