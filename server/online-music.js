/**
 * 在线音乐 API（网易云音乐）
 *
 * 使用网易云官方 API，支持音质排序
 */

import https from 'https';

// 音质等级定义（数值越高音质越好）
const QUALITY_RANK = {
  'hires': 100,      // Hi-Res 无损
  'flac': 90,        // FLAC 无损
  'ape': 85,         // APE 无损
  'wav': 80,         // WAV 无损
  'sq': 70,          // 超高音质 (320kbps)
  '320': 70,         // 320kbps
  '320kbps': 70,
  'hq': 50,          // 高音质 (192kbps)
  '192': 50,         // 192kbps
  'standard': 30,    // 标准音质 (128kbps)
  '128': 30,         // 128kbps
  'low': 10          // 低音质
};

// 格式优先级
const FORMAT_PRIORITY = {
  'flac': 10,
  'wav': 9,
  'ape': 8,
  'mp3': 5,
  'm4a': 4,
  'ogg': 3,
  'aac': 2,
  'unknown': 0
};

export class OnlineMusicApi {
  constructor(config) {
    this.config = config;
    this.provider = config.online?.provider || 'netease';
    this.baseUrl = 'https://music.163.com/api';
    this.songApi = 'https://api.injahow.cn/meting/';
    this.songDetailApi = 'https://music.163.com/api/song/detail';
  }

  /**
   * 搜索歌曲
   */
  async search(query, type = 'song') {
    const typeMap = { song: 1, album: 10, artist: 100, playlist: 1000 };
    const searchType = typeMap[type] || 1;
    
    const url = `${this.baseUrl}/search/get?s=${encodeURIComponent(query)}&type=${searchType}&limit=30`;
    
    try {
      const data = await this._fetch(url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
      });

      if (!data.result || !data.result.songs) {
        return {
          success: false,
          error: '搜索异常',
          hint: '请把以下内容发给 OpenClaw 进行修复：',
          fixMessage: 'Web Audio Streamer 搜索失败，请自动帮我修复。'
        };
      }

      // 获取每首歌的详细信息（包括音质）
      const songs = await Promise.all(
        data.result.songs.map(async (item) => {
          const basicInfo = {
            id: item.id,
            title: item.name,
            artist: item.artists ? item.artists.map(a => a.name).join('/') : '未知',
            album: item.album ? item.album.name : '',
            cover: item.album && item.album.picUrl ? item.album.picUrl : '',
            duration: item.duration
          };
          
          // 获取音质信息
          const qualityInfo = await this._getSongQuality(item.id);
          return { ...basicInfo, ...qualityInfo };
        })
      );

      // 按音质排序
      songs.sort((a, b) => {
        const qualityA = a.qualityScore || 0;
        const qualityB = b.qualityScore || 0;
        return qualityB - qualityA; // 高音质在前
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
   * 获取歌曲音质信息
   */
  async _getSongQuality(songId) {
    try {
      // 调用网易云歌曲详情 API
      const url = `${this.songDetailApi}?ids=[${songId}]`;
      const data = await this._fetch(url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
      });

      if (data && data.songs && data.songs.length > 0) {
        const song = data.songs[0];
        return this._parseQualityInfo(song);
      }
    } catch (error) {
      // 获取失败，返回默认信息
    }
    
    return {
      format: 'unknown',
      size: null,
      sizeText: '未知',
      bitrate: '未知',
      qualityScore: 0
    };
  }

  /**
   * 解析音质信息
   */
  _parseQualityInfo(song) {
    // 网易云音乐的歌曲质量信息
    const hq = song.hQuality;  // 无损
    const sq = song.sq;        // 超高音质
    const lq = song.lMusic;    // 低音质
    const mq = song.mMusic;    // 中音质
    const hqMusic = song.hMusic; // 高音质
    
    // 确定最佳可用音质
    let bestQuality = null;
    let qualityLevel = 'standard';
    let format = 'mp3';
    let size = null;
    let bitrate = '128kbps';
    
    if (hq || song.hr || song.hires) {
      // Hi-Res 无损
      bestQuality = hq || song.hr;
      qualityLevel = 'hires';
      format = 'flac';
      bitrate = 'Hi-Res';
    } else if (sq || song.sqMusic) {
      // 无损音质
      bestQuality = sq || song.sqMusic;
      qualityLevel = 'flac';
      format = 'flac';
      bitrate = '无损';
    } else if (hqMusic) {
      // 高音质 320kbps
      bestQuality = hqMusic;
      qualityLevel = 'sq';
      format = 'mp3';
      bitrate = '320kbps';
    } else if (mq) {
      // 中音质 192kbps
      bestQuality = mq;
      qualityLevel = 'hq';
      format = 'mp3';
      bitrate = '192kbps';
    } else if (lq) {
      // 低音质 128kbps
      bestQuality = lq;
      qualityLevel = 'standard';
      format = 'mp3';
      bitrate = '128kbps';
    }
    
    // 获取文件大小
    if (bestQuality) {
      size = bestQuality.size || bestQuality.fileSize;
      if (bestQuality.extension) {
        format = bestQuality.extension.toLowerCase();
      }
      if (bestQuality.bitrate) {
        bitrate = `${Math.floor(bestQuality.bitrate / 1000)}kbps`;
      }
    }
    
    const qualityScore = QUALITY_RANK[qualityLevel] || 30;
    const sizeText = size ? this._formatSize(size) : '未知';
    
    return {
      format,
      size,
      sizeText,
      bitrate,
      qualityLevel,
      qualityScore,
      isLossless: ['hires', 'flac', 'ape', 'wav'].includes(qualityLevel)
    };
  }

  /**
   * 格式化文件大小
   */
  _formatSize(bytes) {
    if (!bytes) return '未知';
    const mb = bytes / (1024 * 1024);
    if (mb >= 100) {
      return `${(mb).toFixed(0)} MB`;
    } else if (mb >= 10) {
      return `${mb.toFixed(1)} MB`;
    } else {
      return `${mb.toFixed(2)} MB`;
    }
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(id) {
    const url = `${this.songApi}?type=song&id=${id}`;
    const data = await this._fetch(url);
    if (data && data.length > 0) {
      const item = data[0];
      return {
        id: item.id,
        title: item.name || item.title,
        artist: item.artist || item.author,
        album: item.album,
        cover: item.pic,
        url: item.url,
      };
    }
    return null;
  }

  /**
   * 获取歌曲播放链接
   */
  async getSongUrl(id) {
    const song = await this.getSongDetail(id);
    if (song && song.url) {
      return song.url;
    }
    const url = `${this.songApi}?type=url&id=${id}`;
    const data = await this._fetch(url);
    if (data && data.url) {
      return data.url;
    }
    throw new Error('Unable to get song URL');
  }

  /**
   * 获取歌词
   */
  async getLyric(id) {
    const url = `${this.songApi}?type=lyric&id=${id}`;
    const data = await this._fetch(url);
    return data.lyric || data;
  }

  /**
   * 获取歌单
   */
  async getPlaylist(id) {
    const url = `${this.songApi}?type=playlist&id=${id}`;
    const data = await this._fetch(url);
    return data.map(item => ({
      id: item.id,
      title: item.name || item.title,
      artist: item.artist || item.author,
      album: item.album,
      cover: item.pic,
    }));
  }

  /**
   * HTTP 请求封装
   */
  async _fetch(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'Accept': '*/*',
          ...headers
        },
        timeout: 15000
      };
      
      https.get(url, options, (res) => {
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
