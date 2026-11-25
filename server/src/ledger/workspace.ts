import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface WorkspaceChangeFile {
  path: string;
  status: string;
  modifiedAt?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export interface WorkspaceInspection {
  isGitRepo: boolean;
  branch: string | null;
  changedFiles: WorkspaceChangeFile[];
  diffStat: string;
  worktrees: WorktreeInfo[];
  recentFiles: WorkspaceChangeFile[];
}

export interface ToolProbeItem {
  id: string;
  label: string;
  category: "research" | "dev" | "doc";
  available: boolean;
  version: string | null;
}

export interface ProjectTreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  sizeBytes?: number;
  gitStatus?: string;
  fileCount?: number;
  children?: ProjectTreeNode[];
}

export interface ProjectMapSummary {
  generatedAt: string;
  totalFiles: number;
  totalDirs: number;
  outline: string;
  byExtension: Record<string, number>;
}

function buildSearchPath(): string {
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Library/TeX/texbin",
    "/Applications/Stata/StataMP.app/Contents/MacOS",
    "/Applications/Stata/StataSE.app/Contents/MacOS",
    "/Applications/Stata/StataBE.app/Contents/MacOS",
    "/Applications/LibreOffice.app/Contents/MacOS",
    path.join(process.env.HOME ?? "", ".local/bin"),
  ];
  const parts = (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean);
  for (const e of extras) {
    if (e && !parts.includes(e)) parts.push(e);
  }
  return parts.join(path.delimiter);
}

function findBin(candidates: string[], searchPath: string): string | null {
  const dirs = searchPath.split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function probeLocalToolchain(): ToolProbeItem[] {
  const searchPath = buildSearchPath();
  const env = { ...process.env, PATH: searchPath };
  const specs: Array<{ id: string; label: string; category: "research" | "dev" | "doc"; bins: string[]; vArg: string }> = [
    { id: "python3", label: "Python", category: "research", bins: ["python3"], vArg: "--version" },
    { id: "r", label: "R", category: "research", bins: ["Rscript"], vArg: "--version" },
    { id: "stata", label: "Stata", category: "research", bins: ["stata-mp", "stata-se", "stata", "StataMP", "StataSE", "StataBE"], vArg: "-v" },
    { id: "latex", label: "LaTeX", category: "doc", bins: ["xelatex", "pdflatex", "latexmk"], vArg: "--version" },
    { id: "pandoc", label: "Pandoc", category: "doc", bins: ["pandoc"], vArg: "--version" },
    { id: "libreoffice", label: "Office/PDF", category: "doc", bins: ["soffice", "libreoffice"], vArg: "--version" },
    { id: "git", label: "Git", category: "dev", bins: ["git"], vArg: "--version" },
    { id: "node", label: "Node.js", category: "dev", bins: ["node"], vArg: "--version" },
    { id: "uv", label: "uv", category: "dev", bins: ["uv"], vArg: "--version" },
  ];

  return specs.map((s) => {
    const bin = findBin(s.bins, searchPath);
    if (!bin) {
      return { id: s.id, label: s.label, category: s.category, available: false, version: null };
    }
    let version: string | null = null;
    if (s.id !== "stata") {
      try {
        const res = spawnSync(bin, [s.vArg], { env, encoding: "utf8", timeout: 2500 });
        const line = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split(/\r?\n/).find((l) => l.trim()) ?? "";
        const m = line.match(/[0-9]+\.[0-9]+(?:\.[0-9]+)?/);
        version = m ? m[0] : line.slice(0, 28) || null;
      } catch {
        version = null;
      }
    }
    return { id: s.id, label: s.label, category: s.category, available: true, version };
  });
}

function collectRecentFiles(rootPath: string, limit = 15): WorkspaceChangeFile[] {
  const found: Array<{ rel: string; mtimeMs: number }> = [];
  const skipDirs = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".workbench", ".runtime", "archive"]);

  const walk = (dir: string, depth: number) => {
    if (depth > 3 || found.length > 300) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".duo-team") continue;
      if (skipDirs.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".duo-team") {
          walk(path.join(full, "artifacts"), depth + 1);
        } else {
          walk(full, depth + 1);
        }
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          found.push({ rel: path.relative(rootPath, full), mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  };

  walk(rootPath, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map((f) => ({
    path: f.rel,
    status: "recent",
    modifiedAt: new Date(f.mtimeMs).toISOString(),
  }));
}

export function inspectWorkspaceChanges(rootPath: string): WorkspaceInspection {
  const recentFiles = collectRecentFiles(rootPath, 15);

  let isGitRepo = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootPath, stdio: "ignore", timeout: 3000 });
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  if (!isGitRepo) {
    return {
      isGitRepo: false,
      branch: null,
      changedFiles: [],
      diffStat: "",
      worktrees: [],
      recentFiles,
    };
  }

  const runGit = (args: string[]): string => {
    const res = spawnSync("git", args, { cwd: rootPath, encoding: "utf8", timeout: 5000 });
    return res.status === 0 ? (res.stdout ?? "").trim() : "";
  };

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) || null;
  const statusOut = runGit(["status", "--porcelain=v1", "-uall"]);
  const changedFiles: WorkspaceChangeFile[] = statusOut
    ? statusOut
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 60)
        .map((line) => ({
          status: line.slice(0, 2).trim() || "M",
          path: line.slice(3).trim(),
        }))
    : [];

  const diffStat = runGit(["diff", "--stat"]).slice(0, 3500);

  const wtOut = runGit(["worktree", "list", "--porcelain"]);
  const worktrees: WorktreeInfo[] = [];
  if (wtOut) {
    const blocks = wtOut.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
      const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length, "HEAD ".length + 8) ?? "";
      const br = lines.find((l) => l.startsWith("branch "))?.replace("branch refs/heads/", "") ?? "detached";
      if (wtPath && path.resolve(wtPath) !== path.resolve(rootPath)) {
        worktrees.push({ path: wtPath, branch: br, head });
      }
    }
  }

  return {
    isGitRepo: true,
    branch,
    changedFiles,
    diffStat,
    worktrees,
    recentFiles,
  };
}

const TREE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".workbench",
  ".runtime",
]);

export function buildProjectTree(
  rootPath: string,
  opts?: { maxDepth?: number; maxEntries?: number; gitStatusMap?: Map<string, string> }
): { tree: ProjectTreeNode[]; totalFiles: number; totalDirs: number } {
  const maxDepth = opts?.maxDepth ?? 4;
  const maxEntries = opts?.maxEntries ?? 450;
  const gitStatusMap = opts?.gitStatusMap ?? new Map<string, string>();
  let totalFiles = 0;
  let totalDirs = 0;
  let seen = 0;

  const walk = (dir: string, depth: number): ProjectTreeNode[] => {
    if (depth > maxDepth || seen >= maxEntries) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: fs.Dirent[] = [];
    const files: fs.Dirent[] = [];
    for (const ent of entries) {
      if (ent.name === ".DS_Store") continue;
      if (ent.isDirectory()) {
        if (TREE_SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith(".") && ent.name !== ".duo-team") continue;
        dirs.push(ent);
      } else if (ent.isFile()) {
        files.push(ent);
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const nodes: ProjectTreeNode[] = [];
    for (const d of dirs) {
      if (seen >= maxEntries) break;
      seen++;
      totalDirs++;
      const full = path.join(dir, d.name);
      const rel = path.relative(rootPath, full);
      const children = walk(full, depth + 1);
      const countFiles = (list: ProjectTreeNode[]): number =>
        list.reduce((acc, n) => acc + (n.kind === "file" ? 1 : countFiles(n.children ?? [])), 0);
      nodes.push({
        name: d.name,
        path: rel,
        kind: "dir",
        fileCount: countFiles(children),
        children,
      });
    }

    for (const f of files) {
      if (seen >= maxEntries) break;
      seen++;
      totalFiles++;
      const full = path.join(dir, f.name);
      const rel = path.relative(rootPath, full);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {
        // ignore
      }
      nodes.push({
        name: f.name,
        path: rel,
        kind: "file",
        sizeBytes,
        gitStatus: gitStatusMap.get(rel),
      });
    }

    return nodes;
  };

  const tree = walk(rootPath, 0);
  return { tree, totalFiles, totalDirs };
}

function extractFileOutline(absPath: string, ext: string): string[] {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size === 0 || stat.size > 256 * 1024) return [];
    const text = fs.readFileSync(absPath, "utf8");
    const lines = text.split(/\r?\n/);
    const hits: string[] = [];

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
      for (const l of lines) {
        const m = l.match(/^\s*export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z0-9_]+)/);
        if (m) hits.push(m[1]);
        if (hits.length >= 6) break;
      }
    } else if (ext === ".py") {
      for (const l of lines) {
        const m = l.match(/^(?:async\s+def|def|class)\s+([A-Za-z0-9_]+)/);
        if (m && !m[1].startsWith("_")) hits.push(m[1]);
        if (hits.length >= 6) break;
      }
    } else if (ext === ".r" || ext === ".R") {
      for (const l of lines) {
        const m = l.match(/^([A-Za-z0-9_.]+)\s*<-\s*function/);
        if (m) hits.push(m[1]);
        if (hits.length >= 6) break;
      }
    } else if (ext === ".tex") {
      for (const l of lines) {
        const m = l.match(/\\(?:section|subsection|chapter)\*?\{([^}]{1,50})\}/);
        if (m) hits.push(m[1]);
        if (hits.length >= 5) break;
      }
    } else if (ext === ".md") {
      for (const l of lines) {
        const m = l.match(/^#{1,2}\s+(.{1,48})/);
        if (m) hits.push(m[1].trim());
        if (hits.length >= 4) break;
      }
    } else if (ext === ".do") {
      for (const l of lines) {
        const m = l.match(/^\s*program\s+define\s+([A-Za-z0-9_]+)/i);
        if (m) hits.push(m[1]);
        if (hits.length >= 5) break;
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Aider Repo-Map + Research Outline hybrid: compact structural map for Gemini & Codex context injection.
 */
export function buildSmartProjectMap(rootPath: string, maxChars = 4200): ProjectMapSummary {
  const { tree, totalFiles, totalDirs } = buildProjectTree(rootPath, { maxDepth: 4, maxEntries: 350 });
  const byExtension: Record<string, number> = {};
  const lines: string[] = [`# 项目结构与符号地图 · ${path.basename(rootPath)}`];

  const renderNodes = (nodes: ProjectTreeNode[], indent: string) => {
    for (const n of nodes) {
      if (lines.join("\n").length > maxChars) return;
      if (n.kind === "dir") {
        if (n.name === "archive") {
          lines.push(`${indent}📁 ${n.name}/ (${n.fileCount ?? 0} files, archived)`);
          continue;
        }
        lines.push(`${indent}📁 ${n.name}/ (${n.fileCount ?? 0})`);
        if (n.children && n.children.length > 0) {
          renderNodes(n.children, `${indent}  `);
        }
      } else {
        const ext = path.extname(n.name).toLowerCase() || "(no-ext)";
        byExtension[ext] = (byExtension[ext] ?? 0) + 1;
        const abs = path.join(rootPath, n.path);
        const symbols = extractFileOutline(abs, ext);
        const sizeLabel = n.sizeBytes && n.sizeBytes >= 1024 ? `${Math.round(n.sizeBytes / 1024)}KB` : "";
        const symPart = symbols.length > 0 ? ` — [${symbols.join(", ")}]` : sizeLabel ? ` (${sizeLabel})` : "";
        lines.push(`${indent}- ${n.name}${symPart}`);
      }
    }
  };

  renderNodes(tree, "");
  return {
    generatedAt: new Date().toISOString(),
    totalFiles,
    totalDirs,
    outline: lines.join("\n").slice(0, maxChars),
    byExtension,
  };
}
