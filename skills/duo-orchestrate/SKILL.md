---
name: duo-orchestrate
description: >-
  Orchestrate autonomous multi-agent collaboration between Gemini (Antigravity)
  and GPT (OpenAI Codex CLI) across 6 working modes: Plan & Execute (with free
  role swapping), Co-Creation, Blind Parallel Research, Structured Debate,
  Autonomous Team, and Custom Workflows. Activate whenever the user wants
  Gemini and Codex/GPT to plan, divide work, debate, review, or autonomously
  deliver a project together.
---

# Duo-Team Multi-Agent Orchestration

You have direct access to the **Duo-Team MCP Bridge** (`duo-team_bridge`), which controls the user's real local OpenAI Codex CLI (`codex app-server`, supporting ChatGPT Plus / Pro / Team / Edu / Enterprise / Go subscriptions) alongside Antigravity's native Gemini capabilities (Google AI Free / Pro / Ultra / Workspace: `invoke_subagent`, `run_workflow`, `/swarm`, files, terminal, web search).

## Preflight (Always Do First)

1. **语言约定**：除非用户明确要求英文，所有跨模型消息（`team_message_post`）、给 Codex 的 prompt、任务说明、辩论和评审意见均**默认使用简体中文**。
2. Call `team_project_init` on the user's real workspace directory (never relocate their files), call `team_project_map` to instantly grasp the repository/research outline and user-pinned focus files, and call `team_memory_search` to load confirmed decisions and anti-loop pitfalls.
3. Call `codex_status` once at session start to verify Codex is connected, inspect the resolved `subscriptionProfile` (Google tier × auto-detected ChatGPT tier, primary & secondary rate-limit windows, and pairing advice), real available models/efforts, user model lock, and `maxParallelCodex`. Adapt delegation intensity to the pairing (e.g., on **Google AI Ultra + ChatGPT Plus**, let Gemini handle heavy synthesis/parallel subagents and conserve Codex Plus quota for core coding & critical cross-review).
4. After major decisions, bug resolutions, or methodology agreements, persist them via `team_memory_add` (`decision` / `pitfall` / `fact` / `convention`, setting `pinned: true` for core constraints) so both Gemini and Codex never repeat mistakes.
5. Optionally call `open_workbench` so the user can watch the live task board, project tree, memory, debate stream, and all running Codex subagents in the Antigravity side pane.

## Intelligent DAG Scheduling & Self-Healing (智能调度与自愈)

- **先诊断再调度**：执行多任务项目前，调用 `team_schedule_plan` 获取当前 DAG 拓扑波次（Wave 1 → Wave 2…）、关键路径、是否存在依赖死锁环、停滞线程看门狗告警，以及复杂度自适应模型路由建议。
- **一键波次并发发车**：调用 `team_auto_dispatch` 自动按并发上限拉起本波次所有就绪的 Codex 任务（自动附带 `.duo-team/memory.md` 与上游产物摘要，Git 仓库并行写入自动开独立 Worktree）。
- **验证与自动自愈返工**：任务产出后调用 `team_self_heal`，自动运行 `verifyCommand` 与产物校验；若失败且未超 `maxReworks`，系统自动将错误日志打回原 Codex 线程开启自愈修复，超限则自动转为 `awaiting_human` 交由用户决策。

## Multi-Subagent Parallel Execution (多开 Subagent 编队)

- **并发多开 GPT Subagents**：当任务可拆分多路（如多模块编程、多维度文献综述、双盲分支、正反辩论、多角度独立评审）时，直接使用 **`codex_spawn_batch`** 一次并发拉起多个 Codex Subagent（每个可指定独立 `role`、`prompt`、`sandbox`、`createWorktree`、`model`/`effort`），返回所有 `threadId` 后用 `codex_wait` 统一回收，或随时用 `codex_message` 单独给某一个子 Agent 插话纠偏、用 `codex_broadcast` 向全体活跃子 Agent 同步指令。
- **双平台混合编队**：可以同时调用 `codex_spawn_batch`（GPT 编队）与 Antigravity 原生 `invoke_subagent` / `run_workflow`（Gemini 编队），让两家模型的多个 Subagent 真正并行推进，并在工作台实时可视化监控。

## The 6 Collaboration Modes

### 1. Plan & Execute (`plan_execute`) — Supports Full Role Swapping
- **Variant A (Gemini Plans → Codex Executes → Gemini Reviews)**:
  1. Draft a task DAG in the ledger (`team_task_upsert` with `dependsOn`, `acceptanceCriteria`, `verifyCommand`, `artifacts`) and post it via `team_message_post(kind="plan")`.
  2. **Plan Challenge Gate**: Spawn a read-only Codex thread (`role="Plan Reviewer"`, `sandbox="read-only"`, `effort="high"`) to critique the plan before execution. Record Codex's critique (`kind="challenge"`). Revise the plan if valid.
  3. Dispatch ready tasks to Codex via `codex_spawn` (use `async=true` for parallel tasks, `createWorktree=true` for parallel code writes).
  4. When Codex completes, run `team_verify_task` and independently inspect outputs. If defects exist, post `kind="review"` and call `codex_message` on the **same `threadId`** to demand targeted rework (incrementing `reworkCount` via `team_task_upsert`). Repeat until verified or `maxReworks` reached.
- **Variant B (Role Swap: Codex/GPT Plans → Gemini &/or Codex Executes → Codex Reviews)**:
  1. Spawn Codex (`role="Lead Architect"`, `effort="high"` or `"xhigh"`, `sandbox="read-only"`) to design the plan, task DAG, and acceptance criteria.
  2. Record Codex's plan (`fromAgent="Codex (Architect)"`, `kind="plan"`). Challenge any weak spots as Gemini (`kind="challenge"`) and resolve via `codex_message`.
  3. Execute Gemini-owned tasks yourself / with `invoke_subagent`, and delegate Codex-owned tasks via `codex_spawn`.
  4. Send completed deliverables back to Codex's architect/reviewer thread via `codex_message` for independent verification.

### 2. Co-Creation (`co_create`)
- Divide work by comparative advantage (e.g., Gemini handles literature search, research framing, synthesis, visual/doc polish; Codex handles heavy coding, econometrics scripts, data wrangling, automated tests).
- Update `.duo-team/memory.md` after every milestone.
- Run cross-model reviews on each milestone and allow either model to post `kind="challenge"` whenever assumptions conflict.

### 3. Blind Parallel Research (`parallel_research`)
- Freeze the exact question and input file paths in `memory.md`.
- Launch **both sides simultaneously** with strict first-round isolation:
  1. Call `codex_spawn(..., async=true, role="Independent Branch B (Codex)", sandbox="workspace-write")` writing ONLY to `.duo-team/artifacts/branch-codex.md` (instruct Codex NOT to read `branch-gemini.md`).
  2. In parallel, run Gemini's independent analysis (via `invoke_subagent` with `independent-reviewer` or yourself) writing ONLY to `.duo-team/artifacts/branch-gemini.md`.
- Post both outputs via `team_message_post` with `side="branch_a"` and `side="branch_b"` so the workbench renders them side-by-side.
- Wait for Codex via `codex_wait`, then synthesize agreements, contradictions, missing evidence, and verification steps into `.duo-team/artifacts/synthesis.md`.

### 4. Structured Debate (`debate`)
- Define the exact proposition, evidence files, and judging rubric in a task and `team_message_post(kind="plan")`.
- **Round 1 (Blind Openings)**: Concurrently collect Pro opening (`side="pro"`, e.g. Gemini or Codex) and Con opening (`side="con"`, the other model) without seeing each other's draft. Post both with `round=1`.
- **Rounds 2..N (Rebuttals)**: Feed each side the opponent's exact claims and citations (use `codex_message` on the same Codex thread so it keeps its full reasoning context). Post each rebuttal with `kind="rebuttal"`, `round=k`, and matching `side`.
- **Verdict**: Produce an evidence-ranked verdict (`kind="verdict"`) citing verifiable files/data/tests, explicitly flagging any unresolved disputes for the user.

### 5. Autonomous Team (`autonomous_team`)
- Best combined with Antigravity's `run_workflow` or `/goal` for long-horizon goals.
- Continuously inspect `team_board_read`:
  - Dispatch all `ready` tasks in parallel (respecting Codex subscription quota from `codex_status`).
  - Run `team_verify_task` on every produced deliverable.
  - Automatically loop rework up to `maxReworks`.
  - If Codex hits rate limits, mark blocked tasks cleanly and preserve `codexThreadId` so work resumes seamlessly via `codex_message` (`thread/resume`) later.
  - Escalate to `awaiting_human` only for strategic ambiguity, approval gates, or unresolvable cross-model deadlock.

### 6. Custom Workflow (`custom`)
- Use `team_workflow_preset` to manage and execute reusable workflow presets stored in `.duo-team/workflows/*.json`:
  - `action="list"`: Inspect all saved `.duo-team/workflows/*.json` presets for the active project.
  - `action="save"`: Persist a new or customized workflow preset JSON (specifying `presetId`, `name`, `description`, optional `roleModels`, `maxReworks`, and a `stages` DAG template where each stage defines `id`, `title`, `owner`, `reviewer`, `dependsOn`, `acceptanceCriteria`, `verifyCommand`, and `artifacts`).
  - `action="apply"`: Apply the chosen `presetId` to the active project — automatically switching mode to `custom`, updating `roleModels`/`maxReworks`, and materializing the entire dependency-linked task DAG into the project ledger so you can immediately run `team_schedule_plan` and `team_auto_dispatch`.

## Real-Time Steering & Human Intervention
- If the user adds a mid-flight requirement while a Codex thread is running, immediately call `codex_message(threadId=..., text=..., steerIfRunning=true)` to redirect Codex without losing its progress.
- If `codex_wait` shows `status="waiting_approval"`, summarize the pending approval clearly to the user (or remind them they can approve directly in the Duo-Team Workbench Workers tab) and call `codex_control` once they decide.
