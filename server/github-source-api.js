/**
 * GitHub API 音源获取模块
 * 
 * 直接调用 GitHub API 获取洛雪音乐音源
 * - 快速可靠，不依赖浏览器
 * - 获取最新发布的音源文件
 */

import https from 'https';

// 已知可靠的音源仓库列表
const SOURCE_REPOS = [
  { owner: 'TZB679', repo: 'USEFUL-LX-MUSIC-SOURCES' },
  { owner: 'pdnone', repo: 'lx-music-source' },
];

export class GitHubSourceApi {
  constructor(config = {}) {
    this.timeout = config.timeout || 30000; // 30秒超时
  }

  /**
   * 获取音乐源
   */
  async fetchMusicSources() {
    console.log('[GitHubAPI] 开始获取音乐源...');

    const allSources = [];

    for (const repo of SOURCE_REPOS) {
      try {
        const sources = await this._fetchFromRepo(repo.owner, repo.repo);
        allSources.push(...sources);
        if (allSources.length >= 5) break; // 够了就停
      } catch (error) {
        console.error(`[GitHubAPI] 获取 ${repo.owner}/${repo.repo} 失败:`, error.message);
      }
    }

    if (allSources.length === 0) {
      throw new Error('无法从任何仓库获取音源');
    }

    console.log(`[GitHubAPI] 成功获取 ${Math.min(allSources.length, 5)} 个音源`);
    return allSources.slice(0, 5).map((s, i) => ({ ...s, id: i + 1 }));
  }

  /**
   * 从单个仓库获取音源
   */
  _fetchFromRepo(owner, repo) {
    return new Promise((resolve, reject) => {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents`;
      
      console.log(`[GitHubAPI] 请求: ${url}`);
      
      const req = https.get(url, {
        headers: { 'User-Agent': 'Web-Audio-Streamer/1.0' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            
            const files = JSON.parse(data);
            if (!Array.isArray(files)) {
              reject(new Error('响应格式错误'));
              return;
            }

            // 过滤 .js 文件，排除 README 等
            const jsFiles = files.filter(f => 
              f.name.endsWith('.js') && 
              !f.name.toLowerCase().includes('readme')
            );

            const sources = jsFiles.map(f => ({
              name: f.name.replace('.js', ''),
              url: f.download_url,
              searchUrl: f.download_url,
              platforms: ['netease', 'tencent', 'kugou', 'kuwo'],
              tested: false
            }));

            console.log(`[GitHubAPI] ${owner}/${repo}: 找到 ${sources.length} 个音源`);
            resolve(sources);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  /**
   * 检查可用性
   */
  async checkAvailability() {
    return true; // GitHub API 始终可用
  }
}

export default GitHubSourceApi;
