import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";

export type ApprovalPolicyMode = "on-request" | "untrusted" | "never";
export type SandboxModeType = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface PendingApproval {
  id: string;
  requestId: string | number;
  method: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityEntry {
  id: string;
  type: string;
  title: string;
  status: string;
  detail?: string;
  timestamp: string;
}

export interface PlanStep {
  step: string;
  status: string;
}

export interface SubAgentInfo {
  id: string;
  tool: string;
  status: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  receiverThreadIds: string[];
  updatedAt: string;
}

export interface ThreadSnapshot {
  threadId: string;
  role: string;
  taskId: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  sandbox: SandboxModeType;
  approvalPolicy: ApprovalPolicyMode;
  status: "idle" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";
  activeTurnId: string | null;
  lastTurnStatus: string | null;
  lastError: string | null;
  reasoningSummary: string;
  latestOutput: string;
  plan: PlanStep[];
  subAgents: SubAgentInfo[];
  activities: ActivityEntry[];
  pendingApprovals: PendingApproval[];
  updatedAt: string;
}

export interface SpawnTaskOptions {
  prompt: string;
  cwd: string;
  role?: string;
  taskId?: string;
  model?: string;
  effort?: string;
  sandbox?: SandboxModeType;
  approvalPolicy?: ApprovalPolicyMode;
  approvalsReviewer?: "user" | "auto_review";
  developerInstructions?: string;
  async?: boolean;
  waitMs?: number;
}

export interface SendMessageOptions {
  text: string;
  cwd?: string;
  model?: string;
  effort?: string;
  steerIfRunning?: boolean;
  async?: boolean;
  waitMs?: number;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface InternalThread extends ThreadSnapshot {
  loadedInProcess: boolean;
  outputChunks: string[];
  reasoningChunks: string[];
}

export interface CodexBridgeOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  rpcTimeoutMs?: number;
  onThreadUpdate?: (snapshot: ThreadSnapshot) => void;
}

const MAX_ACTIVITIES = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function buildCleanEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const src = baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...src };
  // Enforce subscription login rather than accidental API key billing.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_BASE_URL;
  const existingPath = env.PATH ?? "/usr/bin:/bin";
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", path.join(env.HOME ?? "", ".local/bin")];
  const parts = existingPath.split(path.delimiter).filter(Boolean);
  for (const extra of extras) {
    if (extra && !parts.includes(extra)) parts.push(extra);
  }
  env.PATH = parts.join(path.delimiter);
  return env;
}

function summarizeApproval(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const cmd = typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.join(" ")
        : JSON.stringify(params.parsedCmd ?? params.command ?? "");
    return `命令执行审批: ${cmd.slice(0, 180)}`;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const reason = typeof params.reason === "string" ? params.reason : "申请修改工作区文件";
    return `文件修改审批: ${reason.slice(0, 180)}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `权限升级审批: ${String(params.reason ?? "请求附加沙箱权限").slice(0, 180)}`;
  }
  return `Codex 审批请求 (${method})`;
}

export class CodexAppServerBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private connecting: Promise<void> | null = null;
  private connGen = 0;
  private nextId = 1;
  private pendingRpcs = new Map<number, PendingRpc>();
  private threads = new Map<string, InternalThread>();
  private approvals = new Map<string, PendingApproval>();
  private waiters = new Set<() => void>();
  private stderrTail: string[] = [];
  private latestRateLimits: unknown = null;
  private serverUserAgent: string | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly customEnv?: NodeJS.ProcessEnv;
  private readonly rpcTimeoutMs: number;
  private readonly onThreadUpdate?: (snapshot: ThreadSnapshot) => void;

  constructor(options: CodexBridgeOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.customEnv = options.env;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this.onThreadUpdate = options.onThreadUpdate;
  }

  public isConnected(): boolean {
    return this.proc !== null && this.initialized && this.proc.exitCode === null;
  }

  public getStderrTail(): string[] {
    return [...this.stderrTail];
  }

  public async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    const gen = ++this.connGen;
    const p = this.connectInternal(gen).finally(() => {
      if (this.connecting === p) this.connecting = null;
    });
    this.connecting = p;
    return p;
  }

  private async connectInternal(gen: number): Promise<void> {
    this.cleanupProcess("reconnecting");
    if (gen !== this.connGen) return;
    const env = buildCleanEnv(this.customEnv);
    const child = spawn(this.command, this.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    this.initialized = false;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.stderrTail.push(l);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    });

    child.on("exit", (code, signal) => {
      const reason = `codex app-server exited (code=${code}, signal=${signal})`;
      if (this.proc === child) {
        this.proc = null;
        this.initialized = false;
      }
      for (const t of this.threads.values()) {
        t.loadedInProcess = false;
        if (t.status === "running" || t.status === "waiting_approval") {
          t.status = "interrupted";
          t.lastError = reason;
          t.updatedAt = nowIso();
          this.emitThreadUpdate(t);
        }
      }
      this.approvals.clear();
      this.rejectAllPending(new Error(reason));
      this.notifyWaiters();
    });

    child.on("error", (err) => {
      if (this.proc === child) {
        this.proc = null;
        this.initialized = false;
      }
      this.rejectAllPending(err);
      this.notifyWaiters();
    });

    const initRes = await this.requestRaw<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "duo-team", version: "0.2.0" },
      capabilities: null,
    });
    if (gen !== this.connGen) return;
    if (typeof initRes?.userAgent === "string") {
      this.serverUserAgent = initRes.userAgent;
    }
    this.notifyRaw("initialized");
    this.initialized = true;
  }

  public async reconnect(): Promise<void> {
    this.connGen++;
    this.connecting = null;
    this.cleanupProcess("restarting_for_refresh");
    await this.ensureConnected();
  }

  public async close(): Promise<void> {
    this.cleanupProcess("closed");
  }

  private cleanupProcess(reason: string): void {
    const child = this.proc;
    this.proc = null;
    this.initialized = false;
    this.approvals.clear();
    this.rejectAllPending(new Error(reason));
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRpcs.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRpcs.delete(id);
    }
  }

  private notifyWaiters(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  private sendFrame(payload: Record<string, unknown>): void {
    if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notifyRaw(method: string, params?: unknown): void {
    const frame: Record<string, unknown> = { method };
    if (params !== undefined) frame.params = params;
    this.sendFrame(frame);
  }

  private requestRaw<T = unknown>(method: string, params?: unknown, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC timeout (${timeoutMs}ms) for ${method}`));
      }, timeoutMs);
      this.pendingRpcs.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        const frame: Record<string, unknown> = { id, method };
        if (params !== undefined) frame.params = params;
        this.sendFrame(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRpcs.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    await this.ensureConnected();
    return this.requestRaw<T>(method, params, timeoutMs);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    // 1. Response to our outgoing request
    if (msg.id !== undefined && msg.method === undefined) {
      const numId = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pendingRpcs.get(numId);
      if (!pending) return;
      this.pendingRpcs.delete(numId);
      clearTimeout(pending.timer);
      if (msg.error) {
        const errObj = msg.error as { message?: string; code?: number; data?: unknown };
        pending.reject(
          new Error(`Codex RPC error (${pending.method}, code=${errObj.code ?? "?"}): ${errObj.message ?? JSON.stringify(errObj)}`)
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2. Server-initiated request (e.g., approval)
    if (msg.id !== undefined && typeof msg.method === "string") {
      this.handleServerRequest(msg.id as string | number, msg.method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }

    // 3. Server notification
    if (typeof msg.method === "string") {
      this.handleNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }

  private handleServerRequest(requestId: string | number, method: string, params: Record<string, unknown>): void {
    const threadId = String(params.threadId ?? params.conversationId ?? "");
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : null;

    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]);

    if (approvalMethods.has(method)) {
      const approval: PendingApproval = {
        id: randomUUID().slice(0, 8),
        requestId,
        method,
        threadId,
        turnId,
        itemId,
        summary: summarizeApproval(method, params),
        details: params,
        createdAt: nowIso(),
      };
      this.approvals.set(approval.id, approval);
      const thread = this.threads.get(threadId);
      if (thread) {
        thread.status = "waiting_approval";
        thread.pendingApprovals.push(approval);
        thread.updatedAt = nowIso();
        this.pushActivity(thread, {
          id: approval.id,
          type: "approval",
          title: approval.summary,
          status: "pending",
          timestamp: approval.createdAt,
        });
        this.emitThreadUpdate(thread);
      }
      this.notifyWaiters();
      return;
    }

    // Unsupported server request -> clean JSON-RPC error response
    try {
      this.sendFrame({
        id: requestId,
        error: { code: -32601, message: `Unsupported server request in duo-team bridge: ${method}` },
      });
    } catch {
      // ignore
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      this.latestRateLimits = params.rateLimits ?? params;
      return;
    }

    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;

    const ts = nowIso();
    switch (method) {
      case "turn/started": {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        thread.activeTurnId = typeof turn.id === "string" ? turn.id : thread.activeTurnId;
        thread.status = "running";
        thread.lastError = null;
        thread.outputChunks = [];
        thread.reasoningChunks = [];
        thread.updatedAt = ts;
        break;
      }
      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          thread.outputChunks.push(delta);
          thread.latestOutput = thread.outputChunks.join("");
          thread.updatedAt = ts;
        }
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          thread.reasoningChunks.push(delta);
          thread.reasoningSummary = thread.reasoningChunks.join("");
          thread.updatedAt = ts;
        }
        break;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        thread.plan = plan
          .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
          .map((p) => ({ step: String(p.step ?? ""), status: String(p.status ?? "pending") }));
        thread.updatedAt = ts;
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = (params.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? "");
        const itemId = String(item.id ?? randomUUID().slice(0, 8));
        if (itemType === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          thread.latestOutput = item.text;
        } else if (itemType === "reasoning" && Array.isArray(item.summary) && item.summary.length > 0) {
          thread.reasoningSummary = item.summary.map(String).join("\n");
        } else if (itemType === "commandExecution") {
          this.pushActivity(thread, {
            id: itemId,
            type: "command",
            title: String(item.command ?? "shell command").slice(0, 140),
            status: String(item.status ?? (method === "item/completed" ? "completed" : "running")),
            detail: item.exitCode !== undefined && item.exitCode !== null ? `exit=${item.exitCode}` : undefined,
            timestamp: ts,
          });
        } else if (itemType === "fileChange") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const paths = changes.map((c: Record<string, unknown>) => String(c.path ?? "")).filter(Boolean).slice(0, 4);
          this.pushActivity(thread, {
            id: itemId,
            type: "file",
            title: paths.length ? `修改文件: ${paths.join(", ")}` : "修改工作区文件",
            status: String(item.status ?? (method === "item/completed" ? "completed" : "running")),
            timestamp: ts,
          });
        } else if (itemType === "collabAgentToolCall") {
          const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : [];
          const subEntry: SubAgentInfo = {
            id: itemId,
            tool: String(item.tool ?? "collab"),
            status: String(item.status ?? "running"),
            prompt: typeof item.prompt === "string" ? item.prompt.slice(0, 220) : "",
            model: typeof item.model === "string" ? item.model : null,
            effort: typeof item.reasoningEffort === "string" ? item.reasoningEffort : null,
            receiverThreadIds: receivers,
            updatedAt: ts,
          };
          const existingIdx = thread.subAgents.findIndex((s) => s.id === itemId);
          if (existingIdx >= 0) thread.subAgents[existingIdx] = subEntry;
          else thread.subAgents.push(subEntry);
          this.pushActivity(thread, {
            id: itemId,
            type: "subagent",
            title: `Codex 子代理 (${subEntry.tool})`,
            status: subEntry.status,
            detail: subEntry.prompt ? subEntry.prompt.slice(0, 120) : undefined,
            timestamp: ts,
          });
        } else if (itemType === "subAgentActivity") {
          this.pushActivity(thread, {
            id: itemId,
            type: "subagent",
            title: `子代理活动 (${String(item.kind ?? "activity")})`,
            status: "running",
            detail: typeof item.agentPath === "string" ? item.agentPath : undefined,
            timestamp: ts,
          });
        } else if (itemType === "webSearch") {
          this.pushActivity(thread, {
            id: itemId,
            type: "search",
            title: `联网搜索: ${String(item.query ?? "").slice(0, 120)}`,
            status: method === "item/completed" ? "completed" : "running",
            timestamp: ts,
          });
        }
        thread.updatedAt = ts;
        break;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        const turnStatus = String(turn.status ?? "completed");
        thread.activeTurnId = null;
        thread.lastTurnStatus = turnStatus;
        if (turnStatus === "failed") {
          thread.status = "failed";
          const errObj = turn.error as Record<string, unknown> | null | undefined;
          thread.lastError = errObj ? String(errObj.message ?? JSON.stringify(errObj)) : "Turn failed";
        } else if (turnStatus === "interrupted") {
          thread.status = "interrupted";
        } else {
          thread.status = "completed";
        }
        // Extract final agentMessage if present in turn.items
        if (Array.isArray(turn.items)) {
          const msgs = (turn.items as Record<string, unknown>[])
            .filter((i) => i.type === "agentMessage" && typeof i.text === "string" && (i.text as string).trim())
            .map((i) => i.text as string);
          if (msgs.length > 0) {
            thread.latestOutput = msgs[msgs.length - 1];
          }
        }
        // Clear stale approvals for this thread
        for (const a of thread.pendingApprovals) this.approvals.delete(a.id);
        thread.pendingApprovals = [];
        thread.updatedAt = ts;
        this.emitThreadUpdate(thread);
        this.notifyWaiters();
        return;
      }
      case "error": {
        const errObj = (params.error ?? params) as Record<string, unknown>;
        thread.lastError = String(errObj.message ?? JSON.stringify(errObj));
        thread.updatedAt = ts;
        break;
      }
      default:
        break;
    }
    this.emitThreadUpdate(thread);
  }

  private pushActivity(thread: InternalThread, entry: ActivityEntry): void {
    const idx = thread.activities.findIndex((a) => a.id === entry.id);
    if (idx >= 0) {
      thread.activities[idx] = { ...thread.activities[idx], ...entry };
    } else {
      thread.activities.push(entry);
      if (thread.activities.length > MAX_ACTIVITIES) {
        thread.activities.shift();
      }
    }
  }

  private toSnapshot(t: InternalThread): ThreadSnapshot {
    return {
      threadId: t.threadId,
      role: t.role,
      taskId: t.taskId,
      cwd: t.cwd,
      model: t.model,
      effort: t.effort,
      sandbox: t.sandbox,
      approvalPolicy: t.approvalPolicy,
      status: t.status,
      activeTurnId: t.activeTurnId,
      lastTurnStatus: t.lastTurnStatus,
      lastError: t.lastError,
      reasoningSummary: t.reasoningSummary,
      latestOutput: t.latestOutput,
      plan: [...t.plan],
      subAgents: [...t.subAgents],
      activities: [...t.activities],
      pendingApprovals: [...t.pendingApprovals],
      updatedAt: t.updatedAt,
    };
  }

  private emitThreadUpdate(t: InternalThread): void {
    if (this.onThreadUpdate) {
      this.onThreadUpdate(this.toSnapshot(t));
    }
  }

  public listThreads(): ThreadSnapshot[] {
    return [...this.threads.values()].map((t) => this.toSnapshot(t));
  }

  public getThread(threadId: string): ThreadSnapshot | null {
    const t = this.threads.get(threadId);
    return t ? this.toSnapshot(t) : null;
  }

  public listPendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()];
  }

  public async getStatus(): Promise<{
    connected: boolean;
    userAgent: string | null;
    account: unknown;
    rateLimits: unknown;
    models: unknown[];
    activeThreads: ThreadSnapshot[];
    pendingApprovals: PendingApproval[];
    errors: string[];
  }> {
    const errors: string[] = [];
    let account: unknown = null;
    let rateLimits: unknown = this.latestRateLimits;
    const models: unknown[] = [];

    try {
      await this.ensureConnected();
    } catch (err) {
      return {
        connected: false,
        userAgent: this.serverUserAgent,
        account: null,
        rateLimits: null,
        models: [],
        activeThreads: this.listThreads(),
        pendingApprovals: this.listPendingApprovals(),
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }

    const fetchAllModels = async () => {
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: { data?: unknown[]; models?: unknown[]; nextCursor?: string | null } = await this.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        });
        const items = Array.isArray(res?.data) ? res.data : Array.isArray(res?.models) ? res.models : [];
        models.push(...items);
        if (!res?.nextCursor) break;
        cursor = res.nextCursor;
      }
    };

    await Promise.all([
      this.request("account/read", { refreshToken: false })
        .then((res) => { account = res; })
        .catch((err) => { errors.push(`account/read: ${err instanceof Error ? err.message : String(err)}`); }),
      this.request("account/rateLimits/read")
        .then((res) => {
          rateLimits = res;
          this.latestRateLimits = res;
        })
        .catch((err) => { errors.push(`account/rateLimits/read: ${err instanceof Error ? err.message : String(err)}`); }),
      fetchAllModels().catch((err) => {
        errors.push(`model/list: ${err instanceof Error ? err.message : String(err)}`);
      }),
    ]);

    return {
      connected: this.isConnected(),
      userAgent: this.serverUserAgent,
      account,
      rateLimits,
      models,
      activeThreads: this.listThreads(),
      pendingApprovals: this.listPendingApprovals(),
      errors,
    };
  }

  public async spawnTask(opts: SpawnTaskOptions): Promise<ThreadSnapshot> {
    const sandbox: SandboxModeType = opts.sandbox ?? "workspace-write";
    const approvalPolicy: ApprovalPolicyMode = opts.approvalPolicy ?? "on-request";
    const approvalsReviewer = opts.approvalsReviewer ?? (approvalPolicy === "on-request" ? "auto_review" : "user");

    const startRes = await this.request<{
      thread: { id: string };
      model?: string;
      reasoningEffort?: string | null;
      cwd?: string;
    }>("thread/start", {
      cwd: opts.cwd,
      model: opts.model ?? null,
      sandbox,
      approvalPolicy,
      approvalsReviewer,
      developerInstructions: opts.developerInstructions ?? null,
    });

    const threadId = startRes.thread.id;
    const internal: InternalThread = {
      threadId,
      role: opts.role ?? "Codex Worker",
      taskId: opts.taskId ?? null,
      cwd: startRes.cwd ?? opts.cwd,
      model: startRes.model ?? opts.model ?? null,
      effort: opts.effort ?? startRes.reasoningEffort ?? null,
      sandbox,
      approvalPolicy,
      status: "running",
      activeTurnId: null,
      lastTurnStatus: null,
      lastError: null,
      reasoningSummary: "",
      latestOutput: "",
      plan: [],
      subAgents: [],
      activities: [],
      pendingApprovals: [],
      updatedAt: nowIso(),
      loadedInProcess: true,
      outputChunks: [],
      reasoningChunks: [],
    };
    this.threads.set(threadId, internal);
    this.emitThreadUpdate(internal);

    const turnRes = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      cwd: opts.cwd,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      approvalPolicy,
      approvalsReviewer,
      input: [{ type: "text", text: opts.prompt, text_elements: [] }],
    });

    if (turnRes?.turn?.id) {
      internal.activeTurnId = turnRes.turn.id;
    }
    this.emitThreadUpdate(internal);

    if (opts.async) {
      return this.toSnapshot(internal);
    }
    const waitMs = opts.waitMs ?? 120_000;
    const [result] = await this.waitForThreads([threadId], waitMs);
    return result ?? this.toSnapshot(internal);
  }

  public async sendMessage(threadId: string, opts: SendMessageOptions): Promise<ThreadSnapshot> {
    let internal = this.threads.get(threadId);
    const shouldSteer = opts.steerIfRunning !== false;

    // If running and steer requested, use turn/steer!
    if (internal && internal.loadedInProcess && internal.status === "running" && internal.activeTurnId && shouldSteer) {
      await this.request("turn/steer", {
        threadId,
        expectedTurnId: internal.activeTurnId,
        input: [{ type: "text", text: opts.text, text_elements: [] }],
      });
      this.pushActivity(internal, {
        id: randomUUID().slice(0, 8),
        type: "steer",
        title: `实时插话引导: ${opts.text.slice(0, 120)}`,
        status: "sent",
        timestamp: nowIso(),
      });
      internal.updatedAt = nowIso();
      this.emitThreadUpdate(internal);
      return this.toSnapshot(internal);
    }

    // Resume thread if not currently loaded in process (crash recovery / restart)
    if (!internal || !internal.loadedInProcess) {
      const resumed = await this.request<{
        thread: { id: string };
        model?: string;
        reasoningEffort?: string | null;
        cwd?: string;
      }>("thread/resume", {
        threadId,
        cwd: opts.cwd ?? internal?.cwd ?? null,
        model: opts.model ?? internal?.model ?? null,
        excludeTurns: true,
      });

      if (!internal) {
        internal = {
          threadId: resumed.thread.id,
          role: "Codex Worker (Resumed)",
          taskId: null,
          cwd: resumed.cwd ?? opts.cwd ?? process.cwd(),
          model: resumed.model ?? opts.model ?? null,
          effort: opts.effort ?? resumed.reasoningEffort ?? null,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          status: "idle",
          activeTurnId: null,
          lastTurnStatus: null,
          lastError: null,
          reasoningSummary: "",
          latestOutput: "",
          plan: [],
          subAgents: [],
          activities: [],
          pendingApprovals: [],
          updatedAt: nowIso(),
          loadedInProcess: true,
          outputChunks: [],
          reasoningChunks: [],
        };
        this.threads.set(threadId, internal);
      } else {
        internal.loadedInProcess = true;
      }
    }

    internal.status = "running";
    internal.lastError = null;
    internal.outputChunks = [];
    internal.reasoningChunks = [];
    internal.updatedAt = nowIso();
    this.emitThreadUpdate(internal);

    const turnRes = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      cwd: opts.cwd ?? internal.cwd,
      model: opts.model ?? internal.model ?? null,
      effort: opts.effort ?? internal.effort ?? null,
      input: [{ type: "text", text: opts.text, text_elements: [] }],
    });
    if (turnRes?.turn?.id) {
      internal.activeTurnId = turnRes.turn.id;
    }
    this.emitThreadUpdate(internal);

    if (opts.async) {
      return this.toSnapshot(internal);
    }
    const waitMs = opts.waitMs ?? 120_000;
    const [result] = await this.waitForThreads([threadId], waitMs);
    return result ?? this.toSnapshot(internal);
  }

  public async waitForThreads(threadIds: string[], timeoutMs = 60_000): Promise<ThreadSnapshot[]> {
    const isSettled = (id: string): boolean => {
      const t = this.threads.get(id);
      if (!t) return true;
      return t.status !== "running";
    };

    if (timeoutMs > 0 && !threadIds.every(isSettled)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(check);
          resolve();
        }, timeoutMs);
        const check = () => {
          if (threadIds.every(isSettled)) {
            clearTimeout(timer);
            this.waiters.delete(check);
            resolve();
          }
        };
        this.waiters.add(check);
        check();
      });
    }

    return threadIds
      .map((id) => this.threads.get(id))
      .filter((t): t is InternalThread => Boolean(t))
      .map((t) => this.toSnapshot(t));
  }

  public async interrupt(threadId: string): Promise<ThreadSnapshot | null> {
    const internal = this.threads.get(threadId);
    if (!internal) return null;
    if (internal.activeTurnId && this.isConnected()) {
      await this.request("turn/interrupt", { threadId, turnId: internal.activeTurnId });
    }
    internal.status = "interrupted";
    internal.activeTurnId = null;
    internal.updatedAt = nowIso();
    this.emitThreadUpdate(internal);
    this.notifyWaiters();
    return this.toSnapshot(internal);
  }

  public async interruptAll(): Promise<ThreadSnapshot[]> {
    const running = [...this.threads.values()].filter((t) => t.status === "running" || t.status === "waiting_approval");
    const results: ThreadSnapshot[] = [];
    for (const t of running) {
      const snap = await this.interrupt(t.threadId).catch(() => null);
      if (snap) results.push(snap);
    }
    return results;
  }

  public async broadcastMessage(
    text: string,
    threadIds?: string[]
  ): Promise<Array<{ threadId: string; role: string; ok: boolean; error?: string }>> {
    const targets = threadIds?.length
      ? threadIds.map((id) => this.threads.get(id)).filter((t): t is InternalThread => Boolean(t))
      : [...this.threads.values()].filter((t) => t.status === "running" || t.status === "idle" || t.status === "completed");

    return Promise.all(
      targets.map(async (t) => {
        try {
          await this.sendMessage(t.threadId, { text, steerIfRunning: true, async: true });
          return { threadId: t.threadId, role: t.role, ok: true };
        } catch (err) {
          return { threadId: t.threadId, role: t.role, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
  }

  public async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<{ ok: boolean; approval?: PendingApproval }> {
    const approval = this.approvals.get(approvalId);
    if (!approval) return { ok: false };
    this.approvals.delete(approvalId);

    const payload =
      approval.method === "item/permissions/requestApproval"
        ? { permissions: decision === "accept" || decision === "acceptForSession" ? approval.details.permissions ?? {} : {}, scope: "turn" }
        : { decision };

    this.sendFrame({
      id: approval.requestId,
      result: payload,
    });

    const thread = this.threads.get(approval.threadId);
    if (thread) {
      thread.pendingApprovals = thread.pendingApprovals.filter((a) => a.id !== approvalId);
      if (thread.pendingApprovals.length === 0 && thread.status === "waiting_approval") {
        thread.status = "running";
      }
      this.pushActivity(thread, {
        id: approval.id,
        type: "approval",
        title: `${approval.summary} → ${decision}`,
        status: decision === "decline" || decision === "cancel" ? "declined" : "approved",
        timestamp: nowIso(),
      });
      thread.updatedAt = nowIso();
      this.emitThreadUpdate(thread);
    }
    return { ok: true, approval };
  }
}
