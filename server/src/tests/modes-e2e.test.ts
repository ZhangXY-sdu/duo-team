import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CodexAppServerBridge } from "../codex/client.js";
import { createDuoTeamServer } from "../index.js";

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeCodexScript(dir: string): string {
  const script = path.join(dir, "fake-codex-modes.mjs");
  fs.writeFileSync(
    script,
    `
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
const rl = readline.createInterface({ input: process.stdin });
let seq = 1;
const threadCwds = new Map();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake-codex/0.172.0" } });
  if (msg.method === "account/read") return send({ id: msg.id, result: { account: { type: "chatgpt", planType: "prolite" } } });
  if (msg.method === "account/rateLimits/read") return send({ id: msg.id, result: { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 25, windowDurationMins: 10080 } } } });
  if (msg.method === "model/list") {
    return send({
      id: msg.id,
      result: {
        data: [
          { id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }] },
          { id: "gpt-6.2-astra", displayName: "GPT-6.2-Astra", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
        ],
        nextCursor: null,
      },
    });
  }
  if (msg.method === "thread/start") {
    const id = "thr_mode_" + (seq++);
    threadCwds.set(id, msg.params.cwd);
    const hasChineseRule = typeof msg.params.developerInstructions === "string" && msg.params.developerInstructions.includes("简体中文");
    return send({ id: msg.id, result: { thread: { id }, model: msg.params.model || "gpt-6.2-sol", cwd: msg.params.cwd, reasoningEffort: hasChineseRule ? "xhigh" : "low" } });
  }
  if (msg.method === "thread/resume") {
    return send({ id: msg.id, result: { thread: { id: msg.params.threadId }, model: "gpt-6.2-sol", cwd: msg.params.cwd } });
  }
  if (msg.method === "turn/start") {
    const tid = msg.params.threadId;
    const turnId = "turn_" + (seq++);
    const text = msg.params.input?.[0]?.text || "";
    const cwd = msg.params.cwd || threadCwds.get(tid);
    send({ id: msg.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: tid, turn: { id: turnId } } });

    // Simulate producing real deliverable when requested in self-heal / auto-dispatch
    if (cwd && text.includes("自愈修复")) {
      fs.writeFileSync(path.join(cwd, "verified_result.json"), JSON.stringify({ ok: true, n: 200 }), "utf8");
    } else if (cwd && text.includes("WRITE_BRANCH_B")) {
      fs.mkdirSync(path.join(cwd, ".duo-team", "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".duo-team", "artifacts", "branch-codex.md"), "# 分支 B 独立分析\\n结论：效应显著。", "utf8");
    }

    const reply = text.includes("反驳")
      ? "【第2轮反驳】同意样本聚类口径，但仍坚持需要安慰剂检验。"
      : text.includes("挑刺")
        ? "【计划评审】建议补充平行趋势检验作为前置验收条件。"
        : "【中文执行回复】已完成指派任务：" + text.slice(0, 60);

    send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: reply } });
    send({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, status: "completed", items: [] } } });
  }
});
`,
    "utf8"
  );
  return script;
}

async function withServer(fn: (ctx: { client: Client; projDir: string }) => Promise<void>) {
  const dataDir = makeTmpDir("duo-modes-data-");
  const projDir = makeTmpDir("duo-modes-proj-");
  const script = createFakeCodexScript(dataDir);
  const bridge = new CodexAppServerBridge({ command: process.execPath, args: [script], rpcTimeoutMs: 5000 });
  const { server, ledger } = createDuoTeamServer({ dataDir, bridge });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "modes-e2e", version: "1.0.0" });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    await fn({ client, projDir });
  } finally {
    await client.close();
    await bridge.close();
    ledger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
}

test("Mode 1 (plan_execute + Role Swap): Plan challenge -> Auto-dispatch -> Self-heal pass", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M1-Plan", mode: "plan_execute" } });

    // Gemini drafts plan & Codex challenges it (or vice versa for role swap)
    const challenge = await client.callTool({
      name: "codex_spawn",
      arguments: { project: projDir, role: "计划挑刺评审", prompt: "请对以下计量设计计划挑刺", sandbox: "read-only" },
    });
    const chOut = (challenge.structuredContent as { latestOutput: string }).latestOutput;
    assert.match(chOut, /计划评审/);

    await client.callTool({
      name: "team_task_upsert",
      arguments: {
        project: projDir,
        taskId: "P1",
        title: "产出验证表",
        owner: "codex",
        reviewer: "gemini",
        artifacts: ["verified_result.json"],
        verifyCommand: `node -e "const d=JSON.parse(require('fs').readFileSync('verified_result.json','utf8')); if(!d.ok) process.exit(1)"`,
      },
    });

    // Dispatch wave -> initial verify fails -> self-heal automatically fixes artifact -> second verify passes
    const disp = await client.callTool({ name: "team_auto_dispatch", arguments: { project: projDir } });
    const dispatched = (disp.structuredContent as { dispatched: Array<{ threadId: string }> }).dispatched;
    assert.equal(dispatched.length, 1);
    await client.callTool({ name: "codex_wait", arguments: { threadIds: [dispatched[0].threadId], timeoutMs: 3000 } });

    const heal1 = await client.callTool({ name: "team_self_heal", arguments: { project: projDir, taskId: "P1" } });
    assert.equal((heal1.structuredContent as { action: string }).action, "self_healing");
    await client.callTool({ name: "codex_wait", arguments: { threadIds: [dispatched[0].threadId], timeoutMs: 3000 } });

    const heal2 = await client.callTool({ name: "team_self_heal", arguments: { project: projDir, taskId: "P1" } });
    assert.equal((heal2.structuredContent as { action: string }).action, "passed");
  });
});

test("Mode 2 (co_create): Shared memory + mixed Gemini/Codex task ownership + cross review", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M2-CoCreate", mode: "co_create" } });
    await client.callTool({
      name: "team_memory_add",
      arguments: { project: projDir, category: "decision", title: "分工口径", content: "Gemini负责文献与理论，Codex负责计量脚本", pinned: true },
    });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "C1", title: "文献综述", owner: "gemini", reviewer: "codex" } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "C2", title: "数据清洗脚本", owner: "codex", reviewer: "gemini" } });

    const plan = await client.callTool({ name: "team_schedule_plan", arguments: { project: projDir } });
    const recs = (plan.structuredContent as { recommendations: Array<{ taskId: string; owner: string }> }).recommendations;
    assert.equal(recs.length, 2);
    assert.ok(recs.some((r) => r.taskId === "C1" && r.owner === "gemini"));
    assert.ok(recs.some((r) => r.taskId === "C2" && r.owner === "codex"));
  });
});

test("Mode 3 (parallel_research): Blind isolated branches + side-by-side comparison messages", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M3-Parallel", mode: "parallel_research" } });

    // Branch A (Gemini) + Branch B (Codex) isolated outputs
    fs.mkdirSync(path.join(projDir, ".duo-team", "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".duo-team", "artifacts", "branch-gemini.md"), "# 分支 A 独立分析\n结论：需控制行业趋势。", "utf8");
    await client.callTool({
      name: "codex_spawn",
      arguments: { project: projDir, role: "独立分支 B", prompt: "WRITE_BRANCH_B 请独立分析", sandbox: "workspace-write" },
    });

    assert.ok(fs.existsSync(path.join(projDir, ".duo-team", "artifacts", "branch-codex.md")));

    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Gemini (分支 A)", toAgent: "Team", kind: "proposal", round: 1, side: "branch_a", content: "分支 A 结论" },
    });
    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Codex (分支 B)", toAgent: "Team", kind: "proposal", round: 1, side: "branch_b", content: "分支 B 结论" },
    });

    const board = await client.callTool({ name: "team_board_read", arguments: { project: projDir } });
    const msgs = (board.structuredContent as { messages: Array<{ side: string | null }> }).messages;
    assert.ok(msgs.some((m) => m.side === "branch_a"));
    assert.ok(msgs.some((m) => m.side === "branch_b"));
  });
});

test("Mode 4 (debate): Blind openings -> Round 2 stateful rebuttal -> Verdict", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M4-Debate", mode: "debate" } });

    const conR1 = await client.callTool({
      name: "codex_spawn",
      arguments: { project: projDir, role: "反方辩手", prompt: "围绕政策外生性提交第1轮立论", sandbox: "read-only" },
    });
    const conThreadId = (conR1.structuredContent as { threadId: string }).threadId;

    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Gemini (正方)", toAgent: "Codex (反方)", kind: "proposal", round: 1, side: "pro", content: "正方第1轮立论" },
    });
    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Codex (反方)", toAgent: "Gemini (正方)", kind: "proposal", round: 1, side: "con", content: "反方第1轮立论" },
    });

    // Round 2 rebuttal on SAME Codex thread preserving context
    const conR2 = await client.callTool({
      name: "codex_message",
      arguments: { threadId: conThreadId, text: "请针对正方立论提交第2轮反驳" },
    });
    const r2Text = (conR2.structuredContent as { latestOutput: string }).latestOutput;
    assert.match(r2Text, /第2轮反驳/);

    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Codex (反方)", toAgent: "Gemini (正方)", kind: "rebuttal", round: 2, side: "con", content: r2Text },
    });
    await client.callTool({
      name: "team_message_post",
      arguments: { project: projDir, fromAgent: "Gemini (裁决)", toAgent: "Human", kind: "verdict", round: 2, content: "综合证据裁决：保留安慰剂检验要求。" },
    });

    const board = await client.callTool({ name: "team_board_read", arguments: { project: projDir } });
    const msgs = (board.structuredContent as { messages: Array<{ kind: string; round: number }> }).messages;
    assert.equal(msgs.length, 4);
    assert.equal(msgs[3].kind, "verdict");
  });
});

test("Mode 5 (autonomous_team): Multi-wave DAG + batch parallel dispatch + broadcast", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M5-AutoTeam", mode: "autonomous_team" } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "A1", title: "数据模块 A", owner: "codex" } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "A2", title: "数据模块 B", owner: "codex" } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "A3", title: "汇总建模", owner: "codex", dependsOn: ["A1", "A2"] } });

    // Wave 1 should dispatch A1 and A2 concurrently, NOT A3
    const disp1 = await client.callTool({ name: "team_auto_dispatch", arguments: { project: projDir, useWorktreeForGit: false } });
    const d1 = (disp1.structuredContent as { dispatched: Array<{ taskId: string; threadId: string }> }).dispatched;
    assert.deepEqual(d1.map((x) => x.taskId).sort(), ["A1", "A2"]);

    await client.callTool({ name: "codex_wait", arguments: { threadIds: d1.map((x) => x.threadId), timeoutMs: 3000 } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "A1", status: "done" } });
    await client.callTool({ name: "team_task_upsert", arguments: { project: projDir, taskId: "A2", status: "done" } });

    // Wave 2 now unlocks A3 automatically
    const disp2 = await client.callTool({ name: "team_auto_dispatch", arguments: { project: projDir, useWorktreeForGit: false } });
    const d2 = (disp2.structuredContent as { dispatched: Array<{ taskId: string }> }).dispatched;
    assert.deepEqual(d2.map((x) => x.taskId), ["A3"]);
  });
});

test("Mode 6 (custom): Save, list, apply custom workflow preset -> DAG instantiated & scheduled", async () => {
  await withServer(async ({ client, projDir }) => {
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "M6-Custom", mode: "custom" } });

    await client.callTool({
      name: "team_workflow_preset",
      arguments: {
        project: projDir,
        action: "save",
        presetId: "econ-paper",
        name: "计量实证论文标准流",
        description: "识别设计 -> 清洗回归 -> 独立审稿",
        maxReworks: 2,
        stages: [
          { id: "S1", title: "研究设计与识别策略", owner: "gemini", reviewer: "codex" },
          { id: "S2", title: "Python/Stata 清洗与基准回归", owner: "codex", reviewer: "gemini", dependsOn: ["S1"] },
          { id: "S3", title: "稳健性复核与论文撰写", owner: "gemini", reviewer: "codex", dependsOn: ["S2"] },
        ],
      },
    });

    const listed = await client.callTool({ name: "team_workflow_preset", arguments: { project: projDir, action: "list" } });
    assert.equal((listed.structuredContent as { count: number }).count, 1);

    const applied = await client.callTool({
      name: "team_workflow_preset",
      arguments: { project: projDir, action: "apply", presetId: "econ-paper" },
    });
    const created = (applied.structuredContent as { createdTasks: Array<{ id: string }> }).createdTasks;
    assert.equal(created.length, 3);

    const plan = await client.callTool({ name: "team_schedule_plan", arguments: { project: projDir } });
    const sc = plan.structuredContent as { waves: unknown[]; criticalPath: string[] };
    assert.equal(sc.waves.length, 3);
    assert.deepEqual(sc.criticalPath, ["S1", "S2", "S3"]);
  });
});
