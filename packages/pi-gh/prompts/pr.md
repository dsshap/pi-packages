---
description: Push current branch and open a GitHub PR via gh
argument-hint: "[extra-context]"
---
Push the current branch and open a pull request on GitHub.

**Optional extra context from user:** $@

## Preflight

Run these in parallel:
- `git branch --show-current`
- `git status --short`
- `git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline -10`
- `git remote -v`
- `gh auth status` (verify gh is installed + authenticated)

Bail out early with a clear message if:
- `gh` is missing or not authenticated → tell user to run `gh auth login`.
- Current branch is `main` / `master` / `develop` → instruct user to run `/commit` first.
- Working tree has uncommitted changes → instruct user to run `/commit` first.
- A PR already exists for this branch (`gh pr view --json number 2>/dev/null`) → print its URL and stop.

## Steps

1. **Determine base branch** — default branch from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.

2. **Push the branch**:
   - `git push -u origin <current-branch>`

3. **Compose PR title and body**:
   - **Title**: reuse the most recent commit subject if there's only one commit on the branch; otherwise synthesize a conventional-commit-style title (`<type>(<scope>): <summary>`) summarizing all commits since `origin/<base>`.
   - **Body**: render this template, filling each section from the diff + commit log + `$@`:

     ```markdown
     ## Summary
     <1–3 sentences on what changed and why>

     ## Changes
     - <bullet per logical change, grouped by package if multi-package>

     ## Testing
     - <commands run, e.g. `npm run check`, `npm run test`; "n/a" if docs-only>

     ## Notes
     <anything from $@, or omit section if empty>
     ```

   - Match the tone of recent merged PRs if visible (`gh pr list --state merged --limit 5`).

4. **Decide whether to confirm**:
   - **Auto-open the PR** when all of these hold:
     - Single coherent change (one package or one feature).
     - Title is unambiguous from commit history.
     - No `$@` flag suggesting the user wants to review (e.g. "draft", "review").
   - **Otherwise**, show the proposed title + body and wait for approval.
   - If `$@` contains the word `draft`, open as draft.

5. **Open the PR**:
   - Write the body to a temp file to preserve formatting:
     ```bash
     BODY_FILE=$(mktemp)
     cat > "$BODY_FILE" <<'EOF'
     <rendered body>
     EOF
     gh pr create --base <base> --head <current-branch> --title "<title>" --body-file "$BODY_FILE" [--draft]
     rm "$BODY_FILE"
     ```
   - Print the resulting PR URL from `gh pr view --json url -q .url`.

## Guardrails

- Never force-push.
- Never target a base other than the repo's default branch unless `$@` explicitly names one (e.g. `/pr base:release-1.2`).
- Do not include secrets, tokens, or absolute local paths in the PR body.
- If the branch is behind base, note it in the PR body but do not auto-rebase.
