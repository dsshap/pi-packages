# @dsshap/pi-gh

**Pi GH** — ships GitHub PR prompts and a diagnostic command for the `gh` CLI.

## What it ships

- **`/pr`** — push the current branch and open a pull request on GitHub (with auto-generated title and body).
- **`/triage-pr-feedback <pr-number>`** — triage review feedback on a PR you own; produces a self-contained HTML report and opens it in the browser.
- **`/gh`** — diagnostic command: checks whether `gh` is installed and authenticated, and lists the prompts available from this package.

## Install

```bash
pi install npm:@dsshap/pi-gh
```

Or as part of the monorepo:

```bash
pi install git:github.com/dsshap/pi-packages
```

Try without installing:

```bash
cd packages/pi-gh
pi -e .
```

## Prompts

| Command | Argument | Purpose |
|---|---|---|
| `/pr` | `[extra-context]` | Push current branch and open a GitHub PR with an auto-generated title and body. Bails out if on `main`/`master`, if working tree is dirty, or if a PR already exists for the branch. |
| `/triage-pr-feedback` | `<pr-number>` | Fetch all review threads and comments for a PR you own; analyze each item (valid? actionable? in-scope?); write a self-contained HTML report and open it in the browser. |

## Requirements

- [`gh` CLI](https://cli.github.com/) installed and on `$PATH`.
- Authenticated: `gh auth login`.

The `/gh` command tells you exactly what's wrong if either of these isn't met.

## Diagnostic: `/gh`

Runs `gh auth status` and reports:

- ✅ `gh` is installed and authenticated — shows account details.
- ⚠️ `gh` is not authenticated — tells you to run `gh auth login`.
- ⚠️ `gh` is not installed — links to the install page.
- ⚠️ Unexpected error — shows the raw error detail for debugging.

Always appends the list of prompts shipped by this package so you can see at a glance what's available.

## License

MIT. See [LICENSE](./LICENSE).
