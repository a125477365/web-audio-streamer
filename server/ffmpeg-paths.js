/**
 * 解析 ffmpeg / ffprobe 可执行文件路径
 *
 * 优先使用系统 PATH 中已安装的版本；
 * 找不到时回退到 ffmpeg-static / ffprobe-static 提供的静态二进制，
 * 保证在没有全局安装 ffmpeg 的机器上也能一次性运行。
 */
import { execFileSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";

const require = createRequire(import.meta.url);

function worksInPath(cmd) {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function resolveFfmpeg() {
  if (worksInPath("ffmpeg")) return "ffmpeg";
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return "ffmpeg"; // 让后续报错信息直观（spawn ENOENT）
}

function resolveFfprobe() {
  if (worksInPath("ffprobe")) return "ffprobe";
  try {
    const p = require("ffprobe-static").path;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return "ffprobe";
}

export const FFMPEG_PATH = resolveFfmpeg();
export const FFPROBE_PATH = resolveFfprobe();

console.log(`[FFmpeg] ffmpeg → ${FFMPEG_PATH}`);
console.log(`[FFmpeg] ffprobe → ${FFPROBE_PATH}`);
