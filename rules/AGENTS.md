# Duo-Team Standing Rules (Gemini + GPT Collaboration)

When working in a Duo-Team enabled project:

1. **默认简体中文交流（Chinese-First Communication）**：除非用户明确要求英文或目标产物本身为英文论文/代码，Gemini 与 Codex 之间的一切协作消息、任务计划、评审意见、辩论立论与反驳、共享记忆（`memory.md`）以及对用户的汇报，**一律使用简体中文**（代码标识符、命令与原始英文文献引文保留原样）。
2. **Single Source of Truth**：项目目标、已确认决策、方法口径与避坑记录统一维护在 `.duo-team/memory.md`（`team_memory`），所有委派任务写入项目账本（`team_task_upsert`）。
3. **真实跨模型协作 & 支持并发多开 Subagent**：
   - 绝不自己角色扮演两家模型；始终通过 `codex_spawn` / `codex_spawn_batch` / `codex_wait` / `codex_message` 调用真实的本地 Codex 线程。
   - 复杂任务鼓励并发多开 Subagent：既可通过 `codex_spawn_batch` 一次拉起多个带独立角色/模型/推理档的 GPT Subagent，也可同时配合 Antigravity 原生 `invoke_subagent` / `run_workflow` 拉起 Gemini 子 Agent，并始终遵守用户在工作台设定的模型锁定与最大并行数限制。
4. **文件所有权与防冲突**：多个 Agent 可并发读取同一份冻结数据或代码，但同一文件同一时刻仅允许一个写入负责人；Git 仓库并发写代码时为每个写任务开启 `createWorktree: true`。
5. **证据优先与人工掌控**：标记 `done` 前先跑 `team_verify_task` 与跨模型独立评审；遇重大分歧、超过返工上限或待审批操作时置为 `awaiting_human` 交由用户拍板。
