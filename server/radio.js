/**
 * 网络电台播放器
 */

export class RadioPlayer {
  constructor(config) {
    this.config = config;
    this.currentRadio = null;
  }

  /**
   * 播放电台
   */
  async play(url) {
    this.currentRadio = url;
    return { success: true, url };
  }

  /**
   * 停止播放
   */
  stop() {
    this.currentRadio = null;
  }

  /**
   * 获取预设电台列表
   */
  getPresets() {
    return this.config.radio?.presets || [];
  }
}
