import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CodexAppServerBridge } from "../codex/client.js";
import { createDuoTeamServer } from "../index.js";

function createMockCodexScript(dir: string): string {
  const scriptPath = path.join(dir, "mock-codex-iso.mjs");
  const script = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadSeq = 0;
let turnSeq = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "mock-codex-iso/0.172.0" } });
    return;
  }
  if (msg.method === "account/read") {
    send({ id: msg.id, result: { account: { type: "chatgpt", planType: "pro" } } });
    return;
  }
  if (msg.method === "account/rateLimits/read") {
    send({ id: msg.id, result: { ordinaryUsageAllowed: true, rateLimits: { planType: "pro", primary: { usedPercent: 10, windowDurationMins: 10080 } } } });
    return;
  }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] } });
    return;
  }
  if (msg.method === "thread/start") {
    const tid = "thr-iso-" + (++threadSeq);
    send({ id: msg.id, result: { thread: { id: tid }, model: msg.params?.model || "gpt-6.2-sol", cwd: msg.params?.cwd } });
    return;
  }
  if (msg.method === "turn/start") {
    const turnId = "turn-iso-" + (++turnSeq);
    const tid = msg.params.threadId;
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: tid, turn: { id: turnId } } });
      send({ method: "item/agentMessage/delta", params: { threadId: tid, delta: "已完成任务：" + tid } });
      send({ method: "turn/completed", params: { threadId: tid, turn: { id: turnId, status: "completed" } } });
    }, 15);
    return;
  }
  if (msg.method === "turn/steer") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

test("Strict Project Isolation: same-folder multi-projects, cwd auto-create, reject omitted project, and thread/broadcast scoping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-team-iso-"));
  const sharedDir = path.join(dir, "shared-workspace");
  const qwenDir = path.join(dir, "qwen-experiment");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(qwenDir, { recursive: true });

  const mockScript = createMockCodexScript(dir);
  const bridge = new CodexAppServerBridge({
    command: process.execPath,
    args: [mockScript],
    rpcTimeoutMs: 5000,
  });
  const duo = createDuoTeamServer({ dataDir: path.join(dir, "data"), bridge });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "iso-test", version: "0.4.0" }, { capabilities: {} });

  try {
    await Promise.all([duo.server.connect(serverTransport), client.connect(clientTransport)]);

    // 1. Create TWO completely isolated projects inside the EXACT SAME folder!
    const pResearchRes = await client.callTool({
      name: "team_project_init",
      arguments: { rootPath: sharedDir, name: "实证研究" },
    });
    const pResearch = (pResearchRes.structuredContent as { project: { id: string; storageDir: string | null } }).project;

    const pPptRes = await client.callTool({
      name: "team_project_init",
      arguments: { rootPath: sharedDir, name: "提案大赛 PPT" },
    });
    const pPpt = (pPptRes.structuredContent as { project: { id: string; storageDir: string | null } }).project;

    assert.notEqual(pResearch.id, pPpt.id, "Different topic names in same folder must create separate projects");
    assert.ok(pPpt.storageDir && pPpt.storageDir.includes(pPpt.id), "Second project in same folder gets isolated storageDir");

    // 2. Writing WITHOUT project when >1 projects exist must FAIL strictly (no silent leak to projects[0])
    const omittedErr = await client.callTool({
      name: "team_task_upsert",
      arguments: { title: "未指定项目的任务" },
    });
    assert.equal(omittedErr.isError, true, "Must refuse omitted project when multiple projects exist");

    // 3. Tasks & memories in Research vs PPT stay 100% isolated
    await client.callTool({
      name: "team_task_upsert",
      arguments: { project: pResearch.id, taskId: "R-1", title: "跑 DID 回归" },
    });
    await client.callTool({
      name: "team_task_upsert",
      arguments: { project: pPpt.id, taskId: "P-1", title: "制作提案大赛 PPT 封面" },
    });

    const boardResearch = (await client.callTool({ name: "team_board_read", arguments: { project: pResearch.id } }))
      .structuredContent as { tasks: Array<{ id: string }> };
    const boardPpt = (await client.callTool({ name: "team_board_read", arguments: { project: pPpt.id } }))
      .structuredContent as { tasks: Array<{ id: string }> };

    assert.deepEqual(boardResearch.tasks.map((t) => t.id), ["R-1"]);
    assert.deepEqual(boardPpt.tasks.map((t) => t.id), ["P-1"]);

    // 4. Spawning Codex with a brand-new folder cwd (qwenDir) WITHOUT calling team_project_init first auto-creates an isolated project!
    const qwenSpawn = await client.callTool({
      name: "codex_spawn",
      arguments: {
        cwd: qwenDir,
        role: "Qwen 评测",
        prompt: "评测 Qwen 模型",
        async: false,
      },
    });
    const qwenThread = qwenSpawn.structuredContent as { threadId: string; projectId: string | null };
    assert.ok(qwenThread.projectId, "codex_spawn with new cwd must auto-create and attach projectId");
    assert.notEqual(qwenThread.projectId, pResearch.id);
    assert.notEqual(qwenThread.projectId, pPpt.id);

    // Also spawn a thread inside pPpt
    const pptSpawn = await client.callTool({
      name: "codex_spawn",
      arguments: {
        project: pPpt.id,
        role: "PPT 设计师",
        prompt: "生成大纲",
        async: false,
      },
    });
    const pptThread = pptSpawn.structuredContent as { threadId: string; projectId: string | null };
    assert.equal(pptThread.projectId, pPpt.id);

    // 5. Dashboard for pPpt ONLY shows pPpt's threads; qwen thread appears strictly in otherProjectsThreads!
    const dashPpt = (
      await client.callTool({ name: "ui_dashboard_state", arguments: { project: pPpt.id, includeCodexStatus: false } })
    ).structuredContent as {
      codex: {
        activeThreads: Array<{ threadId: string }>;
        otherProjectsThreads: Array<{ threadId: string; projectId: string | null }>;
      };
    };

    assert.deepEqual(dashPpt.codex.activeThreads.map((t) => t.threadId), [pptThread.threadId]);
    assert.equal(dashPpt.codex.otherProjectsThreads.length, 1);
    assert.equal(dashPpt.codex.otherProjectsThreads[0].threadId, qwenThread.threadId);

    // 6. Project-scoped broadcast ONLY hits pPpt's thread, NEVER qwen's thread!
    const bcast = (
      await client.callTool({
        name: "codex_broadcast",
        arguments: { action: "message", project: pPpt.id, text: "仅限 PPT 项目调整配色" },
      })
    ).structuredContent as { deliveries: Array<{ threadId: string }> };
    assert.deepEqual(bcast.deliveries.map((d) => d.threadId), [pptThread.threadId]);
  } finally {
    await client.close().catch(() => undefined);
    await duo.bridge.close();
    duo.ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
