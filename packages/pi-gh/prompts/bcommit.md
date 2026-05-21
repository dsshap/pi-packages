---
description: Create a git branch and conventional commit from current session changes
argument-hint: "[scope-hint]"
---
Create a git branch and commit for the work done in this session.

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

3. **Derive a branch name** in the form `<type>/<short-kebab-summary>`:
   - If `$@` was provided, incorporate it as the scope or summary anchor.
   - Otherwise infer from the diff (touched modules, new symbols, file paths).
   - Keep summary ≤ 5 words, lowercase, kebab-case.
   - Examples: `feat/auth-token-refresh`, `fix/api-rate-limit`, `refactor/parser-cleanup`.

4. **Write the commit message**:
   - Subject: `<type>(<scope>): <imperative summary>` — ≤ 72 chars, no trailing period.
     - Scope = `$@` if given, else inferred top-level dir or package name (e.g. `pi-pi-experts`).
   - Blank line, then a body with 1–3 short bullets describing *what* and *why* (not how).
   - Match the project's existing tone from `git log` (this repo uses Conventional Commits — see `AGENTS.md`).

5. **Decide whether to confirm**:
   - **Skip confirmation and proceed automatically** when ALL are true:
     - Changes touch a single coherent area (one package or one feature).
     - Type classification is unambiguous (e.g., only `*.md` → `docs:`; only test files → `test:`; pure rename/move → `refactor:`; lockfile/config-only → `chore:`).
     - No secrets and no cross-cutting changes across multiple packages.
   - **Otherwise, show the user** the proposed branch name + commit message and wait for approval.

6. **Execute** (only after auto-approval or user approval):
   - If current branch is `main`/`master`/`develop`: `git checkout -b <branch-name>`.
   - If already on a feature branch that matches the scope, stay on it; otherwise create a new branch.
   - `git add -A`
   - `git commit -m "<subject>" -m "<body>"`
   - Print the final `git log -1 --stat` summary.

## Guardrails

- Never push. Never force-push. Never amend existing commits.
- If the working tree is clean, stop and report "nothing to commit".
- If on `main`/`master`/`develop`, always create a new branch — never commit directly.
- Redact anything that looks like a secret/API key from the message body.
- Respect this repo's multi-package layout: if changes are scoped to one package under `packages/*`, use that package name as the commit scope.
