/**
 * Pure resolution helpers for the --with flag.
 * No ExtensionAPI dependency — safe to import from tests and from the loader.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ResourcesConfig {
	locations: string[];
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
 * `$PI_EXTENSION_RESOURCES_CONFIG` (if set) wins; global home path is always last.
 */
export function configSearchPaths(env: NodeJS.ProcessEnv, homeDir: string): string[] {
	const globalPath = join(homeDir, ".pi", "agent", "extensions", "pi-extension-resources.json");
	const envPath = env.PI_EXTENSION_RESOURCES_CONFIG;
	return envPath ? [envPath, globalPath] : [globalPath];
}

// ── loadConfigFrom ────────────────────────────────────────────────────────

/**
 * Load and validate config from a single path.
 * Missing → { config: null }.
 * Malformed JSON → { config: null, warning }.
 * Valid → expand `~` in each `locations` entry, drop non-strings.
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
	const rawLocs = Array.isArray(obj?.locations) ? (obj.locations as unknown[]) : [];
	const locations = rawLocs
		.filter((l): l is string => typeof l === "string")
		.map((l) => {
			const expanded = expandHome(l);
			return isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
		});
	return { config: { locations } };
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
	const defaultConfig: ResourcesConfig = { locations: [] };
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

/**
 * For each location (in order), list one-level subdirectories (skip dotfiles
 * and node_modules). Returns a Map of basename → absolute path.
 * First location wins on duplicate folder names.
 * Missing locations are skipped silently.
 */
export function listCandidates(locations: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const loc of locations) {
		let entries: string[];
		try {
			entries = readdirSync(loc);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			if (out.has(entry)) continue; // first location wins
			const fullPath = join(loc, entry);
			try {
				const st = statSync(fullPath);
				if (!st.isDirectory()) continue;
			} catch {
				continue;
			}
			out.set(entry, fullPath);
		}
	}
	return out;
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
