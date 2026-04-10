/**
 * 在线音乐 API（多源支持）
 *
 * 使用 nuoxian API 获取完整歌曲
 * 支持网易云、QQ音乐、酷狗等平台
 */
import https from 'https';
import http from 'http';
import crypto from 'crypto';

// 音质等级定义（数值越高音质越好）
const QUALITY_RANK = {
  'hires': 100,    // Hi-Res 无损
  'flac': 90,      // FLAC 无损
  'ape': 85,       // APE 无损
  'wav': 80,       // WAV 无损
  'sq': 70,        // 超高音质 (320kbps)
  '320': 70,       // 320kbps
  '320kbps': 70,
  'hq': 50,        // 高音质 (192kbps)
  '192': 50,       // 192kbps
  'standard': 30,  // 标准音质 (128kbps)
  '128': 30,       // 128kbps
  'low': 10        // 低音质
};

// API 配置
const NXVAV_API = 'https://api.nxvav.cn/api/music/';
const NXVAV_TOKEN = 'nxvav';  // 公共 token

export class OnlineMusicApi {
  constructor(config) {
    this.config = config;
    this.provider = config.online?.provider || 'netease';
  }

  /**
   * 生成认证 token (HMAC-SHA1)
   */
  _generateAuth(id, type = 'url') {
    const message = `${this.provider}${type}${id}`;
    return crypto.createHmac('sha1', NXVAV_TOKEN).update(message).digest('hex');
  }

  /**
   * 搜索歌曲
   */
  async search(query, type = 'song') {
    try {
      // 使用 nuoxian API 搜索（URL 必须以 / 结尾）
      const url = `${NXVAV_API}?server=${this.provider}&type=search&id=${encodeURIComponent(query)}`;
      const data = await this._fetchWithRedirect(url);

      if (!Array.isArray(data)) {
        return {
          success: false,
          error: '搜索异常',
          hint: '请把以下内容发给 OpenClaw 进行修复：',
          fixMessage: 'Web Audio Streamer 搜索失败，请自动帮我修复。'
        };
      }

      // 处理搜索结果
      const songs = data.map((item, index) => {
        // 从 URL 中提取歌曲 ID
        const idMatch = item.url?.match(/id=(\d+)/);
        const id = idMatch ? idMatch[1] : `unknown_${index}`;

        return {
          id: id,
          title: item.title || '未知',
          artist: item.author || '未知',
          album: '',
          cover: item.pic || '',
          playUrl: item.url || '',  // 完整播放URL（带auth）
          duration: null,
          format: 'mp3',
          size: null,
          sizeText: '未知',
          bitrate: '高品质',
          qualityScore: 50
        };
      });

      return songs;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        hint: '请把以下内容发给 OpenClaw 进行修复：',
        fixMessage: 'Web Audio Streamer 搜索失败，请自动帮我修复。'
      };
    }
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(id) {
    try {
      const url = `${NXVAV_API}?server=${this.provider}&type=song&id=${id}`;
      const data = await this._fetchWithRedirect(url);

      if (data && data.title) {
        return {
          id: id,
          title: data.title,
          artist: data.author || '未知',
          album: data.album || '',
          cover: data.pic || '',
          url: data.url
        };
      }
    } catch (error) {
      // 忽略错误，返回基本信息
    }
    return null;
  }

  /**
   * 获取歌曲播放链接
   */
  async getSongUrl(id) {
    try {
      const auth = this._generateAuth(id, 'url');
      const url = `${NXVAV_API}?server=${this.provider}&type=url&id=${id}&auth=${auth}`;

      // 获取重定向后的真实音频链接
      const realUrl = await this._getRedirectUrl(url);
      return realUrl;
    } catch (error) {
      throw new Error('Unable to get song URL: ' + error.message);
    }
  }

  /**
   * 获取重定向后的真实 URL
   */
  _getRedirectUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error('Too many redirects'));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        method: 'GET',
        timeout: 10000
      };

      const req = lib.request(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const location = res.headers.location;
          const newUrl = location.startsWith('http') ? location : new URL(location, parsedUrl.origin).href;
          resolve(this._getRedirectUrl(newUrl, maxRedirects - 1));
        } else if (res.statusCode === 200) {
          resolve(url);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }

  /**
   * 获取歌词
   */
  async getLyric(id) {
    try {
      const auth = this._generateAuth(id, 'lrc');
      const url = `${NXVAV_API}?server=${this.provider}&type=lrc&id=${id}&auth=${auth}`;
      const data = await this._fetchWithRedirect(url);
      return data;
    } catch (error) {
      return '';
    }
  }

  /**
   * HTTP 请求封装（支持重定向）
   */
  _fetchWithRedirect(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error('Too many redirects'));
        return;
      }

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        headers: {
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      };

      lib.get(url, options, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const location = res.headers.location;
          const newUrl = location.startsWith('http') ? location : new URL(location, parsedUrl.origin).href;
          resolve(this._fetchWithRedirect(newUrl, maxRedirects - 1));
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            resolve(data);
          }
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  }
}
