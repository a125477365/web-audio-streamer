/**
 * 在线音乐 API（网易云音乐）
 * 
 * 使用公开 API 获取音乐信息
 */

import https from 'https';

export class OnlineMusicApi {
  constructor(config) {
    this.config = config;
    this.provider = config.online?.provider || 'netease';
    this.apiUrl = config.online?.neteaseApi || 'https://api.injahow.cn/meting/';
  }

  /**
   * 搜索歌曲
   */
  async search(query, type = 'song') {
    const url = `${this.apiUrl}?type=search&id=${encodeURIComponent(query)}`;
    const data = await this._fetch(url);
    
    // 解析结果
    return data.map(item => ({
      id: item.id,
      title: item.name || item.title,
      artist: item.artist || item.author,
      album: item.album,
      cover: item.pic || item.pic_id,
      url: item.url,
    }));
  }

  /**
   * 获取歌曲详情
   */
  async getSongDetail(id) {
    const url = `${this.apiUrl}?type=song&id=${id}`;
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
    // 先尝试获取详情
    const song = await this.getSongDetail(id);
    if (song && song.url) {
      return song.url;
    }

    // 尝试直接获取播放链接
    const url = `${this.apiUrl}?type=url&id=${id}`;
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
    const url = `${this.apiUrl}?type=lyric&id=${id}`;
    const data = await this._fetch(url);
    return data.lyric || data;
  }

  /**
   * 获取歌单
   */
  async getPlaylist(id) {
    const url = `${this.apiUrl}?type=playlist&id=${id}`;
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
  async _fetch(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            // 某些 API 返回非标准 JSON
            resolve(data);
          }
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  }
}
