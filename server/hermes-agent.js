/**
 * 本地 Hermes Agent 调用封装（用于私人FM 智能推荐）
 *
 * - detectHermes(): 检测本机是否安装了 hermes（PATH / 常见路径 / HERMES_COMMAND 环境变量）
 * - runHermesOneshot(prompt): 用 `hermes -z <prompt>` 一次性模式拿到纯文本回复
 *
 * 设计原则：hermes 由用户自行安装与配置（模型/Provider）。本模块只负责"如果有就用、
 * 没有或失败就让上层回退"，绝不尝试安装或修改 hermes 配置。
 */
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

let _cachedHermes = undefined; // undefined=未检测, null=不可用, string=可执行路径/命令

function _which(cmd) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 5000,
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 检测可用的 hermes 命令，返回可执行路径/命令名，找不到返回 null（结果缓存）。
 */
export function detectHermes() {
  if (_cachedHermes !== undefined) return _cachedHermes;

  // 1. 环境变量覆盖
  const override = process.env.HERMES_COMMAND;
  if (override) {
    _cachedHermes = override;
    return _cachedHermes;
  }

  // 2. PATH
  const inPath = _which("hermes");
  if (inPath) {
    _cachedHermes = inPath;
    return _cachedHermes;
  }

  // 3. 常见安装位置
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "hermes"),
    path.join(home, "bin", "hermes"),
    "/usr/local/bin/hermes",
    "/opt/homebrew/bin/hermes",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _cachedHermes = c;
        return _cachedHermes;
      }
    } catch {}
  }

  _cachedHermes = null;
  return _cachedHermes;
}

export function hasHermes() {
  return Boolean(detectHermes());
}

/**
 * 用 hermes 一次性(oneshot)模式发送一个 prompt，返回模型纯文本回复。
 * 失败/超时/未安装时抛错，由上层决定回退。
 *
 * @param {string} prompt
 * @param {object} opts - { timeoutMs=120000, lightweight=true }
 *   lightweight=true 时加 --ignore-user-config，跳过用户级 hooks/MCP，加快启动。
 * @returns {Promise<string>}
 */
export function runHermesOneshot(prompt, opts = {}) {
  const { timeoutMs = 120000, lightweight = true } = opts;
  const cmd = detectHermes();
  if (!cmd) return Promise.reject(new Error("未检测到本地 hermes，请先安装 hermes"));

  return new Promise((resolve, reject) => {
    // --cli：强制独立 CLI 模式，绕过 hermes gateway 守护进程（实测走 gateway 会阻塞挂死）
    const args = ["--cli"];
    if (lightweight) args.push("--ignore-user-config");
    args.push("-z", prompt);

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`hermes 调用超时(${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = _stripAnsi(stdout).trim();
      if (text) resolve(text);
      else reject(new Error(`hermes 无输出 (exit=${code}) ${_stripAnsi(stderr).slice(0, 200)}`));
    });
  });
}

function _stripAnsi(s) {
  // 去除 ANSI 颜色码 / 控制字符，保留可读文本
  return String(s || "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}
