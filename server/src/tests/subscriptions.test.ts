import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TeamLedger } from "../ledger/store.js";
import { analyzeSchedule } from "../scheduler/engine.js";
import {
  clampEffortToModel,
  extractRateLimitSummary,
  normalizeChatGptPlanString,
  resolveSubscriptionProfile,
} from "../scheduler/subscriptions.js";

test("Subscription detection: recognizes Plus, Pro, Team, Edu, Enterprise, Go and dual rate-limit windows", () => {
  assert.equal(normalizeChatGptPlanString("plus"), "plus");
  assert.equal(normalizeChatGptPlanString("chatgpt_pro"), "pro");
  assert.equal(normalizeChatGptPlanString("Business"), "team");
  assert.equal(normalizeChatGptPlanString("edu"), "edu");
  assert.equal(normalizeChatGptPlanString("enterprise"), "enterprise");
  assert.equal(normalizeChatGptPlanString("go"), "go");

  // ChatGPT Plus dual-window scenario: 5h primary window has 80% left, but 7d secondary window has only 18% left
  const summary = extractRateLimitSummary(
    { account: { planType: "plus" } },
    {
      ordinaryUsageAllowed: true,
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 82, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
      },
    }
  );

  assert.equal(summary.detectedPlan, "plus");
  assert.equal(summary.primary?.remainingPercent, 80);
  assert.equal(summary.primary?.windowLabel, "5 小时周期");
  assert.equal(summary.secondary?.remainingPercent, 18);
  assert.equal(summary.secondary?.windowLabel, "7 天周期");
  // Tighter window governs effective remaining quota
  assert.equal(summary.effectiveRemainingPercent, 18);
});

test("Subscription pairing & effort clamping: Google AI Ultra + ChatGPT Plus adapts concurrency, ceiling, and low-quota alert", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-team-sub-"));
  const ws = path.join(dir, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  const ledger = new TeamLedger(path.join(dir, "data"));

  try {
    const updated = ledger.updateGlobalSettings({
      googlePlan: "ultra",
      chatgptPlan: "auto",
      lockCodexModel: false,
      maxParallelCodex: 2,
    });
    assert.equal(updated.googlePlan, "ultra");
    assert.equal(updated.chatgptPlan, "auto");

    const proj = ledger.ensureProject(ws);
    ledger.updateProject(proj.id, { lockCodexModel: false });
    const tCrit = ledger.createTask(proj.id, {
      id: "T-ARCH",
      title: "核心系统架构与计量识别推导",
      owner: "codex",
      reviewer: "gemini",
    });
    const tSimple = ledger.createTask(proj.id, {
      id: "T-FMT",
      title: "简单格式化输出列表",
      owner: "codex",
      reviewer: "gemini",
    });

    const profile = resolveSubscriptionProfile({
      googlePlan: "ultra",
      chatgptPlan: "auto",
      account: { planType: "plus" },
      rateLimits: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 78, windowDurationMins: 300 }, // 22% remaining -> triggers Plus 25% threshold!
        },
      },
    });

    assert.equal(profile.google.tier, "ultra");
    assert.equal(profile.chatgpt.tier, "plus");
    assert.equal(profile.chatgpt.recommendedMaxParallel, 2);
    assert.equal(profile.chatgpt.lowQuotaThreshold, 25);
    assert.match(profile.pairingTitle, /AI Ultra × Plus/);

    // Verify effort clamping never exceeds model's supported list or tier ceiling
    assert.equal(clampEffortToModel("max", ["low", "medium", "high", "xhigh"], "high"), "high");
    assert.equal(clampEffortToModel("xhigh", ["low", "medium"], "max"), "medium");

    const schedule = analyzeSchedule({
      project: ledger.getProject(proj.id),
      globalSettings: ledger.getGlobalSettings(),
      tasks: [tCrit, tSimple],
      activeThreads: [],
      availableModels: [
        { id: "gpt-5.3-codex", efforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.3-codex-mini", efforts: ["low", "medium", "high"] },
      ],
      quotaRemainingPercent: profile.chatgpt.quota.effectiveRemainingPercent,
      subscriptionProfile: profile,
    });

    // 22% <= 25% triggers Plus low-quota warning (would NOT trigger Pro's 15% threshold)
    const quotaAlert = schedule.alerts.find((a) => a.code === "low_quota");
    assert.ok(quotaAlert, "ChatGPT Plus should trigger low_quota at 22% (<= 25%)");
    assert.match(quotaAlert!.title, /ChatGPT Plus/);

    const critRec = schedule.recommendations.find((r) => r.taskId === "T-ARCH");
    assert.equal(critRec?.recommendedEffort, "high", "ChatGPT Plus caps critical effort at high");

    const simpleRec = schedule.recommendations.find((r) => r.taskId === "T-FMT");
    assert.equal(simpleRec?.recommendedModel, "gpt-5.3-codex-mini");
    assert.equal(simpleRec?.recommendedEffort, "low");
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
