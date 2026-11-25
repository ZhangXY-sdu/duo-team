---
name: duo-dev
description: >-
  Software engineering collaboration workflow for Gemini + Codex: architecture
  critique, Git worktree-isolated parallel coding, automated testing, and
  independent cross-model code review & rework loops.
---

# Duo-Team Software Engineering Playbook

Use this playbook alongside `duo-orchestrate` for software repositories, web apps, crawlers, automation tools, and games.

## 1. Parallel Isolation via Git Worktrees
- Whenever two or more tasks modify code concurrently, pass `createWorktree: true` to `team_task_upsert` or `codex_spawn`.
- Each Codex worker operates cleanly in `.duo-team/worktrees/<taskId>` on branch `duo-team/<taskId>`, preventing file overwrite conflicts.

## 2. Independent Code Review Gate
- The model that wrote the implementation MUST NOT be the sole reviewer.
- After `team_verify_task` passes automated tests/typecheck/lint (`pytest`, `npm test`, `cargo test`, etc.), run an independent review by the other model checking:
  - Spec compliance & edge cases
  - Security, error handling, and resource cleanup
  - Diff cleanliness and test coverage
- Post structured findings (`severity`, `file:line`, `required_changes`) via `team_message_post(kind="review")`.
- If `required_changes` is non-empty, send them back via `codex_message` (or fix on Gemini side) and re-verify until clean.
- Present a concise diff & test summary to the user before merging worktree branches back to `main`.
