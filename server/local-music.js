/**
 * 本地音乐扫描器
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { FFPROBE_PATH } from './ffmpeg-paths.js';

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
 const { sortBy = 'name', page = 1, pageSize = 50, withProbe = false } = options;
    
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
 extension: ext.replace('.', ''),
 ...this._quickProbe(fullPath),
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
 * 快速探测音频信息（时长、采样率、比特率）
 * 使用 ffprobe，超时3秒，失败返回默认值
 */
 _quickProbe(filePath) {
 try {
 const stdout = execFileSync(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeout: 3000, encoding: 'utf-8' });
 const data = JSON.parse(stdout);
 const stream = (data.streams || []).find(s => s.codec_type === 'audio') || {};
 const format = data.format || {};
 const duration = parseFloat(stream.duration || format.duration || 0);
 const sampleRate = parseInt(stream.sample_rate || 0);
 const bitRate = parseInt(stream.bit_rate || format.bit_rate || 0);
 const bitsPerSample = parseInt(stream.bits_per_raw_sample || stream.bits_per_sample || 0);
 const channels = parseInt(stream.channels || 0);
 return {
 duration,
 durationText: duration ? this._formatDuration(duration) : '--',
 sampleRate: sampleRate || 0,
 sampleRateText: sampleRate ? `${(sampleRate / 1000).toFixed(1)}kHz` : '--',
 bitRate,
 bitRateText: bitRate ? `${Math.round(bitRate / 1000)}kbps` : '--',
 bitsPerSample: bitsPerSample || 0,
 bitsPerSampleText: bitsPerSample ? `${bitsPerSample}bit` : '',
 channels: channels || 0,
 channelsText: channels ? `${channels}ch` : '',
 };
 } catch (e) {
 return {
 duration: 0, durationText: '--',
 sampleRate: 0, sampleRateText: '--',
 bitRate: 0, bitRateText: '--',
 bitsPerSample: 0, bitsPerSampleText: '',
 channels: 0, channelsText: '',
 };
 }
 }

 /**
 * 格式化时长
 */
 _formatDuration(seconds) {
 const m = Math.floor(seconds / 60);
 const s = Math.floor(seconds % 60);
 return `${m}:${s < 10 ? '0' : ''}${s}`;
 }

  /**
   * 获取已扫描的文件列表
   */
  getFiles() {
    return this.files;
  }
}
