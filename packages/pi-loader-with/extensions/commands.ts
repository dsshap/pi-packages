/**
 * `/loader-with` command implementation.
 *
 * Mutates the on-disk config (the same `pi-loader-with.json` resolved at
 * factory time) so users can add or remove `locations`/`remotes` without
 * hand-editing JSON. Changes take effect on the next pi session — extensions
 * cannot be loaded or unloaded mid-session.
 *
 * The helpers below are pure (no Pi API dependency) and are exported for
 * unit testing.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome } from "./resolver.js";

// ── Types ────────────────────────────────────────────────────────────────

export type SpecKind = "local" | "remote";

export interface RawConfigShape {
	locations: string[];
	remotes: string[];
}

export interface AddResult {
	added: boolean;
	kind: SpecKind;
	stored: string;
}

export interface RemoveResult {
	removedFrom: SpecKind[];
	matchedValue: string;
}

// ── detectSpecKind ───────────────────────────────────────────────────────

const REMOTE_PREFIX_RE = /^(git:|https?:\/\/|ssh:\/\/|git:\/\/)/i;
// SCP-style: `git@host:user/repo`. Requires `:` *not* followed by `/`.
const SCP_LIKE_RE = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+:[^/]/;

/**
 * Heuristic: distinguish a local directory path from a git source spec.
 *
 * Treated as remote:
 *   - `git:`, `https://`, `http://`, `ssh://`, `git://` prefixes
 *   - SCP-style `user@host:path` (e.g. `git@github.com:foo/bar`)
 *
 * Everything else is treated as local. Absolute paths, `~`-paths, and
 * relative paths all qualify.
 */
export function detectSpecKind(input: string): SpecKind {
	const trimmed = input.trim();
	if (REMOTE_PREFIX_RE.test(trimmed)) return "remote";
	if (SCP_LIKE_RE.test(trimmed) && !trimmed.startsWith("/")) return "remote";
	return "local";
}

// ── validateLocalPath ────────────────────────────────────────────────────

export function validateLocalPath(input: string, cwd: string): { ok: true; abs: string } | { ok: false; error: string } {
	const expanded = expandHome(input.trim());
	const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	try {
		const st = statSync(abs);
		if (!st.isDirectory()) return { ok: false, error: `not a directory: ${abs}` };
		return { ok: true, abs };
	} catch {
		return { ok: false, error: `path does not exist: ${abs}` };
	}
}

// ── Config read/write ────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function readConfigRaw(path: string): RawConfigShape {
	if (!existsSync(path)) return { locations: [], remotes: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`config file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const obj = (parsed ?? {}) as { locations?: unknown; remotes?: unknown };
	return {
		locations: asStringArray(obj.locations),
		remotes: asStringArray(obj.remotes),
	};
}

export function writeConfigRaw(path: string, config: RawConfigShape): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// ── addToConfig ──────────────────────────────────────────────────────────

export function addToConfig(
	configPath: string,
	input: string,
	cwd: string,
): { ok: true; result: AddResult } | { ok: false; error: string } {
	const kind = detectSpecKind(input);
	let stored: string;
	if (kind === "local") {
		const v = validateLocalPath(input, cwd);
		if (!v.ok) return { ok: false, error: v.error };
		stored = v.abs;
	} else {
		stored = input.trim();
	}
	let config: RawConfigShape;
	try {
		config = readConfigRaw(configPath);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const arr = kind === "local" ? config.locations : config.remotes;
	if (arr.includes(stored)) {
		return { ok: true, result: { added: false, kind, stored } };
	}
	if (kind === "local") config.locations = [...arr, stored];
	else config.remotes = [...arr, stored];
	writeConfigRaw(configPath, config);
	return { ok: true, result: { added: true, kind, stored } };
}

// ── removeFromConfig ─────────────────────────────────────────────────────

/**
 * Remove a `locations` or `remotes` entry matching `input`. For local paths
 * we also try the expanded-home and cwd-resolved forms so the user can
 * remove `~/foo` by typing `~/foo`, `/Users/.../foo`, or `./foo`.
 */
export function removeFromConfig(
	configPath: string,
	input: string,
	cwd: string,
): { ok: true; result: RemoveResult } | { ok: false; error: string } {
	const trimmed = input.trim();
	const expanded = expandHome(trimmed);
	const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const candidates = new Set([trimmed, expanded, abs]);

	let config: RawConfigShape;
	try {
		config = readConfigRaw(configPath);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}

	const removedFrom: SpecKind[] = [];
	const beforeLoc = config.locations;
	const beforeRem = config.remotes;
	const afterLoc = beforeLoc.filter((x) => !candidates.has(x));
	const afterRem = beforeRem.filter((x) => !candidates.has(x));
	if (afterLoc.length < beforeLoc.length) removedFrom.push("local");
	if (afterRem.length < beforeRem.length) removedFrom.push("remote");
	if (removedFrom.length === 0) return { ok: false, error: `no matching entry found: ${input}` };

	config.locations = afterLoc;
	config.remotes = afterRem;
	writeConfigRaw(configPath, config);
	return { ok: true, result: { removedFrom, matchedValue: trimmed } };
}

// ── parseSubcommand ──────────────────────────────────────────────────────

export function parseSubcommand(args: string): { sub: string; rest: string } {
	const trimmed = (args ?? "").trim();
	if (!trimmed) return { sub: "", rest: "" };
	const m = trimmed.match(/^(\S+)\s*(.*)$/);
	if (!m) return { sub: trimmed, rest: "" };
	return { sub: m[1].toLowerCase(), rest: m[2].trim() };
}

// ── formatList ───────────────────────────────────────────────────────────

export function formatList(config: RawConfigShape, configPath: string): string {
	const lines: string[] = [`Config: ${configPath}`];
	lines.push("", `locations (${config.locations.length}):`);
	if (config.locations.length === 0) lines.push("  (none)");
	else for (const p of config.locations) lines.push(`  - ${p}`);
	lines.push("", `remotes (${config.remotes.length}):`);
	if (config.remotes.length === 0) lines.push("  (none)");
	else for (const p of config.remotes) lines.push(`  - ${p}`);
	return lines.join("\n");
}
