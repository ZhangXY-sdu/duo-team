import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChatGptPlanTier, GooglePlanTier } from "../scheduler/subscriptions.js";

export type CollaborationMode =
  | "plan_execute"
  | "co_create"
  | "parallel_research"
  | "debate"
  | "autonomous_team"
  | "custom";

export type AgentActor = "gemini" | "codex" | "human";
export type TaskStatus = "todo" | "running" | "in_review" | "rework" | "awaiting_human" | "done" | "blocked";
export type MessageKind =
  | "plan"
  | "challenge"
  | "proposal"
  | "review"
  | "rework"
  | "rebuttal"
  | "verdict"
  | "human_note"
  | "system";

export type RolePresetKey = "planner" | "executor" | "reviewer";
export type TeamLanguage = "zh-CN" | "en" | "auto";
export type MemoryCategory = "decision" | "pitfall" | "fact" | "convention";

export interface MemoryItemRecord {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  sourceAgent: string;
  refs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PinnedFileRecord {
  relPath: string;
  note: string;
  pinnedAt: string;
}

export interface CustomWorkflowStage {
  id: string;
  title: string;
  description?: string;
  owner: AgentActor;
  reviewer?: AgentActor | "none";
  dependsOn?: string[];
  acceptanceCriteria?: string;
  verifyCommand?: string | null;
  artifacts?: string[];
}

export interface CustomWorkflowPreset {
  id: string;
  name: string;
  description: string;
  roleModels?: RoleModelMap;
  maxReworks?: number;
  stages: CustomWorkflowStage[];
  updatedAt: string;
}

export interface RoleModelSpec {
  model: string | null;
  effort: string | null;
}

export type RoleModelMap = Partial<Record<RolePresetKey, RoleModelSpec>>;

export interface GlobalModelSettings {
  defaultCodexModel: string | null;
  defaultCodexEffort: string | null;
  lockCodexModel: boolean;
  defaultApprovalPolicy: "on-request" | "untrusted" | "never";
  roleModels: RoleModelMap;
  language: TeamLanguage;
  maxParallelCodex: number;
  googlePlan: GooglePlanTier;
  chatgptPlan: ChatGptPlanTier;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  storageDir: string | null;
  mode: CollaborationMode;
  defaultCodexModel: string | null;
  defaultCodexEffort: string | null;
  lockCodexModel: boolean;
  roleModels: RoleModelMap;
  language: TeamLanguage;
  maxParallelCodex: number;
  defaultApprovalPolicy: "on-request" | "untrusted" | "never";
  maxReworks: number;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResult {
  passed: boolean;
  checkedAt: string;
  command: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts: Array<{
    path: string;
    exists: boolean;
    sizeBytes: number;
    sha256: string | null;
  }>;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  owner: AgentActor;
  reviewer: AgentActor | "none";
  dependsOn: string[];
  ready: boolean;
  status: TaskStatus;
  acceptanceCriteria: string;
  verifyCommand: string | null;
  reworkCount: number;
  maxReworks: number;
  codexThreadId: string | null;
  worktreePath: string | null;
  artifacts: string[];
  lastVerify: VerificationResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  taskId: string | null;
  fromAgent: string;
  toAgent: string;
  kind: MessageKind;
  round: number;
  side: "pro" | "con" | "branch_a" | "branch_b" | null;
  content: string;
  refs: string[];
  createdAt: string;
}

export interface PersistedRunRecord {
  threadId: string;
  taskId: string | null;
  role: string;
  model: string | null;
  effort: string | null;
  cwd: string;
  status: string;
  lastSummary: string;
  finalOutput: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function inferRolePreset(role?: string): RolePresetKey {
  const s = (role ?? "").toLowerCase();
  if (/plan|architect|lead|design|规划|架构|方案/.test(s)) return "planner";
  if (/review|audit|critic|debate|advocate|judge|审|评|复核|辩|反方|正方/.test(s)) return "reviewer";
  return "executor";
}

const DEFAULT_MEMORY_TEMPLATE = (name: string, rootPath: string) => `# 项目共享记忆 · ${name}

> 路径：\`${rootPath}\`
> 本文件由 Gemini（Antigravity）与 GPT（Codex）以及用户共同维护，是跨会话、跨模型的单一事实来源。

## 1. 项目目标与验收口径
- （待补充）

## 2. 已确认决策（Decisions）
- （记录已敲定的研究设计、变量口径、架构选型与原因）

## 3. 避坑与失败记录（Lessons Learned）
- （记录已验证行不通的尝试，防止返工重踩）

## 4. 关键资料与产物索引（Sources & Artifacts）
- （记录原始数据、核心脚本、论文稿件与关键产出路径）
`;

export class TeamLedger {
  private readonly registryDb: DatabaseSync;
  private readonly projectDbs = new Map<string, DatabaseSync>();

  constructor(private readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.registryDb = new DatabaseSync(path.join(dataDir, "registry.sqlite"));
    this.registryDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        storage_dir TEXT,
        mode TEXT NOT NULL DEFAULT 'plan_execute',
        default_codex_model TEXT,
        default_codex_effort TEXT,
        lock_codex_model INTEGER NOT NULL DEFAULT 1,
        role_models_json TEXT NOT NULL DEFAULT '{}',
        language TEXT NOT NULL DEFAULT 'zh-CN',
        max_parallel_codex INTEGER NOT NULL DEFAULT 4,
        default_approval_policy TEXT NOT NULL DEFAULT 'on-request',
        max_reworks INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_codex_model TEXT,
        default_codex_effort TEXT,
        lock_codex_model INTEGER NOT NULL DEFAULT 1,
        default_approval_policy TEXT NOT NULL DEFAULT 'on-request',
        role_models_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
    `);

    // Safe migration for existing registry databases
    const cols = this.registryDb.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("lock_codex_model")) {
      this.registryDb.exec("ALTER TABLE projects ADD COLUMN lock_codex_model INTEGER NOT NULL DEFAULT 1");
    }
    if (!colNames.has("role_models_json")) {
      this.registryDb.exec("ALTER TABLE projects ADD COLUMN role_models_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!colNames.has("language")) {
      this.registryDb.exec("ALTER TABLE projects ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-CN'");
    }
    if (!colNames.has("max_parallel_codex")) {
      this.registryDb.exec("ALTER TABLE projects ADD COLUMN max_parallel_codex INTEGER NOT NULL DEFAULT 4");
    }
    if (!colNames.has("storage_dir")) {
      this.registryDb.exec("ALTER TABLE projects ADD COLUMN storage_dir TEXT");
    }

    // Drop legacy UNIQUE constraint on root_path so users can create multiple isolated topic projects in the same workspace
    const tableSqlRow = this.registryDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get() as { sql?: string } | undefined;
    if (tableSqlRow?.sql && /root_path\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSqlRow.sql)) {
      this.registryDb.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE projects_v2 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          storage_dir TEXT,
          mode TEXT NOT NULL DEFAULT 'plan_execute',
          default_codex_model TEXT,
          default_codex_effort TEXT,
          lock_codex_model INTEGER NOT NULL DEFAULT 1,
          role_models_json TEXT NOT NULL DEFAULT '{}',
          language TEXT NOT NULL DEFAULT 'zh-CN',
          max_parallel_codex INTEGER NOT NULL DEFAULT 4,
          default_approval_policy TEXT NOT NULL DEFAULT 'on-request',
          max_reworks INTEGER NOT NULL DEFAULT 3,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO projects_v2 (
          id, name, root_path, storage_dir, mode, default_codex_model, default_codex_effort,
          lock_codex_model, role_models_json, language, max_parallel_codex,
          default_approval_policy, max_reworks, created_at, updated_at
        )
        SELECT
          id, name, root_path, storage_dir, mode, default_codex_model, default_codex_effort,
          lock_codex_model, role_models_json, language, max_parallel_codex,
          default_approval_policy, max_reworks, created_at, updated_at
        FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_v2 RENAME TO projects;
        COMMIT;
      `);
    }

    const gCols = this.registryDb.prepare("PRAGMA table_info(global_settings)").all() as Array<{ name: string }>;
    const gColNames = new Set(gCols.map((c) => c.name));
    if (!gColNames.has("language")) {
      this.registryDb.exec("ALTER TABLE global_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-CN'");
    }
    if (!gColNames.has("max_parallel_codex")) {
      this.registryDb.exec("ALTER TABLE global_settings ADD COLUMN max_parallel_codex INTEGER NOT NULL DEFAULT 4");
    }
    if (!gColNames.has("google_plan")) {
      this.registryDb.exec("ALTER TABLE global_settings ADD COLUMN google_plan TEXT NOT NULL DEFAULT 'pro'");
    }
    if (!gColNames.has("chatgpt_plan")) {
      this.registryDb.exec("ALTER TABLE global_settings ADD COLUMN chatgpt_plan TEXT NOT NULL DEFAULT 'auto'");
    }

    const existingGlobal = this.registryDb.prepare("SELECT id FROM global_settings WHERE id = 1").get();
    if (!existingGlobal) {
      this.registryDb
        .prepare(
          `INSERT INTO global_settings (id, default_codex_model, default_codex_effort, lock_codex_model, default_approval_policy, role_models_json, google_plan, chatgpt_plan, updated_at)
           VALUES (1, NULL, NULL, 1, 'on-request', '{}', 'pro', 'auto', ?)`
        )
        .run(nowIso());
    }
  }

  public close(): void {
    for (const db of this.projectDbs.values()) {
      db.close();
    }
    this.projectDbs.clear();
    this.registryDb.close();
  }

  public getGlobalSettings(): GlobalModelSettings {
    const row = this.registryDb.prepare("SELECT * FROM global_settings WHERE id = 1").get() as Record<string, unknown>;
    return {
      defaultCodexModel: row.default_codex_model ? String(row.default_codex_model) : null,
      defaultCodexEffort: row.default_codex_effort ? String(row.default_codex_effort) : null,
      lockCodexModel: Boolean(row.lock_codex_model),
      defaultApprovalPolicy: String(row.default_approval_policy) as GlobalModelSettings["defaultApprovalPolicy"],
      roleModels: safeJsonParse<RoleModelMap>(row.role_models_json, {}),
      language: (row.language ? String(row.language) : "zh-CN") as TeamLanguage,
      maxParallelCodex: Number(row.max_parallel_codex ?? 4),
      googlePlan: (row.google_plan ? String(row.google_plan) : "pro") as GooglePlanTier,
      chatgptPlan: (row.chatgpt_plan ? String(row.chatgpt_plan) : "auto") as ChatGptPlanTier,
      updatedAt: String(row.updated_at),
    };
  }

  public updateGlobalSettings(patch: {
    defaultCodexModel?: string | null;
    defaultCodexEffort?: string | null;
    lockCodexModel?: boolean;
    defaultApprovalPolicy?: GlobalModelSettings["defaultApprovalPolicy"];
    roleModels?: RoleModelMap;
    language?: TeamLanguage;
    maxParallelCodex?: number;
    googlePlan?: GooglePlanTier;
    chatgptPlan?: ChatGptPlanTier;
  }): GlobalModelSettings {
    const cur = this.getGlobalSettings();
    const next: GlobalModelSettings = {
      defaultCodexModel: patch.defaultCodexModel !== undefined ? patch.defaultCodexModel : cur.defaultCodexModel,
      defaultCodexEffort: patch.defaultCodexEffort !== undefined ? patch.defaultCodexEffort : cur.defaultCodexEffort,
      lockCodexModel: patch.lockCodexModel !== undefined ? patch.lockCodexModel : cur.lockCodexModel,
      defaultApprovalPolicy: patch.defaultApprovalPolicy ?? cur.defaultApprovalPolicy,
      roleModels: patch.roleModels !== undefined ? patch.roleModels : cur.roleModels,
      language: patch.language ?? cur.language,
      maxParallelCodex: patch.maxParallelCodex !== undefined ? Math.max(1, Math.min(8, patch.maxParallelCodex)) : cur.maxParallelCodex,
      googlePlan: patch.googlePlan ?? cur.googlePlan,
      chatgptPlan: patch.chatgptPlan ?? cur.chatgptPlan,
      updatedAt: nowIso(),
    };
    this.registryDb
      .prepare(
        `UPDATE global_settings
         SET default_codex_model = ?, default_codex_effort = ?, lock_codex_model = ?, default_approval_policy = ?, role_models_json = ?, language = ?, max_parallel_codex = ?, google_plan = ?, chatgpt_plan = ?, updated_at = ?
         WHERE id = 1`
      )
      .run(
        next.defaultCodexModel,
        next.defaultCodexEffort,
        next.lockCodexModel ? 1 : 0,
        next.defaultApprovalPolicy,
        JSON.stringify(next.roleModels),
        next.language,
        next.maxParallelCodex,
        next.googlePlan,
        next.chatgptPlan,
        next.updatedAt
      );
    return next;
  }

  public resolveCodexConfig(opts: {
    projectId?: string | null;
    role?: string;
    requestedModel?: string;
    requestedEffort?: string;
    requestedApprovalPolicy?: "on-request" | "untrusted" | "never";
  }): {
    model: string | undefined;
    effort: string | undefined;
    approvalPolicy: "on-request" | "untrusted" | "never";
    enforcedByUserLock: boolean;
    roleKey: RolePresetKey;
    language: TeamLanguage;
    maxParallelCodex: number;
  } {
    const globalCfg = this.getGlobalSettings();
    const proj = opts.projectId ? this.getProject(opts.projectId) : null;
    const roleKey = inferRolePreset(opts.role);

    const lock = proj ? proj.lockCodexModel : globalCfg.lockCodexModel;
    const approvalPolicy = opts.requestedApprovalPolicy ?? proj?.defaultApprovalPolicy ?? globalCfg.defaultApprovalPolicy;
    const language = proj?.language ?? globalCfg.language;
    const maxParallelCodex = proj?.maxParallelCodex ?? globalCfg.maxParallelCodex;

    const projRole = proj?.roleModels?.[roleKey];
    const globRole = globalCfg.roleModels?.[roleKey];
    const configuredModel = projRole?.model || proj?.defaultCodexModel || globRole?.model || globalCfg.defaultCodexModel || undefined;
    const configuredEffort = projRole?.effort || proj?.defaultCodexEffort || globRole?.effort || globalCfg.defaultCodexEffort || undefined;

    if (lock && (configuredModel || configuredEffort)) {
      return {
        model: configuredModel ?? opts.requestedModel,
        effort: configuredEffort ?? opts.requestedEffort,
        approvalPolicy,
        enforcedByUserLock: true,
        roleKey,
        language,
        maxParallelCodex,
      };
    }

    return {
      model: opts.requestedModel ?? configuredModel,
      effort: opts.requestedEffort ?? configuredEffort,
      approvalPolicy,
      enforcedByUserLock: false,
      roleKey,
      language,
      maxParallelCodex,
    };
  }

  private mapProject(row: Record<string, unknown>): ProjectRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      storageDir: row.storage_dir ? String(row.storage_dir) : null,
      mode: String(row.mode) as CollaborationMode,
      defaultCodexModel: row.default_codex_model ? String(row.default_codex_model) : null,
      defaultCodexEffort: row.default_codex_effort ? String(row.default_codex_effort) : null,
      lockCodexModel: Boolean(row.lock_codex_model ?? 1),
      roleModels: safeJsonParse<RoleModelMap>(row.role_models_json, {}),
      language: (row.language ? String(row.language) : "zh-CN") as TeamLanguage,
      maxParallelCodex: Number(row.max_parallel_codex ?? 4),
      defaultApprovalPolicy: String(row.default_approval_policy) as ProjectRecord["defaultApprovalPolicy"],
      maxReworks: Number(row.max_reworks ?? 3),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public listProjects(): ProjectRecord[] {
    const rows = this.registryDb
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProject(r));
  }

  public findProjectByPath(dirPath: string): ProjectRecord | null {
    const resolved = path.resolve(dirPath);
    const all = this.listProjects();
    // 1. Exact root_path match (most recently updated if multiple isolated projects share the folder)
    const exact = all.find((p) => p.rootPath === resolved);
    if (exact) return exact;
    // 2. Nearest ancestor root_path (e.g. git worktree or subfolder inside a registered project)
    let best: ProjectRecord | null = null;
    for (const p of all) {
      const prefix = p.rootPath.endsWith(path.sep) ? p.rootPath : `${p.rootPath}${path.sep}`;
      if (resolved.startsWith(prefix)) {
        if (!best || p.rootPath.length > best.rootPath.length) {
          best = p;
        }
      }
    }
    return best;
  }

  public getProject(projectIdOrPath: string): ProjectRecord | null {
    const trimmed = projectIdOrPath.trim();
    if (!trimmed) return null;
    const byId = this.registryDb
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(trimmed) as Record<string, unknown> | undefined;
    if (byId) return this.mapProject(byId);

    const resolved = path.resolve(trimmed);
    const byPath = this.registryDb
      .prepare("SELECT * FROM projects WHERE root_path = ? ORDER BY updated_at DESC LIMIT 1")
      .get(resolved) as Record<string, unknown> | undefined;
    if (byPath) return this.mapProject(byPath);

    // Exact case-insensitive project name match (only when unique)
    const byNameRows = this.registryDb
      .prepare("SELECT * FROM projects WHERE lower(name) = lower(?)")
      .all(trimmed) as Record<string, unknown>[];
    if (byNameRows.length === 1) return this.mapProject(byNameRows[0]);
    return null;
  }

  public ensureProject(
    rootPath: string,
    opts?: {
      name?: string;
      forceNew?: boolean;
      mode?: CollaborationMode;
      defaultCodexModel?: string | null;
      defaultCodexEffort?: string | null;
      lockCodexModel?: boolean;
      roleModels?: RoleModelMap;
      language?: TeamLanguage;
      maxParallelCodex?: number;
      defaultApprovalPolicy?: ProjectRecord["defaultApprovalPolicy"];
      maxReworks?: number;
    }
  ): ProjectRecord {
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`项目目录不存在: ${resolved}`);
    }

    const samePathRows = this.registryDb
      .prepare("SELECT * FROM projects WHERE root_path = ? ORDER BY updated_at DESC")
      .all(resolved) as Record<string, unknown>[];
    const samePathProjects = samePathRows.map((r) => this.mapProject(r));

    const ts = nowIso();
    const requestedName = opts?.name?.trim() || "";

    if (!opts?.forceNew && samePathProjects.length > 0) {
      // If a distinct project name is given in an already-used folder, isolate it as a separate project!
      if (requestedName) {
        const sameName = samePathProjects.find((p) => p.name.toLowerCase() === requestedName.toLowerCase());
        if (sameName) {
          const patch = { ...opts };
          delete patch.forceNew;
          if (Object.keys(patch).length > 0) return this.updateProject(sameName.id, patch);
          this.getProjectDb(sameName);
          return sameName;
        }
        // Different name in same folder -> fall through to create an isolated project!
      } else {
        const existing = samePathProjects[0];
        const patch = { ...opts };
        delete patch.forceNew;
        if (Object.keys(patch).length > 0) return this.updateProject(existing.id, patch);
        this.getProjectDb(existing);
        return existing;
      }
    }

    const globalCfg = this.getGlobalSettings();
    const id = randomUUID().slice(0, 8);
    const name = requestedName || path.basename(resolved) || "Project";
    // First project in a directory uses <rootPath>/.duo-team; additional isolated projects use <rootPath>/.duo-team/projects/<id>
    const storageDir =
      samePathProjects.length > 0 || opts?.forceNew
        ? path.join(resolved, ".duo-team", "projects", id)
        : null;
    const mode: CollaborationMode = opts?.mode ?? "plan_execute";
    const defaultCodexModel = opts?.defaultCodexModel !== undefined ? opts.defaultCodexModel : globalCfg.defaultCodexModel;
    const defaultCodexEffort = opts?.defaultCodexEffort !== undefined ? opts.defaultCodexEffort : globalCfg.defaultCodexEffort;
    const lockCodexModel = opts?.lockCodexModel !== undefined ? opts.lockCodexModel : globalCfg.lockCodexModel;
    const roleModels = opts?.roleModels !== undefined ? opts.roleModels : globalCfg.roleModels;
    const language = opts?.language ?? globalCfg.language;
    const maxParallelCodex = opts?.maxParallelCodex ?? globalCfg.maxParallelCodex;
    const defaultApprovalPolicy = opts?.defaultApprovalPolicy ?? globalCfg.defaultApprovalPolicy;
    const maxReworks = opts?.maxReworks ?? 3;

    this.registryDb
      .prepare(
        `INSERT INTO projects (id, name, root_path, storage_dir, mode, default_codex_model, default_codex_effort, lock_codex_model, role_models_json, language, max_parallel_codex, default_approval_policy, max_reworks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        resolved,
        storageDir,
        mode,
        defaultCodexModel,
        defaultCodexEffort,
        lockCodexModel ? 1 : 0,
        JSON.stringify(roleModels),
        language,
        maxParallelCodex,
        defaultApprovalPolicy,
        maxReworks,
        ts,
        ts
      );

    const project = this.getProject(id)!;
    this.getProjectDb(project);
    return project;
  }

  public updateProject(
    projectId: string,
    patch: {
      name?: string;
      mode?: CollaborationMode;
      defaultCodexModel?: string | null;
      defaultCodexEffort?: string | null;
      lockCodexModel?: boolean;
      roleModels?: RoleModelMap;
      language?: TeamLanguage;
      maxParallelCodex?: number;
      defaultApprovalPolicy?: ProjectRecord["defaultApprovalPolicy"];
      maxReworks?: number;
    }
  ): ProjectRecord {
    const current = this.getProject(projectId);
    if (!current) throw new Error(`项目不存在: ${projectId}`);
    const next: ProjectRecord = {
      ...current,
      name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
      mode: patch.mode ?? current.mode,
      defaultCodexModel: patch.defaultCodexModel !== undefined ? patch.defaultCodexModel : current.defaultCodexModel,
      defaultCodexEffort: patch.defaultCodexEffort !== undefined ? patch.defaultCodexEffort : current.defaultCodexEffort,
      lockCodexModel: patch.lockCodexModel !== undefined ? patch.lockCodexModel : current.lockCodexModel,
      roleModels: patch.roleModels !== undefined ? patch.roleModels : current.roleModels,
      language: patch.language ?? current.language,
      maxParallelCodex: patch.maxParallelCodex !== undefined ? Math.max(1, Math.min(8, patch.maxParallelCodex)) : current.maxParallelCodex,
      defaultApprovalPolicy: patch.defaultApprovalPolicy ?? current.defaultApprovalPolicy,
      maxReworks: patch.maxReworks ?? current.maxReworks,
      updatedAt: nowIso(),
    };
    this.registryDb
      .prepare(
        `UPDATE projects
         SET name = ?, mode = ?, default_codex_model = ?, default_codex_effort = ?, lock_codex_model = ?, role_models_json = ?, language = ?, max_parallel_codex = ?, default_approval_policy = ?, max_reworks = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.name,
        next.mode,
        next.defaultCodexModel,
        next.defaultCodexEffort,
        next.lockCodexModel ? 1 : 0,
        JSON.stringify(next.roleModels),
        next.language,
        next.maxParallelCodex,
        next.defaultApprovalPolicy,
        next.maxReworks,
        next.updatedAt,
        current.id
      );
    return next;
  }

  private teamDir(project: ProjectRecord): string {
    return project.storageDir ? project.storageDir : path.join(project.rootPath, ".duo-team");
  }

  private getProjectDb(project: ProjectRecord): DatabaseSync {
    const cached = this.projectDbs.get(project.id);
    if (cached) return cached;

    const dir = this.teamDir(project);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    const memPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath, DEFAULT_MEMORY_TEMPLATE(project.name, project.rootPath), "utf8");
    }

    const db = new DatabaseSync(path.join(dir, "ledger.sqlite"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT 'codex',
        reviewer TEXT NOT NULL DEFAULT 'gemini',
        depends_on TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'todo',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        verify_command TEXT,
        rework_count INTEGER NOT NULL DEFAULT 0,
        max_reworks INTEGER NOT NULL DEFAULT 3,
        codex_thread_id TEXT,
        worktree_path TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]',
        last_verify_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        side TEXT,
        content TEXT NOT NULL,
        refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        thread_id TEXT PRIMARY KEY,
        task_id TEXT,
        role TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        last_summary TEXT NOT NULL DEFAULT '',
        final_output TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'decision',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        source_agent TEXT NOT NULL DEFAULT 'Human',
        refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pinned_files (
        rel_path TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        pinned_at TEXT NOT NULL
      );
    `);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          id UNINDEXED,
          title,
          content,
          tags,
          tokenize = 'unicode61'
        );
      `);
    } catch {
      // Fallback gracefully if FTS5 extension is unavailable
    }
    this.projectDbs.set(project.id, db);
    return db;
  }

  private mapMemoryItem(row: Record<string, unknown>): MemoryItemRecord {
    return {
      id: String(row.id),
      category: String(row.category) as MemoryCategory,
      title: String(row.title),
      content: String(row.content),
      tags: safeJsonParse<string[]>(row.tags, []),
      pinned: Boolean(row.pinned),
      sourceAgent: String(row.source_agent ?? "Human"),
      refs: safeJsonParse<string[]>(row.refs, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public addMemoryItem(
    projectId: string,
    input: {
      category: MemoryCategory;
      title: string;
      content: string;
      tags?: string[];
      pinned?: boolean;
      sourceAgent?: string;
      refs?: string[];
    }
  ): MemoryItemRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const id = `MEM-${randomUUID().slice(0, 6).toUpperCase()}`;
    const ts = nowIso();
    const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const refs = (input.refs ?? []).map((r) => r.trim()).filter(Boolean);

    db.prepare(
      `INSERT INTO memory_items (id, category, title, content, tags, pinned, source_agent, refs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.category,
      input.title.trim(),
      input.content.trim(),
      JSON.stringify(tags),
      input.pinned ? 1 : 0,
      input.sourceAgent ?? "Team",
      JSON.stringify(refs),
      ts,
      ts
    );
    try {
      db.prepare("INSERT INTO memory_fts (id, title, content, tags) VALUES (?, ?, ?, ?)").run(
        id,
        input.title.trim(),
        input.content.trim(),
        tags.join(" ")
      );
    } catch {
      // ignore if FTS unavailable
    }
    this.syncMemoryMarkdown(project.id);
    this.touchProject(project.id);
    return this.searchMemoryItems(project.id, {}).find((m) => m.id === id)!;
  }

  public toggleMemoryPin(projectId: string, memoryId: string, pinned?: boolean): MemoryItemRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const row = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`记忆条目不存在: ${memoryId}`);
    const nextPinned = pinned !== undefined ? (pinned ? 1 : 0) : row.pinned ? 0 : 1;
    db.prepare("UPDATE memory_items SET pinned = ?, updated_at = ? WHERE id = ?").run(nextPinned, nowIso(), memoryId);
    this.syncMemoryMarkdown(project.id);
    this.touchProject(project.id);
    return this.mapMemoryItem(db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId) as Record<string, unknown>);
  }

  public deleteMemoryItem(projectId: string, memoryId: string): boolean {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const info = db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);
    try {
      db.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
    } catch {
      // ignore
    }
    this.syncMemoryMarkdown(project.id);
    this.touchProject(project.id);
    return Number(info.changes ?? 0) > 0;
  }

  public searchMemoryItems(
    projectId: string,
    opts?: { query?: string; category?: MemoryCategory | "all"; pinnedOnly?: boolean; limit?: number }
  ): MemoryItemRecord[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const limit = opts?.limit ?? 80;
    const query = opts?.query?.trim() ?? "";

    let rows: Record<string, unknown>[] = [];
    if (query) {
      const ftsIds = new Set<string>();
      try {
        // Safe FTS5 phrase/prefix matching for alphanumeric tokens
        const safeTerms = query
          .split(/\s+/)
          .map((t) => t.replace(/["'()*^:]/g, ""))
          .filter((t) => t.length >= 2);
        if (safeTerms.length > 0) {
          const matchExpr = safeTerms.map((t) => `"${t}"*`).join(" OR ");
          const ftsRows = db.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?").all(matchExpr, limit) as Array<{ id: string }>;
          for (const r of ftsRows) ftsIds.add(String(r.id));
        }
      } catch {
        // ignore FTS syntax edge cases
      }

      const likePat = `%${query}%`;
      const likeRows = db
        .prepare(
          `SELECT * FROM memory_items
           WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
           ORDER BY pinned DESC, updated_at DESC LIMIT ?`
        )
        .all(likePat, likePat, likePat, limit) as Record<string, unknown>[];

      const seen = new Set(likeRows.map((r) => String(r.id)));
      rows = [...likeRows];
      for (const id of ftsIds) {
        if (!seen.has(id)) {
          const extra = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          if (extra) rows.push(extra);
        }
      }
    } else {
      rows = db
        .prepare("SELECT * FROM memory_items ORDER BY pinned DESC, updated_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[];
    }

    let items = rows.map((r) => this.mapMemoryItem(r));
    if (opts?.category && opts.category !== "all") {
      items = items.filter((m) => m.category === opts.category);
    }
    if (opts?.pinnedOnly) {
      items = items.filter((m) => m.pinned);
    }
    return items.slice(0, limit);
  }

  public syncMemoryMarkdown(projectId: string): void {
    const project = this.getProject(projectId);
    if (!project) return;
    const items = this.searchMemoryItems(project.id, { limit: 100 });
    const pinnedFiles = this.listPinnedFiles(project.id);
    if (items.length === 0 && pinnedFiles.length === 0) return;

    const memPath = path.join(this.teamDir(project), "memory.md");
    const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : DEFAULT_MEMORY_TEMPLATE(project.name, project.rootPath);
    const marker = "<!-- DUO-TEAM-STRUCTURED-MEMORY -->";
    const basePart = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() : existing.trimEnd();

    const catLabel: Record<MemoryCategory, string> = {
      decision: "已确认决策",
      pitfall: "避坑防循环",
      fact: "关键事实与口径",
      convention: "项目规范",
    };

    const lines: string[] = [basePart, "", marker, "## 结构化共享记忆快照（自动同步）"];
    if (pinnedFiles.length > 0) {
      lines.push("", "### 焦点上下文文件（Pinned Files）");
      for (const f of pinnedFiles) {
        lines.push(`- \`${f.relPath}\`${f.note ? ` — ${f.note}` : ""}`);
      }
    }
    for (const cat of ["decision", "pitfall", "fact", "convention"] as MemoryCategory[]) {
      const group = items.filter((i) => i.category === cat);
      if (group.length === 0) continue;
      lines.push("", `### ${catLabel[cat]}`);
      for (const m of group) {
        const pinMark = m.pinned ? "[置顶] " : "";
        lines.push(`- **${pinMark}${m.title}**（${m.sourceAgent}）：${m.content}`);
      }
    }
    fs.writeFileSync(memPath, `${lines.join("\n")}\n`, "utf8");
  }

  public listPinnedFiles(projectId: string): PinnedFileRecord[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    const db = this.getProjectDb(project);
    const rows = db.prepare("SELECT * FROM pinned_files ORDER BY pinned_at DESC").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      relPath: String(r.rel_path),
      note: String(r.note ?? ""),
      pinnedAt: String(r.pinned_at),
    }));
  }

  public setPinnedFile(projectId: string, relPath: string, pinned: boolean, note = ""): PinnedFileRecord[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const normalized = relPath.replace(/^\/+/, "").trim();
    if (!normalized) throw new Error("文件路径不能为空");
    if (pinned) {
      db.prepare(
        `INSERT INTO pinned_files (rel_path, note, pinned_at) VALUES (?, ?, ?)
         ON CONFLICT(rel_path) DO UPDATE SET note = excluded.note, pinned_at = excluded.pinned_at`
      ).run(normalized, note.trim(), nowIso());
    } else {
      db.prepare("DELETE FROM pinned_files WHERE rel_path = ?").run(normalized);
    }
    this.syncMemoryMarkdown(project.id);
    this.touchProject(project.id);
    return this.listPinnedFiles(project.id);
  }

  public listWorkflowPresets(projectId: string): CustomWorkflowPreset[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    this.getProjectDb(project);
    const dir = path.join(this.teamDir(project), "workflows");
    if (!fs.existsSync(dir)) return [];
    const presets: CustomWorkflowPreset[] = [];
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as CustomWorkflowPreset;
        if (raw && typeof raw.id === "string" && typeof raw.name === "string" && Array.isArray(raw.stages)) {
          presets.push(raw);
        }
      } catch {
        // skip malformed json
      }
    }
    return presets;
  }

  public saveWorkflowPreset(
    projectId: string,
    input: {
      id: string;
      name: string;
      description?: string;
      roleModels?: RoleModelMap;
      maxReworks?: number;
      stages: CustomWorkflowStage[];
    }
  ): CustomWorkflowPreset {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    this.getProjectDb(project);
    const safeId = input.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    if (!safeId) throw new Error("工作流预设 id 仅支持字母、数字、连字符和下划线");
    if (!input.stages.length) throw new Error("自定义工作流至少需要 1 个阶段（stage）");

    const preset: CustomWorkflowPreset = {
      id: safeId,
      name: input.name.trim() || safeId,
      description: input.description?.trim() ?? "",
      roleModels: input.roleModels,
      maxReworks: input.maxReworks,
      stages: input.stages,
      updatedAt: nowIso(),
    };
    const filePath = path.join(this.teamDir(project), "workflows", `${safeId}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(preset, null, 2)}\n`, "utf8");
    this.touchProject(project.id);
    return preset;
  }

  public applyWorkflowPreset(
    projectId: string,
    presetId: string
  ): { preset: CustomWorkflowPreset; createdTasks: TaskRecord[] } {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const preset = this.listWorkflowPresets(project.id).find((p) => p.id === presetId);
    if (!preset) throw new Error(`找不到自定义工作流预设: ${presetId}`);

    this.updateProject(project.id, {
      mode: "custom",
      roleModels: preset.roleModels ?? project.roleModels,
      maxReworks: preset.maxReworks ?? project.maxReworks,
    });

    const existingIds = new Set(this.listTasks(project.id).map((t) => t.id));
    const prefix = existingIds.size > 0 ? `${preset.id.slice(0, 4).toUpperCase()}-` : "";
    const idMap = new Map<string, string>();
    for (const s of preset.stages) {
      const candidate = `${prefix}${s.id}`;
      idMap.set(s.id, existingIds.has(candidate) ? `${candidate}-${randomUUID().slice(0, 3).toUpperCase()}` : candidate);
    }

    const createdTasks: TaskRecord[] = [];
    for (const s of preset.stages) {
      const mappedId = idMap.get(s.id)!;
      const mappedDeps = (s.dependsOn ?? []).map((d) => idMap.get(d) ?? d);
      const task = this.createTask(project.id, {
        id: mappedId,
        title: s.title,
        description: s.description ?? "",
        owner: s.owner,
        reviewer: s.reviewer ?? (s.owner === "codex" ? "gemini" : "codex"),
        dependsOn: mappedDeps,
        acceptanceCriteria: s.acceptanceCriteria ?? "",
        verifyCommand: s.verifyCommand ?? null,
        maxReworks: preset.maxReworks ?? project.maxReworks,
        artifacts: s.artifacts ?? [],
      });
      createdTasks.push(task);
    }

    this.postMessage(project.id, {
      fromAgent: "Scheduler (自定义工作流)",
      toAgent: "Team",
      kind: "plan",
      content: `已套用自定义工作流模板「${preset.name}」（${preset.id}），共生成 ${createdTasks.length} 个 DAG 任务：${createdTasks.map((t) => `${t.id}·${t.title}`).join(" → ")}`,
    });

    return { preset, createdTasks };
  }

  public readMemory(projectId: string): { path: string; content: string } {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    this.getProjectDb(project);
    const memPath = path.join(this.teamDir(project), "memory.md");
    const content = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : "";
    return { path: memPath, content };
  }

  public writeMemory(projectId: string, content: string, mode: "replace" | "append" = "replace"): { path: string; content: string } {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    this.getProjectDb(project);
    const memPath = path.join(this.teamDir(project), "memory.md");
    const next = mode === "append" ? `${fs.readFileSync(memPath, "utf8").trimEnd()}\n\n${content.trim()}\n` : content;
    fs.writeFileSync(memPath, next, "utf8");
    this.touchProject(project.id);
    return { path: memPath, content: next };
  }

  private touchProject(projectId: string): void {
    this.registryDb.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), projectId);
  }

  public createTask(
    projectId: string,
    input: {
      id?: string;
      title: string;
      description?: string;
      owner?: AgentActor;
      reviewer?: AgentActor | "none";
      dependsOn?: string[];
      acceptanceCriteria?: string;
      verifyCommand?: string | null;
      maxReworks?: number;
      artifacts?: string[];
    }
  ): TaskRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const id = input.id?.trim() || `T-${randomUUID().slice(0, 6).toUpperCase()}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, owner, reviewer, depends_on, status,
        acceptance_criteria, verify_command, rework_count, max_reworks,
        artifacts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, 0, ?, ?, ?, ?)`
    ).run(
      id,
      input.title.trim(),
      input.description ?? "",
      input.owner ?? "codex",
      input.reviewer ?? "gemini",
      JSON.stringify(input.dependsOn ?? []),
      input.acceptanceCriteria ?? "",
      input.verifyCommand ?? null,
      input.maxReworks ?? project.maxReworks,
      JSON.stringify(input.artifacts ?? []),
      ts,
      ts
    );
    this.touchProject(project.id);
    return this.getTask(project.id, id)!;
  }

  public updateTask(
    projectId: string,
    taskId: string,
    patch: {
      title?: string;
      description?: string;
      owner?: AgentActor;
      reviewer?: AgentActor | "none";
      dependsOn?: string[];
      status?: TaskStatus;
      acceptanceCriteria?: string;
      verifyCommand?: string | null;
      incrementRework?: boolean;
      codexThreadId?: string | null;
      worktreePath?: string | null;
      artifacts?: string[];
      lastVerify?: VerificationResult | null;
    }
  ): TaskRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const existing = this.getTask(project.id, taskId);
    if (!existing) throw new Error(`任务不存在: ${taskId}`);

    const reworkCount = existing.reworkCount + (patch.incrementRework ? 1 : 0);
    const mergedArtifacts = patch.artifacts
      ? [...new Set(patch.artifacts.map((a) => a.trim()).filter(Boolean))]
      : existing.artifacts;

    const ts = nowIso();
    db.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, owner = ?, reviewer = ?, depends_on = ?, status = ?,
        acceptance_criteria = ?, verify_command = ?, rework_count = ?, codex_thread_id = ?,
        worktree_path = ?, artifacts = ?, last_verify_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      patch.title ?? existing.title,
      patch.description ?? existing.description,
      patch.owner ?? existing.owner,
      patch.reviewer ?? existing.reviewer,
      JSON.stringify(patch.dependsOn ?? existing.dependsOn),
      patch.status ?? existing.status,
      patch.acceptanceCriteria ?? existing.acceptanceCriteria,
      patch.verifyCommand !== undefined ? patch.verifyCommand : existing.verifyCommand,
      reworkCount,
      patch.codexThreadId !== undefined ? patch.codexThreadId : existing.codexThreadId,
      patch.worktreePath !== undefined ? patch.worktreePath : existing.worktreePath,
      JSON.stringify(mergedArtifacts),
      patch.lastVerify !== undefined ? (patch.lastVerify ? JSON.stringify(patch.lastVerify) : null) : (existing.lastVerify ? JSON.stringify(existing.lastVerify) : null),
      ts,
      taskId
    );
    this.touchProject(project.id);
    return this.getTask(project.id, taskId)!;
  }

  public listTasks(projectId: string): TaskRecord[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Record<string, unknown>[];
    const doneIds = new Set(rows.filter((r) => r.status === "done").map((r) => String(r.id)));
    return rows.map((r) => {
      const dependsOn = safeJsonParse<string[]>(r.depends_on, []);
      const ready = dependsOn.every((dep) => doneIds.has(dep));
      return {
        id: String(r.id),
        title: String(r.title),
        description: String(r.description ?? ""),
        owner: String(r.owner) as AgentActor,
        reviewer: String(r.reviewer) as AgentActor | "none",
        dependsOn,
        ready,
        status: String(r.status) as TaskStatus,
        acceptanceCriteria: String(r.acceptance_criteria ?? ""),
        verifyCommand: r.verify_command ? String(r.verify_command) : null,
        reworkCount: Number(r.rework_count ?? 0),
        maxReworks: Number(r.max_reworks ?? 3),
        codexThreadId: r.codex_thread_id ? String(r.codex_thread_id) : null,
        worktreePath: r.worktree_path ? String(r.worktree_path) : null,
        artifacts: safeJsonParse<string[]>(r.artifacts, []),
        lastVerify: safeJsonParse<VerificationResult | null>(r.last_verify_json, null),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      };
    });
  }

  public getTask(projectId: string, taskId: string): TaskRecord | null {
    return this.listTasks(projectId).find((t) => t.id === taskId) ?? null;
  }

  public postMessage(
    projectId: string,
    input: {
      taskId?: string | null;
      fromAgent: string;
      toAgent: string;
      kind: MessageKind;
      round?: number;
      side?: MessageRecord["side"];
      content: string;
      refs?: string[];
    }
  ): MessageRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const id = `M-${randomUUID().slice(0, 8)}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO messages (id, task_id, from_agent, to_agent, kind, round, side, content, refs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.taskId ?? null,
      input.fromAgent,
      input.toAgent,
      input.kind,
      input.round ?? 1,
      input.side ?? null,
      input.content,
      JSON.stringify(input.refs ?? []),
      ts
    );
    this.touchProject(project.id);
    return {
      id,
      taskId: input.taskId ?? null,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      kind: input.kind,
      round: input.round ?? 1,
      side: input.side ?? null,
      content: input.content,
      refs: input.refs ?? [],
      createdAt: ts,
    };
  }

  public listMessages(projectId: string, opts?: { taskId?: string; limit?: number }): MessageRecord[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const db = this.getProjectDb(project);
    const limit = opts?.limit ?? 100;
    const rows = (
      opts?.taskId
        ? db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC LIMIT ?").all(opts.taskId, limit)
        : db.prepare("SELECT * FROM messages ORDER BY created_at ASC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      taskId: r.task_id ? String(r.task_id) : null,
      fromAgent: String(r.from_agent),
      toAgent: String(r.to_agent),
      kind: String(r.kind) as MessageKind,
      round: Number(r.round ?? 1),
      side: r.side ? (String(r.side) as MessageRecord["side"]) : null,
      content: String(r.content),
      refs: safeJsonParse<string[]>(r.refs, []),
      createdAt: String(r.created_at),
    }));
  }

  public saveRun(projectId: string, run: PersistedRunRecord): void {
    const project = this.getProject(projectId);
    if (!project) return;
    const db = this.getProjectDb(project);
    db.prepare(
      `INSERT INTO runs (thread_id, task_id, role, model, effort, cwd, status, last_summary, final_output, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         task_id = excluded.task_id,
         role = excluded.role,
         model = excluded.model,
         effort = excluded.effort,
         cwd = excluded.cwd,
         status = excluded.status,
         last_summary = excluded.last_summary,
         final_output = excluded.final_output,
         updated_at = excluded.updated_at`
    ).run(
      run.threadId,
      run.taskId,
      run.role,
      run.model,
      run.effort,
      run.cwd,
      run.status,
      run.lastSummary,
      run.finalOutput,
      run.updatedAt
    );
  }

  public listRuns(projectId: string): PersistedRunRecord[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    const db = this.getProjectDb(project);
    const rows = db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 50").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      threadId: String(r.thread_id),
      taskId: r.task_id ? String(r.task_id) : null,
      role: String(r.role),
      model: r.model ? String(r.model) : null,
      effort: r.effort ? String(r.effort) : null,
      cwd: String(r.cwd),
      status: String(r.status),
      lastSummary: String(r.last_summary ?? ""),
      finalOutput: String(r.final_output ?? ""),
      updatedAt: String(r.updated_at),
    }));
  }

  public runVerification(projectId: string, taskId: string, overrideCommand?: string): VerificationResult {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const task = this.getTask(project.id, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    const cwd = task.worktreePath && fs.existsSync(task.worktreePath) ? task.worktreePath : project.rootPath;
    const command = overrideCommand ?? task.verifyCommand;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    let cmdPassed = true;

    if (command && command.trim()) {
      const res = spawnSync(command, {
        cwd,
        shell: true,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      exitCode = res.status ?? (res.error ? 1 : 0);
      stdout = (res.stdout ?? "").slice(-4000);
      stderr = (res.stderr ?? (res.error ? res.error.message : "")).slice(-4000);
      cmdPassed = exitCode === 0;
    }

    const artifactChecks = task.artifacts.map((relPath) => {
      const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        return { path: relPath, exists: false, sizeBytes: 0, sha256: null };
      }
      const stat = fs.statSync(absPath);
      const hash = stat.size <= 50 * 1024 * 1024
        ? createHash("sha256").update(fs.readFileSync(absPath)).digest("hex").slice(0, 16)
        : "large-file";
      return { path: relPath, exists: true, sizeBytes: stat.size, sha256: hash };
    });

    const artifactsPassed = artifactChecks.every((a) => a.exists && a.sizeBytes > 0);
    const result: VerificationResult = {
      passed: cmdPassed && artifactsPassed,
      checkedAt: nowIso(),
      command: command ?? null,
      exitCode,
      stdout,
      stderr,
      artifacts: artifactChecks,
    };

    this.updateTask(project.id, taskId, { lastVerify: result });
    return result;
  }

  public ensureWorktree(projectId: string, taskId: string): { worktreePath: string; branch: string } {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const task = this.getTask(project.id, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.worktreePath && fs.existsSync(task.worktreePath)) {
      return { worktreePath: task.worktreePath, branch: `duo-team/${taskId.toLowerCase()}` };
    }

    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: project.rootPath, stdio: "ignore" });
    } catch {
      throw new Error("当前项目不是 Git 仓库，无需创建 worktree，请直接在项目目录协作。");
    }

    const worktreeRoot = path.join(this.teamDir(project), "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const safeId = taskId.replace(/[^A-Za-z0-9_-]/g, "_");
    const worktreePath = path.join(worktreeRoot, safeId);
    const branch = `duo-team/${safeId.toLowerCase()}`;

    if (!fs.existsSync(worktreePath)) {
      const checkBranch = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: project.rootPath,
      });
      const args = checkBranch.status === 0
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", "-b", branch, worktreePath];
      const addRes = spawnSync("git", args, { cwd: project.rootPath, encoding: "utf8" });
      if (addRes.status !== 0) {
        throw new Error(`创建 Git worktree 失败: ${addRes.stderr || addRes.stdout}`);
      }
    }

    this.updateTask(project.id, taskId, { worktreePath });
    return { worktreePath, branch };
  }
}
