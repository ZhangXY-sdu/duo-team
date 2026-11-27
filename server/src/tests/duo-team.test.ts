import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TeamLedger } from "../ledger/store.js";
import { buildProjectTree, buildSmartProjectMap } from "../ledger/workspace.js";
import { CodexAppServerBridge } from "../codex/client.js";
import { analyzeSchedule, detectCycles } from "../scheduler/engine.js";
import { createDuoTeamServer } from "../index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("TeamLedger: project init, DAG dependencies, memory, messages, model locks, and verification", () => {
  const dataDir = makeTmpDir("duo-data-");
  const projDir = makeTmpDir("duo-proj-");
  const ledger = new TeamLedger(dataDir);

  try {
    // Global model lock works even before project creation
    ledger.updateGlobalSettings({
      defaultCodexModel: "gpt-5.6-sol",
      defaultCodexEffort: "xhigh",
      lockCodexModel: true,
      roleModels: {
        reviewer: { model: "gpt-6-astra", effort: "max" },
      },
    });
    const resolvedGlobal = ledger.resolveCodexConfig({
      role: "Codex Coder",
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "low",
    });
    assert.equal(resolvedGlobal.model, "gpt-5.6-sol");
    assert.equal(resolvedGlobal.effort, "xhigh");
    assert.equal(resolvedGlobal.enforcedByUserLock, true);
    assert.equal(resolvedGlobal.language, "zh-CN");
    assert.equal(resolvedGlobal.maxParallelCodex, 4);

    ledger.updateGlobalSettings({ maxParallelCodex: 6, language: "zh-CN" });
    assert.equal(ledger.getGlobalSettings().maxParallelCodex, 6);

    const resolvedReviewer = ledger.resolveCodexConfig({
      role: "Independent Reviewer",
      requestedModel: "gpt-5.6-luna",
    });
    assert.equal(resolvedReviewer.model, "gpt-6-astra");
    assert.equal(resolvedReviewer.effort, "max");
    assert.equal(resolvedReviewer.roleKey, "reviewer");

    const project = ledger.ensureProject(projDir, {
      name: "Econometrics Paper",
      mode: "debate",
    });
    assert.equal(project.defaultCodexModel, "gpt-5.6-sol");
    assert.equal(project.defaultCodexEffort, "xhigh");
    assert.equal(project.lockCodexModel, true);
    assert.ok(fs.existsSync(path.join(projDir, ".duo-team", "memory.md")));

    // Unlock allows caller override
    ledger.updateProject(project.id, { lockCodexModel: false });
    const unlocked = ledger.resolveCodexConfig({
      projectId: project.id,
      role: "Executor",
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "medium",
    });
    assert.equal(unlocked.model, "gpt-5.6-luna");
    assert.equal(unlocked.effort, "medium");
    assert.equal(unlocked.enforcedByUserLock, false);

    // Memory append
    const mem = ledger.writeMemory(project.id, "## Confirmed\n- Panel FE clustered at firm level.", "append");
    assert.match(mem.content, /Panel FE clustered at firm level/);

    // Task DAG readiness
    const t1 = ledger.createTask(project.id, {
      id: "T1",
      title: "Clean data",
      owner: "codex",
      reviewer: "gemini",
      artifacts: ["output.json"],
      verifyCommand: `node -e "const d = JSON.parse(require('fs').readFileSync('output.json','utf8')); if (d.n !== 100) process.exit(1);"`,
    });
    const t2 = ledger.createTask(project.id, {
      id: "T2",
      title: "Run regressions",
      owner: "codex",
      reviewer: "gemini",
      dependsOn: ["T1"],
    });

    assert.equal(t1.ready, true);
    assert.equal(t2.ready, false);

    const vFail = ledger.runVerification(project.id, "T1");
    assert.equal(vFail.passed, false);

    fs.writeFileSync(path.join(projDir, "output.json"), JSON.stringify({ n: 100, source: "public" }), "utf8");
    const vPass = ledger.runVerification(project.id, "T1");
    assert.equal(vPass.passed, true);
    assert.equal(vPass.exitCode, 0);

    ledger.updateTask(project.id, "T1", { status: "done" });
    assert.equal(ledger.getTask(project.id, "T2")!.ready, true);

    ledger.postMessage(project.id, {
      taskId: "T2",
      fromAgent: "Gemini (Pro)",
      toAgent: "Codex (Con)",
      kind: "proposal",
      round: 1,
      side: "pro",
      content: "Use staggered DID with Callaway-Sant'Anna estimator.",
    });
    ledger.postMessage(project.id, {
      taskId: "T2",
      fromAgent: "Codex (Con)",
      toAgent: "Gemini (Pro)",
      kind: "rebuttal",
      round: 1,
      side: "con",
      content: "Pre-trends test fails in period t-2; consider synthetic control.",
    });

    const msgs = ledger.listMessages(project.id, { taskId: "T2" });
    assert.equal(msgs.length, 2);

    // Intelligent Scheduler: DAG waves, critical path, cycle detection, stall watchdog, adaptive routing
    const t3 = ledger.createTask(project.id, {
      id: "T3",
      title: "独立架构审稿与因果识别验证",
      owner: "codex",
      dependsOn: ["T2"],
    });
    assert.equal(t3.ready, false);

    const analysis = analyzeSchedule({
      project: ledger.getProject(project.id),
      globalSettings: ledger.getGlobalSettings(),
      tasks: ledger.listTasks(project.id),
      activeThreads: [
        {
          threadId: "thr_stalled",
          projectId: null,
          role: "Stalled Worker",
          taskId: "T2",
          cwd: projDir,
          model: "gpt-6.2-sol",
          effort: "xhigh",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          status: "running",
          activeTurnId: "turn_1",
          lastTurnStatus: null,
          lastError: null,
          reasoningSummary: "",
          latestOutput: "",
          plan: [],
          subAgents: [],
          activities: [],
          pendingApprovals: [],
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ],
      availableModels: [{ id: "gpt-6.2-sol" }, { id: "gpt-6-luna" }],
      quotaRemainingPercent: 10,
    });

    assert.equal(analysis.cycles.length, 0);
    assert.equal(analysis.waves.length, 3);
    assert.deepEqual(analysis.criticalPath, ["T1", "T2", "T3"]);
    assert.deepEqual(analysis.stalledThreadIds, ["thr_stalled"]);
    assert.ok(analysis.alerts.some((a) => a.code === "stalled_thread"));
    assert.ok(analysis.alerts.some((a) => a.code === "low_quota"));

    // Cycle detection test
    ledger.updateTask(project.id, "T1", { dependsOn: ["T3"] });
    const cycs = detectCycles(ledger.listTasks(project.id));
    assert.ok(cycs.length >= 1);

    // Structured FTS5 memory, Chinese/English search, pinned files, project tree & smart outline map
    const m1 = ledger.addMemoryItem(project.id, {
      category: "decision",
      title: "识别策略采用交错 DID",
      content: "使用 Callaway-Sant'Anna 估计量并按企业层面聚类标准误",
      tags: ["DID", "计量"],
      pinned: true,
      sourceAgent: "Gemini",
    });
    ledger.addMemoryItem(project.id, {
      category: "pitfall",
      title: "避免按年份简单去重导致样本丢失",
      content: "原始面板包含季度高频观测，误用 drop_duplicates(subset=['id']) 会丢掉 75% 样本",
      tags: ["数据清洗"],
      pinned: false,
      sourceAgent: "Codex",
    });
    const zhHits = ledger.searchMemoryItems(project.id, { query: "聚类标准误" });
    assert.equal(zhHits.length, 1);
    assert.equal(zhHits[0].id, m1.id);

    const pitfallHits = ledger.searchMemoryItems(project.id, { category: "pitfall" });
    assert.equal(pitfallHits.length, 1);

    const pinned = ledger.setPinnedFile(project.id, "output.json", true, "基准样本核对结果");
    assert.equal(pinned.length, 1);
    assert.match(ledger.readMemory(project.id).content, /识别策略采用交错 DID/);
    assert.match(ledger.readMemory(project.id).content, /output\.json/);

    fs.writeFileSync(path.join(projDir, "analysis.py"), "def run_did_model(df):\n    return df\n", "utf8");
    const treeRes = buildProjectTree(projDir);
    assert.ok(treeRes.totalFiles >= 2);
    const smartMap = buildSmartProjectMap(projDir);
    assert.match(smartMap.outline, /run_did_model/);
  } finally {
    ledger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test("CodexAppServerBridge: initialize, spawn, stream, steer, approval, and resume against mock app-server", async () => {
  const tmpDir = makeTmpDir("duo-mock-");
  const mockScript = path.join(tmpDir, "fake-codex.mjs");
  fs.writeFileSync(
    mockScript,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let turnSeq = 1;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let pendingApprovalTurn = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === 9001 && msg.result) {
    const { threadId, turnId } = pendingApprovalTurn;
    send({ method: "item/agentMessage/delta", params: { threadId, delta: "Approved with " + msg.result.decision } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    return;
  }
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake-codex/0.154.0" } });
  if (msg.method === "account/read") return send({ id: msg.id, result: { account: { type: "chatgpt", planType: "pro" } } });
  if (msg.method === "account/rateLimits/read") return send({ id: msg.id, result: { ordinaryUsageAllowed: true, rateLimits: { planType: "pro" } } });
  if (msg.method === "model/list") return send({ id: msg.id, result: { data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }] } });
  if (msg.method === "thread/start") {
    return send({ id: msg.id, result: { thread: { id: "thr_test_1" }, model: msg.params.model || "gpt-5.6-sol", cwd: msg.params.cwd, reasoningEffort: "high" } });
  }
  if (msg.method === "thread/resume") {
    return send({ id: msg.id, result: { thread: { id: msg.params.threadId }, model: "gpt-5.6-sol", cwd: msg.params.cwd } });
  }
  if (msg.method === "turn/start") {
    const tid = msg.params.threadId;
    const turnId = "turn_" + (turnSeq++);
    const text = msg.params.input?.[0]?.text || "";
    send({ id: msg.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: tid, turn: { id: turnId } } });
    if (text.includes("NEED_APPROVAL")) {
      pendingApprovalTurn = { threadId: tid, turnId };
      send({
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: { threadId: tid, turnId, itemId: "cmd_1", command: "rm -rf /tmp/test-cache" }
      });
    } else if (text.includes("LONG_RUN")) {
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId: tid, delta: "Working..." } });
    } else {
      send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "Echo: " + text } });
      send({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, status: "completed", items: [] } } });
    }
    return;
  }
  if (msg.method === "turn/steer") {
    const tid = msg.params.threadId;
    const steerText = msg.params.input?.[0]?.text || "";
    send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
    send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "Steered: " + steerText } });
    send({ method: "turn/completed", params: { threadId: tid, turn: { id: msg.params.expectedTurnId, status: "completed", items: [] } } });
    return;
  }
});
`,
    "utf8"
  );

  const bridge = new CodexAppServerBridge({
    command: process.execPath,
    args: [mockScript],
    rpcTimeoutMs: 5000,
  });

  try {
    const status = await bridge.getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.models.length, 1);

    const s1 = await bridge.spawnTask({ prompt: "Hello Codex", cwd: tmpDir, role: "Tester" });
    assert.equal(s1.status, "completed");
    assert.equal(s1.latestOutput, "Echo: Hello Codex");

    const s2 = await bridge.sendMessage(s1.threadId, { text: "LONG_RUN", async: true });
    assert.equal(s2.status, "running");
    await bridge.sendMessage(s1.threadId, { text: "Focus on unit tests", steerIfRunning: true });
    const [afterSteer] = await bridge.waitForThreads([s1.threadId], 3000);
    assert.equal(afterSteer.status, "completed");
    assert.equal(afterSteer.latestOutput, "Steered: Focus on unit tests");

    const s3 = await bridge.sendMessage(s1.threadId, { text: "NEED_APPROVAL", waitMs: 3000 });
    assert.equal(s3.status, "waiting_approval");
    assert.equal(s3.pendingApprovals.length, 1);
    const resolved = await bridge.resolveApproval(s3.pendingApprovals[0].id, "accept");
    assert.equal(resolved.ok, true);
    const [afterApprove] = await bridge.waitForThreads([s1.threadId], 3000);
    assert.equal(afterApprove.status, "completed");
    assert.equal(afterApprove.latestOutput, "Approved with accept");
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP Server E2E: project init, FTS5 memory, project map, batch spawn, self-heal, and workbench", async () => {
  const dataDir = makeTmpDir("duo-e2e-data-");
  const projDir = makeTmpDir("duo-e2e-proj-");
  const mockScript = path.join(dataDir, "fake-codex-e2e.mjs");
  fs.writeFileSync(path.join(projDir, "main.py"), "def compute_panel(x):\n    return x * 2\n", "utf8");
  fs.writeFileSync(
    mockScript,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let seq = 1;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake-codex/0.172.0" } });
  if (msg.method === "account/read") return send({ id: msg.id, result: { account: { type: "chatgpt", planType: "prolite" } } });
  if (msg.method === "account/rateLimits/read") return send({ id: msg.id, result: { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080 } } } });
  if (msg.method === "model/list") return send({ id: msg.id, result: { data: [{ id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol" }], nextCursor: null } });
  if (msg.method === "thread/start") {
    const id = "thr_e2e_" + (seq++);
    return send({ id: msg.id, result: { thread: { id }, model: msg.params.model || "gpt-6.2-sol", cwd: msg.params.cwd, reasoningEffort: "xhigh" } });
  }
  if (msg.method === "turn/start") {
    const tid = msg.params.threadId;
    const turnId = "turn_" + (seq++);
    send({ id: msg.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: tid, turn: { id: turnId } } });
    send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "已完成中文协作任务。" } });
    send({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, status: "completed", items: [] } } });
  }
});
`,
    "utf8"
  );

  const bridge = new CodexAppServerBridge({ command: process.execPath, args: [mockScript], rpcTimeoutMs: 5000 });
  const { server, ledger } = createDuoTeamServer({ dataDir, bridge });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 25);

    // 1. Project init & map
    await client.callTool({ name: "team_project_init", arguments: { rootPath: projDir, name: "E2E Research" } });
    const mapRes = await client.callTool({ name: "team_project_map", arguments: { project: projDir } });
    assert.match(String((mapRes.content as Array<{ text: string }>)[0].text), /compute_panel/);

    // 2. Structured memory add & search
    await client.callTool({
      name: "team_memory_add",
      arguments: {
        project: projDir,
        category: "pitfall",
        title: "缺失值处理陷阱",
        content: "不得用 0 填补缺失的财务营收字段",
        pinned: true,
      },
    });
    const memSearch = await client.callTool({
      name: "team_memory_search",
      arguments: { project: projDir, query: "财务营收" },
    });
    assert.equal((memSearch.structuredContent as { count: number }).count, 1);

    // 3. Batch spawn 2 Codex subagents in parallel
    const batchRes = await client.callTool({
      name: "codex_spawn_batch",
      arguments: {
        project: projDir,
        waitAll: true,
        agents: [
          { role: "正方辩手", prompt: "论证方案 A", sandbox: "read-only" },
          { role: "反方辩手", prompt: "质疑方案 A", sandbox: "read-only" },
        ],
      },
    });
    assert.equal((batchRes.structuredContent as { count: number }).count, 2);

    // 4. Create task with failing verifyCommand -> self-heal increments rework
    await client.callTool({
      name: "team_task_upsert",
      arguments: {
        project: projDir,
        taskId: "T-HEAL",
        title: "生成结果表",
        owner: "codex",
        artifacts: ["table1.csv"],
        verifyCommand: "node -e 'process.exit(1)'",
      },
    });
    const healRes = await client.callTool({
      name: "team_self_heal",
      arguments: { project: projDir, taskId: "T-HEAL" },
    });
    assert.equal((healRes.structuredContent as { action: string }).action, "self_healing");

    // 5. Open workbench returns full dashboard payload
    const wbRes = await client.callTool({ name: "open_workbench", arguments: { project: projDir } });
    const wbData = wbRes.structuredContent as { tasks: unknown[]; memoryItems: unknown[]; schedule: { totalTasks: number } };
    assert.equal(wbData.tasks.length, 1);
    assert.equal(wbData.memoryItems.length, 1);
    assert.equal(wbData.schedule.totalTasks, 1);
  } finally {
    await client.close();
    await bridge.close();
    ledger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
