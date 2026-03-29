/**
 * 网络电台播放器
 */

export class RadioPlayer {
  constructor(config) {
    this.config = config;
    this.presets = config.radio?.presets || [];
  }

  /**
   * 获取预设电台列表
   */
  getPresets() {
    return this.presets;
  }

  /**
   * 添加自定义电台
   */
  addPreset(radio) {
    if (!radio.name || !radio.url) {
      throw new Error('Radio must have name and url');
    }

    this.presets.push({
      name: radio.name,
      url: radio.url,
      addedAt: new Date().toISOString(),
    });

    return this.presets;
  }

  /**
   * 删除电台
   */
  removePreset(index) {
    if (index >= 0 && index < this.presets.length) {
      this.presets.splice(index, 1);
    }
    return this.presets;
  }

  /**
   * 获取电台流 URL
   */
  getStreamUrl(radioUrl) {
    // 某些电台需要特殊处理
    // 这里直接返回 URL，由 FFmpeg 处理
    return radioUrl;
  }

  /**
   * 验证电台 URL 是否有效
   */
  async validateUrl(url) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentType = response.headers.get('content-type') || '';
      
      // 检查是否是音频流
      const validTypes = ['audio/', 'application/octet-stream', 'application/x-mpegurl'];
      return validTypes.some(type => contentType.includes(type)) || response.ok;
    } catch (error) {
      return false;
    }
  }
}
