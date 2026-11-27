import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

type TabKey = "models" | "board" | "workers" | "feed" | "artifacts";
type RolePresetKey = "planner" | "executor" | "reviewer";

interface RoleModelSpec {
  model: string | null;
  effort: string | null;
}
type RoleModelMap = Partial<Record<RolePresetKey, RoleModelSpec>>;

type GooglePlanTier = "free" | "pro" | "ultra" | "enterprise";
type ChatGptPlanTier = "auto" | "free" | "go" | "plus" | "pro" | "team" | "edu" | "enterprise";

interface QuotaWindowInfo {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  windowLabel: string | null;
  resetsAt: number | null;
  resetText: string | null;
}

interface SubscriptionProfile {
  google: {
    tier: GooglePlanTier;
    label: string;
    shortBadge: string;
    recommendedGeminiParallel: number;
    summary: string;
  };
  chatgpt: {
    tier: Exclude<ChatGptPlanTier, "auto">;
    configuredTier: ChatGptPlanTier;
    detectedTier: Exclude<ChatGptPlanTier, "auto"> | null;
    rawPlanType: string | null;
    label: string;
    shortBadge: string;
    recommendedMaxParallel: number;
    lowQuotaThreshold: number;
    effortCeiling: string;
    defaultEffort: string;
    summary: string;
    quota: {
      detectedPlan: Exclude<ChatGptPlanTier, "auto"> | null;
      rawPlanType: string | null;
      ordinaryUsageAllowed: boolean | null;
      primary: QuotaWindowInfo | null;
      secondary: QuotaWindowInfo | null;
      effectiveRemainingPercent: number | null;
    };
  };
  pairingTitle: string;
  pairingAdvice: string;
  recommendedRoleSplit: string;
}

interface GlobalModelSettings {
  defaultCodexModel: string | null;
  defaultCodexEffort: string | null;
  lockCodexModel: boolean;
  defaultApprovalPolicy: "on-request" | "untrusted" | "never";
  roleModels: RoleModelMap;
  language?: "zh-CN" | "en" | "auto";
  maxParallelCodex?: number;
  googlePlan?: GooglePlanTier;
  chatgptPlan?: ChatGptPlanTier;
}

interface ProjectRecord extends GlobalModelSettings {
  id: string;
  name: string;
  rootPath: string;
  storageDir?: string | null;
  mode: string;
  maxReworks: number;
}

interface CodexModelInfo {
  id: string;
  displayName: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}

interface VerificationResult {
  passed: boolean;
  checkedAt: string;
  command: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts: Array<{ path: string; exists: boolean; sizeBytes: number; sha256: string | null }>;
}

interface TaskRecord {
  id: string;
  title: string;
  description: string;
  owner: string;
  reviewer: string;
  dependsOn: string[];
  ready: boolean;
  status: string;
  acceptanceCriteria: string;
  verifyCommand: string | null;
  reworkCount: number;
  maxReworks: number;
  codexThreadId: string | null;
  worktreePath: string | null;
  artifacts: string[];
  lastVerify: VerificationResult | null;
  updatedAt: string;
}

interface MessageRecord {
  id: string;
  taskId: string | null;
  fromAgent: string;
  toAgent: string;
  kind: string;
  round: number;
  side: "pro" | "con" | "branch_a" | "branch_b" | null;
  content: string;
  refs: string[];
  createdAt: string;
}

interface PendingApproval {
  id: string;
  method: string;
  threadId: string;
  summary: string;
  createdAt: string;
}

interface ThreadSnapshot {
  threadId: string;
  role: string;
  taskId: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  status: string;
  lastError: string | null;
  reasoningSummary: string;
  latestOutput: string;
  plan: Array<{ step: string; status: string }>;
  subAgents?: Array<{
    id: string;
    tool: string;
    status: string;
    prompt: string;
    model: string | null;
    effort: string | null;
  }>;
  activities: Array<{ id: string; type: string; title: string; status: string; detail?: string; timestamp: string }>;
  pendingApprovals: PendingApproval[];
  updatedAt: string;
}

interface ScheduleAnalysis {
  totalTasks: number;
  doneTasks: number;
  runningTasks: number;
  readyTasks: string[];
  waves: Array<{ wave: number; taskIds: string[] }>;
  criticalPath: string[];
  cycles: string[][];
  stalledThreadIds: string[];
  alerts: Array<{ level: "info" | "warning" | "error"; code: string; title: string; detail: string; targetId?: string }>;
  recommendations: Array<{
    taskId: string;
    taskTitle: string;
    owner: string;
    recommendedModel: string | null;
    recommendedEffort: string | null;
    reason: string;
    enforcedByLock: boolean;
    onCriticalPath: boolean;
  }>;
  healthScore: number;
}

interface MemoryItemRecord {
  id: string;
  category: "decision" | "pitfall" | "fact" | "convention";
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  sourceAgent: string;
  refs: string[];
  createdAt: string;
  updatedAt: string;
}

interface PinnedFileRecord {
  relPath: string;
  note: string;
  pinnedAt: string;
}

interface ProjectTreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  sizeBytes?: number;
  gitStatus?: string;
  fileCount?: number;
  children?: ProjectTreeNode[];
}

interface WorkflowStageDraft {
  id: string;
  title: string;
  description: string;
  owner: "gemini" | "codex" | "human";
  reviewer: "gemini" | "codex" | "human" | "none";
  dependsOn: string[];
  verifyCommand: string;
  artifacts: string;
}

interface WorkflowPresetRecord {
  id: string;
  name: string;
  description: string;
  maxReworks?: number;
  stages: Array<{
    id: string;
    title: string;
    description?: string;
    owner: "gemini" | "codex" | "human";
    reviewer?: "gemini" | "codex" | "human" | "none";
    dependsOn?: string[];
    acceptanceCriteria?: string;
    verifyCommand?: string | null;
    artifacts?: string[];
  }>;
}

interface DashboardState {
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  globalSettings?: GlobalModelSettings;
  subscriptionProfile?: SubscriptionProfile;
  tasks: TaskRecord[];
  messages: MessageRecord[];
  runs: Array<{
    threadId: string;
    taskId: string | null;
    role: string;
    model: string | null;
    effort: string | null;
    cwd?: string;
    status: string;
    lastSummary?: string;
    finalOutput?: string;
    updatedAt: string;
  }>;
  memory: { path: string; content: string };
  memoryItems?: MemoryItemRecord[];
  pinnedFiles?: PinnedFileRecord[];
  workflowPresets?: WorkflowPresetRecord[];
  schedule?: ScheduleAnalysis;
  codex: {
    connected: boolean;
    userAgent?: string | null;
    account: Record<string, unknown> | null;
    rateLimits: Record<string, unknown> | null;
    models: Array<Record<string, unknown>>;
    activeThreads: ThreadSnapshot[];
    pendingApprovals: PendingApproval[];
    otherProjectsThreads?: Array<{
      threadId: string;
      projectId: string | null;
      projectName: string;
      role: string;
      status: string;
    }>;
    otherProjectsApprovalCount?: number;
    errors: string[];
  };
  initialTab?: TabKey;
}

interface WorkspaceInspectState {
  workspace: {
    isGitRepo: boolean;
    branch: string | null;
    changedFiles: Array<{ path: string; status: string; modifiedAt?: string }>;
    diffStat: string;
    worktrees: Array<{ path: string; branch: string; head: string }>;
    recentFiles: Array<{ path: string; status: string; modifiedAt?: string }>;
  } | null;
  projectTree?: {
    tree: ProjectTreeNode[];
    totalFiles: number;
    totalDirs: number;
  } | null;
  projectMap?: {
    generatedAt: string;
    totalFiles: number;
    totalDirs: number;
    outline: string;
    byExtension: Record<string, number>;
  } | null;
  pinnedFiles?: PinnedFileRecord[];
  toolchain: Array<{
    id: string;
    label: string;
    category: "research" | "dev" | "doc";
    available: boolean;
    version: string | null;
  }>;
}

interface SubagentDraft {
  id: string;
  role: string;
  model: string;
  effort: string;
  sandbox: "read-only" | "workspace-write";
  prompt: string;
}

const MODE_LABELS: Record<string, string> = {
  plan_execute: "规划执行",
  co_create: "双向共创",
  parallel_research: "双盲并行研究",
  debate: "结构化辩论",
  autonomous_team: "自主团队",
  custom: "自定义工作流",
};

const MODE_CATALOG: Array<{
  id: string;
  name: string;
  tag: string;
  desc: string;
}> = [
  {
    id: "plan_execute",
    name: "规划执行",
    tag: "支持角色互换",
    desc: "先拆解任务图并经跨模型挑刺评审，再并发执行与自愈验收。支持 Gemini 规划，也可互换由 Codex 当首席架构师。",
  },
  {
    id: "co_create",
    name: "双向共创",
    tag: "比较优势分工",
    desc: "Gemini 擅长文献框架、联网检索与润色，Codex 擅长重代码、计量脚本与单测，全程共享记忆并在关键节点互审。",
  },
  {
    id: "parallel_research",
    name: "双盲并行研究",
    tag: "首轮防锚定",
    desc: "锁定同一问题与资料，双方同时独立产出分析分支且首轮互不可见，最后并排对比共识、分歧与缺失证据。",
  },
  {
    id: "debate",
    name: "结构化辩论",
    tag: "正反多轮质证",
    desc: "Gemini 与 Codex 分持正反方首轮盲写立论，随后保留推理上下文多轮交锋反驳，最终按可验证证据给出裁决。",
  },
  {
    id: "autonomous_team",
    name: "自主团队",
    tag: "多波次全自动",
    desc: "自动拓扑排波、批量并发拉起多路 Subagent 并开 Worktree 隔离，失败自动打回自愈，仅遇重大分歧暂停问你。",
  },
  {
    id: "custom",
    name: "自定义工作流",
    tag: "可复用 SOP",
    desc: "把固定工序存为可复用模板，可视化配好每步执行人、前置依赖与验收命令，随时一键套用批量生成任务看板。",
  },
];

const WORKFLOW_STARTERS: Record<
  "paper" | "dev" | "research",
  { id: string; name: string; description: string; maxReworks: number; stages: WorkflowStageDraft[] }
> = {
  paper: {
    id: "econ-paper",
    name: "计量实证论文流水线",
    description: "数据审计 → 基准回归与图表 → 稳健性检验 → 正文与模拟审稿",
    maxReworks: 3,
    stages: [
      { id: "S1", title: "数据质量审计与描述性统计", description: "检查缺失值、异常值与样本区间", owner: "codex", reviewer: "gemini", dependsOn: [], verifyCommand: "", artifacts: "output/data_audit.md" },
      { id: "S2", title: "基准回归与核心可视化图表", description: "运行主回归并导出规范表格与图", owner: "codex", reviewer: "gemini", dependsOn: ["S1"], verifyCommand: "", artifacts: "output/table_main.tex" },
      { id: "S3", title: "稳健性与异质性检验", description: "安慰剂检验、替代变量与分组回归", owner: "codex", reviewer: "gemini", dependsOn: ["S2"], verifyCommand: "", artifacts: "output/table_robust.tex" },
      { id: "S4", title: "正文撰写与 Referee #2 模拟审稿", description: "Gemini 撰写实证章节，Codex 挑刺审查", owner: "gemini", reviewer: "codex", dependsOn: ["S3"], verifyCommand: "", artifacts: "" },
    ],
  },
  dev: {
    id: "fullstack-tdd",
    name: "全栈 TDD 并行开发流",
    description: "接口契约设计 → 前后端并行编码与单测 → 跨模型安全与回归终审",
    maxReworks: 3,
    stages: [
      { id: "S1", title: "架构与接口契约设计", description: "冻结数据模型与 API 接口", owner: "gemini", reviewer: "codex", dependsOn: [], verifyCommand: "", artifacts: "docs/api-spec.md" },
      { id: "S2", title: "后端实现与单元测试", description: "实现核心服务与单测", owner: "codex", reviewer: "gemini", dependsOn: ["S1"], verifyCommand: "npm test", artifacts: "" },
      { id: "S3", title: "前端界面与交互实现", description: "与后端同波次并行开发 UI", owner: "codex", reviewer: "gemini", dependsOn: ["S1"], verifyCommand: "npm run typecheck", artifacts: "" },
      { id: "S4", title: "跨模型 Code Review 与文档同步", description: "全量回归验收并更新文档", owner: "gemini", reviewer: "codex", dependsOn: ["S2", "S3"], verifyCommand: "npm test", artifacts: "" },
    ],
  },
  research: {
    id: "deep-report",
    name: "深度调研与报告生产流",
    description: "双路资料核查 → 数据整理与制图 → 报告起草与反方挑刺定稿",
    maxReworks: 2,
    stages: [
      { id: "S1", title: "多源文献与行业资料检索", description: "收集一手资料并沉淀事实到共享记忆", owner: "gemini", reviewer: "codex", dependsOn: [], verifyCommand: "", artifacts: "" },
      { id: "S2", title: "定量数据清洗与图表脚本", description: "基于公开数据生成可复现图表", owner: "codex", reviewer: "gemini", dependsOn: ["S1"], verifyCommand: "", artifacts: "" },
      { id: "S3", title: "撰写深度报告并接受反方挑刺", description: "Gemini 成稿，Codex 检查逻辑漏洞与数字口径", owner: "gemini", reviewer: "codex", dependsOn: ["S2"], verifyCommand: "", artifacts: "" },
    ],
  },
};

const STATUS_LABELS: Record<string, string> = {
  todo: "待开始",
  running: "执行中",
  in_review: "待复核",
  rework: "返工中",
  awaiting_human: "等你决策",
  done: "已完成",
  blocked: "已阻塞",
};

const KIND_LABELS: Record<string, string> = {
  plan: "计划",
  challenge: "质疑",
  proposal: "提案",
  review: "评审",
  rework: "返工",
  rebuttal: "反驳",
  verdict: "裁决",
  human_note: "人工指令",
  system: "智能调度",
};

const ROLE_META: Array<{ key: RolePresetKey; label: string; hint: string }> = [
  { key: "planner", label: "规划 / 架构师", hint: "拆解 DAG、挑刺方案、研究设计" },
  { key: "executor", label: "主力执行者", hint: "编码、计量脚本、数据清洗、文稿" },
  { key: "reviewer", label: "独立评审 / 辩手", hint: "交叉复核、缺陷定位、正反质证" },
];

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function normalizeModels(raw: Array<Record<string, unknown>>): CodexModelInfo[] {
  const result: CodexModelInfo[] = [];
  for (const m of raw) {
    const id = String(m.id ?? m.model ?? m.slug ?? "").trim();
    if (!id) continue;
    const rawEfforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [];
    const efforts = rawEfforts
      .map((e) => (typeof e === "string" ? e : String((e as Record<string, unknown>)?.reasoningEffort ?? "")))
      .filter(Boolean);
    result.push({
      id,
      displayName: String(m.displayName ?? id),
      description: typeof m.description === "string" ? m.description : undefined,
      efforts: efforts.length > 0 ? efforts : FALLBACK_EFFORTS,
      defaultEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
    });
  }
  return result;
}

function parseQuota(rateLimits: Record<string, unknown> | null) {
  if (!rateLimits) return null;
  const rl = rateLimits as {
    ordinaryUsageAllowed?: boolean | null;
    rateLimits?: {
      planType?: string | null;
      primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
    };
  };
  const primary = rl.rateLimits?.primary;
  const used = typeof primary?.usedPercent === "number" ? primary.usedPercent : null;
  const remaining = used !== null ? Math.max(0, 100 - used) : null;
  const resetText = primary?.resetsAt ? new Date(primary.resetsAt * 1000).toLocaleString() : null;
  const windowDays = primary?.windowDurationMins ? Math.round(primary.windowDurationMins / 1440) : null;
  return { allowed: rl.ordinaryUsageAllowed, planType: rl.rateLimits?.planType ?? null, used, remaining, resetText, windowDays };
}

// Crisp inline SVGs
const IconRefresh = ({ spinning }: { spinning?: boolean }) => (
  <svg className={`icon ${spinning ? "spin" : ""}`} viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
);
const IconSpark = () => (
  <svg className="icon" viewBox="0 0 24 24"><path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.4l-1.9-5.3L5 10.2l5.1-1.9L12 3z"/></svg>
);
const IconCpu = () => (
  <svg className="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>
);
const IconFile = () => (
  <svg className="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
);
const IconSend = () => (
  <svg className="icon" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
);
const IconCheck = () => (
  <svg className="icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
);
const IconPlay = () => (
  <svg className="icon" viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg>
);
const IconWrench = () => (
  <svg className="icon" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
);
const IconFolder = () => (
  <svg className="icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
);
const IconChev = () => (
  <svg className="icon" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
);
const IconPin = () => (
  <svg className="icon" viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
);

const MEM_CAT_LABELS: Record<MemoryItemRecord["category"], string> = {
  decision: "已定方案",
  pitfall: "踩过的坑",
  fact: "数据口径",
  convention: "约定规则",
};

function summarizeProjectFiles(byExtension?: Record<string, number>) {
  const counts = { code: 0, doc: 0, data: 0, other: 0 };
  if (!byExtension) return counts;
  const codeExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".r", ".do", ".ado", ".go", ".rs", ".java", ".cpp", ".c", ".sh", ".sql", ".css", ".html"]);
  const docExts = new Set([".md", ".tex", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".rtf", ".qmd", ".rmd"]);
  const dataExts = new Set([".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".dta", ".rds", ".sav", ".json", ".yaml", ".yml"]);
  for (const [ext, n] of Object.entries(byExtension)) {
    const lower = ext.toLowerCase();
    if (codeExts.has(lower)) counts.code += n;
    else if (docExts.has(lower)) counts.doc += n;
    else if (dataExts.has(lower)) counts.data += n;
    else counts.other += n;
  }
  return counts;
}

function filterTreeNodes(nodes: ProjectTreeNode[], q: string): ProjectTreeNode[] {
  if (!q) return nodes;
  const lower = q.toLowerCase();
  const out: ProjectTreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === "file") {
      if (n.name.toLowerCase().includes(lower) || n.path.toLowerCase().includes(lower)) out.push(n);
    } else {
      const matchedChildren = filterTreeNodes(n.children ?? [], q);
      if (n.name.toLowerCase().includes(lower) || matchedChildren.length > 0) {
        out.push({ ...n, children: matchedChildren });
      }
    }
  }
  return out;
}

function CircularRing({ percent, size = 50, color = "#4f46e5", label }: { percent: number; size?: number; color?: string; label: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = c - (clamped / 100) * c;
  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg className="ring-svg" width={size} height={size}>
        <circle className="ring-bg" cx={size / 2} cy={size / 2} r={r} />
        <circle
          className="ring-fg"
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span style={{ position: "absolute", fontSize: 11, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

export function AppView() {
  const appRef = useRef<App | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [glider, setGlider] = useState<{ left: number; width: number; ready: boolean }>({ left: 0, width: 0, ready: false });

  const [state, setState] = useState<DashboardState | null>(null);
  const [tab, setTab] = useState<TabKey>("models");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [canMessage, setCanMessage] = useState(false);

  const [steerInputs, setSteerInputs] = useState<Record<string, string>>({});
  const [reworkNotes, setReworkNotes] = useState<Record<string, string>>({});
  const [resumeInputs, setResumeInputs] = useState<Record<string, string>>({});
  const [memoryDraft, setMemoryDraft] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectForceNew, setNewProjectForceNew] = useState(true);
  const [showNewProjectDrawer, setShowNewProjectDrawer] = useState(false);
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});
  const [feedNewestFirst, setFeedNewestFirst] = useState(true);
  const syncInFlightRef = useRef(false);
  const reqSeqRef = useRef(0);
  const [customModelId, setCustomModelId] = useState("");
  const [showCustomModel, setShowCustomModel] = useState(false);
  const [showSquadDrawer, setShowSquadDrawer] = useState(false);
  const [sideBySide, setSideBySide] = useState(true);
  const [autoSync, setAutoSync] = useState(true);

  const [updateInfo, setUpdateInfo] = useState<{
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    installMethod: string;
    message: string;
    output?: string;
  } | null>(null);
  const [updatingCli, setUpdatingCli] = useState(false);

  // Squad launcher
  const [launcherMode, setLauncherMode] = useState<"single" | "batch">("batch");
  const [manualPrompt, setManualPrompt] = useState("");
  const [manualRole, setManualRole] = useState("主力执行");
  const [manualSandbox, setManualSandbox] = useState<"read-only" | "workspace-write">("workspace-write");
  const [squad, setSquad] = useState<SubagentDraft[]>([
    { id: "s1", role: "研究/方案分支 A", model: "", effort: "", sandbox: "read-only", prompt: "" },
    { id: "s2", role: "独立评审/反方 B", model: "", effort: "", sandbox: "read-only", prompt: "" },
  ]);
  const [broadcastInput, setBroadcastInput] = useState("");

  // Board task creator & Custom Workflow Builder
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [newTaskOwner, setNewTaskOwner] = useState<"codex" | "gemini" | "human">("codex");
  const [newTaskReviewer, setNewTaskReviewer] = useState<"gemini" | "codex" | "human" | "none">("gemini");
  const [newTaskCriteria, setNewTaskCriteria] = useState("");
  const [newTaskVerifyCmd, setNewTaskVerifyCmd] = useState("");

  const [showWorkflowBuilder, setShowWorkflowBuilder] = useState(false);
  const [wfPresetId, setWfPresetId] = useState("my-workflow");
  const [wfName, setWfName] = useState("我的标准协作流程");
  const [wfDesc, setWfDesc] = useState("");
  const [wfMaxReworks, setWfMaxReworks] = useState(3);
  const [wfStages, setWfStages] = useState<WorkflowStageDraft[]>([
    { id: "S1", title: "方案设计与口径确认", description: "", owner: "gemini", reviewer: "codex", dependsOn: [], verifyCommand: "", artifacts: "" },
    { id: "S2", title: "核心代码 / 分析执行", description: "", owner: "codex", reviewer: "gemini", dependsOn: ["S1"], verifyCommand: "", artifacts: "" },
    { id: "S3", title: "交叉复核与最终交付", description: "", owner: "gemini", reviewer: "codex", dependsOn: ["S2"], verifyCommand: "", artifacts: "" },
  ]);

  // Feed human composer
  const [humanMsgKind, setHumanMsgKind] = useState<"human_note" | "verdict" | "challenge">("human_note");
  const [humanMsgText, setHumanMsgText] = useState("");

  // Workspace inspection, Project Tree & Structured Memory
  const [wsInspect, setWsInspect] = useState<WorkspaceInspectState | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({ ".duo-team": true, "duo-team": true });
  const [showRepoMap, setShowRepoMap] = useState(false);
  const [showRawMemory, setShowRawMemory] = useState(false);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [memSearch, setMemSearch] = useState("");
  const [memCatFilter, setMemCatFilter] = useState<"all" | MemoryItemRecord["category"] | "pinned">("all");
  const [newMemCat, setNewMemCat] = useState<MemoryItemRecord["category"]>("decision");
  const [newMemTitle, setNewMemTitle] = useState("");
  const [newMemContent, setNewMemContent] = useState("");
  const [newMemTags, setNewMemTags] = useState("");
  const [newMemPinned, setNewMemPinned] = useState(true);

  // Pixel-exact measurement for spring-gliding tab indicator (ResizeObserver + font ready)
  useLayoutEffect(() => {
    const updateGlider = () => {
      const btn = tabRefs.current[tab];
      if (!btn) return;
      setGlider({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
    };
    updateGlider();
    const raf = requestAnimationFrame(updateGlider);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateGlider) : null;
    if (ro && navRef.current) ro.observe(navRef.current);
    window.addEventListener("resize", updateGlider);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", updateGlider);
    };
  }, [tab, state?.tasks.length, state?.messages.length, state?.codex.activeThreads.length, state?.memoryItems?.length]);

  useEffect(() => {
    const app = new App({ name: "Duo-Team Workbench", version: "0.4.0" }, {});
    appRef.current = app;

    app.ontoolresult = (result) => {
      const sc = result.structuredContent as DashboardState | undefined;
      if (sc) {
        setState(sc);
        setMemoryDraft(sc.memory?.content ?? "");
        if (sc.initialTab) setTab(sc.initialTab);
        else setTab(sc.activeProject && sc.tasks.length > 0 ? "board" : "models");
      }
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };

    app.connect().then(async () => {
      const ctx = app.getHostContext();
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      const caps = app.getHostCapabilities() as Record<string, unknown> | undefined;
      setCanMessage(Boolean(caps?.message));
      try {
        const res = await app.callServerTool({ name: "ui_dashboard_state", arguments: {} });
        const sc = res.structuredContent as DashboardState | undefined;
        if (sc) {
          setState(sc);
          setMemoryDraft(sc.memory?.content ?? "");
          setTab(sc.activeProject && sc.tasks.length > 0 ? "board" : "models");
        }
      } catch {
        // ignore
      }
    });
  }, []);

  const models = useMemo(() => normalizeModels(state?.codex.models ?? []), [state?.codex.models]);
  const quota = useMemo(() => parseQuota(state?.codex.rateLimits ?? null), [state?.codex.rateLimits]);
  const subProfile = state?.subscriptionProfile ?? null;
  const activeGooglePlan: GooglePlanTier = subProfile?.google.tier ?? state?.globalSettings?.googlePlan ?? "pro";
  const activeChatGptConfig: ChatGptPlanTier = subProfile?.chatgpt.configuredTier ?? state?.globalSettings?.chatgptPlan ?? "auto";
  const effectiveQuotaRemaining = subProfile?.chatgpt.quota.effectiveRemainingPercent ?? quota?.remaining ?? null;
  const lowQuotaThreshold = subProfile?.chatgpt.lowQuotaThreshold ?? 15;
  const primaryWin = subProfile?.chatgpt.quota.primary ?? null;
  const secondaryWin = subProfile?.chatgpt.quota.secondary ?? null;
  const activeProject = state?.activeProject ?? null;
  const effectiveCfg: GlobalModelSettings = activeProject ?? state?.globalSettings ?? {
    defaultCodexModel: null,
    defaultCodexEffort: null,
    lockCodexModel: true,
    defaultApprovalPolicy: "on-request",
    roleModels: {},
    language: "zh-CN",
    maxParallelCodex: 4,
  };
  const selectedModelMeta = models.find((m) => m.id === effectiveCfg.defaultCodexModel) ?? null;
  const activeEfforts = selectedModelMeta?.efforts ?? FALLBACK_EFFORTS;
  const schedule = state?.schedule ?? null;
  const pendingApprovals = state?.codex.pendingApprovals ?? [];
  const activeThreads = state?.codex.activeThreads ?? [];
  const sortedActiveThreads = useMemo(() => {
    const rank = (status: string) =>
      status === "waiting_approval" ? 0 : status === "running" ? 1 : 2;
    return [...activeThreads].sort((a, b) => {
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      return Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
    });
  }, [activeThreads]);
  const otherProjectsThreads = state?.codex.otherProjectsThreads ?? [];
  const otherProjectsApprovalCount = state?.codex.otherProjectsApprovalCount ?? 0;
  const runningCount = activeThreads.filter((t) => t.status === "running").length;

  const historicalRuns = useMemo(() => {
    const activeIds = new Set(activeThreads.map((t) => t.threadId));
    return [...(state?.runs ?? [])]
      .filter((r) => !activeIds.has(r.threadId))
      .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
  }, [state?.runs, activeThreads]);

  const sortedMessages = useMemo(() => {
    const list = state?.messages ?? [];
    return feedNewestFirst ? [...list].reverse() : list;
  }, [state?.messages, feedNewestFirst]);

  const dualSideMessages = useMemo(() => {
    const msgs = sortedMessages;
    const left = msgs.filter((m) => m.side === "pro" || m.side === "branch_a");
    const right = msgs.filter((m) => m.side === "con" || m.side === "branch_b");
    return { hasSides: left.length > 0 || right.length > 0, left, right };
  }, [sortedMessages]);

  // Dual-speed continuous silent sync: 1.2s when running/pending approval, 3s when idle, plus instant sync on focus/tab switch
  useEffect(() => {
    if (!autoSync) return;
    const intervalMs = runningCount > 0 || pendingApprovals.length > 0 ? 1200 : 3000;
    const silentSync = () => {
      const app = appRef.current;
      if (!app || syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      const mySeq = reqSeqRef.current;
      app
        .callServerTool({
          name: "ui_dashboard_state",
          arguments: { project: activeProject?.id, includeCodexStatus: false },
        })
        .then((res) => {
          if (mySeq !== reqSeqRef.current) return;
          const sc = res.structuredContent as DashboardState | undefined;
          if (sc) setState(sc);
        })
        .catch(() => undefined)
        .finally(() => {
          syncInFlightRef.current = false;
        });
    };

    const timer = setInterval(silentSync, intervalMs);
    const onFocusOrVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        silentSync();
      }
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [autoSync, runningCount, pendingApprovals.length, activeProject?.id]);

  useEffect(() => {
    if (tab === "artifacts") inspectWorkspace(activeProject?.id);
    if (autoSync && appRef.current && !syncInFlightRef.current) {
      const mySeq = reqSeqRef.current;
      appRef.current
        .callServerTool({
          name: "ui_dashboard_state",
          arguments: { project: activeProject?.id, includeCodexStatus: false },
        })
        .then((res) => {
          if (mySeq !== reqSeqRef.current) return;
          const sc = res.structuredContent as DashboardState | undefined;
          if (sc) setState(sc);
        })
        .catch(() => undefined);
    }
  }, [tab, activeProject?.id]);

  async function refresh(project?: string, includeCodexStatus = false, restartCodex = false) {
    const app = appRef.current;
    if (!app) return;
    reqSeqRef.current += 1;
    const mySeq = reqSeqRef.current;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "ui_dashboard_state",
        arguments: { project: project ?? activeProject?.id, includeCodexStatus, restartCodex },
      });
      if (mySeq !== reqSeqRef.current) return;
      const sc = res.structuredContent as DashboardState | undefined;
      if (sc) {
        setState(sc);
        setMemoryDraft(sc.memory?.content ?? "");
        if (restartCodex) setNotice(`已同步最新模型目录（共 ${sc.codex.models.length} 个模型）`);
      }
    } catch (err) {
      setNotice(`刷新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function checkCliUpdate() {
    const app = appRef.current;
    if (!app) return;
    setUpdatingCli(true);
    setNotice("正在无锁检查最新 Codex CLI 版本...");
    try {
      const res = await app.callServerTool({ name: "ui_check_codex_update", arguments: {} });
      const info = res.structuredContent as typeof updateInfo;
      if (info) {
        setUpdateInfo(info);
        setNotice(info.message);
      }
    } catch (err) {
      setNotice(`检查更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdatingCli(false);
    }
  }

  async function upgradeCliNow() {
    const app = appRef.current;
    if (!app) return;
    setUpdatingCli(true);
    setNotice("已启动后台更新，实时同步进度...");
    try {
      const startRes = await app.callServerTool({
        name: "ui_upgrade_codex_cli",
        arguments: { action: "start", projectId: activeProject?.id ?? null },
      });
      type JobPayload = {
        job?: { status: "idle" | "running" | "succeeded" | "failed"; currentVersion: string | null; installMethod: string; message: string; output: string };
        dashboard?: DashboardState | null;
      };
      let sc = startRes.structuredContent as JobPayload | undefined;
      const syncJob = (payload?: JobPayload) => {
        if (payload?.job) {
          setUpdateInfo((prev) => ({
            currentVersion: payload.job!.currentVersion,
            latestVersion: prev?.latestVersion ?? payload.job!.currentVersion,
            updateAvailable: payload.job!.status !== "succeeded" && Boolean(prev?.updateAvailable),
            installMethod: payload.job!.installMethod,
            message: payload.job!.message,
            output: payload.job!.output,
          }));
          setNotice(payload.job.message);
        }
        if (payload?.dashboard) {
          setState(payload.dashboard);
          setMemoryDraft(payload.dashboard.memory?.content ?? "");
        }
      };
      syncJob(sc);
      for (let i = 0; i < 120 && sc?.job?.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const pollRes = await app.callServerTool({
          name: "ui_upgrade_codex_cli",
          arguments: { action: "poll", projectId: activeProject?.id ?? null },
        });
        sc = pollRes.structuredContent as JobPayload | undefined;
        syncJob(sc);
      }
    } catch (err) {
      setNotice(`更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdatingCli(false);
    }
  }

  async function updateModelConfig(patch: Record<string, unknown>, toastMsg?: string) {
    const app = appRef.current;
    if (!app) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "ui_update_model_config",
        arguments: { projectId: activeProject?.id ?? null, ...patch },
      });
      const sc = res.structuredContent as DashboardState | undefined;
      if (sc) setState(sc);
      if (toastMsg) setNotice(toastMsg);
    } catch (err) {
      setNotice(`保存配置失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function updateRoleModel(roleKey: RolePresetKey, field: "model" | "effort", value: string | null) {
    const prev = effectiveCfg.roleModels ?? {};
    const cur = prev[roleKey] ?? { model: null, effort: null };
    await updateModelConfig(
      { roleModels: { ...prev, [roleKey]: { ...cur, [field]: value } } },
      "角色路由配置已更新"
    );
  }

  async function autoDispatchWave() {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_auto_dispatch",
        arguments: { project: activeProject.id },
      });
      const sc = res.structuredContent as { dispatched?: unknown[]; skippedReason?: string; dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) setState(sc.dashboard);
      if (sc?.dispatched?.length) {
        setNotice(`智能调度已并发派发 ${sc.dispatched.length} 个就绪任务给 Codex！`);
        setTab("workers");
      } else {
        setNotice(sc?.skippedReason ?? "当前没有待派发的就绪 Codex 任务");
      }
    } catch (err) {
      setNotice(`智能调度失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function selfHealTask(taskId: string) {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_self_heal",
        arguments: { project: activeProject.id, taskId },
      });
      const sc = res.structuredContent as { action?: string; dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) setState(sc.dashboard);
      const txt = (res.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "已完成验收与自愈检查";
      setNotice(txt);
    } catch (err) {
      setNotice(`自愈检查失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function initProjectFromUi(override?: { rootPath?: string; name?: string; forceNew?: boolean }) {
    const app = appRef.current;
    const target = (override?.rootPath ?? newProjectPath).trim();
    if (!app || !target) return;
    const name = (override?.name ?? newProjectName).trim();
    const forceNew = override?.forceNew ?? newProjectForceNew;
    reqSeqRef.current += 1;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_project_init",
        arguments: {
          rootPath: target,
          name: name || undefined,
          forceNew,
        },
      });
      const sc = res.structuredContent as { project?: ProjectRecord; dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) {
        setState(sc.dashboard);
        setMemoryDraft(sc.dashboard.memory?.content ?? "");
      } else if (sc?.project?.id) {
        await refresh(sc.project.id, false);
      } else {
        await refresh(target, false);
      }
      setNewProjectPath("");
      setNewProjectName("");
      setShowNewProjectDrawer(false);
      setNotice(`已创建并切换至独立项目「${sc?.project?.name ?? (name || target)}」（与其他项目完全隔离）`);
    } catch (err) {
      setNotice(`新建项目失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function manualSpawnCodex() {
    const app = appRef.current;
    if (!app || !manualPrompt.trim()) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "codex_spawn",
        arguments: {
          prompt: manualPrompt.trim(),
          project: activeProject?.id,
          cwd: activeProject?.rootPath,
          role: manualRole.trim() || "主力执行",
          model: effectiveCfg.defaultCodexModel ?? undefined,
          effort: effectiveCfg.defaultCodexEffort ?? undefined,
          sandbox: manualSandbox,
          async: true,
        },
      });
      setManualPrompt("");
      setShowSquadDrawer(false);
      await refresh();
      setNotice("已启动 GPT 线程（简体中文模式）");
    } catch (err) {
      setNotice(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function spawnSquadBatch() {
    const app = appRef.current;
    const valid = squad.filter((s) => s.prompt.trim());
    if (!app || valid.length === 0) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "codex_spawn_batch",
        arguments: {
          project: activeProject?.id,
          cwd: activeProject?.rootPath,
          waitAll: false,
          agents: valid.map((s) => ({
            role: s.role.trim() || "Subagent",
            prompt: s.prompt.trim(),
            model: s.model || undefined,
            effort: s.effort || undefined,
            sandbox: s.sandbox,
            respectLock: !s.model && !s.effort,
          })),
        },
      });
      setSquad((prev) => prev.map((s) => ({ ...s, prompt: "" })));
      setShowSquadDrawer(false);
      await refresh();
      setNotice(`已并发拉起 ${valid.length} 个 GPT Subagent`);
    } catch (err) {
      setNotice(`批量启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function broadcastToTeam(action: "message" | "interrupt_all") {
    const app = appRef.current;
    if (!app) return;
    if (action === "message" && !broadcastInput.trim()) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "codex_broadcast",
        arguments:
          action === "message"
            ? { action, project: activeProject?.id, text: broadcastInput.trim() }
            : { action, project: activeProject?.id },
      });
      if (action === "message") setBroadcastInput("");
      await refresh();
      setNotice(action === "message" ? "已向全体活跃 Subagent 广播纠偏" : "已中断全部运行中的 Subagent");
    } catch (err) {
      setNotice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function applySquadPreset(preset: "parallel" | "debate" | "dev3") {
    if (preset === "parallel") {
      setSquad([
        { id: "p1", role: "独立研究分支 A", model: "", effort: "", sandbox: "read-only", prompt: "" },
        { id: "p2", role: "独立研究分支 B", model: "", effort: "", sandbox: "read-only", prompt: "" },
      ]);
    } else if (preset === "debate") {
      setSquad([
        { id: "d1", role: "正方辩手（立论）", model: "", effort: "", sandbox: "read-only", prompt: "" },
        { id: "d2", role: "反方辩手（挑刺）", model: "", effort: "", sandbox: "read-only", prompt: "" },
      ]);
    } else {
      setSquad([
        { id: "t1", role: "架构与任务拆解", model: "", effort: "", sandbox: "read-only", prompt: "" },
        { id: "t2", role: "主力编码/分析", model: "", effort: "", sandbox: "workspace-write", prompt: "" },
        { id: "t3", role: "独立测试与审稿", model: "", effort: "", sandbox: "read-only", prompt: "" },
      ]);
    }
  }

  async function humanDecision(taskId: string, decision: "accept" | "rework" | "block") {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "ui_human_decision",
        arguments: { projectId: activeProject.id, taskId, decision, note: reworkNotes[taskId] ?? "" },
      });
      const sc = res.structuredContent as DashboardState | undefined;
      if (sc) setState(sc);
      setReworkNotes((p) => ({ ...p, [taskId]: "" }));
      setNotice(decision === "accept" ? `任务 ${taskId} 已通过验收` : `任务 ${taskId} 已标记为 ${decision}`);
    } catch (err) {
      setNotice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function steerCodex(threadId: string) {
    const app = appRef.current;
    const text = (steerInputs[threadId] ?? "").trim();
    if (!app || !text) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "codex_message",
        arguments: { threadId, text, steerIfRunning: true, async: true },
      });
      setSteerInputs((p) => ({ ...p, [threadId]: "" }));
      await refresh();
      setNotice(`已向线程 ${threadId.slice(0, 8)} 实时插话`);
    } catch (err) {
      setNotice(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function resumeHistoricalThread(threadId: string, cwd?: string) {
    const app = appRef.current;
    const text = (resumeInputs[threadId] ?? "").trim();
    if (!app || !text) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "codex_message",
        arguments: { threadId, text, cwd, steerIfRunning: true, async: true },
      });
      setResumeInputs((p) => ({ ...p, [threadId]: "" }));
      await refresh();
      setNotice(`已续接历史线程 ${threadId.slice(0, 8)}`);
    } catch (err) {
      setNotice(`续接失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function controlCodex(action: string, target: { threadId?: string; approvalId?: string }) {
    const app = appRef.current;
    if (!app) return;
    setLoading(true);
    try {
      await app.callServerTool({ name: "codex_control", arguments: { action, ...target } });
      await refresh();
      setNotice(`已执行 ${action}`);
    } catch (err) {
      setNotice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveMemory() {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "team_memory",
        arguments: { project: activeProject.id, action: "replace", content: memoryDraft },
      });
      await refresh();
      setNotice("共享记忆已保存");
    } catch (err) {
      setNotice(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function inspectWorkspace(projectId?: string) {
    const app = appRef.current;
    if (!app) return;
    try {
      const res = await app.callServerTool({
        name: "ui_workspace_inspect",
        arguments: { projectId: projectId ?? activeProject?.id ?? null },
      });
      const sc = res.structuredContent as WorkspaceInspectState | undefined;
      if (sc) setWsInspect(sc);
    } catch {
      // ignore
    }
  }

  async function togglePinFile(relPath: string, currentlyPinned: boolean) {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "ui_toggle_pin_file",
        arguments: { projectId: activeProject.id, relPath, pinned: !currentlyPinned },
      });
      const sc = res.structuredContent as { pinnedFiles?: PinnedFileRecord[]; dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) {
        setState(sc.dashboard);
        setMemoryDraft(sc.dashboard.memory?.content ?? "");
      }
      // Sync pinned files into Antigravity's pending model context pill when supported
      const caps = app.getHostCapabilities() as Record<string, unknown> | undefined;
      const nextPinned = sc?.pinnedFiles ?? [];
      if (caps?.updateModelContext) {
        const ctxText = nextPinned.length
          ? `【Duo-Team 焦点文件】${nextPinned.map((f) => `${activeProject.rootPath}/${f.relPath}`).join(" , ")}`
          : "";
        app.updateModelContext({ content: ctxText ? [{ type: "text", text: ctxText }] : [] }).catch(() => undefined);
      }
      setNotice(!currentlyPinned ? `已将 ${relPath} 挂载为双模型焦点上下文` : `已取消挂载 ${relPath}`);
    } catch (err) {
      setNotice(`挂载操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function addMemoryItemFromUi() {
    const app = appRef.current;
    if (!app || !activeProject || !newMemTitle.trim() || !newMemContent.trim()) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_memory_add",
        arguments: {
          project: activeProject.id,
          action: "add",
          category: newMemCat,
          title: newMemTitle.trim(),
          content: newMemContent.trim(),
          tags: newMemTags.split(/[,，\s]+/).filter(Boolean),
          pinned: newMemPinned,
          sourceAgent: "Human",
        },
      });
      const sc = res.structuredContent as { dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) {
        setState(sc.dashboard);
        setMemoryDraft(sc.dashboard.memory?.content ?? "");
      }
      setNewMemTitle("");
      setNewMemContent("");
      setNewMemTags("");
      setShowAddMemory(false);
      setNotice("结构化记忆已入库（已建 FTS5 索引并同步至 memory.md）");
    } catch (err) {
      setNotice(`保存记忆失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function mutateMemoryItem(memoryId: string, action: "toggle_pin" | "delete") {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_memory_add",
        arguments: { project: activeProject.id, action, memoryId },
      });
      const sc = res.structuredContent as { dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) {
        setState(sc.dashboard);
        setMemoryDraft(sc.dashboard.memory?.content ?? "");
      }
      setNotice(action === "toggle_pin" ? "已切换记忆置顶状态" : "已删除该记忆条目");
    } catch (err) {
      setNotice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function createTaskFromUi() {
    const app = appRef.current;
    if (!app || !activeProject || !newTaskTitle.trim()) return;
    setLoading(true);
    try {
      await app.callServerTool({
        name: "team_task_upsert",
        arguments: {
          project: activeProject.id,
          title: newTaskTitle.trim(),
          description: newTaskDesc.trim(),
          owner: newTaskOwner,
          reviewer: newTaskReviewer,
          acceptanceCriteria: newTaskCriteria.trim(),
          verifyCommand: newTaskVerifyCmd.trim() || null,
        },
      });
      setNewTaskTitle("");
      setNewTaskDesc("");
      setNewTaskCriteria("");
      setNewTaskVerifyCmd("");
      setShowNewTask(false);
      await refresh();
      setNotice("任务已加入 DAG 看板");
    } catch (err) {
      setNotice(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function loadWorkflowStarter(key: "paper" | "dev" | "research") {
    const tpl = WORKFLOW_STARTERS[key];
    setWfPresetId(tpl.id);
    setWfName(tpl.name);
    setWfDesc(tpl.description);
    setWfMaxReworks(tpl.maxReworks);
    setWfStages(tpl.stages.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })));
    setNotice(`已载入入门模板「${tpl.name}」，可按需微调后保存或直接套用`);
  }

  function loadExistingPresetIntoBuilder(wp: WorkflowPresetRecord) {
    setWfPresetId(wp.id);
    setWfName(wp.name);
    setWfDesc(wp.description ?? "");
    setWfMaxReworks(wp.maxReworks ?? 3);
    setWfStages(
      wp.stages.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description ?? "",
        owner: s.owner,
        reviewer: s.reviewer ?? (s.owner === "codex" ? "gemini" : "codex"),
        dependsOn: [...(s.dependsOn ?? [])],
        verifyCommand: s.verifyCommand ?? "",
        artifacts: (s.artifacts ?? []).join(", "),
      }))
    );
    setShowWorkflowBuilder(true);
    setNotice(`已将模板「${wp.name}」载入编辑器`);
  }

  function addWorkflowStage() {
    const used = new Set(wfStages.map((s) => s.id));
    let n = wfStages.length + 1;
    while (used.has(`S${n}`)) n++;
    const prevId = wfStages.length > 0 ? wfStages[wfStages.length - 1].id : null;
    setWfStages((prev) => [
      ...prev,
      {
        id: `S${n}`,
        title: "",
        description: "",
        owner: "codex",
        reviewer: "gemini",
        dependsOn: prevId ? [prevId] : [],
        verifyCommand: "",
        artifacts: "",
      },
    ]);
  }

  function toggleStageDep(stageIdx: number, depId: string) {
    setWfStages((prev) =>
      prev.map((st, i) => {
        if (i !== stageIdx) return st;
        const exists = st.dependsOn.includes(depId);
        return {
          ...st,
          dependsOn: exists ? st.dependsOn.filter((d) => d !== depId) : [...st.dependsOn, depId],
        };
      })
    );
  }

  async function applyWorkflowPresetFromUi(presetId: string, presetName?: string) {
    const app = appRef.current;
    if (!app || !activeProject) return;
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_workflow_preset",
        arguments: { project: activeProject.id, action: "apply", presetId },
      });
      const sc = res.structuredContent as { dashboard?: DashboardState; createdTasks?: unknown[] } | undefined;
      if (sc?.dashboard) setState(sc.dashboard);
      setNotice(`已一键套用「${presetName ?? presetId}」，共生成 ${sc?.createdTasks?.length ?? 0} 个 DAG 任务`);
    } catch (err) {
      setNotice(`套用失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveWorkflowPresetFromUi(andApply: boolean) {
    const app = appRef.current;
    if (!app || !activeProject) return;
    const safeId = wfPresetId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || `wf-${Date.now().toString().slice(-4)}`;
    const validStages = wfStages.filter((s) => s.title.trim());
    if (validStages.length === 0) {
      setNotice("请至少填写 1 个阶段的标题");
      return;
    }
    setLoading(true);
    try {
      const res = await app.callServerTool({
        name: "team_workflow_preset",
        arguments: {
          project: activeProject.id,
          action: "save",
          presetId: safeId,
          name: wfName.trim() || safeId,
          description: wfDesc.trim(),
          maxReworks: wfMaxReworks,
          stages: validStages.map((s) => ({
            id: s.id.trim() || "S1",
            title: s.title.trim(),
            description: s.description.trim() || undefined,
            owner: s.owner,
            reviewer: s.reviewer,
            dependsOn: s.dependsOn,
            verifyCommand: s.verifyCommand.trim() || null,
            artifacts: s.artifacts
              .split(/[,，\n]+/)
              .map((x) => x.trim())
              .filter(Boolean),
          })),
        },
      });
      const sc = res.structuredContent as { dashboard?: DashboardState } | undefined;
      if (sc?.dashboard) setState(sc.dashboard);
      setWfPresetId(safeId);

      if (andApply) {
        const applyRes = await app.callServerTool({
          name: "team_workflow_preset",
          arguments: { project: activeProject.id, action: "apply", presetId: safeId },
        });
        const applySc = applyRes.structuredContent as { dashboard?: DashboardState; createdTasks?: unknown[] } | undefined;
        if (applySc?.dashboard) setState(applySc.dashboard);
        setShowWorkflowBuilder(false);
        setNotice(`已保存并套用「${wfName.trim() || safeId}」，生成了 ${applySc?.createdTasks?.length ?? validStages.length} 个任务！`);
      } else {
        setNotice(`自定义工作流「${wfName.trim() || safeId}」已保存至 .duo-team/workflows/${safeId}.json`);
      }
    } catch (err) {
      setNotice(`保存工作流失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function selectModeFromCard(modeId: string) {
    if (activeProject) {
      await updateModelConfig({ mode: modeId }, `已切换为「${MODE_LABELS[modeId] ?? modeId}」模式`);
    } else {
      setNotice(`请先在「智能调度看板」绑定项目目录后再切换为「${MODE_LABELS[modeId] ?? modeId}」`);
    }
    if (modeId === "custom") {
      setShowWorkflowBuilder(true);
      setTab("board");
    }
  }

  async function postHumanMessage(alsoNotifyGemini: boolean) {
    const app = appRef.current;
    if (!app || !activeProject || !humanMsgText.trim()) return;
    const text = humanMsgText.trim();
    setLoading(true);
    try {
      await app.callServerTool({
        name: "team_message_post",
        arguments: { project: activeProject.id, fromAgent: "Human", toAgent: "Team", kind: humanMsgKind, content: text },
      });
      setHumanMsgText("");
      await refresh();
      if (alsoNotifyGemini && canMessage) {
        await sendToConversation(`【人工${KIND_LABELS[humanMsgKind] ?? "指令"}】${text}`);
      } else {
        setNotice("已记录至跨模型协作流");
      }
    } catch (err) {
      setNotice(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function openWorkspaceFile(relOrAbsPath: string) {
    const app = appRef.current;
    if (!app || !activeProject) return;
    const abs = relOrAbsPath.startsWith("/") ? relOrAbsPath : `${activeProject.rootPath.replace(/\/$/, "")}/${relOrAbsPath}`;
    try {
      await app.request(
        { method: "com.google.antigravity/toggle-aux-pane", params: { tabType: "fileView", uri: `file://${abs}` } } as unknown as Parameters<App["request"]>[0],
        z.object({ isError: z.boolean().optional() }).passthrough()
      );
    } catch {
      setNotice(`文件路径: ${abs}`);
    }
  }

  async function sendToConversation(prompt: string) {
    const app = appRef.current;
    if (!app || !canMessage) return;
    await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
    setNotice("已同步指令到当前 Antigravity 对话");
  }

  const taskMap = useMemo(() => new Map((state?.tasks ?? []).map((t) => [t.id, t])), [state?.tasks]);
  const criticalSet = useMemo(() => new Set(schedule?.criticalPath ?? []), [schedule?.criticalPath]);
  const recMap = useMemo(() => new Map((schedule?.recommendations ?? []).map((r) => [r.taskId, r])), [schedule?.recommendations]);

  const TABS: Array<{ key: TabKey; label: string; count?: string | number }> = [
    { key: "models", label: "模型与策略" },
    { key: "board", label: "智能调度看板", count: state?.tasks.length ?? 0 },
    { key: "workers", label: "GPT 编队", count: runningCount > 0 ? `${runningCount} 运行中` : activeThreads.length },
    { key: "feed", label: "协作与辩论", count: state?.messages.length ?? 0 },
    { key: "artifacts", label: "文件与备忘", count: state?.memoryItems?.length ?? 0 },
  ];

  const pinnedSet = useMemo(() => new Set((state?.pinnedFiles ?? wsInspect?.pinnedFiles ?? []).map((f) => f.relPath)), [state?.pinnedFiles, wsInspect?.pinnedFiles]);
  const pinnedList = state?.pinnedFiles ?? wsInspect?.pinnedFiles ?? [];
  const filteredTree = useMemo(
    () => filterTreeNodes(wsInspect?.projectTree?.tree ?? [], treeFilter.trim()),
    [wsInspect?.projectTree?.tree, treeFilter]
  );

  const filteredMemoryItems = useMemo(() => {
    const list = state?.memoryItems ?? [];
    const q = memSearch.trim().toLowerCase();
    return list.filter((m) => {
      if (memCatFilter === "pinned" && !m.pinned) return false;
      if (memCatFilter !== "all" && memCatFilter !== "pinned" && m.category !== memCatFilter) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [state?.memoryItems, memSearch, memCatFilter]);

  function renderTreeBranch(nodes: ProjectTreeNode[], depth = 0): React.ReactNode {
    return nodes.map((node) => {
      const isDir = node.kind === "dir";
      const isExpanded = Boolean(treeFilter.trim()) || Boolean(expandedDirs[node.path]);
      const isPinned = pinnedSet.has(node.path);
      return (
        <div key={node.path}>
          <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
            {isDir ? (
              <button
                type="button"
                className="tree-trigger"
                onClick={() => setExpandedDirs((p) => ({ ...p, [node.path]: !isExpanded }))}
              >
                <span className={`tree-chev ${isExpanded ? "open" : ""}`}><IconChev /></span>
                <IconFolder />
                <span className="tree-name" style={{ fontWeight: 560 }}>{node.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{node.fileCount ?? 0}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="tree-trigger"
                  onClick={() => openWorkspaceFile(node.path)}
                  title={`在侧栏打开 ${node.path}`}
                >
                  <IconFile />
                  <span className="tree-name">{node.name}</span>
                  {node.gitStatus && <span className="pill running" style={{ fontSize: 10 }}>{node.gitStatus}</span>}
                </button>
                <button
                  type="button"
                  className={`btn sm ${isPinned ? "primary" : "ghost"}`}
                  style={{ padding: "2px 7px", fontSize: 11 }}
                  onClick={() => togglePinFile(node.path, isPinned)}
                  title={isPinned ? "取消双模型必读" : "设为必读：Gemini 和 GPT 每次干活都会优先看它"}
                >
                  <IconPin /> {isPinned ? "必读" : "设为必读"}
                </button>
              </>
            )}
          </div>
          {isDir && node.children && node.children.length > 0 && (
            <div className={`tree-children ${isExpanded ? "open" : ""}`}>
              <div className="tree-children-inner">{renderTreeBranch(node.children, depth + 1)}</div>
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="brand-group">
            <span className="logo-orb">DT</span>
            <div>
              <div className="brand-name">Duo-Team</div>
              <div className="brand-sub">Gemini × Codex 自主协作控制面</div>
            </div>
            {state && state.projects.length > 0 && (
              <select
                value={activeProject?.id ?? ""}
                onChange={(e) => refresh(e.target.value, false)}
                aria-label="切换项目"
                style={{ marginLeft: 4 }}
              >
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.storageDir ? " (独立)" : ""}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={`btn sm ${showNewProjectDrawer ? "primary" : "ghost"}`}
              onClick={() => {
                if (!showNewProjectDrawer && !newProjectPath && activeProject?.rootPath) {
                  setNewProjectPath(activeProject.rootPath);
                }
                setShowNewProjectDrawer((v) => !v);
              }}
              title="新建完全隔离的独立项目（支持新文件夹，也支持同文件夹下按主题拆分）"
            >
              {showNewProjectDrawer ? "收起" : "+ 新建项目"}
            </button>
          </div>

          <div className="row">
            {activeProject && (
              <select
                value={activeProject.mode}
                onChange={(e) => {
                  const next = e.target.value;
                  updateModelConfig({ mode: next }, `已切换为「${MODE_LABELS[next]}」`);
                  if (next === "custom") {
                    setShowWorkflowBuilder(true);
                    setTab("board");
                  }
                }}
                aria-label="协作模式"
              >
                {Object.entries(MODE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            )}
            <button
              className="btn sm ghost"
              onClick={() => setAutoSync((v) => !v)}
              title="运行中每 1.2 秒实时刷新，空闲每 3 秒静默同步，切回窗口立刻更新"
            >
              <span className={`dot ${autoSync && runningCount > 0 ? "pulse" : ""}`} style={{ color: autoSync ? "var(--emerald)" : "var(--text-faint)" }} />
              <span>{autoSync ? (runningCount > 0 ? "1.2s 实时" : "3s 自动") : "已暂停"}</span>
            </button>
            <button className="btn sm" onClick={() => refresh(undefined, true)} disabled={loading}>
              <IconRefresh spinning={loading} />
            </button>
          </div>
        </div>

        <div className={`drawer ${showNewProjectDrawer ? "open" : ""}`}>
          <div className="drawer-inner">
            <div className="card subtle" style={{ padding: "10px 12px", marginTop: 4 }}>
              <div className="row-between">
                <span style={{ fontWeight: 620, fontSize: 12.5 }}>新建独立隔离项目（任务、GPT 线程与记忆完全分开，互不串台）</span>
                <span className="muted" style={{ fontSize: 11 }}>可填新目录，也可沿用同目录按项目名拆分</span>
              </div>
              <div className="row">
                <input
                  type="text"
                  style={{ flex: 1, minWidth: 150 }}
                  placeholder="项目名称（如：提案大赛 PPT / Qwen 实验）"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                />
                <input
                  type="text"
                  style={{ flex: 2, minWidth: 210 }}
                  placeholder="文件夹绝对路径（如 /Users/you/Documents/Qwen）"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                />
                <button
                  type="button"
                  className="switch"
                  onClick={() => setNewProjectForceNew((v) => !v)}
                  title="开启后即使路径与已有项目相同，也会建立全新独立账本"
                >
                  <span className={`switch-track ${newProjectForceNew ? "on" : ""}`}><span className="switch-thumb" /></span>
                  <span>独立账本</span>
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={loading || !newProjectPath.trim()}
                  onClick={() => initProjectFromUi()}
                >
                  创建并切换
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Slim Always-Visible GPT Model Strip */}
        <div className="quick-strip">
          <div className="strip-group">
            <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600 }}>
              <IconCpu /> GPT
            </span>
            <select
              value={effectiveCfg.defaultCodexModel ?? ""}
              onChange={(e) => {
                const nextModel = e.target.value || null;
                const meta = models.find((m) => m.id === nextModel);
                const nextEffort =
                  effectiveCfg.defaultCodexEffort && meta && !meta.efforts.includes(effectiveCfg.defaultCodexEffort)
                    ? meta.defaultEffort ?? meta.efforts[meta.efforts.length - 1] ?? null
                    : effectiveCfg.defaultCodexEffort;
                updateModelConfig({ defaultCodexModel: nextModel, defaultCodexEffort: nextEffort }, `GPT 模型：${meta?.displayName ?? "官方默认"}`);
              }}
            >
              <option value="">官方默认模型</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>

            <select
              value={effectiveCfg.defaultCodexEffort ?? ""}
              onChange={(e) => updateModelConfig({ defaultCodexEffort: e.target.value || null }, `推理强度：${e.target.value || "默认"}`)}
            >
              <option value="">强度：默认</option>
              {activeEfforts.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
            </select>

            <button
              type="button"
              className="switch"
              onClick={() =>
                updateModelConfig(
                  { lockCodexModel: !effectiveCfg.lockCodexModel },
                  !effectiveCfg.lockCodexModel ? "已锁定模型：AI 启动 Codex 将强制使用你的选型" : "已解锁：开启智能复杂度自适应路由"
                )
              }
              title="开启后强制按你选定的模型执行；关闭则允许调度器按任务难度智能选模"
            >
              <span className={`switch-track ${effectiveCfg.lockCodexModel ? "on" : ""}`}>
                <span className="switch-thumb" />
              </span>
              <span>{effectiveCfg.lockCodexModel ? "强制锁定" : "智能路由"}</span>
            </button>
          </div>

          <div className="strip-group">
            {effectiveQuotaRemaining !== null && (
              <span
                className="strip-chip"
                title={
                  [
                    primaryWin ? `主窗口(${primaryWin.windowLabel ?? "主周期"}): 余 ${primaryWin.remainingPercent}%${primaryWin.resetText ? ` · 重置 ${primaryWin.resetText}` : ""}` : null,
                    secondaryWin ? `次窗口(${secondaryWin.windowLabel ?? "次周期"}): 余 ${secondaryWin.remainingPercent}%${secondaryWin.resetText ? ` · 重置 ${secondaryWin.resetText}` : ""}` : null,
                  ]
                    .filter(Boolean)
                    .join("\n") || (quota?.resetText ? `重置：${quota.resetText}` : undefined)
                }
              >
                <span className="dot" style={{ color: effectiveQuotaRemaining <= lowQuotaThreshold ? "var(--rose)" : "var(--emerald)" }} />
                <span>{subProfile?.chatgpt.shortBadge ?? "Codex"} 余量 {effectiveQuotaRemaining}%</span>
              </span>
            )}
            {schedule && schedule.totalTasks > 0 && (
              <span className="strip-chip">
                <span>健康度 {schedule.healthScore}</span>
              </span>
            )}
          </div>
        </div>

        {/* Spring-Gliding Tab Bar */}
        <nav className="nav-wrap" ref={navRef}>
          {glider.ready && (
            <span
              className="nav-glider"
              style={{ width: glider.width, transform: `translateX(${glider.left}px)` }}
            />
          )}
          {TABS.map((item) => (
            <button
              key={item.key}
              ref={(el) => { tabRefs.current[item.key] = el; }}
              className={`nav-tab ${tab === item.key ? "active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              <span>{item.label}</span>
              {item.count !== undefined && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {notice && (
          <div className="toast">
            <span>{notice}</span>
            <button className="btn sm ghost" onClick={() => setNotice("")}>关闭</button>
          </div>
        )}

        {/* Watchdog / Scheduler Live Alerts */}
        {(schedule?.alerts ?? []).map((alert, idx) => (
          <div key={`${alert.code}-${idx}`} className={`alert-card ${alert.level === "error" ? "error" : "warning"}`}>
            <div>
              <strong>{alert.title}</strong>
              <span style={{ marginLeft: 8, opacity: 0.9 }}>{alert.detail}</span>
            </div>
            {(alert.code === "waiting_approval" || alert.code === "stalled_thread") && (
              <button className="btn sm" onClick={() => setTab("workers")}>去处理</button>
            )}
          </div>
        ))}

        {/* TAB 1: MODELS & STRATEGY */}
        {tab === "models" && (
          <div key="stage-models" className="stage">
            {/* Dual-Engine Animated Hero Bridge */}
            <div className="hero-bridge stagger" style={{ "--i": 0 } as React.CSSProperties}>
              <div className="engine-node">
                <span className="engine-badge gemini">Ge</span>
                <div>
                  <div style={{ fontWeight: 680, fontSize: 13 }}>Gemini · Antigravity</div>
                  <div className="muted">主控工作台 · {subProfile?.google.label ?? "Google AI Pro"}</div>
                </div>
              </div>

              <div className="bridge-beam" aria-hidden="true">
                <svg width="100%" height="22" viewBox="0 0 180 22" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="beamGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#4f46e5" />
                      <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                  </defs>
                  <line className="beam-line" x1="8" y1="11" x2="172" y2="11" />
                  <circle cx="8" cy="11" r="3" fill="#4f46e5" />
                  <circle cx="172" cy="11" r="3" fill="#10b981" />
                </svg>
                <span className="muted" style={{ fontSize: 11 }}>
                  {effectiveCfg.lockCodexModel ? "强制锁模协作" : "智能复杂度路由"} · {effectiveCfg.language === "zh-CN" ? "简体中文" : effectiveCfg.language ?? "简体中文"}
                </span>
              </div>

              <div className="engine-node" style={{ justifyContent: "flex-end" }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 680, fontSize: 13 }}>
                    {selectedModelMeta?.displayName ?? effectiveCfg.defaultCodexModel ?? "Codex 官方默认"}
                    {effectiveCfg.defaultCodexEffort ? ` · ${effectiveCfg.defaultCodexEffort}` : ""}
                  </div>
                  <div className="muted">
                    {subProfile?.chatgpt.label ?? "ChatGPT"} · {state?.codex.connected ? `并发上限 ${effectiveCfg.maxParallelCodex ?? 4}` : "等待连接 Codex"}
                  </div>
                </div>
                <span className="engine-badge codex">GPT</span>
              </div>
            </div>

            <div className="card stagger" style={{ "--i": 1 } as React.CSSProperties}>
              <div className="card-head">
                <div>
                  <div className="section-title">GPT / Codex 模型目录</div>
                  <div className="muted">
                    实时同步自本机官方 Codex 内核，零硬编码。{state?.codex.userAgent ? `(${state.codex.userAgent.split(" ")[0]})` : ""}
                  </div>
                </div>
                <div className="row">
                  <button className="btn sm" onClick={checkCliUpdate} disabled={loading || updatingCli}>
                    {updatingCli ? "处理中..." : "检查 CLI 更新"}
                  </button>
                  <button
                    className={`btn sm ${updateInfo?.updateAvailable ? "primary" : ""}`}
                    onClick={upgradeCliNow}
                    disabled={loading || updatingCli}
                  >
                    更新 CLI
                  </button>
                  <button className="btn sm ghost" onClick={() => refresh(undefined, true, true)} disabled={loading || updatingCli}>
                    <IconRefresh spinning={loading} /> 同步
                  </button>
                </div>
              </div>

              {updateInfo && (
                <div className="card subtle" style={{ padding: "10px 12px" }}>
                  <div className="row-between">
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{updateInfo.message}</span>
                    {updateInfo.updateAvailable && (
                      <button className="btn sm primary" onClick={upgradeCliNow} disabled={updatingCli}>
                        升级至 {updateInfo.latestVersion}
                      </button>
                    )}
                  </div>
                  {updateInfo.output && <pre className="code-block" style={{ maxHeight: 110 }}>{updateInfo.output}</pre>}
                </div>
              )}

              <div className="grid-models">
                <button
                  type="button"
                  style={{ "--i": 0 } as React.CSSProperties}
                  className={`model-card ${!effectiveCfg.defaultCodexModel ? "selected" : ""}`}
                  onClick={() => updateModelConfig({ defaultCodexModel: null }, "已切换为官方默认模型")}
                >
                  <div className="row-between">
                    <strong style={{ fontSize: 13 }}>官方默认</strong>
                    {!effectiveCfg.defaultCodexModel && <span className="pill gemini">使用中</span>}
                  </div>
                  <div className="muted">自动跟随账户推荐旗舰</div>
                </button>

                {models.map((m, i) => {
                  const isSelected = effectiveCfg.defaultCodexModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      style={{ "--i": i + 1 } as React.CSSProperties}
                      className={`model-card ${isSelected ? "selected" : ""}`}
                      onMouseMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
                        e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
                      }}
                      onClick={() => {
                        const nextEffort =
                          effectiveCfg.defaultCodexEffort && m.efforts.includes(effectiveCfg.defaultCodexEffort)
                            ? effectiveCfg.defaultCodexEffort
                            : m.defaultEffort ?? "high";
                        updateModelConfig(
                          { defaultCodexModel: m.id, defaultCodexEffort: nextEffort },
                          `已选定 ${m.displayName} · ${nextEffort}`
                        );
                      }}
                    >
                      <div className="row-between">
                        <strong style={{ fontSize: 13 }}>{m.displayName}</strong>
                        {isSelected && <span className="pill gemini selected-pop">使用中</span>}
                      </div>
                      <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{m.id}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{m.efforts.join(" · ")}</div>
                    </button>
                  );
                })}
              </div>

              <div className="row-between" style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>推理强度（Reasoning Effort）</div>
                  <div className="muted">动态适配当前所选模型支持的全部档位</div>
                </div>
                <div className="segmented">
                  <button
                    type="button"
                    className={`seg-btn ${!effectiveCfg.defaultCodexEffort ? "active" : ""}`}
                    onClick={() => updateModelConfig({ defaultCodexEffort: null }, "推理强度：默认")}
                  >
                    默认
                  </button>
                  {activeEfforts.map((eff) => (
                    <button
                      key={eff}
                      type="button"
                      className={`seg-btn ${effectiveCfg.defaultCodexEffort === eff ? "active" : ""}`}
                      onClick={() => updateModelConfig({ defaultCodexEffort: eff }, `推理强度：${eff}`)}
                    >
                      {eff}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row-between">
                <button className="btn sm ghost" onClick={() => setShowCustomModel((v) => !v)}>
                  {showCustomModel ? "收起自定义模型 ID" : "+ 手动输入自定义模型 ID"}
                </button>
                {canMessage && effectiveCfg.defaultCodexModel && (
                  <button
                    className="btn sm"
                    onClick={() =>
                      sendToConversation(
                        `接下来协作请使用我设定的 GPT 模型：${selectedModelMeta?.displayName ?? effectiveCfg.defaultCodexModel}${effectiveCfg.defaultCodexEffort ? `（${effectiveCfg.defaultCodexEffort}）` : ""}，全程简体中文。`
                      )
                    }
                  >
                    <IconSend /> 同步设定给 Gemini
                  </button>
                )}
              </div>

              <div className={`drawer ${showCustomModel ? "open" : ""}`}>
                <div className="drawer-inner">
                  <div className="row" style={{ paddingTop: 4 }}>
                    <input
                      type="text"
                      style={{ flex: 1 }}
                      placeholder="输入模型 slug，例如 gpt-6.2-sol"
                      value={customModelId}
                      onChange={(e) => setCustomModelId(e.target.value)}
                    />
                    <button
                      className="btn sm primary"
                      disabled={loading || !customModelId.trim()}
                      onClick={() => {
                        const slug = customModelId.trim();
                        setCustomModelId("");
                        setShowCustomModel(false);
                        updateModelConfig({ defaultCodexModel: slug }, `已指定模型：${slug}`);
                      }}
                    >
                      应用
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid-2">
              <div className="card stagger" style={{ "--i": 1 } as React.CSSProperties}>
                <div>
                  <div className="section-title">角色专属模型路由</div>
                  <div className="muted">精细指定规划、执行与评审角色所用 GPT 模型；留空则沿用全局或智能路由。</div>
                </div>
                <div>
                  {ROLE_META.map(({ key, label, hint }) => {
                    const spec = effectiveCfg.roleModels?.[key] ?? { model: null, effort: null };
                    const roleModelObj = models.find((m) => m.id === spec.model);
                    const roleEfforts = roleModelObj?.efforts ?? activeEfforts;
                    return (
                      <div key={key} className="role-row">
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 12.5 }}>{label}</div>
                          <div className="muted" style={{ fontSize: 11 }}>{hint}</div>
                        </div>
                        <select value={spec.model ?? ""} onChange={(e) => updateRoleModel(key, "model", e.target.value || null)}>
                          <option value="">跟随全局</option>
                          {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                        </select>
                        <select value={spec.effort ?? ""} onChange={(e) => updateRoleModel(key, "effort", e.target.value || null)}>
                          <option value="">强度：全局</option>
                          {roleEfforts.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="card stagger" style={{ "--i": 2 } as React.CSSProperties}>
                <div className="row-between">
                  <div className="section-title">双平台订阅适配与额度</div>
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={loading}
                    onClick={() =>
                      updateModelConfig(
                        { googlePlan: activeGooglePlan, chatgptPlan: activeChatGptConfig, applyTierDefaults: true },
                        `已按「${subProfile?.google.shortBadge ?? activeGooglePlan} × ${subProfile?.chatgpt.shortBadge ?? "Codex"}」一键优化并发与推理策略`
                      )
                    }
                    title="按当前 Google × ChatGPT 订阅档位自动设置推荐并发数、推理强度与省流智能路由"
                  >
                    <IconSpark /> 按订阅一键优化
                  </button>
                </div>

                <div className="card subtle" style={{ padding: 12 }}>
                  <div className="row-between">
                    <div className="ring-wrap">
                      <CircularRing
                        percent={effectiveQuotaRemaining ?? 0}
                        color={(effectiveQuotaRemaining ?? 100) <= lowQuotaThreshold ? "#e11d48" : "#10b981"}
                        label={effectiveQuotaRemaining !== null ? `${effectiveQuotaRemaining}%` : "--"}
                      />
                      <div>
                        <div style={{ fontWeight: 650 }}>
                          {subProfile?.chatgpt.label ?? "ChatGPT 订阅"}
                          {primaryWin?.windowLabel ? ` · ${primaryWin.windowLabel}` : quota?.windowDays ? ` · ${quota.windowDays} 天周期` : ""}
                        </div>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {primaryWin?.resetText
                            ? `主窗口余 ${primaryWin.remainingPercent}% · 重置 ${primaryWin.resetText}`
                            : quota?.resetText
                              ? `重置：${quota.resetText}`
                              : "点击右上角刷新读取实时额度"}
                        </div>
                        {secondaryWin && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            次窗口（{secondaryWin.windowLabel ?? "长周期"}）：余 {secondaryWin.remainingPercent}%
                            {secondaryWin.resetText ? ` · 重置 ${secondaryWin.resetText}` : ""}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className={`pill ${state?.codex.connected ? "done" : "rework"}`}>
                      {state?.codex.connected ? "已连接" : "未连接"}
                    </span>
                  </div>
                </div>

                <div className="row-between">
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>Google 订阅档位</span>
                  <div className="segmented">
                    {[
                      { id: "free", label: "Free" },
                      { id: "pro", label: "AI Pro" },
                      { id: "ultra", label: "AI Ultra" },
                      { id: "enterprise", label: "Workspace" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`seg-btn ${activeGooglePlan === opt.id ? "active" : ""}`}
                        onClick={() => updateModelConfig({ googlePlan: opt.id }, `Google 订阅档位：${opt.label}`)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="row-between">
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>ChatGPT 订阅档位</span>
                  <select
                    value={activeChatGptConfig}
                    onChange={(e) => updateModelConfig({ chatgptPlan: e.target.value }, `ChatGPT 订阅档位已切换`)}
                    aria-label="ChatGPT 订阅档位"
                  >
                    <option value="auto">
                      自动识别（当前：{subProfile?.chatgpt.detectedTier ? subProfile.chatgpt.label : "待读取/默认 Pro"}）
                    </option>
                    <option value="plus">ChatGPT Plus（5h 窗口 · 推荐 2 并发 / high）</option>
                    <option value="pro">ChatGPT Pro（高配额 · 推荐 4 并发 / max）</option>
                    <option value="team">ChatGPT Team / Business（推荐 3 并发 / xhigh）</option>
                    <option value="edu">ChatGPT Edu（高校科研 · 推荐 3 并发 / xhigh）</option>
                    <option value="enterprise">ChatGPT Enterprise（企业高并发 · 推荐 6 并发）</option>
                    <option value="go">ChatGPT Go（轻量 · 推荐 1 并发 / medium）</option>
                    <option value="free">ChatGPT Free（基础 · 推荐 1 并发 / medium）</option>
                  </select>
                </div>

                {subProfile && (
                  <div className="card subtle" style={{ padding: "9px 11px", fontSize: 11.5 }}>
                    <div style={{ fontWeight: 640, marginBottom: 3 }}>{subProfile.pairingTitle}</div>
                    <div className="muted" style={{ lineHeight: 1.5 }}>{subProfile.pairingAdvice}</div>
                  </div>
                )}

                <div className="row-between">
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>协作语言</span>
                  <div className="segmented">
                    {[
                      { id: "zh-CN", label: "简体中文" },
                      { id: "en", label: "English" },
                      { id: "auto", label: "自动" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`seg-btn ${(effectiveCfg.language ?? "zh-CN") === opt.id ? "active" : ""}`}
                        onClick={() => updateModelConfig({ language: opt.id }, `协作语言：${opt.label}`)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="row-between">
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>最大并行 Subagent</span>
                  <div className="segmented">
                    {[1, 2, 3, 4, 6, 8].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`seg-btn ${(effectiveCfg.maxParallelCodex ?? 4) === n ? "active" : ""}`}
                        onClick={() => updateModelConfig({ maxParallelCodex: n }, `并行上限：${n} 个`)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="row-between">
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>审批策略</span>
                  <div className="segmented">
                    {[
                      { id: "on-request", label: "越界审批" },
                      { id: "untrusted", label: "严格审批" },
                      { id: "never", label: "全自动" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`seg-btn ${effectiveCfg.defaultApprovalPolicy === opt.id ? "active" : ""}`}
                        onClick={() => updateModelConfig({ defaultApprovalPolicy: opt.id }, `审批策略：${opt.label}`)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 6 Collaboration Modes Feature Showcase */}
            <div className="card stagger" style={{ "--i": 3 } as React.CSSProperties}>
              <div className="card-head">
                <div>
                  <div className="section-title">六大协作模式特色与一键切换</div>
                  <div className="muted">点击任意卡片即时切换当前项目模式；点「自定义工作流」可直接打开可视化工序配置器。</div>
                </div>
                {activeProject && (
                  <span className="pill gemini">当前：{MODE_LABELS[activeProject.mode] ?? activeProject.mode}</span>
                )}
              </div>
              <div className="mode-grid">
                {MODE_CATALOG.map((m) => {
                  const isActive = activeProject?.mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`mode-card ${isActive ? "active" : ""}`}
                      onClick={() => selectModeFromCard(m.id)}
                    >
                      <div className="row-between">
                        <strong style={{ fontSize: 13 }}>{m.name}</strong>
                        <span className={`pill ${isActive ? "gemini" : "todo"}`} style={{ fontSize: 10.5 }}>
                          {isActive ? "当前模式" : m.tag}
                        </span>
                      </div>
                      <div className="mode-card-desc">{m.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: INTELLIGENT SCHEDULER & TASK BOARD */}
        {tab === "board" && (
          <div key="stage-board" className="stage">
            {!activeProject ? (
              <div className="empty-state">
                <div className="section-title">尚未绑定项目目录</div>
                <div className="muted">输入你的论文、科研或代码仓库绝对路径，即可激活 DAG 智能调度。</div>
                <div className="row" style={{ width: "100%", maxWidth: 460 }}>
                  <input
                    type="text"
                    style={{ flex: 1 }}
                    placeholder="/Users/you/Documents/Project"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                  />
                  <button className="btn primary" onClick={() => initProjectFromUi()} disabled={loading || !newProjectPath.trim()}>
                    初始化
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="row-between">
                  <div className="row">
                    <span className="muted">{activeProject.rootPath}</span>
                  </div>
                  <div className="row">
                    <button
                      className={`btn sm ${showWorkflowBuilder ? "primary" : ""}`}
                      onClick={() => setShowWorkflowBuilder((v) => !v)}
                    >
                      <IconWrench /> {showWorkflowBuilder ? "收起自定义工作流" : "自定义工作流"}
                    </button>
                    <button className="btn sm" onClick={() => setShowNewTask((v) => !v)}>
                      {showNewTask ? "收起" : "+ 新建任务"}
                    </button>
                    <button
                      className="btn sm primary"
                      onClick={autoDispatchWave}
                      disabled={loading || (schedule?.readyTasks.length ?? 0) === 0}
                    >
                      <IconSpark /> 一键智能调度本波次
                    </button>
                    {canMessage && (
                      <button
                        className="btn sm"
                        onClick={() =>
                          sendToConversation(`请调用 team_schedule_plan 检查项目「${activeProject.name}」的 DAG 波次与停滞状态，并推进下一步。`)
                        }
                      >
                        <IconPlay /> 交给 Gemini 统筹
                      </button>
                    )}
                  </div>
                </div>

                {/* Active Mode Quick Feature Strip */}
                {(() => {
                  const curModeInfo = MODE_CATALOG.find((m) => m.id === activeProject.mode);
                  if (!curModeInfo) return null;
                  return (
                    <div className="card subtle" style={{ padding: "8px 12px" }}>
                      <div className="row-between">
                        <div className="row" style={{ gap: 8 }}>
                          <span className="pill gemini">{curModeInfo.name} · {curModeInfo.tag}</span>
                          <span className="muted" style={{ fontSize: 12 }}>{curModeInfo.desc}</span>
                        </div>
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => setTab("models")}
                        >
                          查看全部 6 种模式
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Visual Custom Workflow Builder Drawer */}
                <div className={`drawer ${showWorkflowBuilder ? "open" : ""}`}>
                  <div className="drawer-inner">
                    <div className="card subtle" style={{ marginBottom: 4 }}>
                      <div className="card-head">
                        <div>
                          <div className="section-title">自定义工作流配置器（免写 JSON · 存入 .duo-team/workflows/）</div>
                          <div className="muted">把你常用的固定流程配好阶段、负责模型与前置依赖，保存后可一键批量生成 DAG 任务。</div>
                        </div>
                        <div className="row">
                          <span className="muted" style={{ fontSize: 11.5 }}>一键载入范本：</span>
                          <button type="button" className="btn sm" onClick={() => loadWorkflowStarter("paper")}>计量论文流</button>
                          <button type="button" className="btn sm" onClick={() => loadWorkflowStarter("dev")}>全栈 TDD 流</button>
                          <button type="button" className="btn sm" onClick={() => loadWorkflowStarter("research")}>深度调研流</button>
                        </div>
                      </div>

                      {(state?.workflowPresets?.length ?? 0) > 0 && (
                        <div className="row" style={{ paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
                          <span className="muted" style={{ fontSize: 11.5 }}>已保存模板：</span>
                          {state!.workflowPresets!.map((wp) => (
                            <div key={wp.id} className="row" style={{ gap: 4 }}>
                              <button
                                type="button"
                                className="btn sm primary"
                                disabled={loading}
                                onClick={() => applyWorkflowPresetFromUi(wp.id, wp.name)}
                              >
                                <IconPlay /> 套用「{wp.name}」({wp.stages.length})
                              </button>
                              <button
                                type="button"
                                className="btn sm ghost"
                                onClick={() => loadExistingPresetIntoBuilder(wp)}
                              >
                                编辑
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="row">
                        <input
                          type="text"
                          style={{ flex: 2, minWidth: 160 }}
                          placeholder="工作流名称（如：我的实证论文流程）"
                          value={wfName}
                          onChange={(e) => setWfName(e.target.value)}
                        />
                        <input
                          type="text"
                          style={{ flex: 1, minWidth: 120, fontFamily: "var(--mono)" }}
                          placeholder="模板 ID（英文，如 my-paper）"
                          value={wfPresetId}
                          onChange={(e) => setWfPresetId(e.target.value)}
                        />
                        <select
                          value={wfMaxReworks}
                          onChange={(e) => setWfMaxReworks(Number(e.target.value))}
                          aria-label="最大自愈返工次数"
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>最多返工 {n} 次</option>
                          ))}
                        </select>
                      </div>

                      <input
                        type="text"
                        placeholder="一句话简介（可选，说明这套工作流适用于什么任务）"
                        value={wfDesc}
                        onChange={(e) => setWfDesc(e.target.value)}
                      />

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {wfStages.map((st, idx) => {
                          const earlierStages = wfStages.slice(0, idx);
                          return (
                            <div key={`${st.id}-${idx}`} className="wf-stage-card">
                              <div className="row">
                                <span className="pill gemini" style={{ fontFamily: "var(--mono)" }}>{st.id}</span>
                                <input
                                  type="text"
                                  style={{ flex: 2, minWidth: 170 }}
                                  placeholder={`第 ${idx + 1} 阶段标题（如：数据清洗与描述统计）`}
                                  value={st.title}
                                  onChange={(e) =>
                                    setWfStages((prev) => prev.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))
                                  }
                                />
                                <select
                                  value={st.owner}
                                  onChange={(e) =>
                                    setWfStages((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, owner: e.target.value as WorkflowStageDraft["owner"] } : x))
                                    )
                                  }
                                >
                                  <option value="codex">执行：Codex (GPT)</option>
                                  <option value="gemini">执行：Gemini</option>
                                  <option value="human">执行：人工</option>
                                </select>
                                <select
                                  value={st.reviewer}
                                  onChange={(e) =>
                                    setWfStages((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, reviewer: e.target.value as WorkflowStageDraft["reviewer"] } : x))
                                    )
                                  }
                                >
                                  <option value="gemini">复核：Gemini</option>
                                  <option value="codex">复核：Codex (GPT)</option>
                                  <option value="human">复核：人工</option>
                                  <option value="none">无需复核</option>
                                </select>
                                {wfStages.length > 1 && (
                                  <button
                                    type="button"
                                    className="btn sm rose"
                                    onClick={() => {
                                      const removedId = st.id;
                                      setWfStages((prev) =>
                                        prev
                                          .filter((_, i) => i !== idx)
                                          .map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== removedId) }))
                                      );
                                    }}
                                  >
                                    删除
                                  </button>
                                )}
                              </div>

                              <div className="row">
                                <input
                                  type="text"
                                  style={{ flex: 1, minWidth: 160 }}
                                  placeholder="自动验收命令（可选，如 pytest / npm test）"
                                  value={st.verifyCommand}
                                  onChange={(e) =>
                                    setWfStages((prev) => prev.map((x, i) => (i === idx ? { ...x, verifyCommand: e.target.value } : x)))
                                  }
                                />
                                <input
                                  type="text"
                                  style={{ flex: 1, minWidth: 160 }}
                                  placeholder="预期交付文件（可选，逗号分隔，如 output/table1.tex）"
                                  value={st.artifacts}
                                  onChange={(e) =>
                                    setWfStages((prev) => prev.map((x, i) => (i === idx ? { ...x, artifacts: e.target.value } : x)))
                                  }
                                />
                              </div>

                              {earlierStages.length > 0 && (
                                <div className="row" style={{ gap: 6 }}>
                                  <span className="muted" style={{ fontSize: 11 }}>前置依赖（勾同一个前置即可并行）：</span>
                                  {earlierStages.map((prevSt) => {
                                    const on = st.dependsOn.includes(prevSt.id);
                                    return (
                                      <button
                                        key={prevSt.id}
                                        type="button"
                                        className={`dep-chip ${on ? "on" : ""}`}
                                        onClick={() => toggleStageDep(idx, prevSt.id)}
                                      >
                                        {on ? "✓" : "+"} {prevSt.id}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="row-between" style={{ paddingTop: 4 }}>
                        <button type="button" className="btn sm" onClick={addWorkflowStage}>
                          + 添加一个阶段
                        </button>
                        <div className="row">
                          <button
                            type="button"
                            className="btn sm"
                            disabled={loading}
                            onClick={() => saveWorkflowPresetFromUi(false)}
                          >
                            仅保存模板
                          </button>
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={loading}
                            onClick={() => saveWorkflowPresetFromUi(true)}
                          >
                            <IconPlay /> 保存并立即套用到看板
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Collapsible New Task Drawer */}
                <div className={`drawer ${showNewTask ? "open" : ""}`}>
                  <div className="drawer-inner">
                    <div className="card subtle" style={{ marginBottom: 4 }}>
                      <div className="section-title">新建协作任务</div>
                      <div className="row">
                        <input
                          type="text"
                          style={{ flex: 2, minWidth: 180 }}
                          placeholder="任务标题（如：面板数据清洗与基准回归）"
                          value={newTaskTitle}
                          onChange={(e) => setNewTaskTitle(e.target.value)}
                        />
                        <select value={newTaskOwner} onChange={(e) => setNewTaskOwner(e.target.value as "codex" | "gemini" | "human")}>
                          <option value="codex">执行：Codex (GPT)</option>
                          <option value="gemini">执行：Gemini</option>
                          <option value="human">执行：人工</option>
                        </select>
                        <select value={newTaskReviewer} onChange={(e) => setNewTaskReviewer(e.target.value as "gemini" | "codex" | "human" | "none")}>
                          <option value="gemini">复核：Gemini</option>
                          <option value="codex">复核：Codex (GPT)</option>
                          <option value="human">复核：人工</option>
                          <option value="none">无需复核</option>
                        </select>
                      </div>
                      <input type="text" placeholder="任务说明（可选）" value={newTaskDesc} onChange={(e) => setNewTaskDesc(e.target.value)} />
                      <div className="row">
                        <input type="text" style={{ flex: 1 }} placeholder="验收标准" value={newTaskCriteria} onChange={(e) => setNewTaskCriteria(e.target.value)} />
                        <input type="text" style={{ flex: 1 }} placeholder="自动验收命令（支持自愈返工，如 pytest）" value={newTaskVerifyCmd} onChange={(e) => setNewTaskVerifyCmd(e.target.value)} />
                        <button className="btn primary" onClick={createTaskFromUi} disabled={loading || !newTaskTitle.trim()}>创建</button>
                      </div>
                    </div>
                  </div>
                </div>

                  {!showWorkflowBuilder && activeProject.mode === "custom" && (state?.workflowPresets?.length ?? 0) > 0 && (
                    <div className="card subtle" style={{ padding: 10 }}>
                      <div className="row-between">
                        <span style={{ fontWeight: 600, fontSize: 12 }}>已保存的自定义工作流 (.duo-team/workflows/)</span>
                        <div className="row">
                          {state!.workflowPresets!.map((wp) => (
                            <button
                              key={wp.id}
                              className="btn sm primary"
                              disabled={loading}
                              onClick={() => applyWorkflowPresetFromUi(wp.id, wp.name)}
                            >
                              <IconPlay /> 套用「{wp.name}」({wp.stages.length})
                            </button>
                          ))}
                          <button className="btn sm" onClick={() => setShowWorkflowBuilder(true)}>
                            编辑 / 新建
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Plain-Chinese Visual Execution Flow */}
                {schedule && schedule.waves.length > 0 && (
                  <div className="card stagger" style={{ "--i": 0 } as React.CSSProperties}>
                    <div className="row-between">
                      <div>
                        <div className="section-title">执行顺序流程图（从左到右按批次推进）</div>
                        <div className="muted">同一列里的任务会 <strong>同时并行做</strong>，箭头指向的下一批会等前面全部完成后自动启动；紫色边框是最关键主线。</div>
                      </div>
                      <span className="muted" style={{ fontWeight: 600 }}>
                        进度 {schedule.doneTasks}/{schedule.totalTasks} · 当前可启动 {schedule.readyTasks.length}
                      </span>
                    </div>
                    <div className="row" style={{ fontSize: 11.5 }}>
                      <span className="pill running"><span className="dot pulse" />进行中</span>
                      <span className="pill done">已完成</span>
                      <span className="pill todo">待开始</span>
                      <span className="pill awaiting_human">等你拍板</span>
                      <span className="pill gemini">⭐ 核心主线：{schedule.criticalPath.join(" → ") || "无"}</span>
                    </div>
                    <div className="dag-strip">
                      {schedule.waves.map((w, idx) => (
                        <React.Fragment key={w.wave}>
                          <div className="dag-wave">
                            <div className="dag-wave-head">
                              <span>第 {w.wave} 批{w.taskIds.length > 1 ? "（同时做）" : ""}</span>
                              <span>{w.taskIds.length} 项</span>
                            </div>
                            {w.taskIds.map((tid) => {
                              const t = taskMap.get(tid);
                              if (!t) return null;
                              const isCrit = criticalSet.has(tid);
                              return (
                                <div key={tid} className={`dag-node ${isCrit ? "critical" : ""}`} title={`${tid} · ${t.title}（执行：${t.owner}）`}>
                                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {isCrit ? "⭐ " : ""}
                                    <strong>{t.title}</strong>
                                  </span>
                                  <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                                    <span className={`pill ${t.owner}`} style={{ fontSize: 10 }}>
                                      {t.owner === "codex" ? "GPT" : t.owner === "gemini" ? "Gemini" : "人工"}
                                    </span>
                                    <span className={`pill ${t.status}`} style={{ fontSize: 10 }}>
                                      {STATUS_LABELS[t.status] ?? t.status}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {idx < schedule.waves.length - 1 && (
                            <div className="dag-connector" aria-hidden="true">
                              <svg width="26" height="16" viewBox="0 0 26 16">
                                <line className="flow-line" x1="2" y1="8" x2="20" y2="8" />
                                <polyline points="16,4 21,8 16,12" fill="none" stroke="currentColor" strokeWidth="1.6" />
                              </svg>
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}

                {state!.tasks.length === 0 ? (
                  <div className="empty-state">
                    <div className="section-title">从一个目标开始组建 AI 团队</div>
                    <div className="muted">一键启动任意跨模型协作模式，或点右上角「+ 新建任务」构建你的 DAG 任务图。</div>
                    {canMessage && (
                      <div className="row" style={{ justifyContent: "center", marginTop: 6 }}>
                        {[
                          { label: "规划执行（智能 DAG）", prompt: `请在项目「${activeProject.name}」启动 Duo-Team 规划执行模式（全程简体中文）：拆解任务 DAG 并让 Codex 挑刺评审计划，通过后用 team_auto_dispatch 并发执行并用 team_self_heal 自动验收自愈。` },
                          { label: "角色互换（GPT 做架构师）", prompt: `请在项目「${activeProject.name}」启动角色互换模式（全程简体中文）：让 Codex 担任首席架构师制定任务图，Gemini 评审质疑后共同分工交付。` },
                          { label: "双盲并行研究", prompt: `请在项目「${activeProject.name}」启动双盲并行研究模式（全程简体中文）：Gemini 与 Codex 同时独立研究同一资料，完成后交叉对比共识与分歧。` },
                          { label: "结构化辩论（2 轮）", prompt: `请在项目「${activeProject.name}」启动结构化辩论模式（全程简体中文）：Gemini 与 Codex 分别任正反方盲写立论，2 轮质证反驳后给出证据裁决。` },
                        ].map((item) => (
                          <button key={item.label} className="btn sm" onClick={() => sendToConversation(item.prompt)}>
                            <IconPlay /> {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid-2">
                    {state!.tasks.map((t, idx) => {
                      const rec = recMap.get(t.id);
                      return (
                        <div
                          key={t.id}
                          style={{ "--i": idx + 1 } as React.CSSProperties}
                          className={`card stagger ${t.status === "running" ? "running-card" : ""}`}
                        >
                          <div className="card-head">
                            <div>
                              <div className="row">
                                <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{t.id}</span>
                                {criticalSet.has(t.id) && <span className="pill gemini">关键路径</span>}
                              </div>
                              <div className="section-title">{t.title}</div>
                            </div>
                            <span className={`pill ${t.status}`}>
                              <span className={`dot ${t.status === "running" ? "pulse" : ""}`} />
                              {STATUS_LABELS[t.status] ?? t.status}
                            </span>
                          </div>

                          <div className="row">
                            <span className={`pill ${t.owner}`}>执行: {t.owner}</span>
                            <span className={`pill ${t.reviewer}`}>复核: {t.reviewer}</span>
                            {t.reworkCount > 0 && <span className="pill rework">自愈/返工 {t.reworkCount}/{t.maxReworks}</span>}
                            {t.dependsOn.length > 0 && (
                              <span className="pill">依赖: {t.dependsOn.join(", ")}{!t.ready ? " (等待)" : ""}</span>
                            )}
                          </div>

                          {rec && (
                            <div className="muted" style={{ fontSize: 11.5 }}>
                              推荐路由：<strong>{rec.recommendedModel ?? "默认"}{rec.recommendedEffort ? ` · ${rec.recommendedEffort}` : ""}</strong>（{rec.reason}）
                            </div>
                          )}

                          {t.description && <div style={{ color: "var(--text-muted)" }}>{t.description}</div>}
                          {t.acceptanceCriteria && <div className="muted">验收标准：{t.acceptanceCriteria}</div>}

                          {t.artifacts.length > 0 && (
                            <div className="row">
                              {t.artifacts.map((a) => (
                                <button key={a} className="btn sm" onClick={() => openWorkspaceFile(a)}>
                                  <IconFile /> {a}
                                </button>
                              ))}
                            </div>
                          )}

                          {t.lastVerify && (
                            <div className="row">
                              <span className={`pill ${t.lastVerify.passed ? "done" : "rework"}`}>
                                {t.lastVerify.passed ? "校验通过" : "校验未通过"}
                              </span>
                              {t.lastVerify.command && (
                                <span className="muted" style={{ fontFamily: "var(--mono)" }}>
                                  {t.lastVerify.command} (exit {t.lastVerify.exitCode})
                                </span>
                              )}
                            </div>
                          )}

                          <div className="row">
                            <input
                              type="text"
                              style={{ flex: 1 }}
                              placeholder="验收或返工备注（可选）"
                              value={reworkNotes[t.id] ?? ""}
                              onChange={(e) => setReworkNotes((p) => ({ ...p, [t.id]: e.target.value }))}
                            />
                          </div>
                          <div className="row">
                            {(t.verifyCommand || t.artifacts.length > 0) && (
                              <button className="btn sm" onClick={() => selfHealTask(t.id)} disabled={loading}>
                                <IconWrench /> 验收并自愈
                              </button>
                            )}
                            <button className="btn sm emerald" onClick={() => humanDecision(t.id, "accept")} disabled={loading}>
                              <IconCheck /> 通过
                            </button>
                            <button className="btn sm rose" onClick={() => humanDecision(t.id, "rework")} disabled={loading}>打回</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* TAB 3: GPT SUBAGENT SQUAD */}
        {tab === "workers" && (
          <div key="stage-workers" className="stage">
            {pendingApprovals.map((a) => (
              <div key={a.id} className="card" style={{ borderColor: "var(--amber)" }}>
                <div className="card-head">
                  <div className="section-title">待审批 · {a.summary}</div>
                  <span className="pill awaiting_human">{a.threadId.slice(0, 8)}</span>
                </div>
                <div className="row">
                  <button className="btn sm emerald" onClick={() => controlCodex("approve", { approvalId: a.id })}>批准本次</button>
                  <button className="btn sm primary" onClick={() => controlCodex("approve_session", { approvalId: a.id })}>本会话放行</button>
                  <button className="btn sm rose" onClick={() => controlCodex("decline", { approvalId: a.id })}>拒绝</button>
                </div>
              </div>
            ))}

            <div className="row-between">
              <div className="row">
                <span className="section-title">本项目 GPT 线程 ({sortedActiveThreads.length})</span>
                <span className="pill codex">并发上限 {effectiveCfg.maxParallelCodex ?? 4}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>运行中与最新线程自动置顶</span>
              </div>
              <button className="btn sm primary" onClick={() => setShowSquadDrawer((v) => !v)}>
                {showSquadDrawer ? "收起启动台" : "+ 多开 / 启动 Subagent"}
              </button>
            </div>

            {(otherProjectsThreads.length > 0 || otherProjectsApprovalCount > 0) && (
              <div className="card subtle" style={{ padding: "8px 12px" }}>
                <div className="row-between">
                  <span className="muted" style={{ fontSize: 12 }}>
                    已自动隔离：其他项目另有 <strong>{otherProjectsThreads.length}</strong> 个线程
                    {otherProjectsApprovalCount > 0 ? `（含 ${otherProjectsApprovalCount} 项待审批）` : ""}，不会混入本项目。
                  </span>
                  <div className="row">
                    {Array.from(
                      new Map(
                        otherProjectsThreads
                          .filter((x) => x.projectId)
                          .map((x) => [x.projectId!, x.projectName])
                      ).entries()
                    ).map(([pid, pname]) => (
                      <button key={pid} type="button" className="btn sm" onClick={() => refresh(pid, false)}>
                        切到「{pname}」
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className={`drawer ${showSquadDrawer ? "open" : ""}`}>
              <div className="drawer-inner">
                <div className="card subtle" style={{ marginBottom: 4 }}>
                  <div className="row-between">
                    <div className="segmented">
                      <button type="button" className={`seg-btn ${launcherMode === "batch" ? "active" : ""}`} onClick={() => setLauncherMode("batch")}>
                        并发多开编队
                      </button>
                      <button type="button" className={`seg-btn ${launcherMode === "single" ? "active" : ""}`} onClick={() => setLauncherMode("single")}>
                        单开线程
                      </button>
                    </div>
                    {launcherMode === "batch" && (
                      <div className="row">
                        <button type="button" className="btn sm" onClick={() => applySquadPreset("parallel")}>双盲 2 路</button>
                        <button type="button" className="btn sm" onClick={() => applySquadPreset("debate")}>辩论 2 路</button>
                        <button type="button" className="btn sm" onClick={() => applySquadPreset("dev3")}>研发 3 人组</button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={squad.length >= (effectiveCfg.maxParallelCodex ?? 4)}
                          onClick={() => setSquad((p) => [...p, { id: `s-${Date.now()}`, role: `子代理 #${p.length + 1}`, model: "", effort: "", sandbox: "read-only", prompt: "" }])}
                        >
                          + 加一路
                        </button>
                      </div>
                    )}
                  </div>

                  {launcherMode === "single" ? (
                    <div className="row">
                      <input type="text" style={{ width: 150 }} value={manualRole} onChange={(e) => setManualRole(e.target.value)} placeholder="角色名" />
                      <select value={manualSandbox} onChange={(e) => setManualSandbox(e.target.value as "read-only" | "workspace-write")}>
                        <option value="workspace-write">工作区可写</option>
                        <option value="read-only">仅只读评审</option>
                      </select>
                      <input
                        type="text"
                        style={{ flex: 1, minWidth: 200 }}
                        placeholder={activeProject ? `在 ${activeProject.name} 下达中文任务...` : "请先绑定项目目录"}
                        value={manualPrompt}
                        onChange={(e) => setManualPrompt(e.target.value)}
                        disabled={!activeProject}
                      />
                      <button className="btn primary" onClick={manualSpawnCodex} disabled={loading || !activeProject || !manualPrompt.trim()}>
                        <IconPlay /> 启动
                      </button>
                    </div>
                  ) : (
                    <>
                      {squad.map((slot, idx) => {
                        const slotMeta = models.find((m) => m.id === slot.model);
                        const slotEfforts = slotMeta?.efforts ?? activeEfforts;
                        return (
                          <div key={slot.id} className="card" style={{ padding: 10, gap: 6 }}>
                            <div className="row">
                              <span className="pill gemini">#{idx + 1}</span>
                              <input type="text" style={{ width: 150 }} value={slot.role} onChange={(e) => setSquad((p) => p.map((x) => (x.id === slot.id ? { ...x, role: e.target.value } : x)))} />
                              <select value={slot.model} onChange={(e) => setSquad((p) => p.map((x) => (x.id === slot.id ? { ...x, model: e.target.value } : x)))}>
                                <option value="">模型：全局</option>
                                {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                              </select>
                              <select value={slot.effort} onChange={(e) => setSquad((p) => p.map((x) => (x.id === slot.id ? { ...x, effort: e.target.value } : x)))}>
                                <option value="">强度：全局</option>
                                {slotEfforts.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
                              </select>
                              <select value={slot.sandbox} onChange={(e) => setSquad((p) => p.map((x) => (x.id === slot.id ? { ...x, sandbox: e.target.value as "read-only" | "workspace-write" } : x)))}>
                                <option value="read-only">只读</option>
                                <option value="workspace-write">可写</option>
                              </select>
                              {squad.length > 1 && (
                                <button type="button" className="btn sm ghost" onClick={() => setSquad((p) => p.filter((x) => x.id !== slot.id))}>移除</button>
                              )}
                            </div>
                            <input
                              type="text"
                              style={{ width: "100%" }}
                              value={slot.prompt}
                              disabled={!activeProject}
                              onChange={(e) => setSquad((p) => p.map((x) => (x.id === slot.id ? { ...x, prompt: e.target.value } : x)))}
                              placeholder={`给「${slot.role}」下达中文指令...`}
                            />
                          </div>
                        );
                      })}
                      <div className="row-between">
                        <span className="muted">已填 {squad.filter((s) => s.prompt.trim()).length}/{squad.length} 路</span>
                        <button
                          className="btn primary"
                          onClick={spawnSquadBatch}
                          disabled={loading || !activeProject || squad.filter((s) => s.prompt.trim()).length === 0}
                        >
                          <IconPlay /> 一键并发启动
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {activeThreads.length > 0 && (
              <div className="card subtle" style={{ padding: 10 }}>
                <div className="row">
                  <span style={{ fontWeight: 600, fontSize: 12 }}>全体广播</span>
                  <input
                    type="text"
                    style={{ flex: 1, minWidth: 180 }}
                    placeholder="向所有活跃 GPT Subagent 同时发送纠偏指令..."
                    value={broadcastInput}
                    onChange={(e) => setBroadcastInput(e.target.value)}
                  />
                  <button className="btn sm primary" disabled={loading || !broadcastInput.trim()} onClick={() => broadcastToTeam("message")}>
                    <IconSend /> 广播
                  </button>
                  {runningCount > 0 && (
                    <button className="btn sm rose" disabled={loading} onClick={() => broadcastToTeam("interrupt_all")}>
                      全部中断 ({runningCount})
                    </button>
                  )}
                </div>
              </div>
            )}

            {sortedActiveThreads.length === 0 ? (
              <div className="empty-state">
                <div className="section-title">当前项目暂无活跃 GPT Subagent</div>
                <div className="muted">点击上方「+ 多开 / 启动 Subagent」，或在任务看板点「一键智能调度本波次」。</div>
              </div>
            ) : (
              sortedActiveThreads.map((t, idx) => {
                const isLive = t.status === "running" || t.status === "waiting_approval";
                const isExpanded = isLive || Boolean(expandedThreads[t.threadId]);
                const timeStr = t.updatedAt ? new Date(t.updatedAt).toLocaleTimeString() : "";
                return (
                  <div
                    key={t.threadId}
                    style={{ "--i": idx } as React.CSSProperties}
                    className={`card stagger ${t.status === "running" ? "running-card" : ""}`}
                  >
                    <div className="card-head">
                      <div>
                        <div className="row">
                          <div className="section-title">{t.role}</div>
                          {idx === 0 && <span className="pill gemini" style={{ fontSize: 10 }}>最新</span>}
                        </div>
                        <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
                          {t.threadId.slice(0, 12)} · {t.model ?? "默认"}{t.effort ? ` (${t.effort})` : ""}{timeStr ? ` · ${timeStr}` : ""}
                        </div>
                      </div>
                      <div className="row">
                        {!isLive && (t.latestOutput || t.reasoningSummary) && (
                          <button
                            type="button"
                            className="btn sm ghost"
                            onClick={() => setExpandedThreads((p) => ({ ...p, [t.threadId]: !isExpanded }))}
                          >
                            {isExpanded ? "收起详情" : "展开完整输出"}
                          </button>
                        )}
                        <span className={`pill ${t.status}`}>
                          <span className={`dot ${t.status === "running" ? "pulse" : ""}`} />
                          {t.status}
                        </span>
                      </div>
                    </div>
                    {t.lastError && <div className="pill failed">{t.lastError}</div>}
                    {!isExpanded && t.latestOutput && (
                      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {t.latestOutput}
                      </div>
                    )}
                    {isExpanded && t.reasoningSummary && (
                      <div>
                        <div className="muted" style={{ marginBottom: 4 }}>公开推理摘要</div>
                        <pre className="code-block">{t.reasoningSummary}</pre>
                      </div>
                    )}
                    {isExpanded && t.latestOutput && (
                      <div>
                        <div className="muted" style={{ marginBottom: 4 }}>最新输出</div>
                        <pre className="code-block">{t.latestOutput}</pre>
                      </div>
                    )}
                    {t.subAgents && t.subAgents.length > 0 && (
                      <div className="card subtle" style={{ padding: 10, gap: 6 }}>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>Codex 原生子代理 ({t.subAgents.length})</div>
                        {t.subAgents.map((sa) => (
                          <div key={sa.id} className="row-between">
                            <div className="row">
                              <span className="pill codex">{sa.tool}</span>
                              {sa.model && <span className="muted" style={{ fontFamily: "var(--mono)" }}>{sa.model}</span>}
                              {sa.prompt && <span className="muted">{sa.prompt.slice(0, 80)}</span>}
                            </div>
                            <span className={`pill ${sa.status}`}>{sa.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {t.activities.length > 0 && (
                      <div className="muted">最近活动：{t.activities.slice(-3).map((a) => `${a.title} [${a.status}]`).join(" · ")}</div>
                    )}
                    <div className="row">
                      <input
                        type="text"
                        style={{ flex: 1 }}
                        placeholder="实时插话纠偏 (Steer) 或追加返工指令..."
                        value={steerInputs[t.threadId] ?? ""}
                        onChange={(e) => setSteerInputs((p) => ({ ...p, [t.threadId]: e.target.value }))}
                      />
                      <button className="btn primary" onClick={() => steerCodex(t.threadId)}>
                        <IconSend /> 发送
                      </button>
                      {t.status === "running" && (
                        <button className="btn rose" onClick={() => controlCodex("interrupt", { threadId: t.threadId })}>中断</button>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {historicalRuns.length > 0 && (
              <div className="card subtle">
                <div>
                  <div className="section-title">历史线程 · 断点续传 ({historicalRuns.length})</div>
                  <div className="muted">通过官方 thread/resume 跨天无损续接原上下文</div>
                </div>
                {historicalRuns.slice(0, 8).map((r) => (
                  <div key={r.threadId} className="card" style={{ padding: 10 }}>
                    <div className="row-between">
                      <div className="row">
                        <strong style={{ fontSize: 12.5 }}>{r.role}</strong>
                        <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                          {r.threadId.slice(0, 12)} · {r.model ?? "默认"}{r.effort ? ` (${r.effort})` : ""}
                        </span>
                      </div>
                      <span className={`pill ${r.status}`}>{r.status}</span>
                    </div>
                    {r.finalOutput && <pre className="code-block" style={{ maxHeight: 85 }}>{r.finalOutput.slice(0, 340)}</pre>}
                    <div className="row">
                      <input
                        type="text"
                        style={{ flex: 1 }}
                        placeholder="输入续接指令恢复此线程..."
                        value={resumeInputs[r.threadId] ?? ""}
                        onChange={(e) => setResumeInputs((p) => ({ ...p, [r.threadId]: e.target.value }))}
                      />
                      <button className="btn sm primary" disabled={loading || !(resumeInputs[r.threadId] ?? "").trim()} onClick={() => resumeHistoricalThread(r.threadId, r.cwd)}>
                        <IconPlay /> 续接
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: FEED & DEBATE */}
        {tab === "feed" && (
          <div key="stage-feed" className="stage">
            {activeProject && (
              <div className="card subtle" style={{ padding: 10 }}>
                <div className="row">
                  <select value={humanMsgKind} onChange={(e) => setHumanMsgKind(e.target.value as "human_note" | "verdict" | "challenge")}>
                    <option value="human_note">人工指令</option>
                    <option value="verdict">人工裁决</option>
                    <option value="challenge">人工质疑</option>
                  </select>
                  <input
                    type="text"
                    style={{ flex: 1, minWidth: 200 }}
                    placeholder="直接向双模型协作流写入你的指示或裁决..."
                    value={humanMsgText}
                    onChange={(e) => setHumanMsgText(e.target.value)}
                  />
                  <button className="btn sm" disabled={loading || !humanMsgText.trim()} onClick={() => postHumanMessage(false)}>仅记录</button>
                  {canMessage && (
                    <button className="btn sm primary" disabled={loading || !humanMsgText.trim()} onClick={() => postHumanMessage(true)}>
                      <IconSend /> 写入并通知 Gemini
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="row-between">
              <span className="muted">
                {dualSideMessages.hasSides ? "检测到双盲并行研究或辩论记录" : `共 ${sortedMessages.length} 条协作记录`}
              </span>
              <div className="row">
                <button className="btn sm ghost" onClick={() => setFeedNewestFirst((v) => !v)}>
                  {feedNewestFirst ? "排序：最新在前" : "排序：时间正序"}
                </button>
                {dualSideMessages.hasSides && (
                  <button className="btn sm" onClick={() => setSideBySide((v) => !v)}>
                    {sideBySide ? "切换时间流" : "切换左右双栏"}
                  </button>
                )}
              </div>
            </div>

            {sortedMessages.length === 0 ? (
              <div className="empty-state">
                <div className="section-title">暂无跨模型协作记录</div>
                <div className="muted">Gemini 与 Codex 之间的计划、质疑、评审、自愈日志与辩论反驳会实时汇聚于此。</div>
              </div>
            ) : dualSideMessages.hasSides && sideBySide ? (
              <div className="grid-2">
                <div className="card subtle">
                  <div className="section-title">正方 / 分支 A</div>
                  {dualSideMessages.left.map((m, idx) => (
                    <div key={m.id} style={{ "--i": idx } as React.CSSProperties} className="card stagger side-pro">
                      <div className="row-between">
                        <span className="pill gemini">{m.fromAgent}</span>
                        <span className="pill">R{m.round} · {KIND_LABELS[m.kind] ?? m.kind}</span>
                      </div>
                      <pre className="code-block">{m.content}</pre>
                    </div>
                  ))}
                </div>
                <div className="card subtle">
                  <div className="section-title">反方 / 分支 B</div>
                  {dualSideMessages.right.map((m, idx) => (
                    <div key={m.id} style={{ "--i": idx } as React.CSSProperties} className="card stagger side-con">
                      <div className="row-between">
                        <span className="pill codex">{m.fromAgent}</span>
                        <span className="pill">R{m.round} · {KIND_LABELS[m.kind] ?? m.kind}</span>
                      </div>
                      <pre className="code-block">{m.content}</pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              sortedMessages.map((m, idx) => (
                <div key={m.id} style={{ "--i": idx } as React.CSSProperties} className="card stagger">
                  <div className="card-head">
                    <div className="row">
                      <span className={`pill ${m.fromAgent.toLowerCase().includes("codex") ? "codex" : m.fromAgent === "Human" ? "human" : "gemini"}`}>
                        {m.fromAgent}
                      </span>
                      <span className="muted">→ {m.toAgent}</span>
                      <span className="pill">{KIND_LABELS[m.kind] ?? m.kind} · R{m.round}</span>
                      {m.taskId && <span className="pill">{m.taskId}</span>}
                    </div>
                    <span className="muted">{new Date(m.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <pre className="code-block">{m.content}</pre>
                  {m.refs.length > 0 && (
                    <div className="row">
                      {m.refs.map((r) => (
                        <button key={r} className="btn sm" onClick={() => openWorkspaceFile(r)}>
                          <IconFile /> {r}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* TAB 5: FILES, MUST-READ CONTEXT & SHARED TEAM NOTES */}
        {tab === "artifacts" && (
          <div key="stage-artifacts" className="stage">
            {!activeProject ? (
              <div className="empty-state">
                <div className="section-title">请先绑定一个项目目录</div>
                <div className="muted">绑定后可在这里挑出「必读文件」交给双模型优先看，并在右侧记录两个 AI 共同遵守的备忘录。</div>
              </div>
            ) : (
              <>
                <div className="grid-2">
                  {/* LEFT: Plain-Chinese Project Files & Must-Read Context */}
                  <div className="card stagger" style={{ "--i": 0 } as React.CSSProperties}>
                    <div className="row-between">
                      <div>
                        <div className="section-title">
                          项目文件与必读资料
                          {wsInspect?.projectTree ? `（共 ${wsInspect.projectTree.totalFiles} 个文件）` : ""}
                        </div>
                        <div className="muted">点文件名预览；点「设为必读」后，Gemini 和 GPT 每次干活都会优先阅读它。</div>
                      </div>
                      <button className="btn sm ghost" onClick={() => inspectWorkspace(activeProject.id)} title="重新扫描目录">
                        <IconRefresh />
                      </button>
                    </div>

                    {/* Visual Project Content Overview (Human-Readable Replacement for Raw Text Map) */}
                    {wsInspect?.projectMap && (() => {
                      const stats = summarizeProjectFiles(wsInspect.projectMap.byExtension);
                      return (
                        <div className="card subtle" style={{ padding: "8px 10px" }}>
                          <div className="row-between">
                            <span style={{ fontWeight: 600, fontSize: 12 }}>项目内容一览</span>
                            <button className="btn sm ghost" style={{ fontSize: 11 }} onClick={() => setShowRepoMap((v) => !v)}>
                              {showRepoMap ? "收起代码大纲" : "查看技术大纲"}
                            </button>
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <span className="pill gemini">代码脚本 {stats.code}</span>
                            <span className="pill codex">论文/文档 {stats.doc}</span>
                            <span className="pill done">数据/表格 {stats.data}</span>
                            {stats.other > 0 && <span className="pill">其他 {stats.other}</span>}
                            <span className="muted" style={{ fontSize: 11 }}>
                              · {wsInspect.projectMap.totalDirs} 个文件夹
                            </span>
                          </div>
                        </div>
                      );
                    })()}

                    {pinnedList.length > 0 && (
                      <div className="row" style={{ padding: "6px 8px", borderRadius: 8, background: "var(--indigo-soft)" }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--indigo)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <IconPin /> 双模型必读资料 ({pinnedList.length})：
                        </span>
                        {pinnedList.map((pf) => (
                          <button
                            key={pf.relPath}
                            className="btn sm"
                            style={{ padding: "2px 8px", fontSize: 11.5 }}
                            onClick={() => togglePinFile(pf.relPath, true)}
                            title="点击取消必读"
                          >
                            {pf.relPath} ×
                          </button>
                        ))}
                      </div>
                    )}

                    <input
                      type="text"
                      placeholder="输入文件名快速搜索..."
                      value={treeFilter}
                      onChange={(e) => setTreeFilter(e.target.value)}
                    />

                    <div className="tree-box">
                      {filteredTree.length === 0 ? (
                        <div className="muted" style={{ padding: 12, textAlign: "center" }}>
                          {wsInspect?.projectTree ? "没有找到匹配的文件" : "正在扫描项目目录..."}
                        </div>
                      ) : (
                        renderTreeBranch(filteredTree)
                      )}
                    </div>

                    <div className={`drawer ${showRepoMap ? "open" : ""}`}>
                      <div className="drawer-inner">
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 }}>
                          <div className="row-between">
                            <span style={{ fontWeight: 600, fontSize: 12 }}>技术代码大纲（自动给 AI 看的目录与函数索引）</span>
                            {canMessage && wsInspect?.projectMap && (
                              <button
                                className="btn sm"
                                onClick={() =>
                                  sendToConversation(`请参考项目「${activeProject.name}」的最新目录大纲与必读资料开展协作。`)
                                }
                              >
                                <IconSend /> 提醒 Gemini 阅读
                              </button>
                            )}
                          </div>
                          <pre className="code-block" style={{ maxHeight: 190 }}>
                            {wsInspect?.projectMap?.outline ?? "正在生成目录大纲..."}
                          </pre>
                        </div>
                      </div>
                    </div>

                    {/* Compact Environment Footer */}
                    <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
                      <div className="row-between">
                        <span className="muted" style={{ fontWeight: 600 }}>
                          {wsInspect?.workspace?.isGitRepo
                            ? `版本状态 · 分支 ${wsInspect.workspace.branch ?? "HEAD"}（${wsInspect.workspace.changedFiles.length} 个未提交改动）`
                            : "普通文件夹（论文 / 调研 / PPT 模式）"}
                        </span>
                      </div>
                      {wsInspect?.workspace?.diffStat && (
                        <pre className="code-block" style={{ maxHeight: 90 }}>{wsInspect.workspace.diffStat}</pre>
                      )}
                      <div className="row">
                        {(wsInspect?.toolchain ?? []).filter((t) => t.available).map((tool) => (
                          <span key={tool.id} className="pill done" title="本机已安装，AI 可直接调用">
                            <span className="dot" />
                            {tool.label}{tool.version ? ` ${tool.version}` : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT: Plain-Chinese Shared Team Notes / Memory */}
                  <div className="card stagger" style={{ "--i": 1 } as React.CSSProperties}>
                    <div className="row-between">
                      <div>
                        <div className="section-title">团队共享备忘录（双模型共同记忆）</div>
                        <div className="muted">写在这里的结论和坑，Gemini 和 GPT 都会记住，不用反复提醒或犯同一个错。</div>
                      </div>
                      <button className="btn sm primary" onClick={() => setShowAddMemory((v) => !v)}>
                        {showAddMemory ? "收起" : "+ 记一条备忘"}
                      </button>
                    </div>

                    <div className={`drawer ${showAddMemory ? "open" : ""}`}>
                      <div className="drawer-inner">
                        <div className="card subtle" style={{ padding: 12, marginBottom: 4 }}>
                          <div className="row">
                            <select value={newMemCat} onChange={(e) => setNewMemCat(e.target.value as MemoryItemRecord["category"])}>
                              <option value="decision">📌 已定方案（拍板的结论）</option>
                              <option value="pitfall">⚠️ 踩过的坑（别再重犯）</option>
                              <option value="fact">📊 数据口径（关键数字/定义）</option>
                              <option value="convention">📏 约定规则（格式/风格要求）</option>
                            </select>
                            <input
                              type="text"
                              style={{ flex: 1, minWidth: 160 }}
                              placeholder="简短标题（如：PPT 用学术深蓝配色）"
                              value={newMemTitle}
                              onChange={(e) => setNewMemTitle(e.target.value)}
                            />
                          </div>
                          <textarea
                            rows={3}
                            placeholder="写下具体要求、已验证结论或避坑提醒..."
                            value={newMemContent}
                            onChange={(e) => setNewMemContent(e.target.value)}
                          />
                          <div className="row-between">
                            <input
                              type="text"
                              style={{ flex: 1 }}
                              placeholder="关键词标签（可选，逗号分隔）"
                              value={newMemTags}
                              onChange={(e) => setNewMemTags(e.target.value)}
                            />
                            <button type="button" className="switch" onClick={() => setNewMemPinned((v) => !v)}>
                              <span className={`switch-track ${newMemPinned ? "on" : ""}`}><span className="switch-thumb" /></span>
                              <span>每次自动提醒 AI</span>
                            </button>
                            <button
                              className="btn sm primary"
                              disabled={loading || !newMemTitle.trim() || !newMemContent.trim()}
                              onClick={addMemoryItemFromUi}
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="row">
                      <input
                        type="text"
                        style={{ flex: 1 }}
                        placeholder="搜索备忘录..."
                        value={memSearch}
                        onChange={(e) => setMemSearch(e.target.value)}
                      />
                    </div>
                    <div className="segmented">
                      {[
                        { id: "all", label: "全部" },
                        { id: "pinned", label: "必看置顶" },
                        { id: "decision", label: "已定方案" },
                        { id: "pitfall", label: "踩过的坑" },
                        { id: "fact", label: "数据口径" },
                        { id: "convention", label: "约定规则" },
                      ].map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={`seg-btn ${memCatFilter === c.id ? "active" : ""}`}
                          onClick={() => setMemCatFilter(c.id as typeof memCatFilter)}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 370, overflow: "auto" }}>
                      {filteredMemoryItems.length === 0 ? (
                        <div className="empty-state" style={{ padding: "24px 14px" }}>
                          <div className="muted">还没有备忘记录。点右上角「+ 记一条备忘」，或让 Gemini / GPT 自动把关键结论记到这里。</div>
                        </div>
                      ) : (
                        filteredMemoryItems.map((m) => (
                          <div key={m.id} className={`mem-card ${m.pinned ? "pinned" : ""} ${m.category === "pitfall" ? "pitfall" : ""}`}>
                            <div className="row-between">
                              <div className="row">
                                <span className={`pill ${m.category === "pitfall" ? "rework" : m.category === "decision" ? "gemini" : "codex"}`}>
                                  {MEM_CAT_LABELS[m.category]}
                                </span>
                                <strong style={{ fontSize: 12.5 }}>{m.title}</strong>
                              </div>
                              <div className="row">
                                <button
                                  className={`btn sm ${m.pinned ? "primary" : "ghost"}`}
                                  style={{ padding: "2px 7px", fontSize: 11 }}
                                  onClick={() => mutateMemoryItem(m.id, "toggle_pin")}
                                >
                                  <IconPin /> {m.pinned ? "必看" : "置顶"}
                                </button>
                                <button
                                  className="btn sm ghost"
                                  style={{ padding: "2px 6px", fontSize: 11 }}
                                  onClick={() => mutateMemoryItem(m.id, "delete")}
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{m.content}</div>
                            <div className="row-between">
                              <div className="row">
                                {m.tags.map((tag) => <span key={tag} className="pill">{tag}</span>)}
                              </div>
                              <span className="muted" style={{ fontSize: 11 }}>记录人：{m.sourceAgent}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                      <div className="row-between">
                        <button className="btn sm ghost" onClick={() => setShowRawMemory((v) => !v)}>
                          {showRawMemory ? "收起原始文档" : "查看/编辑底层 memory.md"}
                        </button>
                        <button className="btn sm ghost" onClick={() => openWorkspaceFile(state?.memory.path || ".duo-team/memory.md")}>
                          <IconFile /> 侧栏打开
                        </button>
                      </div>
                      <div className={`drawer ${showRawMemory ? "open" : ""}`}>
                        <div className="drawer-inner">
                          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
                            <textarea rows={10} value={memoryDraft} onChange={(e) => setMemoryDraft(e.target.value)} />
                            <div className="row-between">
                              <span className="muted">上方备忘条目会自动同步到这份文档里</span>
                              <button className="btn sm primary" onClick={saveMemory} disabled={loading}>保存原文</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
