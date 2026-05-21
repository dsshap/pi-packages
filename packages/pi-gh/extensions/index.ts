import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export type GhStatus =
	| { kind: "missing" }
	| { kind: "unauthenticated"; detail: string }
	| { kind: "authenticated"; detail: string }
	| { kind: "error"; detail: string };

// ── Pure helpers (exported for tests) ────────────────────────────────────

/**
 * Classify the output of `gh auth status` into a typed status.
 *
 * `gh auth status` writes its output to **stderr** on both success and failure.
 * The `error` object comes from promisify(execFile) rejecting when the exit
 * code is non-zero; its `.stdout` / `.stderr` properties carry the raw output.
 */
export function classifyGhAuthOutput(opts: { error: NodeJS.ErrnoException | null; stdout: string; stderr: string }): GhStatus {
	const { error, stdout, stderr } = opts;

	// gh is not installed
	if (error?.code === "ENOENT") {
		return { kind: "missing" };
	}

	// gh exited non-zero
	if (error) {
		const combined = (stderr || stdout).trim();
		const lower = combined.toLowerCase();
		if (lower.includes("not logged") || lower.includes("not authenticated")) {
			return { kind: "unauthenticated", detail: combined };
		}
		return { kind: "error", detail: combined || String(error) };
	}

	// gh exited 0 — authenticated
	const detail = (stderr || stdout).trim();
	return { kind: "authenticated", detail };
}

const PROMPTS_FOOTER = `
This package ships prompts:
  • /pr — open a PR for the current branch
  • /triage-pr-feedback <pr-number> — triage feedback on a PR you own`.trimStart();

/**
 * Format a human-readable message for each GhStatus kind.
 * Every message includes the prompts footer so users know what prompts are available.
 */
export function formatGhStatusMessage(status: GhStatus): string {
	let header: string;
	switch (status.kind) {
		case "missing":
			header = "gh CLI not found.\nInstall it from https://cli.github.com/ then run `gh auth login`.";
			break;
		case "unauthenticated":
			header = `gh CLI is not authenticated.\nRun \`gh auth login\` to sign in.\n\n${status.detail}`;
			break;
		case "authenticated":
			header = `gh CLI is authenticated.\n\n${status.detail}`;
			break;
		case "error":
			header = `gh auth status returned an unexpected error.\n\n${status.detail}`;
			break;
	}
	return `${header}\n\n${PROMPTS_FOOTER}`;
}

// ── Extension entry ──────────────────────────────────────────────────────

export default function piGh(pi: ExtensionAPI): void {
	pi.registerCommand("gh", {
		description: "Diagnose gh CLI auth and list prompts shipped by @dsshap/pi-gh",
		handler: async (_args, ctx) => {
			let status: GhStatus;
			try {
				const { stdout, stderr } = await execFileAsync("gh", ["auth", "status"], { timeout: 5000 });
				status = classifyGhAuthOutput({ error: null, stdout, stderr });
			} catch (err) {
				const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
				status = classifyGhAuthOutput({ error: e, stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
			}
			ctx.ui.notify(formatGhStatusMessage(status), status.kind === "authenticated" ? "info" : "warning");
		},
	});
}
