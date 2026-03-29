/**
 * 本地音乐扫描器
 */

import fs from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';

export class LocalMusicScanner {
  constructor(config) {
    this.config = config;
    this.supportedFormats = config.music.supportedFormats || [
      '.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.ape'
    ];
    this.files = [];
  }

  /**
   * 扫描音乐文件夹
   */
  async scan(scanPath) {
    const paths = scanPath ? [scanPath] : this.config.music.localPaths;
    this.files = [];

    for (const basePath of paths) {
      if (!fs.existsSync(basePath)) {
        console.warn(`[LocalScanner] Path not found: ${basePath}`);
        continue;
      }

      await this._scanDirectory(basePath);
    }

    console.log(`[LocalScanner] Found ${this.files.length} music files`);
    return this.files;
  }

  /**
   * 递归扫描目录
   */
  async _scanDirectory(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await this._scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (this.supportedFormats.includes(ext)) {
          const fileInfo = await this._getFileInfo(fullPath);
          this.files.push(fileInfo);
        }
      }
    }
  }

  /**
   * 获取文件信息和元数据
   */
  async _getFileInfo(filePath) {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // 基本文件信息
    const info = {
      path: filePath,
      filename: path.basename(filePath),
      extension: ext,
      size: stats.size,
      modified: stats.mtime,
      // 默认元数据
      title: path.basename(filePath, ext),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      duration: 0,
    };

    // 尝试提取元数据
    try {
      const metadata = await parseFile(filePath);
      
      if (metadata.common) {
        info.title = metadata.common.title || info.title;
        info.artist = metadata.common.artist || info.artist;
        info.album = metadata.common.album || info.album;
        info.duration = metadata.format.duration || 0;
      }

      // 专辑封面
      if (metadata.common.picture && metadata.common.picture.length > 0) {
        info.cover = `data:${metadata.common.picture[0].format};base64,${metadata.common.picture[0].data.toString('base64')}`;
      }
    } catch (error) {
      // 元数据提取失败，使用默认值
      console.debug(`[LocalScanner] Failed to parse metadata: ${filePath}`, error.message);
    }

    return info;
  }

  /**
   * 获取已扫描的文件列表
   */
  getFiles() {
    return this.files;
  }

  /**
   * 搜索文件
   */
  search(query) {
    const q = query.toLowerCase();
    return this.files.filter(f => 
      f.title.toLowerCase().includes(q) ||
      f.artist.toLowerCase().includes(q) ||
      f.album.toLowerCase().includes(q)
    );
  }

  /**
   * 添加扫描路径
   */
  addPath(newPath) {
    if (!this.config.music.localPaths.includes(newPath)) {
      this.config.music.localPaths.push(newPath);
    }
  }
}
