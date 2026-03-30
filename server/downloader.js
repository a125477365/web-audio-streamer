/**
 * 音乐下载器
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

export class MusicDownloader {
  constructor(config) {
    this.config = config;
    this.downloadPath = config.music?.downloadPath || './music';
    this.progress = {};
  }

  /**
   * 下载歌曲
   */
  async download(songId, options = {}) {
    const { title = 'unknown', artist = 'unknown', format = 'mp3' } = options;
    
    // 确保下载目录存在
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
    
    // 生成文件名
    const safeName = this._sanitizeFileName(`${artist} - ${title}`);
    const ext = this._getExtension(format);
    const filename = `${safeName}.${ext}`;
    const filepath = path.join(this.downloadPath, filename);
    
    // 如果文件已存在，直接返回
    if (fs.existsSync(filepath)) {
      return { filepath, filename, skipped: true };
    }
    
    // 获取下载链接
    const url = await this._getDownloadUrl(songId);
    
    // 下载文件
    this.progress[filename] = { percent: 0, status: 'downloading' };
    
    await this._downloadFile(url, filepath, (percent) => {
      this.progress[filename].percent = percent;
    });
    
    this.progress[filename] = { percent: 100, status: 'completed' };
    
    return { filepath, filename, size: fs.statSync(filepath).size };
  }

  /**
   * 获取下载进度
   */
  getProgress() {
    return this.progress;
  }

  /**
   * 获取下载 URL
   */
  async _getDownloadUrl(songId) {
    // 先用 song 类型获取歌曲信息
    const songUrl = `https://api.injahow.cn/meting/?type=song&id=${songId}`;
    
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*'
        }
      };
      
      https.get(songUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const songs = JSON.parse(data);
            if (Array.isArray(songs) && songs.length > 0 && songs[0].url) {
              // 获取实际音频 URL
              const audioApiUrl = songs[0].url;
              this._fetchActualUrl(audioApiUrl).then(resolve).catch(reject);
            } else {
              reject(new Error('No song info found'));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 获取实际音频 URL
   */
  async _fetchActualUrl(apiUrl) {
    return new Promise((resolve, reject) => {
      https.get(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        // 检查是否是重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
          return;
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json && json.url) {
              resolve(json.url);
            } else {
              // 可能已经是音频流 URL
              resolve(apiUrl);
            }
          } catch (e) {
            // 不是 JSON，可能已经是音频 URL
            resolve(apiUrl);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 下载文件
   */
  async _downloadFile(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(filepath);
      
      protocol.get(url, (res) => {
        // 处理重定向
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(filepath);
          this._downloadFile(res.headers.location, filepath, onProgress).then(resolve).catch(reject);
          return;
        }
        
        const totalSize = parseInt(res.headers['content-length'], 10);
        let downloaded = 0;
        
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0;
          onProgress(percent);
        });
        
        res.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlinkSync(filepath);
        reject(err);
      });
    });
  }

  /**
   * 清理文件名
   */
  _sanitizeFileName(name) {
    return name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
  }

  /**
   * 获取文件扩展名
   */
  _getExtension(format) {
    const extMap = {
      'flac': 'flac',
      'mp3': 'mp3',
      'wav': 'wav',
      'aac': 'aac',
      'ogg': 'ogg',
      'm4a': 'm4a'
    };
    return extMap[format?.toLowerCase()] || 'mp3';
  }
}
