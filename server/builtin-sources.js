/**
 * 内置音源列表
 * 已验证可用的音乐API
 */

export const BUILTIN_SOURCES = [
 {
 name: "诺贤音乐API",
 searchUrl: "https://api.nxvav.cn/api/music/",
 description: "支持网易云、QQ音乐、酷狗、酷我",
 platforms: ["netease", "tencent", "kugou", "kuwo"],
 tested: true
 }
];

/**
 * 快速获取音源（使用内置列表）
 */
export function getBuiltinSources() {
 return BUILTIN_SOURCES;
}
