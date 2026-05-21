---
description: Create a conventional commit from current session changes (no branching)
argument-hint: "[scope-hint]"
---
Create a git commit for the work done in this session on the **current branch**. Do not create or switch branches.

**Optional scope hint from user:** $@

## Steps

1. **Inspect changes** — run these in parallel:
   - `git status --short`
   - `git diff --stat`
   - `git diff` (and `git diff --cached` if anything is staged)
   - `git log -5 --oneline` (to match existing commit style)
   - `git branch --show-current`

2. **Classify the change** and pick ONE conventional commit type:
   - `feat:` — new user-facing capability
   - `fix:` — bug fix
   - `refactor:` — internal restructure, no behavior change
   - `chore:` — tooling, deps, build, config
   - `docs:` — documentation only
   - `test:` — tests only

3. **Write the commit message**:
   - Subject: `<type>(<scope>): <imperative summary>` — ≤ 72 chars, no trailing period.
     - Scope = `$@` if given, else inferred top-level dir or package name (e.g. `pi-pi-experts`).
   - Blank line, then a body with 1–3 short bullets describing *what* and *why* (not how).
   - Match the project's existing tone from `git log` (this repo uses Conventional Commits — see `AGENTS.md`).

4. **Decide whether to confirm**:
   - **Skip confirmation and proceed automatically** when ALL are true:
     - Changes touch a single coherent area (one package or one feature).
     - Type classification is unambiguous (e.g., only `*.md` → `docs:`; only test files → `test:`; pure rename/move → `refactor:`; lockfile/config-only → `chore:`).
     - Current branch is **not** `main` / `master` / `develop`.
     - No secrets and no cross-cutting changes across multiple packages.
   - **Otherwise**, show the user the proposed commit message and wait for approval. In particular:
     - If on `main` / `master` / `develop`, **always confirm** and warn the user — suggest `/bcommit` to create a branch first.

5. **Execute** (only after auto-approval or user approval):
   - `git add -A`
   - `git commit -m "<subject>" -m "<body>"`
   - Print the final `git log -1 --stat` summary.

## Guardrails

- **Never create or switch branches.** This command commits on whatever branch you are currently on. Use `/bcommit` if you want a new branch.
- Never push. Never force. Never amend existing commits.
- If the working tree is clean, stop and report "nothing to commit".
- Redact anything that looks like a secret/API key from the message body.
- Respect this repo's multi-package layout: if changes are scoped to one package under `packages/*`, use that package name as the commit scope.
