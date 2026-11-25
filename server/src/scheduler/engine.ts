import {
  inferRolePreset,
  type GlobalModelSettings,
  type ProjectRecord,
  type TaskRecord,
  type VerificationResult,
} from "../ledger/store.js";
import type { ThreadSnapshot } from "../codex/client.js";
import {
  clampEffortToModel,
  resolveSubscriptionProfile,
  type SubscriptionProfile,
} from "./subscriptions.js";

export interface ScheduleAlert {
  level: "info" | "warning" | "error";
  code: "cycle_detected" | "stalled_thread" | "waiting_approval" | "rework_exhausted" | "low_quota";
  title: string;
  detail: string;
  targetId?: string;
}

export interface RoutingRecommendation {
  taskId: string;
  taskTitle: string;
  owner: string;
  recommendedModel: string | null;
  recommendedEffort: string | null;
  reason: string;
  enforcedByLock: boolean;
  onCriticalPath: boolean;
}

export interface WaveLayer {
  wave: number;
  taskIds: string[];
}

export interface ScheduleAnalysis {
  totalTasks: number;
  doneTasks: number;
  runningTasks: number;
  readyTasks: string[];
  waves: WaveLayer[];
  criticalPath: string[];
  cycles: string[][];
  stalledThreadIds: string[];
  alerts: ScheduleAlert[];
  recommendations: RoutingRecommendation[];
  healthScore: number; // 0..100
}

const STALL_MS = 5 * 60 * 1000;

/**
 * Detect dependency cycles using DFS (returns list of cycles as task ID chains).
 */
export function detectCycles(tasks: TaskRecord[]): string[][] {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const stack: string[] = [];
  const cycles: string[][] = [];

  const dfs = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    const node = map.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (!map.has(dep)) continue;
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          const idx = stack.indexOf(dep);
          if (idx >= 0) cycles.push([...stack.slice(idx), dep]);
        } else if (c === 0) {
          dfs(dep);
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) dfs(t.id);
  }
  return cycles;
}

/**
 * Compute topological execution waves (Kahn's algorithm) and longest-chain critical path.
 */
export function computeWavesAndCriticalPath(tasks: TaskRecord[]): {
  waves: WaveLayer[];
  criticalPath: string[];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const inDeg = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const t of tasks) {
    const validDeps = t.dependsOn.filter((d) => byId.has(d));
    inDeg.set(t.id, validDeps.length);
    for (const d of validDeps) {
      const list = children.get(d) ?? [];
      list.push(t.id);
      children.set(d, list);
    }
  }

  const waves: WaveLayer[] = [];
  let frontier = tasks.filter((t) => (inDeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const visited = new Set<string>();
  const depth = new Map<string, number>();
  const parent = new Map<string, string | null>();

  let waveIdx = 1;
  while (frontier.length > 0) {
    waves.push({ wave: waveIdx++, taskIds: [...frontier] });
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      visited.add(id);
      if (!depth.has(id)) {
        depth.set(id, 1);
        parent.set(id, null);
      }
      const curDepth = depth.get(id)!;
      for (const childId of children.get(id) ?? []) {
        const nextDeg = (inDeg.get(childId) ?? 1) - 1;
        inDeg.set(childId, nextDeg);
        if (curDepth + 1 > (depth.get(childId) ?? 0)) {
          depth.set(childId, curDepth + 1);
          parent.set(childId, id);
        }
        if (nextDeg === 0) nextFrontier.push(childId);
      }
    }
    frontier = nextFrontier;
  }

  // Remaining nodes (if cycle exists) placed in final wave for visibility
  const unplaced = tasks.filter((t) => !visited.has(t.id)).map((t) => t.id);
  if (unplaced.length > 0) {
    waves.push({ wave: waveIdx, taskIds: unplaced });
  }

  // Reconstruct longest path among unfinished (or all) tasks
  let bestEnd: string | null = null;
  let bestLen = 0;
  for (const [id, d] of depth.entries()) {
    const task = byId.get(id);
    const weight = task && task.status !== "done" ? d + 0.5 : d;
    if (weight > bestLen) {
      bestLen = weight;
      bestEnd = id;
    }
  }

  const criticalPath: string[] = [];
  let cursor = bestEnd;
  while (cursor) {
    criticalPath.unshift(cursor);
    cursor = parent.get(cursor) ?? null;
  }

  return { waves, criticalPath };
}

function classifyComplexity(task: TaskRecord): "high" | "medium" | "low" {
  const text = `${task.title} ${task.description} ${task.acceptanceCriteria}`.toLowerCase();
  if (/架构|设计|计量|识别|因果|证明|推导|辩论|审稿|评审|安全|优化|重构|architect|identif|econometr|review|debate|proof|algorithm/.test(text)) {
    return "high";
  }
  if (/格式|整理|翻译|文案|列表|简单|format|rename|lint|copy/.test(text)) {
    return "low";
  }
  return "medium";
}

function pickAdaptiveModel(
  task: TaskRecord,
  availableModels: Array<{ id: string; efforts?: string[] }>,
  lowQuota: boolean,
  onCriticalPath: boolean,
  subscription: SubscriptionProfile
): { model: string | null; effort: string | null; reason: string } {
  const complexity = classifyComplexity(task);
  const tier = subscription.chatgpt;
  const findModel = (patterns: RegExp[]) => {
    for (const p of patterns) {
      const hit = availableModels.find((m) => p.test(m.id));
      if (hit) return hit;
    }
    return availableModels[0] ?? null;
  };
  const lightPatterns = [/mini/i, /spark/i, /flash/i, /luna/i, /terra/i, /sol/i];
  const strongPatterns = [/6\.2-sol/i, /6\.2-astra/i, /6\.1-sol/i, /6-astra/i, /5\.4/i, /5\.3/i, /codex-max/i, /codex/i, /sol/i];
  const balancedPatterns = [/6\.2-sol/i, /6\.1-sol/i, /5\.4/i, /5\.3/i, /codex/i, /sol/i];

  if (lowQuota && !onCriticalPath && complexity !== "high") {
    const fastModel = findModel(lightPatterns);
    const effort = clampEffortToModel(tier.lightEffort, fastModel?.efforts, tier.effortCeiling);
    return {
      model: fastModel?.id ?? null,
      effort,
      reason: `检测到 ${tier.label} 订阅余量偏低且此任务不在关键路径，自动降档节流 (${effort ?? "default"}) 以保护主任务额度`,
    };
  }

  if (complexity === "high" || onCriticalPath) {
    const strongModel = findModel(strongPatterns);
    const desired = task.reworkCount > 0 ? tier.reworkEffort : tier.criticalEffort;
    const effort = clampEffortToModel(desired, strongModel?.efforts, tier.effortCeiling);
    return {
      model: strongModel?.id ?? null,
      effort,
      reason:
        task.reworkCount > 0
          ? `返工第 ${task.reworkCount} 轮，按 ${tier.label} 上限自动调优推理深度 (${effort ?? "default"}) 避免重复出错`
          : onCriticalPath
            ? `处于项目关键路径或高复杂度分析任务，按 ${tier.label} 策略分配旗舰模型 (${effort ?? "default"})`
            : `高复杂度推理任务，按 ${tier.label} 策略分配高阶模型 (${effort ?? "default"})`,
    };
  }

  if (complexity === "low") {
    const lightModel = findModel(lightPatterns);
    const effort = clampEffortToModel(tier.lightEffort, lightModel?.efforts, tier.effortCeiling);
    return {
      model: lightModel?.id ?? null,
      effort,
      reason: `轻量整理/常规任务，按 ${tier.label} 策略使用省流速度档位 (${effort ?? "default"}) 提升并行吞吐`,
    };
  }

  const balancedModel = findModel(balancedPatterns);
  const effort = clampEffortToModel(tier.defaultEffort, balancedModel?.efforts, tier.effortCeiling);
  return {
    model: balancedModel?.id ?? null,
    effort,
    reason: `标准研发/分析任务，按 ${tier.label} 策略使用主力模型 (${effort ?? "default"})`,
  };
}

export function analyzeSchedule(params: {
  project: ProjectRecord | null;
  globalSettings: GlobalModelSettings;
  tasks: TaskRecord[];
  activeThreads: ThreadSnapshot[];
  availableModels: Array<{ id: string; efforts?: string[] }>;
  quotaRemainingPercent: number | null;
  subscriptionProfile?: SubscriptionProfile;
  nowMs?: number;
}): ScheduleAnalysis {
  const { project, globalSettings, tasks, activeThreads, availableModels, quotaRemainingPercent } = params;
  const subscription =
    params.subscriptionProfile ??
    resolveSubscriptionProfile({
      googlePlan: globalSettings.googlePlan,
      chatgptPlan: globalSettings.chatgptPlan,
    });
  const nowMs = params.nowMs ?? Date.now();
  const alerts: ScheduleAlert[] = [];

  const cycles = detectCycles(tasks);
  for (const cyc of cycles) {
    alerts.push({
      level: "error",
      code: "cycle_detected",
      title: "检测到任务循环依赖死锁",
      detail: `依赖环：${cyc.join(" → ")}，请调整其中一项的 dependsOn 解除死锁。`,
    });
  }

  const { waves, criticalPath } = computeWavesAndCriticalPath(tasks);
  const criticalSet = new Set(criticalPath);

  const stalledThreadIds: string[] = [];
  for (const t of activeThreads) {
    const updatedMs = Date.parse(t.updatedAt);
    const idleMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : 0;
    if (t.status === "waiting_approval") {
      alerts.push({
        level: "warning",
        code: "waiting_approval",
        title: `线程「${t.role}」等待你的操作审批`,
        detail: t.pendingApprovals[0]?.summary ?? "有待放行的文件或命令权限请求。",
        targetId: t.threadId,
      });
    } else if (t.status === "running" && idleMs > STALL_MS) {
      stalledThreadIds.push(t.threadId);
      alerts.push({
        level: "warning",
        code: "stalled_thread",
        title: `检测到疑似停滞线程「${t.role}」`,
        detail: `已超过 ${Math.round(idleMs / 60000)} 分钟无新事件输出，建议实时插话（Steer）唤醒或中断重试。`,
        targetId: t.threadId,
      });
    }
  }

  for (const t of tasks) {
    if (t.status === "rework" && t.reworkCount >= t.maxReworks) {
      alerts.push({
        level: "error",
        code: "rework_exhausted",
        title: `任务 ${t.id} 已达返工上限 (${t.reworkCount}/${t.maxReworks})`,
        detail: `「${t.title}」连续返工仍未达标，建议人工介入调整口径或拆分任务。`,
        targetId: t.id,
      });
    }
  }

  const lowQuotaThreshold = subscription.chatgpt.lowQuotaThreshold;
  const lowQuota = quotaRemainingPercent !== null && quotaRemainingPercent <= lowQuotaThreshold;
  if (lowQuota) {
    alerts.push({
      level: "warning",
      code: "low_quota",
      title: `${subscription.chatgpt.label} 订阅余量偏低 (${quotaRemainingPercent}%)`,
      detail: `已触发 ${subscription.chatgpt.shortBadge} 保护阈值 (≤${lowQuotaThreshold}%)，建议将 Codex 并发收敛至 ≤${subscription.chatgpt.recommendedMaxParallel} 路或对非关键任务启用智能降档。`,
    });
  }

  const readyTasks = tasks
    .filter((t) => (t.status === "todo" || t.status === "rework") && t.ready)
    .map((t) => t.id);

  const cfg = project ?? globalSettings;
  const recommendations: RoutingRecommendation[] = tasks
    .filter((t) => readyTasks.includes(t.id))
    .map((t) => {
      const roleKey = inferRolePreset(`${t.title} ${t.description}`);
      const rolePreset = cfg.roleModels?.[roleKey];
      const lockedModel = rolePreset?.model || cfg.defaultCodexModel;
      const lockedEffort = rolePreset?.effort || cfg.defaultCodexEffort;
      const onCritical = criticalSet.has(t.id);

      if (t.owner === "gemini") {
        return {
          taskId: t.id,
          taskTitle: t.title,
          owner: t.owner,
          recommendedModel: `Gemini (${subscription.google.shortBadge})`,
          recommendedEffort: null,
          reason: onCritical
            ? `由 Antigravity 原生主控/子代理执行（关键路径 · ${subscription.google.label}）`
            : `由 Antigravity 原生子代理执行（${subscription.google.label}）`,
          enforcedByLock: false,
          onCriticalPath: onCritical,
        };
      }

      if (cfg.lockCodexModel && (lockedModel || lockedEffort)) {
        return {
          taskId: t.id,
          taskTitle: t.title,
          owner: t.owner,
          recommendedModel: lockedModel,
          recommendedEffort: lockedEffort,
          reason: rolePreset?.model
            ? `已按你的角色预设（${roleKey}）强制锁定`
            : "已按你的手动锁定模型配置强制执行",
          enforcedByLock: true,
          onCriticalPath: onCritical,
        };
      }

      const adaptive = pickAdaptiveModel(t, availableModels, lowQuota, onCritical, subscription);
      return {
        taskId: t.id,
        taskTitle: t.title,
        owner: t.owner,
        recommendedModel: adaptive.model,
        recommendedEffort: adaptive.effort,
        reason: adaptive.reason,
        enforcedByLock: false,
        onCriticalPath: onCritical,
      };
    });

  let healthScore = 100;
  for (const a of alerts) {
    healthScore -= a.level === "error" ? 28 : a.level === "warning" ? 12 : 4;
  }
  healthScore = Math.max(10, Math.min(100, healthScore));

  return {
    totalTasks: tasks.length,
    doneTasks: tasks.filter((t) => t.status === "done").length,
    runningTasks: tasks.filter((t) => t.status === "running").length,
    readyTasks,
    waves,
    criticalPath,
    cycles,
    stalledThreadIds,
    alerts,
    recommendations,
    healthScore,
  };
}

export function buildSelfHealPrompt(task: TaskRecord, verify: VerificationResult): string {
  const missingArtifacts = verify.artifacts.filter((a) => !a.exists || a.sizeBytes === 0).map((a) => a.path);
  const parts = [
    `【自动验收未通过 · 第 ${task.reworkCount + 1}/${task.maxReworks} 轮自愈修复】`,
    `任务：${task.id} · ${task.title}`,
  ];
  if (task.acceptanceCriteria) parts.push(`验收标准：${task.acceptanceCriteria}`);
  if (verify.command) {
    parts.push(`验收命令：\`${verify.command}\`（退出码：${verify.exitCode}）`);
  }
  if (missingArtifacts.length > 0) {
    parts.push(`缺失或为空的交付文件：${missingArtifacts.join("、")}`);
  }
  if (verify.stderr.trim()) {
    parts.push(`标准错误输出（stderr）：\n\`\`\`\n${verify.stderr.trim().slice(-2000)}\n\`\`\``);
  }
  if (verify.stdout.trim()) {
    parts.push(`标准输出摘要（stdout）：\n\`\`\`\n${verify.stdout.trim().slice(-1500)}\n\`\`\``);
  }
  parts.push("请用简体中文先精准定位根因，再直接修复问题并自行复跑验证，确保所有验收项通过后汇报结果。");
  return parts.join("\n\n");
}
