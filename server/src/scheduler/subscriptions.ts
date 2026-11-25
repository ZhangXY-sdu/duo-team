export type GooglePlanTier = "free" | "pro" | "ultra" | "enterprise";
export type ChatGptPlanTier = "auto" | "free" | "go" | "plus" | "pro" | "team" | "edu" | "enterprise";
export type ResolvedChatGptPlanTier = Exclude<ChatGptPlanTier, "auto">;

export interface QuotaWindowInfo {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  windowLabel: string | null;
  resetsAt: number | null;
  resetText: string | null;
}

export interface RateLimitSummary {
  detectedPlan: ResolvedChatGptPlanTier | null;
  rawPlanType: string | null;
  ordinaryUsageAllowed: boolean | null;
  primary: QuotaWindowInfo | null;
  secondary: QuotaWindowInfo | null;
  effectiveRemainingPercent: number | null;
}

export interface GooglePlanProfile {
  tier: GooglePlanTier;
  label: string;
  shortBadge: string;
  recommendedGeminiParallel: number;
  summary: string;
}

export interface ChatGptPlanProfile {
  tier: ResolvedChatGptPlanTier;
  label: string;
  shortBadge: string;
  recommendedMaxParallel: number;
  lowQuotaThreshold: number;
  effortCeiling: string;
  defaultEffort: string;
  criticalEffort: string;
  reworkEffort: string;
  lightEffort: string;
  summary: string;
}

export interface SubscriptionProfile {
  google: GooglePlanProfile;
  chatgpt: ChatGptPlanProfile & {
    configuredTier: ChatGptPlanTier;
    detectedTier: ResolvedChatGptPlanTier | null;
    rawPlanType: string | null;
    quota: RateLimitSummary;
  };
  pairingTitle: string;
  pairingAdvice: string;
  recommendedRoleSplit: string;
}

export const EFFORT_RANK: Record<string, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

export const GOOGLE_PLAN_PROFILES: Record<GooglePlanTier, GooglePlanProfile> = {
  free: {
    tier: "free",
    label: "Google AI Free",
    shortBadge: "AI Free",
    recommendedGeminiParallel: 1,
    summary: "基础免费额度：建议 Gemini 聚焦轻量化总控与决策确认，将重度编码/分析交给 Codex。",
  },
  pro: {
    tier: "pro",
    label: "Google AI Pro",
    shortBadge: "AI Pro",
    recommendedGeminiParallel: 2,
    summary: "标准个人订阅：适合常规规划、联网检索、独立复核与 2 路左右 Gemini 子代理并行。",
  },
  ultra: {
    tier: "ultra",
    label: "Google AI Ultra",
    shortBadge: "AI Ultra",
    recommendedGeminiParallel: 5,
    summary: "旗舰超高配额：可充分释放 Gemini 深度推理与多路原生 Subagent/Workflow 并行优势。",
  },
  enterprise: {
    tier: "enterprise",
    label: "Google Workspace / Enterprise",
    shortBadge: "Workspace",
    recommendedGeminiParallel: 4,
    summary: "组织级高配额：支持稳定的大规模并行研究、审稿与长周期任务编排。",
  },
};

export const CHATGPT_PLAN_PROFILES: Record<ResolvedChatGptPlanTier, ChatGptPlanProfile> = {
  free: {
    tier: "free",
    label: "ChatGPT Free",
    shortBadge: "Free",
    recommendedMaxParallel: 1,
    lowQuotaThreshold: 35,
    effortCeiling: "medium",
    defaultEffort: "low",
    criticalEffort: "medium",
    reworkEffort: "medium",
    lightEffort: "low",
    summary: "基础免费档：建议单线程运行并保持轻/中推理强度。",
  },
  go: {
    tier: "go",
    label: "ChatGPT Go",
    shortBadge: "Go",
    recommendedMaxParallel: 1,
    lowQuotaThreshold: 30,
    effortCeiling: "medium",
    defaultEffort: "medium",
    criticalEffort: "medium",
    reworkEffort: "medium",
    lightEffort: "low",
    summary: "轻量入门档：建议 1 路顺序执行、控制推理强度在 medium 以内。",
  },
  plus: {
    tier: "plus",
    label: "ChatGPT Plus",
    shortBadge: "Plus",
    recommendedMaxParallel: 2,
    lowQuotaThreshold: 25,
    effortCeiling: "high",
    defaultEffort: "medium",
    criticalEffort: "high",
    reworkEffort: "high",
    lightEffort: "low",
    summary: "5 小时滚动窗口 + 周限额：建议 2 路并发、常规 medium / 关键任务 high，避免瞬时刷空窗口。",
  },
  pro: {
    tier: "pro",
    label: "ChatGPT Pro",
    shortBadge: "Pro",
    recommendedMaxParallel: 4,
    lowQuotaThreshold: 15,
    effortCeiling: "max",
    defaultEffort: "high",
    criticalEffort: "xhigh",
    reworkEffort: "max",
    lightEffort: "medium",
    summary: "高额度旗舰个人订阅：支持 4 路并发编队与 xhigh/max 深度推理，胜任全模式重度协作。",
  },
  team: {
    tier: "team",
    label: "ChatGPT Team / Business",
    shortBadge: "Team",
    recommendedMaxParallel: 3,
    lowQuotaThreshold: 20,
    effortCeiling: "xhigh",
    defaultEffort: "high",
    criticalEffort: "xhigh",
    reworkEffort: "xhigh",
    lightEffort: "medium",
    summary: "团队协作订阅：额度较 Plus 更宽裕，推荐 3 路并发与 high/xhigh 阶梯推理。",
  },
  edu: {
    tier: "edu",
    label: "ChatGPT Edu",
    shortBadge: "Edu",
    recommendedMaxParallel: 3,
    lowQuotaThreshold: 20,
    effortCeiling: "xhigh",
    defaultEffort: "high",
    criticalEffort: "xhigh",
    reworkEffort: "xhigh",
    lightEffort: "medium",
    summary: "高校科研订阅：适合课题组实证与论文协作，推荐 3 路并发与 high/xhigh 推理。",
  },
  enterprise: {
    tier: "enterprise",
    label: "ChatGPT Enterprise",
    shortBadge: "Enterprise",
    recommendedMaxParallel: 6,
    lowQuotaThreshold: 15,
    effortCeiling: "max",
    defaultEffort: "high",
    criticalEffort: "xhigh",
    reworkEffort: "max",
    lightEffort: "medium",
    summary: "企业级高并发配额：支持 6 路满速并发编队与全档位深度推理。",
  },
};

export function normalizeChatGptPlanString(raw: unknown): ResolvedChatGptPlanTier | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("enterprise")) return "enterprise";
  if (s.includes("edu")) return "edu";
  if (s.includes("team") || s.includes("business")) return "team";
  if (s === "pro" || s.includes("chatgpt_pro") || s.includes("chatgpt-pro") || /\bpro\b/.test(s)) return "pro";
  if (s === "plus" || s.includes("chatgpt_plus") || s.includes("chatgpt-plus") || /\bplus\b/.test(s)) return "plus";
  if (s === "go" || s.includes("chatgpt_go") || s.includes("chatgpt-go")) return "go";
  if (s === "free" || s.includes("chatgpt_free")) return "free";
  return null;
}

export function formatWindowDuration(mins: number | null | undefined): string | null {
  if (typeof mins !== "number" || !Number.isFinite(mins) || mins <= 0) return null;
  if (mins < 60) return `${Math.round(mins)} 分钟周期`;
  if (mins < 1440) {
    const hrs = Math.round((mins / 60) * 10) / 10;
    return `${hrs} 小时周期`;
  }
  const days = Math.round((mins / 1440) * 10) / 10;
  return `${days} 天周期`;
}

function parseWindow(raw: unknown): QuotaWindowInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const used = typeof obj.usedPercent === "number" ? obj.usedPercent : null;
  if (used === null) return null;
  const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
  const windowDurationMins = typeof obj.windowDurationMins === "number" ? obj.windowDurationMins : null;
  const resetsAt = typeof obj.resetsAt === "number" ? obj.resetsAt : null;
  return {
    usedPercent: used,
    remainingPercent: remaining,
    windowDurationMins,
    windowLabel: formatWindowDuration(windowDurationMins),
    resetsAt,
    resetText: resetsAt ? new Date(resetsAt * 1000).toLocaleString() : null,
  };
}

export function extractRateLimitSummary(
  account: unknown,
  rateLimits: unknown
): RateLimitSummary {
  const accObj = (account && typeof account === "object" ? account : {}) as Record<string, unknown>;
  const accInner = (accObj.account && typeof accObj.account === "object" ? accObj.account : accObj) as Record<string, unknown>;

  const rlObj = (rateLimits && typeof rateLimits === "object" ? rateLimits : {}) as Record<string, unknown>;
  const rlInner = (rlObj.rateLimits && typeof rlObj.rateLimits === "object" ? rlObj.rateLimits : rlObj) as Record<string, unknown>;

  const rawPlanCandidate =
    rlInner.planType ??
    rlObj.planType ??
    accInner.planType ??
    accObj.planType ??
    accInner.plan ??
    null;
  const rawPlanType = typeof rawPlanCandidate === "string" && rawPlanCandidate.trim() ? rawPlanCandidate.trim() : null;
  const detectedPlan = normalizeChatGptPlanString(rawPlanType);

  const primary = parseWindow(rlInner.primary);
  const secondary = parseWindow(rlInner.secondary);

  const candidates = [primary?.remainingPercent, secondary?.remainingPercent].filter(
    (v): v is number => typeof v === "number"
  );
  const effectiveRemainingPercent = candidates.length > 0 ? Math.min(...candidates) : null;
  const ordinaryUsageAllowed =
    typeof rlObj.ordinaryUsageAllowed === "boolean"
      ? rlObj.ordinaryUsageAllowed
      : typeof rlInner.ordinaryUsageAllowed === "boolean"
        ? rlInner.ordinaryUsageAllowed
        : null;

  return {
    detectedPlan,
    rawPlanType,
    ordinaryUsageAllowed,
    primary,
    secondary,
    effectiveRemainingPercent,
  };
}

export function clampEffortToModel(
  desiredEffort: string | null,
  supportedEfforts?: string[],
  ceilingEffort?: string
): string | null {
  if (!desiredEffort) return null;
  const ceilingRank = ceilingEffort && ceilingEffort in EFFORT_RANK ? EFFORT_RANK[ceilingEffort] : 99;

  // Apply ceiling first
  let target = desiredEffort;
  if (target in EFFORT_RANK && EFFORT_RANK[target] > ceilingRank && ceilingEffort) {
    target = ceilingEffort;
  }

  if (!supportedEfforts || supportedEfforts.length === 0) {
    return target;
  }
  if (supportedEfforts.includes(target)) {
    return target;
  }

  // Pick closest supported effort at or below target rank (and below ceiling)
  const targetRank = Math.min(target in EFFORT_RANK ? EFFORT_RANK[target] : 3, ceilingRank);
  const ranked = supportedEfforts
    .map((e) => ({ e, r: e in EFFORT_RANK ? EFFORT_RANK[e] : 3 }))
    .sort((a, b) => a.r - b.r);

  const atOrBelow = ranked.filter((x) => x.r <= targetRank);
  if (atOrBelow.length > 0) {
    return atOrBelow[atOrBelow.length - 1].e;
  }
  return ranked[0]?.e ?? null;
}

export function resolveSubscriptionProfile(params: {
  googlePlan?: GooglePlanTier | null;
  chatgptPlan?: ChatGptPlanTier | null;
  account?: unknown;
  rateLimits?: unknown;
}): SubscriptionProfile {
  const googleTier: GooglePlanTier =
    params.googlePlan && params.googlePlan in GOOGLE_PLAN_PROFILES ? params.googlePlan : "pro";
  const configuredChatGpt: ChatGptPlanTier =
    params.chatgptPlan && (params.chatgptPlan === "auto" || params.chatgptPlan in CHATGPT_PLAN_PROFILES)
      ? params.chatgptPlan
      : "auto";

  const quota = extractRateLimitSummary(params.account, params.rateLimits);
  const effectiveChatGptTier: ResolvedChatGptPlanTier =
    configuredChatGpt !== "auto" ? configuredChatGpt : quota.detectedPlan ?? "pro";

  const google = GOOGLE_PLAN_PROFILES[googleTier];
  const chatgptBase = CHATGPT_PLAN_PROFILES[effectiveChatGptTier];

  const isGeminiHeavy = googleTier === "ultra" || googleTier === "enterprise";
  const isCodexHeavy = effectiveChatGptTier === "pro" || effectiveChatGptTier === "enterprise";
  const isCodexTight = effectiveChatGptTier === "plus" || effectiveChatGptTier === "go" || effectiveChatGptTier === "free";

  let pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge}`;
  let pairingAdvice = "";
  let recommendedRoleSplit = "";

  if (isGeminiHeavy && isCodexHeavy) {
    pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge} · 双旗舰满血编队`;
    pairingAdvice = `双端均为高配额档位：推荐 Codex 并发上限 ${chatgptBase.recommendedMaxParallel}、Gemini 原生子代理并发 ${google.recommendedGeminiParallel}，适合全速运行自主团队、双盲并行研究与多轮深度辩论。`;
    recommendedRoleSplit = "双边重负载并行：Gemini 深度综合/多路检索/复核 + Codex 多 Worktree 并发编码/计量脚本/深度推理。";
  } else if (isGeminiHeavy && isCodexTight) {
    pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge} · Gemini 主力 + GPT 精准打击`;
    pairingAdvice = `Gemini 处于高配额档位而 ${chatgptBase.label} 窗口偏紧：建议将探索、综述、文档与常规并行任务优先交给 Gemini（可开 ${google.recommendedGeminiParallel} 路），Codex 并发收敛至 ${chatgptBase.recommendedMaxParallel} 路、推理上限设 ${chatgptBase.effortCeiling}，专注核心代码实现与关键交叉审稿。`;
    recommendedRoleSplit = "Gemini 承担 70%（规划/研究/起草/多路验证）+ Codex 聚焦 30%（核心算法/关键代码/独立挑刺）。";
  } else if (!isGeminiHeavy && isCodexHeavy) {
    pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge} · GPT 重载执行 + Gemini 轻控复核`;
    pairingAdvice = `${chatgptBase.label} 配额充裕：可将大型编码、批量数据脚本、多分支对比与深度推理任务（支持 ${chatgptBase.recommendedMaxParallel} 路并发）充分委托给 Codex，Gemini 专注顶层规划、联网检索与结果把关。`;
    recommendedRoleSplit = "Gemini 负责规划/联网/统筹验收 + Codex 承担 65% 重度编码/实证计算/自愈返工。";
  } else if (googleTier === "pro" && (effectiveChatGptTier === "team" || effectiveChatGptTier === "edu")) {
    pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge} · 科研与团队均衡档`;
    pairingAdvice = `双端配额均衡：推荐 Codex 并发 ${chatgptBase.recommendedMaxParallel} 路与 high/xhigh 阶梯推理，适合联合共创、规划执行与课题组自定义流水线。`;
    recommendedRoleSplit = "按比较优势 50/50 协作：Gemini 文献框架与排版 + Codex 实证代码与自动化测试。";
  } else {
    pairingTitle = `${google.shortBadge} × ${chatgptBase.shortBadge} · 精打细算节流组合`;
    pairingAdvice = `双端均存在窗口限额压力：强烈建议关闭强制锁模以启用智能复杂度路由，Codex 并发控制在 ${chatgptBase.recommendedMaxParallel} 路、推理上限 ${chatgptBase.effortCeiling}，优先把额度留给关键路径与最终交叉复核。`;
    recommendedRoleSplit = "精简并发、小步快跑：非关键任务降档省流，关键架构与核心代码再上高推理档。";
  }

  return {
    google,
    chatgpt: {
      ...chatgptBase,
      configuredTier: configuredChatGpt,
      detectedTier: quota.detectedPlan,
      rawPlanType: quota.rawPlanType,
      quota,
    },
    pairingTitle,
    pairingAdvice,
    recommendedRoleSplit,
  };
}
