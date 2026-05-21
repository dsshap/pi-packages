---
description: Triage feedback on a PR you own — outputs an HTML report and auto-opens it in the browser
argument-hint: "<pr-number>"
---

Triage the feedback on **PR #$1** (a PR you own) and produce an HTML report that is auto-opened in the browser. Most of the work is investigation; the deliverable is one self-contained `.html` file in the user's reports directory.

## Preflight

Bail out, with the indicated message to the user, if any of:
- `$1` is empty or not a positive integer → "Usage: `/triage-pr-feedback <pr-number>`"
- `gh auth status` fails → "Run `gh auth login` first."

## Resolve the effective repo

The PR might live in this repo OR in its upstream parent (if this repo is a fork). Resolve once, then use the result on every subsequent `gh` call:

1. `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)` — start with the current repo.
2. Try `gh pr view "$1" -R "$REPO" --json number`. If it succeeds, keep `$REPO`.
3. Otherwise check whether the current repo is a fork:
   `gh repo view --json isFork,parent -q '{isFork: .isFork, parent: (.parent.nameWithOwner // "")}'`
   - If `isFork` is `true` and `parent` is non-empty, set `REPO=<parent>` and retry step 2.
4. If the PR still cannot be found, bail: "PR #$1 not found in current repo or its upstream parent."

## Fetch in parallel

Run all of these in one tool round-trip:

- `gh pr view "$1" -R "$REPO" --json number,title,author,state,baseRefName,headRefName,body,additions,deletions,changedFiles,url,reviews,isCrossRepository`
- `gh pr diff "$1" -R "$REPO"`
- `gh pr checks "$1" -R "$REPO"` (best-effort; if it fails, treat CI as "unknown")
- Inline review threads via GraphQL (with `isResolved` / `isOutdated`):
  ```bash
  OWNER=${REPO%/*}; NAME=${REPO#*/}
  gh api graphql -f query='
    query($owner: String!, $repo: String!, $num: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $num) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              isOutdated
              path
              line
              comments(first: 50) {
                nodes { author { login } body createdAt }
              }
            }
          }
        }
      }
    }' -F owner="$OWNER" -F repo="$NAME" -F num="$1"
  ```
- Issue-level conversation comments: `gh api "repos/$REPO/issues/$1/comments" --paginate`

## Analyze

1. **Understand intent.** From the PR title, body, and (if helpful) commits, summarize in 1-2 sentences what this PR is trying to do.

2. **Map the diff.** Count files changed and lines added/removed. Group changed files by area / package only if the count is non-trivial (>3 files in >1 area).

3. **Enumerate every feedback item** from three sources, deduplicated:
   - **Inline review threads** (GraphQL `reviewThreads`)
   - **Issue-level conversation comments** (REST `issues/<num>/comments`)
   - **Review-level summaries** with a non-empty `body` from `gh pr view --json reviews`

   Ignore the PR author's own status notes (e.g. "rebased onto main"). Surface everything else.

4. **For each feedback item:**
   - **Capture both the full quote AND a truncated preview.** The truncated preview is ~200 chars ending in `…` (never alter meaning when truncating). The full quote is the entire verbatim comment, with newlines preserved. The HTML emits both — see the "Quote rendering" rule below.
   - If inline, identify the referenced `file:line`.
   - **READ THE ACTUAL CODE** at that location for context.
   - Score three axes — **valid? / actionable? / in-scope?**
   - Assign verdict: **Address** / **Defer** / **Dismiss** with a one-line rationale.
   - If `isResolved: true`, tag `(resolved)` — usually `Dismiss`.
   - If `isOutdated: true`, tag `(outdated)` — usually `Dismiss`.

5. **Cross-check CI.** If `gh pr checks` shows failures, fetch logs for failing jobs (`gh run view --log-failed <run-id>`). A failing test that aligns with a commenter's concern materially raises that comment's importance.

## Generate the HTML report

The deliverable is a self-contained `.html` file with the design-system CSS inlined.

### Paths and naming

- **Report output**: `~/.pi/agent/output/triage-pr/<owner>-<repo>-<pr>-<YYYYMMDD-HHmm>.html`
  - `<owner>-<repo>` comes from `$REPO` with `/` replaced by `-`.
  - `<pr>` is `$1`.
  - `<YYYYMMDD-HHmm>` is the current local time, e.g. `20260521-1034`.
  - Create the directory if it doesn't exist: `mkdir -p ~/.pi/agent/output/triage-pr/`.
- **Design system CSS**: read from `~/.pi/agent/styles/pi-report.css` and inline its contents into a `<style>` tag in the HTML. This makes the report portable — if the user emails or archives it, it renders correctly without external dependencies.

### HTML skeleton

Use exactly this structure, substituting the bracketed placeholders. Omit any section with no content (e.g. skip the prerequisites block if there are none, skip the "Implementation plan" `<h2>` and `<ol>` entirely if the overall verdict is "Not worth implementing").

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PR #[NUM] — [TITLE]</title>
<style>
[INLINE THE FULL CONTENTS OF ~/.pi/agent/styles/pi-report.css HERE]
</style>
</head>
<body>
<main class="report">

  <header class="report__header">
    <div class="report__title-row">
      <span class="report__num">#[NUM]</span>
      <h1 class="report__title">[TITLE]</h1>
    </div>
    <div class="report__meta">
      <span class="badge">@[AUTHOR]</span>
      <span class="badge">[STATE]</span>
      <span class="badge [CI_BADGE_CLASS]">CI [CI_STATUS]</span>
      <span class="badge"><code>[OWNER/REPO]</code></span>
      <span class="badge">[N] files, <span class="diff-add">+[ADD]</span>/<span class="diff-del">−[DEL]</span></span>
      <a href="[URL]">[URL_DISPLAY] ↗</a>
    </div>
  </header>

  <div class="verdict-banner verdict-banner--[address|partial|dismiss]">
    <div class="verdict-banner__label">Overall judgement</div>
    <div class="verdict-banner__decision">[Worth implementing | Partial — selected items only | Not worth implementing]</div>
    <p class="verdict-banner__rationale">[2-3 sentence justification — concise, tied to PR goal + CI signal]</p>
  </div>

  <h2>Summary</h2>
  <table class="summary-table">
    <thead>
      <tr><th>#</th><th>Commenter</th><th>File:Line</th><th>Verdict</th><th>Why</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>[N]</td>
        <td class="commenter">@[COMMENTER]</td>
        <td class="file">[FILE:LINE or "—" for issue-level]</td>
        <td><span class="verdict verdict--[address|defer|dismiss]">[Address|Defer|Dismiss]</span></td>
        <td>[short one-line rationale]</td>
      </tr>
      <!-- repeat per item -->
    </tbody>
  </table>

  <!-- Include this section ONLY when overall verdict is Worth/Partial -->
  <h2>Implementation plan</h2>
  <ol class="plan">
    <li>
      [Step description — 1 sentence, name the file/function]
      <span class="plan__step-meta"><span class="resolves">resolves #[N]</span>[<span class="resolves">resolves #[M]</span>]</span>
    </li>
    <!-- repeat per step -->
    <!-- Optional: include only if there are prerequisites -->
    <div class="plan__prereqs">
      <strong>Prerequisites:</strong> [rebase / discuss / etc.]
    </div>
  </ol>

  <h2>Feedback details</h2>

  <div class="feedback-item feedback-item--[address|defer|dismiss]">
    <div class="feedback-item__head">
      <span class="feedback-item__num">#[N]</span>
      <span class="feedback-item__commenter">@[COMMENTER]</span>
      <span class="feedback-item__file">[FILE:LINE]</span>
      <!-- include the tag if applicable -->
      <span class="feedback-item__tag feedback-item__tag--[resolved|outdated]">([resolved|outdated])</span>
    </div>
    [QUOTE BLOCK — see "Quote rendering" below for which of the two forms to emit]
    <p class="feedback-item__investigation">[1-2 sentence investigation finding]</p>
    <div class="feedback-item__assessment">
      <span class="chip chip--[ok|no]">[✓|✗] valid</span>
      <span class="chip chip--[ok|no]">[✓|✗] actionable</span>
      <span class="chip chip--[ok|no]">[✓|✗] in-scope</span>
    </div>
    <div class="feedback-item__verdict-row">
      <span class="verdict verdict--[address|defer|dismiss]">[Address|Defer|Dismiss]</span>
      <span class="feedback-item__rationale">[one-line rationale]</span>
    </div>
  </div>
  <!-- repeat per item -->

  <div class="footer">
    Generated by <code>/triage-pr-feedback</code> · <span class="report__timestamp">[YYYY-MM-DD HH:MM TZ]</span>
  </div>

</main>
</body>
</html>
```

### Quote rendering

Every feedback item embeds the commenter's text. Choose **one of two forms** based on the full quote's length:

**Form A** — plain blockquote (use when the full quote is ≤ 200 characters, no truncation needed):

```html
<blockquote class="feedback-item__quote">[FULL QUOTE]</blockquote>
```

**Form B** — expandable `<details>` (use when the full quote is > 200 characters; preserves the truncated preview AND the full text in the same HTML, click-to-expand):

```html
<details class="feedback-item__quote">
  <summary>
    <span class="feedback-item__quote-short">[TRUNCATED PREVIEW — ~200 chars ending in …]</span>
    <span class="feedback-item__quote-toggle" aria-hidden="true"></span>
  </summary>
  <div class="feedback-item__quote-full">[FULL VERBATIM QUOTE, NEWLINES PRESERVED]</div>
</details>
```

For Form B:
- The `__quote-short` span is the truncated preview the user sees by default.
- The `__quote-full` div holds the complete quote; CSS hides it until the user clicks to expand.
- Do NOT include any toggle text inside `__quote-toggle` — the CSS injects "show full" / "show less" via `::before` content automatically based on the `[open]` state.
- Preserve newlines from the original GitHub comment by writing literal newlines inside the `__quote-full` div (the CSS uses `white-space: pre-wrap`). Escape HTML special chars in the quote text (`<`, `>`, `&`) but keep inline `<code>...</code>` tags if the original comment had backtick-fenced inline code.
- DO NOT hide the truncated preview yourself or duplicate the full text in the summary — CSS handles the open/closed visibility swap.

### Class rules

- **CI badge class**: pass → `badge--ok`, fail → `badge--fail`, pending → `badge--pending`, unknown → no class.
- **Verdict banner class** maps from the overall verdict:
  - "Worth implementing" → `verdict-banner--address`
  - "Partial — selected items only" → `verdict-banner--partial`
  - "Not worth implementing" → `verdict-banner--dismiss`
- **Feedback item class** mirrors the per-item verdict: `feedback-item--address` / `--defer` / `--dismiss`.
- **Assessment chips**: `chip--ok` (with `✓`) for yes, `chip--no` (with `✗`) for no. For resolved/outdated items where the concern no longer holds, mark `valid` as `chip--no` with the parenthetical reason inline (e.g. `✗ valid (outdated)`).

### Conciseness rules

The user wants to scan, not read. Enforce:
- Verdict-banner rationale: ≤ 3 sentences.
- Investigation per item: 1-2 sentences max — what the code actually does, NOT a recap of the quote.
- Summary-table "Why" column: ≤ 12 words.
- Plan steps: 1 sentence each, name the file/function.
- Never duplicate info between summary table, plan, and feedback cards. The table is the index; cards are the deep dive.

## Open the report

After writing the HTML file:

1. Detect platform and open:
   ```bash
   case "$(uname -s)" in
     Darwin) open "<PATH>" ;;
     Linux)  xdg-open "<PATH>" >/dev/null 2>&1 ;;
     MINGW*|MSYS*|CYGWIN*) start "<PATH>" ;;
     *) ;;  # unsupported — fall through, just print the path
   esac
   ```
2. If the open command fails (e.g. headless env, no display), do not error — the file is already written.

## Final chat output

Reply with **one line only** (the user reads the report in the browser, not the chat):

```
Triaged PR #$1 — <Worth implementing | Partial | Not worth implementing>. Report: <full-path-to-html>. Opened in browser.
```

If the browser-open command failed, change the last sentence to: `Open it manually: file://<full-path-to-html>`.

## Guardrails

- **Do not** post comments on the PR, approve, request changes, dismiss reviews, or merge.
- **Do not** modify any source files, stage changes, or push commits in this session.
- **Do not** write the report anywhere other than the namespaced output path.
- **Do not** reply with markdown narrative in the chat — the HTML report is the deliverable, the chat line is just the confirmation.
- If the diff exceeds ~2000 lines, note it in the verdict-banner rationale and focus your review on the highest-risk files rather than every change.
- For `Dismiss` verdicts, briefly explain *why* the concern doesn't hold. For `Defer` verdicts, suggest what should happen next (separate issue, follow-up PR, etc.).
- Quote excerpts always truncated with `…` — never silently cut.
- If the PR is in a cross-repository state (`isCrossRepository: true` and the resolved repo is the upstream), the verdict-banner rationale should mention that pushing fixes goes through the user's fork branch.
