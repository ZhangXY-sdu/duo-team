import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type InstallMethod = "homebrew-cask" | "homebrew-formula" | "npm" | "unknown";

export interface CodexUpdateCheckResult {
  binaryPath: string;
  realPath: string;
  installMethod: InstallMethod;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string;
}

export interface UpgradeJobState {
  status: "idle" | "running" | "succeeded" | "failed";
  installMethod: InstallMethod;
  command: string;
  previousVersion: string | null;
  currentVersion: string | null;
  upgraded: boolean;
  message: string;
  output: string;
  startedAt: string | null;
  finishedAt: string | null;
}

let activeJob: UpgradeJobState = {
  status: "idle",
  installMethod: "unknown",
  command: "",
  previousVersion: null,
  currentVersion: null,
  upgraded: false,
  message: "",
  output: "",
  startedAt: null,
  finishedAt: null,
};

function buildPathEnv(noAutoUpdate = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", path.join(env.HOME ?? "", ".local/bin")];
  const parts = (env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean);
  for (const e of extras) {
    if (e && !parts.includes(e)) parts.push(e);
  }
  env.PATH = parts.join(path.delimiter);
  if (noAutoUpdate) {
    env.HOMEBREW_NO_AUTO_UPDATE = "1";
  }
  env.HOMEBREW_NO_INSTALL_CLEANUP = "1";
  return env;
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function detectInstallMethod(realPath: string): InstallMethod {
  if (realPath.includes("/Caskroom/codex/")) return "homebrew-cask";
  if (realPath.includes("/Cellar/codex/")) return "homebrew-formula";
  if (realPath.includes("node_modules/@openai/codex")) return "npm";
  return "unknown";
}

async function readLocalVersion(codexPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(codexPath, ["--version"], { env, timeout: 10_000 });
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/codex-cli\s+([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/i) ?? text.match(/\b([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "duo-team/0.2.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteLatestVersion(method: InstallMethod): Promise<{ version: string | null; error?: string }> {
  try {
    if (method === "homebrew-cask") {
      const data = await fetchJsonWithTimeout<{ version?: string }>("https://formulae.brew.sh/api/cask/codex.json");
      if (data?.version) return { version: data.version };
    } else if (method === "homebrew-formula") {
      const data = await fetchJsonWithTimeout<{ versions?: { stable?: string } }>("https://formulae.brew.sh/api/formula/codex.json");
      if (data?.versions?.stable) return { version: data.versions.stable };
    } else if (method === "npm") {
      const data = await fetchJsonWithTimeout<{ version?: string }>("https://registry.npmjs.org/@openai/codex/latest");
      if (data?.version) return { version: data.version };
    }
  } catch {
    // Fallback to GitHub releases
  }

  try {
    const gh = await fetchJsonWithTimeout<{ tag_name?: string }>("https://api.github.com/repos/openai/codex/releases/latest");
    const tag = gh?.tag_name?.replace(/^rust-v/i, "").replace(/^v/i, "") ?? null;
    if (tag) return { version: tag };
  } catch (err) {
    return { version: null, error: err instanceof Error ? err.message : String(err) };
  }
  return { version: null };
}

export async function checkCodexUpdate(): Promise<CodexUpdateCheckResult> {
  const env = buildPathEnv(true);
  const binaryPath = findExecutable("codex", env);
  if (!binaryPath) {
    return {
      binaryPath: "",
      realPath: "",
      installMethod: "unknown",
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      message: "未在 PATH 中找到 codex 可执行文件。",
    };
  }

  let realPath = binaryPath;
  try {
    realPath = fs.realpathSync(binaryPath);
  } catch {
    // ignore
  }
  const installMethod = detectInstallMethod(realPath);
  const [currentVersion, remote] = await Promise.all([
    readLocalVersion(binaryPath, env),
    fetchRemoteLatestVersion(installMethod),
  ]);

  const latestVersion = remote.version;
  const updateAvailable = Boolean(currentVersion && latestVersion && currentVersion !== latestVersion);
  let message = "";
  if (updateAvailable) {
    message = `发现新版本：${currentVersion} → ${latestVersion}（来源：${installMethod}）`;
  } else if (currentVersion && latestVersion) {
    message = `当前已是最新版本 ${currentVersion}（来源：${installMethod}）`;
  } else if (currentVersion) {
    message = `当前版本 ${currentVersion}（来源：${installMethod}${remote.error ? `；检查远程失败: ${remote.error}` : ""}）`;
  } else {
    message = "无法读取本地 Codex CLI 版本。";
  }

  return {
    binaryPath,
    realPath,
    installMethod,
    currentVersion,
    latestVersion,
    updateAvailable,
    message,
  };
}

export function getUpgradeJobState(): UpgradeJobState {
  return { ...activeJob };
}

export async function startCodexUpgradeAsync(onComplete?: () => Promise<void> | void): Promise<UpgradeJobState> {
  if (activeJob.status === "running") {
    return { ...activeJob };
  }

  const env = buildPathEnv(false);
  const binaryPath = findExecutable("codex", env);
  if (!binaryPath) {
    activeJob = {
      status: "failed",
      installMethod: "unknown",
      command: "",
      previousVersion: null,
      currentVersion: null,
      upgraded: false,
      message: "未找到本机 codex 可执行文件。",
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    return { ...activeJob };
  }

  let realPath = binaryPath;
  try {
    realPath = fs.realpathSync(binaryPath);
  } catch {
    // ignore
  }
  const installMethod = detectInstallMethod(realPath);
  const previousVersion = await readLocalVersion(binaryPath, env);

  let cmd = "";
  let args: string[] = [];
  if (installMethod === "homebrew-cask") {
    cmd = findExecutable("brew", env) ?? "brew";
    args = ["upgrade", "--cask", "codex"];
  } else if (installMethod === "homebrew-formula") {
    cmd = findExecutable("brew", env) ?? "brew";
    args = ["upgrade", "codex"];
  } else if (installMethod === "npm") {
    cmd = findExecutable("npm", env) ?? "npm";
    args = ["install", "-g", "@openai/codex@latest"];
  } else {
    activeJob = {
      status: "failed",
      installMethod,
      command: "",
      previousVersion,
      currentVersion: previousVersion,
      upgraded: false,
      message: "无法识别安装方式，请手动运行 brew upgrade --cask codex 或 npm i -g @openai/codex@latest。",
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    return { ...activeJob };
  }

  const commandText = `${cmd} ${args.join(" ")}`;
  activeJob = {
    status: "running",
    installMethod,
    command: commandText,
    previousVersion,
    currentVersion: previousVersion,
    upgraded: false,
    message: `正在后台执行 ${commandText}...`,
    output: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const appendLog = (chunk: Buffer) => {
    activeJob.output = `${activeJob.output}${chunk.toString("utf8")}`.slice(-4000);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);

  child.on("error", (err) => {
    activeJob.status = "failed";
    activeJob.message = `启动更新命令失败: ${err.message}`;
    activeJob.finishedAt = new Date().toISOString();
  });

  child.on("close", async (code) => {
    const newVersion = await readLocalVersion(binaryPath, env);
    const upgraded = Boolean(newVersion && newVersion !== previousVersion);
    activeJob.currentVersion = newVersion ?? previousVersion;
    activeJob.upgraded = upgraded;
    if (code === 0) {
      activeJob.message = upgraded
        ? `已升级到 ${newVersion}，正在重启 codex app-server 并加载最新模型...`
        : `升级检查完成（${newVersion ?? previousVersion ?? "未知"}），正在重连 Codex...`;
      if (onComplete) {
        try {
          await onComplete();
        } catch (err) {
          activeJob.output = `${activeJob.output}\n[reconnect] ${err instanceof Error ? err.message : String(err)}`.slice(-4000);
        }
      }
      activeJob.finishedAt = new Date().toISOString();
      activeJob.status = "succeeded";
      activeJob.message = upgraded
        ? `Codex CLI 已更新：${previousVersion ?? "旧版"} → ${newVersion}，已自动重载最新模型目录！`
        : `更新命令已完成，当前 Codex CLI 版本：${newVersion ?? previousVersion ?? "未知"}。`;
    } else {
      activeJob.finishedAt = new Date().toISOString();
      activeJob.status = "failed";
      const lockHint = activeJob.output.includes("already locked")
        ? "（Homebrew 正在后台运行另一个任务，稍等片刻再重试）"
        : "";
      activeJob.message = `更新命令退出码 ${code}${lockHint}`;
    }
  });

  return { ...activeJob };
}
