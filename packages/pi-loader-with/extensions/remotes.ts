/**
 * Remote-source handling for the `--with` flag.
 *
 * Delegates install bookkeeping to Pi's own `DefaultPackageManager`, so
 * remotes land in the same cache `pi install` uses and respect Pi's spec-
 * parsing conventions. Two schemes are supported:
 *
 *   - `git:` / `https://` / `ssh://` / SCP-style → git clone
 *      (`~/.pi/agent/git/<host>/<user>/<repo>`)
 *   - `npm:` → npm package install
 *      (`~/.pi/agent/npm/node_modules/<pkg>`)
 *
 * Refresh is *lazy*: on the first time a session asks for candidates from a
 * given remote, if the spec is not pinned and `PI_OFFLINE` is not set:
 *   - git: `git fetch + reset --hard` against the existing clone; if HEAD
 *     moved, re-run `npm install` to pick up dependency changes.
 *   - npm: re-run `pm.install(spec)` so npm can resolve to a newer version.
 *
 * Hard-fail policy: any clone/fetch/install error propagates to the caller,
 * which will surface it via `withStartupSummary.errors`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DefaultPackageManager, getAgentDir, type PackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getRemoteScheme, isPinnedGitSpec, isPinnedRemoteSpec, scanCloneForCandidates } from "./resolver.js";

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
	/** True if the clone is a monorepo (`packages/` layout). */
	isMonorepo: boolean;
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
	options: { reportProgress?: ProgressReporter; env?: NodeJS.ProcessEnv; alias?: string } = {},
): Promise<EnsureRemoteResult> {
	const report = options.reportProgress ?? (() => {});
	const env = options.env ?? process.env;
	const scheme = getRemoteScheme(spec);

	// First-time install via Pi's package manager. This is a no-op if the dir
	// already exists, which means we can call it cheaply on every session.
	let installPath = pm.getInstalledPath(spec, "user");
	const existedBefore = Boolean(installPath && existsSync(installPath));
	if (!existedBefore) {
		report(`[loader-with] ${scheme === "npm" ? "installing" : "cloning"} ${spec}`);
		await pm.install(spec);
		installPath = pm.getInstalledPath(spec, "user");
		if (!installPath || !existsSync(installPath)) {
			throw new Error(`pm.install("${spec}") succeeded but install path is missing`);
		}
	}

	let touched = !existedBefore;
	let changed = false;

	// Refresh policy: unpinned + online + already-existed-this-session.
	const shouldRefresh = !isPinnedRemoteSpec(spec) && existedBefore && !isOfflineMode(env);
	if (shouldRefresh) {
		if (scheme === "npm") {
			// Let npm re-resolve the version. pm.install handles the dist-tag
			// (`latest` or bare name) and updates `node_modules/<pkg>` in place.
			report(`[loader-with] refreshing ${spec}`);
			await pm.install(spec);
			touched = true;
			// We don't get a cheap "version moved?" signal from pm.install, so
			// `changed` stays false. Downstream code only uses it for git's
			// optional re-install — npm install already handled deps.
		} else {
			const ref = extractRef(spec) ?? "HEAD";
			const remoteSpec = ref === "HEAD" ? ["origin"] : ["origin", ref];
			const before = runGit(["rev-parse", "HEAD"], installPath as string);
			report(`[loader-with] refreshing ${spec}`);
			runGit(["fetch", ...remoteSpec, "--depth=1"], installPath as string);
			runGit(["reset", "--hard", "FETCH_HEAD"], installPath as string);
			const after = runGit(["rev-parse", "HEAD"], installPath as string);
			touched = true;
			changed = before !== after;
			if (changed) {
				report(`[loader-with] HEAD moved ${before.slice(0, 7)} → ${after.slice(0, 7)}, running npm install`);
				// Re-run npm install. Use plain `npm`, deferring `npmCommand`
				// configurability (a settings.json knob) until anyone asks for it.
				execFileSync("npm", ["install"], { cwd: installPath as string, stdio: "inherit" });
			}
		}
	}

	const { candidates, isMonorepo } = scanCloneForCandidates(installPath as string, options.alias);
	return { cloneDir: installPath as string, candidates, touched, changed, isMonorepo };
}
