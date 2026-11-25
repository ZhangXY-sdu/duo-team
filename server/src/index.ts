import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerBridge,
  type ApprovalDecision,
  type ApprovalPolicyMode,
  type SandboxModeType,
  type ThreadSnapshot,
} from "./codex/client.js";
import { checkCodexUpdate, getUpgradeJobState, startCodexUpgradeAsync } from "./codex/updater.js";
import {
  TeamLedger,
  type CollaborationMode,
  type CustomWorkflowStage,
  type MemoryCategory,
  type MessageKind,
  type RoleModelMap,
  type TaskStatus,
  type TeamLanguage,
} from "./ledger/store.js";
import {
  buildProjectTree,
  buildSmartProjectMap,
  inspectWorkspaceChanges,
  probeLocalToolchain,
} from "./ledger/workspace.js";
import { analyzeSchedule, buildSelfHealPrompt } from "./scheduler/engine.js";
import {
  resolveSubscriptionProfile,
  type ChatGptPlanTier,
  type GooglePlanTier,
} from "./scheduler/subscriptions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = "ui://duo-team/workbench.html";
// Dynamic string validation so future GPT reasoning tiers work without code updates
const EFFORT_SCHEMA = z.string().trim().min(1).max(32);
const ROLE_MODELS_SCHEMA = z
  .object({
    planner: z.object({ model: z.string().nullable(), effort: EFFORT_SCHEMA.nullable() }).optional(),
    executor: z.object({ model: z.string().nullable(), effort: EFFORT_SCHEMA.nullable() }).optional(),
    reviewer: z.object({ model: z.string().nullable(), effort: EFFORT_SCHEMA.nullable() }).optional(),
  })
  .optional();

function parseArgs(argv: string[]): { dataDir: string } {
  let dataDir = path.join(os.homedir(), ".gemini", "config", "duo-team-data");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    }
  }
  return { dataDir };
}

function loadWorkbenchHtml(): string {
  const envOverride = process.env.DUO_TEAM_UI_HTML;
  const candidates = [
    envOverride,
    path.resolve(__dirname, "../ui/workbench.html"),
    path.resolve(__dirname, "../../dist/ui/workbench.html"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8");
    }
  }
  return `<!doctype html><html><body style="font-family:system-ui;padding:24px"><h2>Duo-Team Workbench UI 未构建</h2><p>请在 duo-team 目录运行 <code>npm run build:ui</code>。</p></body></html>`;
}

function resolveProjectId(ledger: TeamLedger, projectIdOrPath?: string): string {
  if (projectIdOrPath) {
    const found = ledger.getProject(projectIdOrPath);
    if (found) return found.id;
    if (fs.existsSync(projectIdOrPath) && fs.statSync(projectIdOrPath).isDirectory()) {
      return ledger.ensureProject(projectIdOrPath).id;
    }
    throw new Error(`找不到项目: ${projectIdOrPath}。请先调用 team_project_init 或传入有效的项目目录路径。`);
  }
  const projects = ledger.listProjects();
  if (projects.length > 0) return projects[0].id;
  throw new Error("尚未注册任何 Duo-Team 项目。请先调用 team_project_init 指定项目目录。");
}

function summarizeText(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function buildLanguageDeveloperInstructions(language: TeamLanguage, extra?: string | null): string | undefined {
  const parts: string[] = [];
  if (language === "zh-CN") {
    parts.push(
      "请全程使用简体中文进行回复、思考摘要、计划制定、代码/研究评审、辩论论证以及与主控代理（Gemini）和用户的协作交流（代码标识符、终端命令与原始英文文献引文可保留原样）。如果你派生了 Codex 子代理，也请要求子代理使用简体中文汇报。"
    );
  } else if (language === "en") {
    parts.push("Communicate all plans, reasoning summaries, reviews, debate arguments, and collaboration notes in clear English.");
  }
  if (extra && extra.trim()) parts.push(extra.trim());
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function createDuoTeamServer(options: {
  dataDir: string;
  bridge?: CodexAppServerBridge;
  ledger?: TeamLedger;
}) {
  const ledger = options.ledger ?? new TeamLedger(options.dataDir);
  const threadProjectMap = new Map<string, string>();

  // Cache live Codex account/models/rateLimits for 60s so opening the workbench shows real models immediately
  let codexStatusCache: { at: number; data: Awaited<ReturnType<CodexAppServerBridge["getStatus"]>> } | null = null;
  let toolchainCache: ReturnType<typeof probeLocalToolchain> | null = null;

  const bridge =
    options.bridge ??
    new CodexAppServerBridge({
      onThreadUpdate: (snap: ThreadSnapshot) => {
        const pid = threadProjectMap.get(snap.threadId);
        if (!pid) return;
        ledger.saveRun(pid, {
          threadId: snap.threadId,
          taskId: snap.taskId,
          role: snap.role,
          model: snap.model,
          effort: snap.effort,
          cwd: snap.cwd,
          status: snap.status,
          lastSummary: snap.reasoningSummary.slice(-1500),
          finalOutput: snap.latestOutput.slice(-8000),
          updatedAt: snap.updatedAt,
        });
      },
    });

  async function getLiveCodexStatus(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && codexStatusCache && now - codexStatusCache.at < 60_000) {
      return {
        ...codexStatusCache.data,
        connected: bridge.isConnected(),
        activeThreads: bridge.listThreads(),
        pendingApprovals: bridge.listPendingApprovals(),
      };
    }
    const fresh = await bridge.getStatus();
    if (fresh.connected) {
      codexStatusCache = { at: now, data: fresh };
    }
    return fresh;
  }

  const server = new McpServer({
    name: "duo-team",
    version: "0.4.0",
  });

  // 1. Native MCP App HTML resource
  server.registerResource(
    "duo-team-workbench",
    APP_URI,
    {
      title: "Duo-Team Visual Workbench",
      description: "Embedded Gemini + GPT multi-agent task board, model controls, debate view, Codex monitor, and verification panel.",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: "text/html;profile=mcp-app",
          text: loadWorkbenchHtml(),
        },
      ],
    })
  );

  async function buildDashboardPayload(projectIdOrPath?: string, forceRefreshCodex = false) {
    const projects = ledger.listProjects();
    let activeProject = projectIdOrPath ? ledger.getProject(projectIdOrPath) : null;
    if (!activeProject && projectIdOrPath && fs.existsSync(projectIdOrPath) && fs.statSync(projectIdOrPath).isDirectory()) {
      activeProject = ledger.ensureProject(projectIdOrPath);
    }
    if (!activeProject && projects.length > 0) {
      activeProject = projects[0];
    }

    const codexStatus = await getLiveCodexStatus(forceRefreshCodex).catch((err) => ({
      connected: false,
      account: null,
      rateLimits: null,
      models: [],
      activeThreads: bridge.listThreads(),
      pendingApprovals: bridge.listPendingApprovals(),
      errors: [err instanceof Error ? err.message : String(err)],
    }));

    const globalSettings = ledger.getGlobalSettings();
    const normalizedModels = (codexStatus.models ?? [])
      .map((m) => {
        const obj = m as Record<string, unknown>;
        const id = String(obj.id ?? obj.model ?? obj.slug ?? "");
        const rawEff = Array.isArray(obj.supportedReasoningEfforts) ? obj.supportedReasoningEfforts : [];
        const efforts = rawEff
          .map((e) => (typeof e === "string" ? e : String((e as Record<string, unknown>)?.reasoningEffort ?? "")))
          .filter(Boolean);
        return id ? { id, efforts } : null;
      })
      .filter((x): x is { id: string; efforts: string[] } => Boolean(x));

    const subscriptionProfile = resolveSubscriptionProfile({
      googlePlan: globalSettings.googlePlan,
      chatgptPlan: globalSettings.chatgptPlan,
      account: codexStatus.account,
      rateLimits: codexStatus.rateLimits,
    });
    const quotaRemaining = subscriptionProfile.chatgpt.quota.effectiveRemainingPercent;

    if (!activeProject) {
      const schedule = analyzeSchedule({
        project: null,
        globalSettings,
        tasks: [],
        activeThreads: codexStatus.activeThreads,
        availableModels: normalizedModels,
        quotaRemainingPercent: quotaRemaining,
        subscriptionProfile,
      });
      return {
        projects: [],
        activeProject: null,
        globalSettings,
        subscriptionProfile,
        tasks: [],
        messages: [],
        runs: [],
        memory: { path: "", content: "" },
        memoryItems: [],
        pinnedFiles: [],
        workflowPresets: [],
        schedule,
        codex: codexStatus,
      };
    }

    const tasks = ledger.listTasks(activeProject.id);
    const schedule = analyzeSchedule({
      project: activeProject,
      globalSettings,
      tasks,
      activeThreads: codexStatus.activeThreads,
      availableModels: normalizedModels,
      quotaRemainingPercent: quotaRemaining,
      subscriptionProfile,
    });

    return {
      projects,
      activeProject,
      globalSettings,
      subscriptionProfile,
      tasks,
      messages: ledger.listMessages(activeProject.id, { limit: 150 }),
      runs: ledger.listRuns(activeProject.id),
      memory: ledger.readMemory(activeProject.id),
      memoryItems: ledger.searchMemoryItems(activeProject.id, { limit: 100 }),
      pinnedFiles: ledger.listPinnedFiles(activeProject.id),
      workflowPresets: ledger.listWorkflowPresets(activeProject.id),
      schedule,
      codex: codexStatus,
    };
  }

  // 2. Open Visual Workbench (aux_pane + global sidebar entrypoints)
  server.registerTool(
    "open_workbench",
    {
      title: "Duo-Team Workbench",
      description:
        "Open or refresh the interactive Duo-Team visual workbench (task board/DAG, GPT model & reasoning effort controls, Gemini+GPT debate feed, live Codex worker control, shared memory, and Codex quota).",
      inputSchema: {
        project: z.string().optional().describe("Optional project ID or workspace absolute path."),
        tab: z.enum(["board", "feed", "workers", "models", "artifacts"]).optional().describe("Initial UI tab to focus."),
        refreshCodex: z.boolean().optional().describe("If true, force-refresh live Codex models and subscription quota."),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Duo-Team" },
            { type: "global", title: "Duo-Team" },
          ],
        },
      },
    },
    async ({ project, tab, refreshCodex }) => {
      const payload = await buildDashboardPayload(project, Boolean(refreshCodex));
      const cfg = ledger.resolveCodexConfig({ projectId: payload.activeProject?.id });
      const modelNote = cfg.model ? ` · GPT模型: ${cfg.model}${cfg.effort ? ` (${cfg.effort})` : ""}${cfg.enforcedByUserLock ? " [已锁定]" : ""}` : "";
      const summary = payload.activeProject
        ? `Duo-Team 工作台已打开 · 项目「${payload.activeProject.name}」(${payload.activeProject.mode})${modelNote} · ${payload.tasks.length} 个任务 · ${payload.codex.activeThreads.length} 个活跃 Codex 线程`
        : `Duo-Team 工作台已打开${modelNote}（尚未绑定项目，可在界面或对话中初始化项目目录）。`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { ...payload, initialTab: tab ?? "board" },
      };
    }
  );

  // 3. Codex Runtime Tools
  server.registerTool(
    "codex_status",
    {
      title: "Check Codex Status, Subscription Profile, Model Lock & Quota",
      description:
        "Inspect local Codex CLI status via official codex app-server across any ChatGPT subscription tier (Plus, Pro, Team, Edu, Enterprise, Go): login account, auto-detected plan tier, primary & secondary rate limit windows, resolved Google × ChatGPT subscription pairing profile, available models/reasoning efforts, user model lock, active threads, and pending approvals.",
      inputSchema: {},
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async () => {
      const status = await getLiveCodexStatus(true);
      const globalSettings = ledger.getGlobalSettings();
      const subscriptionProfile = resolveSubscriptionProfile({
        googlePlan: globalSettings.googlePlan,
        chatgptPlan: globalSettings.chatgptPlan,
        account: status.account,
        rateLimits: status.rateLimits,
      });
      const result = { ...status, userModelSettings: globalSettings, subscriptionProfile };
      return {
        content: [{ type: "text", text: summarizeText(result) }],
        structuredContent: result,
      };
    }
  );

  server.registerTool(
    "codex_spawn",
    {
      title: "Spawn Codex Agent Thread",
      description:
        "Launch a new Codex thread via official codex app-server using the user's ChatGPT Pro subscription. Honors the user's manually configured GPT model, reasoning effort, per-role presets, and model lock setting from the Duo-Team Workbench.",
      inputSchema: {
        prompt: z.string().min(1).describe("Clear instructions for Codex, including context/file paths and expected deliverables."),
        cwd: z.string().optional().describe("Working directory. Defaults to the active project root (or task worktree if createWorktree=true)."),
        project: z.string().optional().describe("Project ID or absolute path to register this Codex run under."),
        taskId: z.string().optional().describe("Optional task ID in the project ledger to attach this thread to."),
        role: z.string().optional().describe("Role title, e.g. 'Architect', 'Econometrics Coder', 'Devil Advocate Reviewer'."),
        model: z.string().optional().describe("Optional model slug (overridden automatically if user locked a GPT model in Duo-Team settings)."),
        effort: EFFORT_SCHEMA.optional().describe("Optional reasoning effort level."),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("Codex sandbox mode. Default: workspace-write."),
        approvalPolicy: z.enum(["on-request", "untrusted", "never"]).optional().describe("Approval policy. Default: user setting."),
        approvalsReviewer: z.enum(["user", "auto_review"]).optional().describe("Route approvals to user (bridge/UI) or Codex auto_review."),
        createWorktree: z.boolean().optional().describe("For Git coding tasks, create an isolated git worktree for this task before launching Codex."),
        async: z.boolean().optional().describe("If true, return immediately with threadId so you can run multiple Codex workers or Gemini subagents in parallel. Default: false."),
        waitMs: z.number().int().min(1000).max(600000).optional().describe("Max wait milliseconds when async=false (default 180000)."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      let projectId: string | null = null;
      let effectiveCwd = args.cwd;

      if (args.project || (!effectiveCwd && ledger.listProjects().length > 0)) {
        try {
          projectId = resolveProjectId(ledger, args.project);
          const proj = ledger.getProject(projectId)!;
          if (!effectiveCwd) effectiveCwd = proj.rootPath;
          if (args.createWorktree && args.taskId) {
            const wt = ledger.ensureWorktree(projectId, args.taskId);
            effectiveCwd = wt.worktreePath;
          }
        } catch {
          // Allow standalone cwd invocation even without registered project
        }
      }

      if (!effectiveCwd) {
        throw new Error("请提供 cwd 或先调用 team_project_init 初始化项目。");
      }

      const resolvedCfg = ledger.resolveCodexConfig({
        projectId,
        role: args.role,
        requestedModel: args.model,
        requestedEffort: args.effort,
        requestedApprovalPolicy: args.approvalPolicy as ApprovalPolicyMode | undefined,
      });

      const snap = await bridge.spawnTask({
        prompt: args.prompt,
        cwd: path.resolve(effectiveCwd),
        role: args.role ?? "Codex Worker",
        taskId: args.taskId,
        model: resolvedCfg.model,
        effort: resolvedCfg.effort,
        sandbox: (args.sandbox ?? "workspace-write") as SandboxModeType,
        approvalPolicy: resolvedCfg.approvalPolicy,
        approvalsReviewer: args.approvalsReviewer,
        developerInstructions: buildLanguageDeveloperInstructions(resolvedCfg.language),
        async: args.async ?? false,
        waitMs: args.waitMs ?? 180_000,
      });

      if (projectId) {
        threadProjectMap.set(snap.threadId, projectId);
        ledger.saveRun(projectId, {
          threadId: snap.threadId,
          taskId: snap.taskId,
          role: snap.role,
          model: snap.model,
          effort: snap.effort,
          cwd: snap.cwd,
          status: snap.status,
          lastSummary: snap.reasoningSummary.slice(-1500),
          finalOutput: snap.latestOutput.slice(-8000),
          updatedAt: snap.updatedAt,
        });
        if (args.taskId) {
          const task = ledger.getTask(projectId, args.taskId);
          if (task) {
            ledger.updateTask(projectId, args.taskId, {
              codexThreadId: snap.threadId,
              status: snap.status === "completed" ? "in_review" : snap.status === "waiting_approval" ? "awaiting_human" : "running",
            });
          }
        }
      }

      const responsePayload = {
        ...snap,
        appliedModelConfig: resolvedCfg,
      };
      return {
        content: [{ type: "text", text: summarizeText(responsePayload) }],
        structuredContent: responsePayload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "codex_spawn_batch",
    {
      title: "Spawn Multiple Codex Subagents in Parallel",
      description:
        "Launch 1 to 8 independent Codex subagent threads concurrently in one call (each with its own role, prompt, optional model/effort override, sandbox, and optional isolated Git worktree). Enforces the user's maxParallelCodex limit, model lock, and Chinese collaboration language preference.",
      inputSchema: {
        project: z.string().optional().describe("Project ID or absolute path."),
        cwd: z.string().optional().describe("Default working directory if a subagent omits cwd."),
        waitAll: z.boolean().optional().describe("If true, wait for all launched subagents to finish before returning (default false = async parallel)."),
        waitMs: z.number().int().min(1000).max(600000).optional(),
        agents: z
          .array(
            z.object({
              role: z.string().min(1).describe("Distinct subagent role name, e.g. '分支A-计量分析', '独立审稿'."),
              prompt: z.string().min(1),
              taskId: z.string().optional(),
              cwd: z.string().optional(),
              model: z.string().optional(),
              effort: EFFORT_SCHEMA.optional(),
              sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
              createWorktree: z.boolean().optional(),
              respectLock: z.boolean().optional().describe("Defaults to true; UI manual squad launcher can pass false to honor explicit per-slot model picks."),
            })
          )
          .min(1)
          .max(8),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      let projectId: string | null = null;
      let baseCwd = args.cwd;
      if (args.project || (!baseCwd && ledger.listProjects().length > 0)) {
        try {
          projectId = resolveProjectId(ledger, args.project);
          const proj = ledger.getProject(projectId)!;
          if (!baseCwd) baseCwd = proj.rootPath;
        } catch {
          // allow standalone cwd
        }
      }

      const globalCfg = ledger.getGlobalSettings();
      const activeProj = projectId ? ledger.getProject(projectId) : null;
      const maxParallel = activeProj?.maxParallelCodex ?? globalCfg.maxParallelCodex;
      const currentlyRunning = bridge.listThreads().filter((t) => t.status === "running" || t.status === "waiting_approval").length;
      if (currentlyRunning + args.agents.length > maxParallel) {
        throw new Error(
          `超出最大并行 Subagent 上限（当前运行 ${currentlyRunning} 个 + 新开 ${args.agents.length} 个 > 上限 ${maxParallel} 个）。可在工作台「模型与角色」中调大最大并行数。`
        );
      }

      const launched = await Promise.all(
        args.agents.map(async (item) => {
          let itemCwd = item.cwd ?? baseCwd;
          if (item.createWorktree && projectId && item.taskId) {
            const wt = ledger.ensureWorktree(projectId, item.taskId);
            itemCwd = wt.worktreePath;
          }
          if (!itemCwd) throw new Error(`Subagent「${item.role}」缺少工作目录 cwd。`);

          const resolvedCfg = ledger.resolveCodexConfig({
            projectId,
            role: item.role,
            requestedModel: item.model,
            requestedEffort: item.effort,
          });
          const effectiveModel = item.respectLock === false && item.model ? item.model : resolvedCfg.model;
          const effectiveEffort = item.respectLock === false && item.effort ? item.effort : resolvedCfg.effort;

          const snap = await bridge.spawnTask({
            prompt: item.prompt,
            cwd: path.resolve(itemCwd),
            role: item.role,
            taskId: item.taskId,
            model: effectiveModel,
            effort: effectiveEffort,
            sandbox: (item.sandbox ?? "workspace-write") as SandboxModeType,
            approvalPolicy: resolvedCfg.approvalPolicy,
            developerInstructions: buildLanguageDeveloperInstructions(resolvedCfg.language),
            async: true,
          });

          if (projectId) {
            threadProjectMap.set(snap.threadId, projectId);
            ledger.saveRun(projectId, {
              threadId: snap.threadId,
              taskId: snap.taskId,
              role: snap.role,
              model: snap.model,
              effort: snap.effort,
              cwd: snap.cwd,
              status: snap.status,
              lastSummary: snap.reasoningSummary.slice(-1500),
              finalOutput: snap.latestOutput.slice(-8000),
              updatedAt: snap.updatedAt,
            });
            if (item.taskId && ledger.getTask(projectId, item.taskId)) {
              ledger.updateTask(projectId, item.taskId, {
                codexThreadId: snap.threadId,
                status: "running",
              });
            }
          }
          return snap;
        })
      );

      const finalThreads = args.waitAll
        ? await bridge.waitForThreads(
            launched.map((s) => s.threadId),
            args.waitMs ?? 180_000
          )
        : launched;

      const payload = { count: finalThreads.length, threads: finalThreads };
      return {
        content: [{ type: "text", text: summarizeText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "codex_broadcast",
    {
      title: "Broadcast Message or Interrupt All Codex Subagents",
      description: "Send a steering/follow-up instruction to multiple or all active Codex subagents simultaneously, or interrupt all running subagents at once.",
      inputSchema: {
        action: z.enum(["message", "interrupt_all"]),
        text: z.string().optional().describe("Required when action='message'."),
        threadIds: z.array(z.string()).optional().describe("Optional subset of thread IDs; omit to target all active threads."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ action, text, threadIds }) => {
      if (action === "interrupt_all") {
        const interrupted = await bridge.interruptAll();
        const payload = { interruptedCount: interrupted.length, threads: interrupted };
        return {
          content: [{ type: "text", text: summarizeText(payload) }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      }
      if (!text || !text.trim()) throw new Error("广播消息时必须提供 text 内容");
      const deliveries = await bridge.broadcastMessage(text.trim(), threadIds);
      const payload = { deliveries };
      return {
        content: [{ type: "text", text: summarizeText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "codex_wait",
    {
      title: "Wait or Poll Codex Threads",
      description: "Check or wait for one or more Codex threads to complete or request approval, returning their latest outputs, reasoning summaries, plans, and tool activities.",
      inputSchema: {
        threadIds: z.array(z.string()).min(1).describe("Codex thread IDs to monitor."),
        timeoutMs: z.number().int().min(0).max(600000).optional().describe("Max wait time in ms (0 = immediate poll; default 60000)."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ threadIds, timeoutMs }) => {
      const snapshots = await bridge.waitForThreads(threadIds, timeoutMs ?? 60_000);
      return {
        content: [{ type: "text", text: summarizeText({ threads: snapshots }) }],
        structuredContent: { threads: snapshots },
      };
    }
  );

  server.registerTool(
    "codex_message",
    {
      title: "Message or Steer Codex Thread",
      description:
        "Send a follow-up turn, rework request, challenge, or mid-flight steer to an existing Codex thread. Automatically uses turn/steer if the thread is actively running, or thread/resume + turn/start if idle or restarted.",
      inputSchema: {
        threadId: z.string().min(1).describe("Existing Codex thread ID."),
        text: z.string().min(1).describe("Follow-up instruction, review feedback, debate rebuttal, or mid-turn correction."),
        cwd: z.string().optional(),
        model: z.string().optional(),
        effort: EFFORT_SCHEMA.optional(),
        steerIfRunning: z.boolean().optional().describe("Use turn/steer when thread is actively running (default true)."),
        async: z.boolean().optional().describe("Return immediately without waiting for completion (default false)."),
        waitMs: z.number().int().min(1000).max(600000).optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const snap = await bridge.sendMessage(args.threadId, {
        text: args.text,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        steerIfRunning: args.steerIfRunning ?? true,
        async: args.async ?? false,
        waitMs: args.waitMs ?? 180_000,
      });
      return {
        content: [{ type: "text", text: summarizeText(snap) }],
        structuredContent: snap as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "codex_control",
    {
      title: "Control Codex Thread or Approval",
      description: "Interrupt a running Codex thread, or approve/decline a pending Codex command/file approval request.",
      inputSchema: {
        action: z.enum(["interrupt", "approve", "approve_session", "decline", "cancel"]),
        threadId: z.string().optional().describe("Required when action='interrupt'."),
        approvalId: z.string().optional().describe("Required for approve/approve_session/decline/cancel."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ action, threadId, approvalId }) => {
      if (action === "interrupt") {
        if (!threadId) throw new Error("interrupt 需要提供 threadId");
        const snap = await bridge.interrupt(threadId);
        return {
          content: [{ type: "text", text: summarizeText({ interrupted: Boolean(snap), thread: snap }) }],
          structuredContent: { interrupted: Boolean(snap), thread: snap },
        };
      }
      if (!approvalId) throw new Error(`${action} 需要提供 approvalId`);
      const map: Record<string, ApprovalDecision> = {
        approve: "accept",
        approve_session: "acceptForSession",
        decline: "decline",
        cancel: "cancel",
      };
      const res = await bridge.resolveApproval(approvalId, map[action]);
      return {
        content: [{ type: "text", text: summarizeText(res) }],
        structuredContent: res as unknown as Record<string, unknown>,
      };
    }
  );

  // 4. Shared Project Brain & Ledger Tools
  server.registerTool(
    "team_project_init",
    {
      title: "Initialize or Switch Duo-Team Project",
      description:
        "Register or update a real workspace directory for Duo-Team collaboration. Creates .duo-team/ledger.sqlite and shared memory.md directly inside the project root without relocating user files.",
      inputSchema: {
        rootPath: z.string().min(1).describe("Absolute path of the real project folder (code, paper, research data, etc.)."),
        name: z.string().optional(),
        mode: z.enum(["plan_execute", "co_create", "parallel_research", "debate", "autonomous_team", "custom"]).optional(),
        defaultCodexModel: z.string().nullable().optional(),
        defaultCodexEffort: EFFORT_SCHEMA.nullable().optional(),
        lockCodexModel: z.boolean().optional(),
        roleModels: ROLE_MODELS_SCHEMA,
        defaultApprovalPolicy: z.enum(["on-request", "untrusted", "never"]).optional(),
        maxReworks: z.number().int().min(0).max(10).optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const project = ledger.ensureProject(args.rootPath, {
        name: args.name,
        mode: args.mode as CollaborationMode | undefined,
        defaultCodexModel: args.defaultCodexModel,
        defaultCodexEffort: args.defaultCodexEffort,
        lockCodexModel: args.lockCodexModel,
        roleModels: args.roleModels as RoleModelMap | undefined,
        defaultApprovalPolicy: args.defaultApprovalPolicy,
        maxReworks: args.maxReworks,
      });
      const memory = ledger.readMemory(project.id);
      return {
        content: [{ type: "text", text: summarizeText({ project, memoryPath: memory.path }) }],
        structuredContent: { project, memoryPath: memory.path },
      };
    }
  );

  server.registerTool(
    "team_memory",
    {
      title: "Read or Update Shared Project Memory",
      description: "Read, replace, or append to .duo-team/memory.md shared across Gemini, Codex, and the user.",
      inputSchema: {
        project: z.string().optional(),
        action: z.enum(["read", "replace", "append"]),
        content: z.string().optional().describe("Required for replace/append."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, action, content }) => {
      const pid = resolveProjectId(ledger, project);
      const res =
        action === "read"
          ? ledger.readMemory(pid)
          : ledger.writeMemory(pid, content ?? "", action);
      return {
        content: [{ type: "text", text: res.content }],
        structuredContent: res,
      };
    }
  );

  server.registerTool(
    "team_task_upsert",
    {
      title: "Create or Update Team Task",
      description: "Create a new task in the project DAG or update an existing task's status, owner, reviewer, artifacts, verification command, or rework counter.",
      inputSchema: {
        project: z.string().optional(),
        taskId: z.string().optional().describe("Provide to update an existing task; omit to create a new task."),
        title: z.string().optional(),
        description: z.string().optional(),
        owner: z.enum(["gemini", "codex", "human"]).optional(),
        reviewer: z.enum(["gemini", "codex", "human", "none"]).optional(),
        dependsOn: z.array(z.string()).optional(),
        status: z.enum(["todo", "running", "in_review", "rework", "awaiting_human", "done", "blocked"]).optional(),
        acceptanceCriteria: z.string().optional(),
        verifyCommand: z.string().nullable().optional(),
        incrementRework: z.boolean().optional(),
        codexThreadId: z.string().nullable().optional(),
        artifacts: z.array(z.string()).optional(),
        createWorktree: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const pid = resolveProjectId(ledger, args.project);
      let task = args.taskId && ledger.getTask(pid, args.taskId)
        ? ledger.updateTask(pid, args.taskId, {
            title: args.title,
            description: args.description,
            owner: args.owner,
            reviewer: args.reviewer,
            dependsOn: args.dependsOn,
            status: args.status as TaskStatus | undefined,
            acceptanceCriteria: args.acceptanceCriteria,
            verifyCommand: args.verifyCommand,
            incrementRework: args.incrementRework,
            codexThreadId: args.codexThreadId,
            artifacts: args.artifacts,
          })
        : ledger.createTask(pid, {
            id: args.taskId,
            title: args.title ?? "未命名任务",
            description: args.description,
            owner: args.owner,
            reviewer: args.reviewer,
            dependsOn: args.dependsOn,
            acceptanceCriteria: args.acceptanceCriteria,
            verifyCommand: args.verifyCommand,
            artifacts: args.artifacts,
          });

      if (args.createWorktree) {
        ledger.ensureWorktree(pid, task.id);
        task = ledger.getTask(pid, task.id)!;
      }

      return {
        content: [{ type: "text", text: summarizeText(task) }],
        structuredContent: task as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_message_post",
    {
      title: "Post Cross-Model Team Message",
      description:
        "Record a structured message in the shared cross-model communication feed (plan, challenge, proposal, review, rework, rebuttal, verdict, or human_note). Use `side` ('pro'|'con'|'branch_a'|'branch_b') for side-by-side debate or parallel research comparison.",
      inputSchema: {
        project: z.string().optional(),
        taskId: z.string().nullable().optional(),
        fromAgent: z.string().min(1).describe("e.g. 'Gemini (Architect)', 'Codex (Reviewer)', 'Human'"),
        toAgent: z.string().min(1).describe("e.g. 'Codex', 'Gemini', 'Team', 'Human'"),
        kind: z.enum(["plan", "challenge", "proposal", "review", "rework", "rebuttal", "verdict", "human_note", "system"]),
        round: z.number().int().min(1).optional(),
        side: z.enum(["pro", "con", "branch_a", "branch_b"]).nullable().optional(),
        content: z.string().min(1),
        refs: z.array(z.string()).optional().describe("Referenced file paths or evidence citations."),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const pid = resolveProjectId(ledger, args.project);
      const msg = ledger.postMessage(pid, {
        taskId: args.taskId ?? null,
        fromAgent: args.fromAgent,
        toAgent: args.toAgent,
        kind: args.kind as MessageKind,
        round: args.round ?? 1,
        side: args.side ?? null,
        content: args.content,
        refs: args.refs ?? [],
      });
      return {
        content: [{ type: "text", text: summarizeText(msg) }],
        structuredContent: msg as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_verify_task",
    {
      title: "Run Deterministic Task Verification",
      description:
        "Execute the task's deterministic verification command (pytest, Rscript, stata, latexmk, python check, etc.) and verify all declared artifact files exist with SHA-256 hashes.",
      inputSchema: {
        project: z.string().optional(),
        taskId: z.string().min(1),
        overrideCommand: z.string().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, taskId, overrideCommand }) => {
      const pid = resolveProjectId(ledger, project);
      const result = ledger.runVerification(pid, taskId, overrideCommand);
      return {
        content: [{ type: "text", text: summarizeText(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_board_read",
    {
      title: "Read Project Board & State",
      description: "Read the full current state of a Duo-Team project: tasks DAG, messages, persisted runs, user model lock settings, and memory summary.",
      inputSchema: {
        project: z.string().optional(),
        includeCodexStatus: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, includeCodexStatus }) => {
      const payload = await buildDashboardPayload(project, Boolean(includeCodexStatus));
      return {
        content: [{ type: "text", text: summarizeText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  // 5. App-Only UI Tools
  server.registerTool(
    "ui_dashboard_state",
    {
      title: "Fetch UI Dashboard State",
      description: "App-only tool to refresh full workbench state.",
      inputSchema: {
        project: z.string().optional(),
        includeCodexStatus: z.boolean().optional(),
        restartCodex: z.boolean().optional().describe("Restart codex app-server to pick up newly upgraded Codex CLI binaries & models."),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ project, includeCodexStatus, restartCodex }) => {
      if (restartCodex) {
        codexStatusCache = null;
        await bridge.reconnect().catch(() => undefined);
      }
      const payload = await buildDashboardPayload(project, Boolean(includeCodexStatus || restartCodex));
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_update_model_config",
    {
      title: "Update Global or Project GPT Model & Subscription Controls",
      description: "App-only tool to configure GPT model, reasoning effort, lock flag, role routing, language, max parallel subagents, subscription tier profiles (Google AI Free/Pro/Ultra/Workspace & ChatGPT Auto/Plus/Pro/Team/Edu/Enterprise/Go), and collaboration mode.",
      inputSchema: {
        projectId: z.string().nullable().optional(),
        mode: z.enum(["plan_execute", "co_create", "parallel_research", "debate", "autonomous_team", "custom"]).optional(),
        defaultCodexModel: z.string().nullable().optional(),
        defaultCodexEffort: EFFORT_SCHEMA.nullable().optional(),
        lockCodexModel: z.boolean().optional(),
        roleModels: ROLE_MODELS_SCHEMA,
        language: z.enum(["zh-CN", "en", "auto"]).optional(),
        maxParallelCodex: z.number().int().min(1).max(8).optional(),
        defaultApprovalPolicy: z.enum(["on-request", "untrusted", "never"]).optional(),
        maxReworks: z.number().int().min(0).max(10).optional(),
        googlePlan: z.enum(["free", "pro", "ultra", "enterprise"]).optional(),
        chatgptPlan: z.enum(["auto", "free", "go", "plus", "pro", "team", "edu", "enterprise"]).optional(),
        applyTierDefaults: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      let maxParallel = args.maxParallelCodex;
      let defaultEffort = args.defaultCodexEffort;
      let lockModel = args.lockCodexModel;

      if (args.applyTierDefaults) {
        const curGlobal = ledger.getGlobalSettings();
        const liveCodex = await getLiveCodexStatus(false).catch(() => null);
        const profile = resolveSubscriptionProfile({
          googlePlan: (args.googlePlan as GooglePlanTier | undefined) ?? curGlobal.googlePlan,
          chatgptPlan: (args.chatgptPlan as ChatGptPlanTier | undefined) ?? curGlobal.chatgptPlan,
          account: liveCodex?.account,
          rateLimits: liveCodex?.rateLimits,
        });
        maxParallel = profile.chatgpt.recommendedMaxParallel;
        defaultEffort = profile.chatgpt.defaultEffort;
        if (profile.chatgpt.tier === "plus" || profile.chatgpt.tier === "go" || profile.chatgpt.tier === "free") {
          // Enable adaptive smart routing on tighter tiers so simple tasks conserve quota automatically
          lockModel = false;
        }
      }

      ledger.updateGlobalSettings({
        defaultCodexModel: args.defaultCodexModel,
        defaultCodexEffort: defaultEffort,
        lockCodexModel: lockModel,
        roleModels: args.roleModels as RoleModelMap | undefined,
        language: args.language as TeamLanguage | undefined,
        maxParallelCodex: maxParallel,
        defaultApprovalPolicy: args.defaultApprovalPolicy,
        googlePlan: args.googlePlan as GooglePlanTier | undefined,
        chatgptPlan: args.chatgptPlan as ChatGptPlanTier | undefined,
      });
      if (args.projectId) {
        ledger.updateProject(args.projectId, {
          mode: args.mode as CollaborationMode | undefined,
          defaultCodexModel: args.defaultCodexModel,
          defaultCodexEffort: defaultEffort,
          lockCodexModel: lockModel,
          roleModels: args.roleModels as RoleModelMap | undefined,
          language: args.language as TeamLanguage | undefined,
          maxParallelCodex: maxParallel,
          defaultApprovalPolicy: args.defaultApprovalPolicy,
          maxReworks: args.maxReworks,
        });
      }
      const payload = await buildDashboardPayload(args.projectId ?? undefined, false);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_human_decision",
    {
      title: "Accept or Request Rework from UI",
      description: "App-only tool for human acceptance or rework feedback.",
      inputSchema: {
        projectId: z.string().min(1),
        taskId: z.string().min(1),
        decision: z.enum(["accept", "rework", "block"]),
        note: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectId, taskId, decision, note }) => {
      const status: TaskStatus = decision === "accept" ? "done" : decision === "rework" ? "rework" : "blocked";
      ledger.updateTask(projectId, taskId, {
        status,
        incrementRework: decision === "rework",
      });
      ledger.postMessage(projectId, {
        taskId,
        fromAgent: "Human",
        toAgent: "Team",
        kind: decision === "accept" ? "verdict" : "rework",
        content: note?.trim() || (decision === "accept" ? "人工验收通过。" : decision === "rework" ? "人工退回返工。" : "人工暂停阻塞此任务。"),
      });
      const payload = await buildDashboardPayload(projectId, false);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_check_codex_update",
    {
      title: "Check Codex CLI Update",
      description: "App-only tool to check whether a newer official Codex CLI release is available.",
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const check = await checkCodexUpdate();
      return {
        content: [{ type: "text", text: check.message }],
        structuredContent: check as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_upgrade_codex_cli",
    {
      title: "Start or Poll Async Codex CLI Upgrade",
      description: "App-only tool to start non-blocking Codex CLI upgrade or poll live job status/output, auto-reloading models on completion.",
      inputSchema: {
        action: z.enum(["start", "poll"]).optional(),
        projectId: z.string().nullable().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ action, projectId }) => {
      const job =
        action === "poll"
          ? getUpgradeJobState()
          : await startCodexUpgradeAsync(async () => {
              codexStatusCache = null;
              await bridge.reconnect().catch(() => undefined);
            });
      const dashboard =
        job.status === "succeeded"
          ? await buildDashboardPayload(projectId ?? undefined, true)
          : null;
      return {
        content: [{ type: "text", text: job.message || job.status }],
        structuredContent: {
          job,
          dashboard,
        } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_schedule_plan",
    {
      title: "Analyze DAG Waves, Critical Path, Stalls & Adaptive Routing",
      description:
        "Intelligent scheduler analysis inspired by Orkestra, Gas Town, and Symphony: detects dependency cycles, computes parallel DAG waves and critical path, flags stalled threads or exhausted rework loops, and generates adaptive model/effort routing recommendations (strictly honoring user model lock when enabled).",
      inputSchema: {
        project: z.string().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project }) => {
      const payload = await buildDashboardPayload(project, false);
      return {
        content: [{ type: "text", text: summarizeText(payload.schedule) }],
        structuredContent: payload.schedule as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_auto_dispatch",
    {
      title: "Auto-Dispatch Next Ready DAG Wave to Codex Subagents",
      description:
        "Automatically dispatch all currently ready Codex-owned tasks in the active DAG wave up to maxParallelCodex. Injects shared .duo-team/memory.md context, upstream dependency artifacts, Chinese collaboration rules, optional Git worktree isolation for parallel writes, and honors user model locks or adaptive routing.",
      inputSchema: {
        project: z.string().optional(),
        useWorktreeForGit: z.boolean().optional().describe("Auto-create isolated git worktree per parallel Codex task if project is a git repo (default true when >1 task dispatched)."),
        limit: z.number().int().min(1).max(8).optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, useWorktreeForGit, limit }) => {
      const pid = resolveProjectId(ledger, project);
      const proj = ledger.getProject(pid)!;
      const payload = await buildDashboardPayload(pid, false);
      const schedule = payload.schedule;

      if (schedule.cycles.length > 0) {
        throw new Error(`存在依赖死锁环（${schedule.cycles.map((c) => c.join("→")).join("; ")}），请先修复任务依赖再调度。`);
      }

      const runningNow = bridge.listThreads().filter((t) => t.status === "running" || t.status === "waiting_approval").length;
      const slotsAvailable = Math.max(0, proj.maxParallelCodex - runningNow);
      const maxBatch = Math.min(slotsAvailable, limit ?? slotsAvailable);

      const readyCodexTasks = payload.tasks.filter(
        (t) => schedule.readyTasks.includes(t.id) && t.owner === "codex"
      );

      if (readyCodexTasks.length === 0) {
        const readyGemini = payload.tasks.filter((t) => schedule.readyTasks.includes(t.id) && t.owner === "gemini").map((t) => t.id);
        const msg = readyGemini.length
          ? `当前波次没有待启动的 Codex 任务；有 ${readyGemini.length} 个 Gemini 就绪任务（${readyGemini.join(", ")}）可由 Antigravity 直接推进。`
          : "当前没有可自动派发的就绪 Codex 任务。";
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { dispatched: [], skippedReason: msg, readyGemini },
        };
      }

      if (maxBatch <= 0) {
        throw new Error(`已达到最大并行 Subagent 上限（当前运行 ${runningNow}/${proj.maxParallelCodex}）。请等待完成或在工作台调大并行上限。`);
      }

      const batch = readyCodexTasks.slice(0, maxBatch);
      const recMap = new Map(schedule.recommendations.map((r) => [r.taskId, r]));
      const pinnedMemories = ledger.searchMemoryItems(pid, { pinnedOnly: true, limit: 12 });
      const pinnedFiles = ledger.listPinnedFiles(pid);
      const projectMap = buildSmartProjectMap(proj.rootPath, 1800);
      const memorySnippet = payload.memory.content.slice(0, 1400);
      const wantWorktree = useWorktreeForGit ?? batch.length > 1;

      const dispatched = await Promise.all(
        batch.map(async (task) => {
          let cwd = proj.rootPath;
          if (wantWorktree) {
            try {
              const wt = ledger.ensureWorktree(pid, task.id);
              cwd = wt.worktreePath;
            } catch {
              // Non-git project (e.g. academic paper folder) -> run cleanly in project root
            }
          }

          const rec = recMap.get(task.id);
          const resolvedCfg = ledger.resolveCodexConfig({
            projectId: pid,
            role: `${task.title} ${task.description}`,
            requestedModel: rec?.recommendedModel ?? undefined,
            requestedEffort: rec?.recommendedEffort ?? undefined,
          });

          const upstreamRefs = task.dependsOn
            .map((depId) => payload.tasks.find((x) => x.id === depId))
            .filter((x): x is NonNullable<typeof x> => Boolean(x))
            .map((x) => `- ${x.id}「${x.title}」产物：${x.artifacts.length ? x.artifacts.join("、") : "见工作区"}`);

          const pinnedMemLines = pinnedMemories.map((m) => `- [${m.category}] ${m.title}：${m.content}`);
          const pinnedFileLines = pinnedFiles.map((f) => `- ${f.relPath}${f.note ? `（${f.note}）` : ""}`);

          const prompt = [
            `【Duo-Team 智能波次调度 · 任务 ${task.id}】`,
            `任务标题：${task.title}`,
            task.description ? `详细要求：${task.description}` : "",
            task.acceptanceCriteria ? `验收标准：${task.acceptanceCriteria}` : "",
            task.verifyCommand ? `自动验收命令：\`${task.verifyCommand}\`（请在交付前自行确认通过）` : "",
            task.artifacts.length ? `预期交付文件：${task.artifacts.join("、")}` : "",
            upstreamRefs.length ? `上游依赖完成情况：\n${upstreamRefs.join("\n")}` : "",
            pinnedFileLines.length ? `用户置顶焦点文件（请优先参考）：\n${pinnedFileLines.join("\n")}` : "",
            pinnedMemLines.length ? `置顶核心记忆与避坑约束：\n${pinnedMemLines.join("\n")}` : "",
            `项目结构与符号地图：\n${projectMap.outline}`,
            memorySnippet ? `共享记忆补充（.duo-team/memory.md）：\n${memorySnippet}` : "",
            "请全程使用简体中文汇报执行过程、关键结论与文件改动清单。",
          ]
            .filter(Boolean)
            .join("\n\n");

          const snap = await bridge.spawnTask({
            prompt,
            cwd,
            role: `${task.id} · ${task.title.slice(0, 24)}`,
            taskId: task.id,
            model: resolvedCfg.model,
            effort: resolvedCfg.effort,
            sandbox: "workspace-write",
            approvalPolicy: resolvedCfg.approvalPolicy,
            developerInstructions: buildLanguageDeveloperInstructions(resolvedCfg.language),
            async: true,
          });

          threadProjectMap.set(snap.threadId, pid);
          ledger.saveRun(pid, {
            threadId: snap.threadId,
            taskId: task.id,
            role: snap.role,
            model: snap.model,
            effort: snap.effort,
            cwd: snap.cwd,
            status: snap.status,
            lastSummary: "",
            finalOutput: "",
            updatedAt: snap.updatedAt,
          });
          ledger.updateTask(pid, task.id, { codexThreadId: snap.threadId, status: "running" });
          ledger.postMessage(pid, {
            taskId: task.id,
            fromAgent: "Scheduler (智能调度)",
            toAgent: `Codex (${snap.model ?? "默认"}${snap.effort ? `/${snap.effort}` : ""})`,
            kind: "system",
            content: `已自动派发任务 ${task.id}「${task.title}」\n路由理由：${rec?.reason ?? "默认策略"}`,
          });

          return { taskId: task.id, threadId: snap.threadId, model: snap.model, effort: snap.effort, cwd, reason: rec?.reason };
        })
      );

      const refreshed = await buildDashboardPayload(pid, false);
      return {
        content: [{ type: "text", text: `已自动并发派发 ${dispatched.length} 个就绪 Codex 任务：\n${summarizeText(dispatched)}` }],
        structuredContent: { dispatched, dashboard: refreshed } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_self_heal",
    {
      title: "Verify Task & Auto-Trigger Self-Healing Rework Loop",
      description:
        "Run deterministic task verification (verifyCommand + artifact check). If it fails and reworkCount < maxReworks, automatically feeds structured error telemetry back to the task's Codex thread for self-healing rework; if rework limit is exceeded, escalates to awaiting_human.",
      inputSchema: {
        project: z.string().optional(),
        taskId: z.string().min(1),
        overrideCommand: z.string().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, taskId, overrideCommand }) => {
      const pid = resolveProjectId(ledger, project);
      const task = ledger.getTask(pid, taskId);
      if (!task) throw new Error(`任务不存在: ${taskId}`);

      const verify = ledger.runVerification(pid, taskId, overrideCommand);
      if (verify.passed) {
        ledger.updateTask(pid, taskId, { status: task.reviewer === "none" ? "done" : "in_review" });
        ledger.postMessage(pid, {
          taskId,
          fromAgent: "Verifier (自动验收)",
          toAgent: "Team",
          kind: "review",
          content: `任务 ${taskId} 确定性验收已通过${verify.command ? `（${verify.command}, exit=0）` : ""}，已转入${task.reviewer === "none" ? "已完成" : "独立复核"}。`,
        });
        const dashboard = await buildDashboardPayload(pid, false);
        return {
          content: [{ type: "text", text: `任务 ${taskId} 验收通过！` }],
          structuredContent: { action: "passed", verify, dashboard } as unknown as Record<string, unknown>,
        };
      }

      if (task.reworkCount >= task.maxReworks) {
        ledger.updateTask(pid, taskId, { status: "awaiting_human" });
        ledger.postMessage(pid, {
          taskId,
          fromAgent: "Verifier (自动验收)",
          toAgent: "Human",
          kind: "challenge",
          content: `任务 ${taskId} 验收未通过且已达到最大自动自愈轮数 (${task.reworkCount}/${task.maxReworks})，已暂停并交由你决策。\nstderr: ${verify.stderr.slice(-600)}`,
        });
        const dashboard = await buildDashboardPayload(pid, false);
        return {
          content: [{ type: "text", text: `任务 ${taskId} 已达自愈上限，已升级为等待人工决策。` }],
          structuredContent: { action: "escalated_to_human", verify, dashboard } as unknown as Record<string, unknown>,
        };
      }

      // Auto-trigger self-healing rework
      const healPrompt = buildSelfHealPrompt(task, verify);
      ledger.updateTask(pid, taskId, { status: "rework", incrementRework: true });
      ledger.postMessage(pid, {
        taskId,
        fromAgent: "Verifier (自愈调度)",
        toAgent: task.owner === "codex" ? "Codex" : "Gemini",
        kind: "rework",
        round: task.reworkCount + 1,
        content: healPrompt,
      });

      let thread: ThreadSnapshot | null = null;
      if (task.owner === "codex" && task.codexThreadId) {
        thread = await bridge.sendMessage(task.codexThreadId, {
          text: healPrompt,
          cwd: task.worktreePath ?? ledger.getProject(pid)!.rootPath,
          steerIfRunning: true,
          async: true,
        });
        ledger.updateTask(pid, taskId, { status: "running" });
      }

      const dashboard = await buildDashboardPayload(pid, false);
      return {
        content: [
          {
            type: "text",
            text: thread
              ? `任务 ${taskId} 验收未通过，已自动将错误日志打回原 Codex 线程 (${thread.threadId.slice(0, 8)}) 进行第 ${task.reworkCount + 1} 轮自愈修复！`
              : `任务 ${taskId} 验收未通过，已生成第 ${task.reworkCount + 1} 轮自愈诊断记录并标记为 rework。`,
          },
        ],
        structuredContent: { action: "self_healing", verify, thread, dashboard } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_memory_search",
    {
      title: "Search Structured Project Memory (FTS5)",
      description:
        "Search or list tiered project memory items (decisions, pitfalls/anti-loop lessons, facts, conventions) via local SQLite FTS5 + substring hybrid retrieval. Use before planning or debugging to avoid repeating past mistakes.",
      inputSchema: {
        project: z.string().optional(),
        query: z.string().optional().describe("Keyword query (Chinese or English). Omit to list recent/pinned memories."),
        category: z.enum(["all", "decision", "pitfall", "fact", "convention"]).optional(),
        pinnedOnly: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, query, category, pinnedOnly }) => {
      const pid = resolveProjectId(ledger, project);
      const items = ledger.searchMemoryItems(pid, {
        query,
        category: (category ?? "all") as MemoryCategory | "all",
        pinnedOnly: Boolean(pinnedOnly),
      });
      return {
        content: [{ type: "text", text: summarizeText({ count: items.length, items }) }],
        structuredContent: { count: items.length, items },
      };
    }
  );

  server.registerTool(
    "team_memory_add",
    {
      title: "Save or Pin Structured Project Memory",
      description:
        "Persist a structured decision, pitfall (anti-loop lesson), fact, or convention into the project's local SQLite FTS5 memory store and auto-sync .duo-team/memory.md. Pin critical memories so they are auto-injected into every dispatched Codex subagent.",
      inputSchema: {
        project: z.string().optional(),
        action: z.enum(["add", "toggle_pin", "delete"]).optional(),
        memoryId: z.string().optional().describe("Required for toggle_pin or delete."),
        category: z.enum(["decision", "pitfall", "fact", "convention"]).optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
        sourceAgent: z.string().optional(),
        refs: z.array(z.string()).optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const pid = resolveProjectId(ledger, args.project);
      const act = args.action ?? "add";
      if (act === "toggle_pin") {
        if (!args.memoryId) throw new Error("toggle_pin 需要 memoryId");
        const item = ledger.toggleMemoryPin(pid, args.memoryId, args.pinned);
        const dashboard = await buildDashboardPayload(pid, false);
        return {
          content: [{ type: "text", text: summarizeText(item) }],
          structuredContent: { item, dashboard } as unknown as Record<string, unknown>,
        };
      }
      if (act === "delete") {
        if (!args.memoryId) throw new Error("delete 需要 memoryId");
        const deleted = ledger.deleteMemoryItem(pid, args.memoryId);
        const dashboard = await buildDashboardPayload(pid, false);
        return {
          content: [{ type: "text", text: summarizeText({ deleted }) }],
          structuredContent: { deleted, dashboard } as unknown as Record<string, unknown>,
        };
      }
      if (!args.title?.trim() || !args.content?.trim()) {
        throw new Error("新增记忆需要填写 title 和 content");
      }
      const item = ledger.addMemoryItem(pid, {
        category: (args.category ?? "decision") as MemoryCategory,
        title: args.title,
        content: args.content,
        tags: args.tags,
        pinned: args.pinned ?? false,
        sourceAgent: args.sourceAgent ?? "Team",
        refs: args.refs,
      });
      const dashboard = await buildDashboardPayload(pid, false);
      return {
        content: [{ type: "text", text: summarizeText(item) }],
        structuredContent: { item, dashboard } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_project_map",
    {
      title: "Generate Smart Repo & Research Project Map",
      description:
        "Generate an Aider-inspired compact structural map of the project workspace (code exports/classes/functions, LaTeX sections, Markdown outlines, Stata/R scripts, data files) plus user-pinned focus files so Gemini and Codex share exact structural awareness without wasting tokens.",
      inputSchema: {
        project: z.string().optional(),
        maxChars: z.number().int().min(800).max(12000).optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ project, maxChars }) => {
      const pid = resolveProjectId(ledger, project);
      const proj = ledger.getProject(pid)!;
      const map = buildSmartProjectMap(proj.rootPath, maxChars ?? 4200);
      const pinnedFiles = ledger.listPinnedFiles(pid);
      const payload = { project: proj.name, rootPath: proj.rootPath, pinnedFiles, map };
      return {
        content: [{ type: "text", text: `${map.outline}\n\nPinned Files: ${pinnedFiles.map((f) => f.relPath).join(", ") || "None"}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "team_workflow_preset",
    {
      title: "Manage & Apply Custom Workflow Presets",
      description:
        "List, save, or apply project-level custom workflow presets stored in .duo-team/workflows/*.json. Applying a preset switches the project to custom mode, sets optional roleModels/maxReworks, and instantiates all DAG stage tasks cleanly.",
      inputSchema: {
        project: z.string().optional(),
        action: z.enum(["list", "save", "apply"]),
        presetId: z.string().optional().describe("Preset ID (required for save and apply)."),
        name: z.string().optional().describe("Human-readable preset name (for save)."),
        description: z.string().optional(),
        roleModels: ROLE_MODELS_SCHEMA,
        maxReworks: z.number().int().min(0).max(10).optional(),
        stages: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              description: z.string().optional(),
              owner: z.enum(["gemini", "codex", "human"]),
              reviewer: z.enum(["gemini", "codex", "human", "none"]).optional(),
              dependsOn: z.array(z.string()).optional(),
              acceptanceCriteria: z.string().optional(),
              verifyCommand: z.string().nullable().optional(),
              artifacts: z.array(z.string()).optional(),
            })
          )
          .optional(),
      },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args) => {
      const pid = resolveProjectId(ledger, args.project);
      if (args.action === "list") {
        const presets = ledger.listWorkflowPresets(pid);
        return {
          content: [{ type: "text", text: summarizeText({ count: presets.length, presets }) }],
          structuredContent: { count: presets.length, presets },
        };
      }
      if (args.action === "save") {
        if (!args.presetId || !args.stages?.length) {
          throw new Error("save 预设必须提供 presetId 和至少一个 stage");
        }
        const preset = ledger.saveWorkflowPreset(pid, {
          id: args.presetId,
          name: args.name ?? args.presetId,
          description: args.description,
          roleModels: args.roleModels as RoleModelMap | undefined,
          maxReworks: args.maxReworks,
          stages: args.stages as CustomWorkflowStage[],
        });
        const dashboard = await buildDashboardPayload(pid, false);
        return {
          content: [{ type: "text", text: summarizeText(preset) }],
          structuredContent: { preset, dashboard } as unknown as Record<string, unknown>,
        };
      }
      if (!args.presetId) throw new Error("apply 预设必须提供 presetId");
      const applied = ledger.applyWorkflowPreset(pid, args.presetId);
      const dashboard = await buildDashboardPayload(pid, false);
      return {
        content: [{ type: "text", text: `已套用自定义工作流「${applied.preset.name}」，创建了 ${applied.createdTasks.length} 个任务。` }],
        structuredContent: { ...applied, dashboard } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_toggle_pin_file",
    {
      title: "Pin or Unpin Focus File for Team Context",
      description: "App-only tool to pin/unpin a workspace file so it is auto-injected into dispatched Codex & Gemini contexts.",
      inputSchema: {
        projectId: z.string().min(1),
        relPath: z.string().min(1),
        pinned: z.boolean(),
        note: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectId, relPath, pinned, note }) => {
      const pinnedFiles = ledger.setPinnedFile(projectId, relPath, pinned, note ?? "");
      const dashboard = await buildDashboardPayload(projectId, false);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { pinnedFiles, dashboard } as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "ui_workspace_inspect",
    {
      title: "Inspect Project Tree, Smart Map, Git Changes & Local Toolchain",
      description: "App-only tool to inspect nested project file tree, compact symbol/outline map, git status/diff/worktrees, pinned files, and local research/dev tools.",
      inputSchema: {
        projectId: z.string().nullable().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectId }) => {
      if (!toolchainCache) toolchainCache = probeLocalToolchain();
      const proj = projectId ? ledger.getProject(projectId) : ledger.listProjects()[0] ?? null;
      const workspace = proj ? inspectWorkspaceChanges(proj.rootPath) : null;
      const gitStatusMap = new Map<string, string>(
        (workspace?.changedFiles ?? []).map((f) => [f.path, f.status])
      );
      const projectTree = proj ? buildProjectTree(proj.rootPath, { maxDepth: 4, maxEntries: 450, gitStatusMap }) : null;
      const projectMap = proj ? buildSmartProjectMap(proj.rootPath, 4200) : null;
      const pinnedFiles = proj ? ledger.listPinnedFiles(proj.id) : [];
      const payload = { workspace, projectTree, projectMap, pinnedFiles, toolchain: toolchainCache };
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  );

  return { server, ledger, bridge };
}

async function main() {
  const { dataDir } = parseArgs(process.argv.slice(2));
  const { server, bridge, ledger } = createDuoTeamServer({ dataDir });
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await bridge.close();
    ledger.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await bridge.close();
    ledger.close();
    process.exit(0);
  });

  await server.connect(transport);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error("duo-team MCP server fatal error:", err);
    process.exit(1);
  });
}
