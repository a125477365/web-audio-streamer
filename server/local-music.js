/**
 * 本地音乐扫描器
 */

import fs from 'fs';
import path from 'path';

export class LocalMusicScanner {
  constructor(config) {
    this.config = config;
    this.files = [];
    this.supportedFormats = config.music?.supportedFormats || 
      ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.ape'];
  }

  /**
   * 扫描目录
   */
  async scan(scanPath, options = {}) {
    const { sortBy = 'name', page = 1, pageSize = 50 } = options;
    
    this.files = [];
    
    if (!fs.existsSync(scanPath)) {
      return { files: [], count: 0, page, pageSize };
    }
    
    this._scanDir(scanPath);
    
    // 排序
    this.files.sort((a, b) => {
      switch (sortBy) {
        case 'date':
          return (b.modifiedAt || 0) - (a.modifiedAt || 0);
        case 'size':
          return (b.size || 0) - (a.size || 0);
        case 'name':
        default:
          return a.name.localeCompare(b.name, 'zh-CN');
      }
    });
    
    // 分页
    const count = this.files.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pagedFiles = this.files.slice(start, end);
    
    return {
      files: pagedFiles,
      count,
      page,
      pageSize,
      totalPages: Math.ceil(count / pageSize)
    };
  }

  /**
   * 递归扫描目录
   */
  _scanDir(dir) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      items.forEach(item => {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
          this._scanDir(fullPath);
        } else if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          if (this.supportedFormats.includes(ext)) {
            try {
              const stat = fs.statSync(fullPath);
              const parsed = this._parseFileName(item.name);
              
              this.files.push({
                path: fullPath,
                name: item.name,
                title: parsed.title,
                artist: parsed.artist,
                size: stat.size,
                sizeText: this._formatSize(stat.size),
                modifiedAt: stat.mtimeMs,
                modifiedAtText: stat.mtime.toISOString(),
                extension: ext.replace('.', '')
              });
            } catch (e) {
              // 忽略无法读取的文件
            }
          }
        }
      });
    } catch (e) {
      console.error('[LocalMusic] Scan error:', e.message);
    }
  }

  /**
   * 解析文件名
   */
  _parseFileName(filename) {
    const name = filename.replace(/\.[^.]+$/, '');
    const match = name.match(/^(.+?)\s*-\s*(.+)$/);
    
    if (match) {
      return {
        artist: match[1].trim(),
        title: match[2].trim()
      };
    }
    
    return {
      artist: '未知',
      title: name
    };
  }

  /**
   * 格式化文件大小
   */
  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * 获取已扫描的文件列表
   */
  getFiles() {
    return this.files;
  }
}
