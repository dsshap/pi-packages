/**
 * Remote-source handling for the `--with` flag.
 *
 * Delegates clone/install bookkeeping to Pi's own `DefaultPackageManager` so
 * remotes land in the same `~/.pi/agent/git/<host>/<user>/<repo>` cache that
 * `pi install` uses, run `npm install` automatically, and respect Pi's
 * conventions for source spec parsing.
 *
 * Refresh is *lazy*: on the first time a session asks for candidates from a
 * given remote, if the spec is not pinned (no `@<ref>`) and `PI_OFFLINE` is
 * not set, we shell out to `git fetch + reset --hard` against the existing
 * clone. If HEAD moved we re-run `npm install` to pick up dependency changes.
 *
 * Hard-fail policy: any clone/fetch/reset/npm-install error propagates to the
 * caller, which will surface it via `withStartupSummary.errors`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DefaultPackageManager, getAgentDir, type PackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isPinnedGitSpec, scanCloneForCandidates } from "./resolver.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ProgressReporter = (line: string) => void;

export interface EnsureRemoteResult {
	/** Absolute path to the clone root. */
	cloneDir: string;
	/** Candidate map derived from the clone (monorepo or single-package). */
	candidates: Map<string, string>;
	/** True if a clone or fetch actually ran during this call. */
	touched: boolean;
	/** True if a fetch moved HEAD. */
	changed: boolean;
}

// ── PackageManager singleton ─────────────────────────────────────────────

let _pm: PackageManager | null = null;

/**
 * Lazily construct (and cache) a `DefaultPackageManager` bound to the current
 * working directory and Pi's standard agent dir. Constructed on first use so
 * extensions that never use a remote pay no cost.
 */
export function getPackageManager(cwd: string = process.cwd()): PackageManager {
	if (_pm) return _pm;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	_pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	return _pm;
}

// Test-only: reset the singleton between tests.
export function _resetPackageManagerForTests(): void {
	_pm = null;
}

// ── Ensure / refresh ─────────────────────────────────────────────────────

/**
 * Extract the ref portion from a git spec, or `undefined` if unpinned.
 * Mirrors the convention used by `isPinnedGitSpec`.
 */
function extractRef(spec: string): string | undefined {
	if (!isPinnedGitSpec(spec)) return undefined;
	const raw = spec.startsWith("git:") ? spec.slice(4) : spec;
	const lastSlash = raw.lastIndexOf("/");
	const tail = raw.slice(lastSlash + 1);
	const at = tail.indexOf("@");
	return tail.slice(at + 1);
}

function isOfflineMode(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_OFFLINE;
	if (!v) return false;
	return v !== "0" && v.toLowerCase() !== "false";
}

function runGit(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Ensure a remote is cloned and (if unpinned & online) up to date, then scan
 * for candidates. Idempotent — safe to call multiple times per session; each
 * remote is cloned/fetched at most once.
 *
 * Errors are thrown (hard fail). The caller should catch and route them to
 * the user-visible startup-summary errors list.
 */
export async function ensureRemote(
	spec: string,
	pm: PackageManager,
	options: { reportProgress?: ProgressReporter; env?: NodeJS.ProcessEnv } = {},
): Promise<EnsureRemoteResult> {
	const report = options.reportProgress ?? (() => {});
	const env = options.env ?? process.env;

	// First-time clone via Pi's package manager. This is a no-op if the dir
	// exists, which means we can call it cheaply on every session.
	let cloneDir = pm.getInstalledPath(spec, "user");
	const existedBefore = Boolean(cloneDir && existsSync(cloneDir));
	if (!existedBefore) {
		report(`[loader-with] cloning ${spec}`);
		await pm.install(spec);
		cloneDir = pm.getInstalledPath(spec, "user");
		if (!cloneDir || !existsSync(cloneDir)) {
			throw new Error(`pm.install("${spec}") succeeded but install path is missing`);
		}
	}

	let touched = !existedBefore;
	let changed = false;

	// Refresh policy: unpinned + online + clone existed before this session.
	const pinned = isPinnedGitSpec(spec);
	if (!pinned && existedBefore && !isOfflineMode(env)) {
		const ref = extractRef(spec) ?? "HEAD";
		const remoteSpec = ref === "HEAD" ? ["origin"] : ["origin", ref];
		const before = runGit(["rev-parse", "HEAD"], cloneDir as string);
		report(`[loader-with] refreshing ${spec}`);
		runGit(["fetch", ...remoteSpec, "--depth=1"], cloneDir as string);
		runGit(["reset", "--hard", "FETCH_HEAD"], cloneDir as string);
		const after = runGit(["rev-parse", "HEAD"], cloneDir as string);
		touched = true;
		changed = before !== after;
		if (changed) {
			report(`[loader-with] HEAD moved ${before.slice(0, 7)} → ${after.slice(0, 7)}, running npm install`);
			// Re-run npm install. Use plain `npm`, deferring `npmCommand`
			// configurability (a settings.json knob) until anyone asks for it.
			execFileSync("npm", ["install"], { cwd: cloneDir as string, stdio: "inherit" });
		}
	}

	const candidates = scanCloneForCandidates(cloneDir as string);
	return { cloneDir: cloneDir as string, candidates, touched, changed };
}
