/**
 * Pure resolution helpers for the --with flag.
 * No ExtensionAPI dependency — safe to import from tests and from the loader.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * A `locations[]` entry as it appears on disk: either a plain string path or
 * an object with an optional `name` alias. The alias overrides the candidate
 * key used by `--with` name resolution.
 */
export type RawLocationEntry = string | { path: string; name?: string };

/**
 * A `remotes[]` entry as it appears on disk: either a plain string spec or an
 * object with an optional `name` alias.
 */
export type RawRemoteEntry = string | { spec: string; name?: string };

/** Normalized location after `~` expansion and absolute-path resolution. */
export interface NormalizedLocation {
	/** Absolute path on disk. */
	path: string;
	/** Optional alias overriding the default candidate key (basename / discovered name). */
	name?: string;
}

/** Normalized remote spec entry. */
export interface NormalizedRemote {
	/** Git source spec (verbatim, in Pi's `pi install` format). */
	spec: string;
	/** Optional alias overriding the default candidate key. */
	name?: string;
}

export interface ResourcesConfig {
	locations: NormalizedLocation[];
	remotes: NormalizedRemote[];
}

// ── expandHome ────────────────────────────────────────────────────────────

/**
 * Expand `~` and `~/...` to the home directory.
 * Leaves absolute paths and relative paths as-is.
 * Does NOT handle `~user` — only bare `~` and `~/...`.
 */
export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

// ── parseWithFromArgv ─────────────────────────────────────────────────────

/**
 * Scan argv for `--with <value>` and `--with=<value>` occurrences.
 * Ignores `--without`, `--with-anything-else`, etc. (exact match on `--with`
 * and exact prefix `--with=`).
 * Comma-splits each value, trims, drops empties, deduplicates (first-seen).
 */
export function parseWithFromArgv(argv: string[]): string[] {
	const raw: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--with") {
			const next = argv[i + 1];
			if (next !== undefined) {
				raw.push(next);
				i++;
			}
		} else if (a.startsWith("--with=")) {
			raw.push(a.slice("--with=".length));
		}
	}
	return dedupe(
		raw
			.flatMap((v) => v.split(","))
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

// ── parseWithFromEnv ──────────────────────────────────────────────────────

/**
 * Read `PI_WITH` from env, comma-split, trim, drop empties, deduplicate.
 * Returns [] if unset or empty.
 */
export function parseWithFromEnv(env: NodeJS.ProcessEnv): string[] {
	const val = env.PI_WITH;
	if (!val) return [];
	return dedupe(
		val
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

// ── configSearchPaths ─────────────────────────────────────────────────────

/**
 * Returns ordered list of config file paths to search.
 * `$PI_EXTENSION_LOADER_WITH_CONFIG` (if set) wins; global home path is always last.
 */
export function configSearchPaths(env: NodeJS.ProcessEnv, homeDir: string): string[] {
	const globalPath = join(homeDir, ".pi", "agent", "extensions", "pi-loader-with.json");
	const envPath = env.PI_EXTENSION_LOADER_WITH_CONFIG;
	return envPath ? [envPath, globalPath] : [globalPath];
}

// ── normalizeLocationEntry / normalizeRemoteEntry ─────────────────────────

/**
 * Normalize a raw `locations[]` entry into `{ path, name? }`.
 * String entries become `{ path: <resolved> }`. Object entries must have a
 * non-empty `path`; any other field is ignored. Returns `null` for invalid
 * input (so callers can drop it silently).
 *
 * `~` is expanded and relative paths are resolved against `baseDir` (typically
 * the directory of the config file).
 */
export function normalizeLocationEntry(raw: unknown, baseDir: string): NormalizedLocation | null {
	let path: string | undefined;
	let name: string | undefined;
	if (typeof raw === "string") {
		path = raw;
	} else if (raw && typeof raw === "object") {
		const o = raw as { path?: unknown; name?: unknown };
		if (typeof o.path === "string") path = o.path;
		if (typeof o.name === "string" && o.name.length > 0) name = o.name;
	}
	if (!path || path.length === 0) return null;
	const expanded = expandHome(path);
	const abs = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
	return name ? { path: abs, name } : { path: abs };
}

/**
 * Normalize a raw `remotes[]` entry into `{ spec, name? }`.
 * String entries become `{ spec }`. Object entries must have a non-empty
 * `spec`. Returns `null` for invalid input.
 */
export function normalizeRemoteEntry(raw: unknown): NormalizedRemote | null {
	let spec: string | undefined;
	let name: string | undefined;
	if (typeof raw === "string") {
		spec = raw;
	} else if (raw && typeof raw === "object") {
		const o = raw as { spec?: unknown; name?: unknown };
		if (typeof o.spec === "string") spec = o.spec;
		if (typeof o.name === "string" && o.name.length > 0) name = o.name;
	}
	if (!spec || spec.length === 0) return null;
	return name ? { spec, name } : { spec };
}

// ── loadConfigFrom ────────────────────────────────────────────────────────

/**
 * Load and validate config from a single path.
 * Missing → { config: null }.
 * Malformed JSON → { config: null, warning }.
 * Valid → expand `~` in each `locations` entry, normalize both string and
 * object forms, drop invalid entries.
 */
export function loadConfigFrom(path: string, _homeDir: string): { config: ResourcesConfig | null; warning?: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { config: null };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return {
			config: null,
			warning: `Failed to parse config at ${path}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	const obj = parsed as Record<string, unknown>;
	const baseDir = dirname(path);
	const rawLocs = Array.isArray(obj?.locations) ? (obj.locations as unknown[]) : [];
	const locations: NormalizedLocation[] = [];
	for (const r of rawLocs) {
		const n = normalizeLocationEntry(r, baseDir);
		if (n) locations.push(n);
	}
	const rawRemotes = Array.isArray(obj?.remotes) ? (obj.remotes as unknown[]) : [];
	const remotes: NormalizedRemote[] = [];
	for (const r of rawRemotes) {
		const n = normalizeRemoteEntry(r);
		if (n) remotes.push(n);
	}
	return { config: { locations, remotes } };
}

// ── ensureDefaultConfig ───────────────────────────────────────────────────

export interface EnsureDefaultResult {
	config: ResourcesConfig;
	sourcePath: string;
	created: boolean;
	warnings: string[];
}

/**
 * Find the first existing config file from searchPaths; if none exist, create
 * the last path (the global home one) with `{ "locations": [] }`.
 * Never throws — write failures produce a warning + in-memory default.
 */
export function ensureDefaultConfig(searchPaths: string[], homeDir: string): EnsureDefaultResult {
	const warnings: string[] = [];

	// Try each path in order (first existing wins).
	for (const p of searchPaths) {
		const result = loadConfigFrom(p, homeDir);
		if (result.config !== null) {
			if (result.warning) warnings.push(result.warning);
			return { config: result.config, sourcePath: p, created: false, warnings };
		}
		if (result.warning) warnings.push(result.warning);
	}

	// No file found — create the last path (global home).
	const targetPath = searchPaths[searchPaths.length - 1];
	const defaultConfig: ResourcesConfig = { locations: [], remotes: [] };
	const defaultContent = JSON.stringify(defaultConfig, null, 2);

	try {
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, defaultContent, { flag: "wx" }); // exclusive create
		return { config: defaultConfig, sourcePath: targetPath, created: true, warnings };
	} catch (e) {
		// If the file was created between our check and write, try reading it.
		const retry = loadConfigFrom(targetPath, homeDir);
		if (retry.config !== null) {
			if (retry.warning) warnings.push(retry.warning);
			return { config: retry.config, sourcePath: targetPath, created: false, warnings };
		}
		warnings.push(`Could not create default config at ${targetPath}: ${e instanceof Error ? e.message : String(e)}`);
		return { config: defaultConfig, sourcePath: targetPath, created: false, warnings };
	}
}

// ── listCandidates ────────────────────────────────────────────────────────

export interface ListCandidatesResult {
	/** Candidate map: short-name → absolute extension dir. */
	candidates: Map<string, string>;
	/** Non-fatal warnings (e.g. alias ignored because location is multi-package). */
	warnings: string[];
}

/**
 * Walk each location and collect candidate extensions.
 *
 * For each location, the layout is auto-detected (same convention as
 * `scanCloneForCandidates`):
 *   1. If the location itself contains a `package.json`, treat it as a
 *      single dedicated extension. Candidate key = `entry.name ?? basename(path)`.
 *   2. Otherwise, list one-level subdirectories (skipping dotfiles and
 *      `node_modules`). Each subdir is a candidate keyed by its folder name.
 *      In this mode `entry.name` does not apply (a single alias cannot stand
 *      in for a directory of many extensions) and a warning is emitted.
 *
 * Locations are processed in declared order; the first location wins on
 * candidate-name collisions. Missing or unreadable locations are skipped
 * silently.
 *
 * Accepts both string entries (legacy) and `NormalizedLocation` objects.
 */
export function listCandidates(locations: ReadonlyArray<string | NormalizedLocation>): ListCandidatesResult {
	const out = new Map<string, string>();
	const warnings: string[] = [];

	for (const raw of locations) {
		const entry: NormalizedLocation = typeof raw === "string" ? { path: raw } : raw;
		const loc = entry.path;

		// (1) Single-package: location itself contains a package.json.
		let isSinglePackage = false;
		try {
			isSinglePackage = statSync(join(loc, "package.json")).isFile();
		} catch {
			isSinglePackage = false;
		}
		if (isSinglePackage) {
			const key = entry.name ?? basename(loc);
			if (!out.has(key)) out.set(key, loc);
			continue;
		}

		// (2) Multi-package: walk one level deep.
		if (entry.name) {
			warnings.push(
				`location ${loc}: alias "${entry.name}" ignored — the directory has no package.json so it's treated as a multi-package container; each subdirectory is its own candidate by name`,
			);
		}
		let entries: string[];
		try {
			entries = readdirSync(loc);
		} catch {
			continue;
		}
		for (const child of entries) {
			if (child.startsWith(".") || child === "node_modules") continue;
			if (out.has(child)) continue; // first location wins
			const fullPath = join(loc, child);
			try {
				const st = statSync(fullPath);
				if (!st.isDirectory()) continue;
			} catch {
				continue;
			}
			out.set(child, fullPath);
		}
	}
	return { candidates: out, warnings };
}

// ── resolveName ───────────────────────────────────────────────────────────

export type ResolveNameResult = { ok: true; path: string } | { ok: false; reason: "ambiguous" | "no-match"; matches?: string[] };

/**
 * Three-tier name resolution against a candidates map.
 * Tier (a) exact key, (b) case-insensitive exact, (c) case-insensitive substring.
 * First tier with exactly one match wins; >1 match → ambiguous; all empty → no-match.
 */
export function resolveName(name: string, candidates: Map<string, string>): ResolveNameResult {
	const lower = name.toLowerCase();

	// Tier (a): exact
	if (candidates.has(name)) {
		return { ok: true, path: candidates.get(name) as string };
	}

	// Tier (b): case-insensitive exact
	const ciExact: string[] = [];
	for (const key of candidates.keys()) {
		if (key.toLowerCase() === lower) ciExact.push(key);
	}
	if (ciExact.length === 1) return { ok: true, path: candidates.get(ciExact[0]) as string };
	if (ciExact.length > 1) return { ok: false, reason: "ambiguous", matches: ciExact };

	// Tier (c): case-insensitive substring
	const ciSub: string[] = [];
	for (const key of candidates.keys()) {
		if (key.toLowerCase().includes(lower)) ciSub.push(key);
	}
	if (ciSub.length === 1) return { ok: true, path: candidates.get(ciSub[0]) as string };
	if (ciSub.length > 1) return { ok: false, reason: "ambiguous", matches: ciSub };

	return { ok: false, reason: "no-match" };
}

// ── resolveAll ────────────────────────────────────────────────────────────

export interface ResolveAllResult {
	resolved: Array<{ name: string; path: string }>;
	errors: Array<{ name: string; message: string }>;
}

/**
 * Resolve all names against the candidates map.
 * Order-preserving; per-name errors are non-fatal.
 */
export function resolveAll(names: string[], candidates: Map<string, string>): ResolveAllResult {
	const resolved: Array<{ name: string; path: string }> = [];
	const errors: Array<{ name: string; message: string }> = [];
	const seenPaths = new Set<string>();

	for (const name of names) {
		const result = resolveName(name, candidates);
		if (!result.ok) {
			if (result.reason === "ambiguous") {
				errors.push({
					name,
					message: `ambiguous — matches: ${(result.matches ?? []).join(", ")}`,
				});
			} else {
				errors.push({ name, message: "no matching extension found" });
			}
			continue;
		}
		if (seenPaths.has(result.path)) continue; // dedupe paths
		seenPaths.add(result.path);
		resolved.push({ name, path: result.path });
	}

	return { resolved, errors };
}

// ── isPinnedGitSpec ───────────────────────────────────────────────────────

/**
 * Detect whether a git source spec is pinned via `@<ref>` (tag/branch/sha).
 * Matches Pi's own convention: `git:host/user/repo@v1`, `https://host/user/repo@main`.
 * Returns `false` for sources without a ref (e.g. `git:github.com/foo/bar`) and
 * for SCP-style `git@host:user/repo` (the `@` is part of the user, not a ref).
 */
export function isPinnedGitSpec(spec: string): boolean {
	const raw = spec.startsWith("git:") ? spec.slice(4) : spec;
	const lastSlash = raw.lastIndexOf("/");
	if (lastSlash < 0) return false;
	const tail = raw.slice(lastSlash + 1);
	const at = tail.indexOf("@");
	return at > 0 && at < tail.length - 1;
}

/** Remote source schemes that the loader can resolve via Pi's PackageManager. */
export type RemoteScheme = "npm" | "git";

/**
 * Classify a remote spec. `npm:` prefix → `npm`; everything else (git:,
 * https://, ssh://, git://, SCP-style) → `git`. Mirrors Pi's `parseSource()`
 * convention from `@earendil-works/pi-coding-agent`.
 */
export function getRemoteScheme(spec: string): RemoteScheme {
	return spec.startsWith("npm:") ? "npm" : "git";
}

/**
 * Detect whether an `npm:` spec is pinned to a specific version.
 *
 *   npm:pkg                  → unpinned
 *   npm:@scope/pkg           → unpinned (leading `@` is the scope marker)
 *   npm:pkg@latest           → unpinned (`latest` is a moving dist-tag)
 *   npm:pkg@1.2.3            → pinned
 *   npm:@scope/pkg@1.2.3     → pinned
 *   npm:@scope/pkg@next      → pinned (any explicit dist-tag besides `latest`)
 */
export function isPinnedNpmSpec(spec: string): boolean {
	if (!spec.startsWith("npm:")) return false;
	const body = spec.slice(4);
	// Scoped packages begin with `@` — that first `@` is the scope marker,
	// not a version separator. The version, if any, is after the LAST `@`
	// at index > 0.
	const lastAt = body.lastIndexOf("@");
	if (lastAt <= 0) return false;
	const version = body.slice(lastAt + 1);
	return version.length > 0 && version !== "latest";
}

/**
 * Unified "is this spec pinned?" check across both schemes. Used by the
 * loader to decide whether to refresh a remote on first use this session.
 */
export function isPinnedRemoteSpec(spec: string): boolean {
	return getRemoteScheme(spec) === "npm" ? isPinnedNpmSpec(spec) : isPinnedGitSpec(spec);
}

// ── scanCloneForCandidates ────────────────────────────────────────────────

export interface ScanCloneResult {
	/** Candidate map: short-name → absolute extension dir within the clone. */
	candidates: Map<string, string>;
	/** True iff the clone was a multi-package monorepo (`packages/` layout). */
	isMonorepo: boolean;
}

/**
 * Given a cloned remote's root directory, derive a candidate map by basename.
 *
 * Auto-detects layout:
 *  - If `<root>/packages/` exists → walk it as a monorepo (one-level subdirs).
 *    `alias` does NOT apply (a single alias cannot stand in for many sub-packages).
 *  - Else if `<root>/package.json` exists → treat the clone itself as a single
 *    package, keyed by `alias` if provided, else its directory basename.
 *  - Otherwise → empty map.
 *
 * Same filtering as `listCandidates`: skip dotfiles and `node_modules`.
 */
export function scanCloneForCandidates(cloneRoot: string, alias?: string): ScanCloneResult {
	const out = new Map<string, string>();
	const pkgsDir = join(cloneRoot, "packages");
	let hasPackagesDir = false;
	try {
		hasPackagesDir = statSync(pkgsDir).isDirectory();
	} catch {
		hasPackagesDir = false;
	}
	if (hasPackagesDir) {
		let entries: string[] = [];
		try {
			entries = readdirSync(pkgsDir);
		} catch {
			return { candidates: out, isMonorepo: true };
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			const fullPath = join(pkgsDir, entry);
			try {
				if (!statSync(fullPath).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!out.has(entry)) out.set(entry, fullPath);
		}
		return { candidates: out, isMonorepo: true };
	}

	try {
		statSync(join(cloneRoot, "package.json"));
	} catch {
		return { candidates: out, isMonorepo: false };
	}
	const key = alias ?? basename(cloneRoot);
	if (key) out.set(key, cloneRoot);
	return { candidates: out, isMonorepo: false };
}

// ── internal ──────────────────────────────────────────────────────────────

function dedupe(arr: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of arr) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}
