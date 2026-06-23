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

/**
 * On-disk shape of one `locations[]` entry. Either a plain string (legacy) or
 * an object with an optional alias overriding the candidate key.
 */
export type RawLocationEntry = string | { path: string; name?: string };

/** On-disk shape of one `remotes[]` entry. Same string/object shape rules. */
export type RawRemoteEntry = string | { spec: string; name?: string };

export interface RawConfigShape {
	locations: RawLocationEntry[];
	remotes: RawRemoteEntry[];
}

export interface AddResult {
	added: boolean;
	kind: SpecKind;
	/** The path (local) or spec (remote) that was stored. */
	stored: string;
	/** The alias that was stored alongside `stored`, if any. */
	name?: string;
}

export interface RemoveResult {
	removedFrom: SpecKind[];
	matchedValue: string;
}

// Entry-shape helpers.

/** Extract the path string from a `locations[]` entry. */
export function locationEntryPath(entry: RawLocationEntry): string {
	return typeof entry === "string" ? entry : entry.path;
}

/** Extract the spec string from a `remotes[]` entry. */
export function remoteEntrySpec(entry: RawRemoteEntry): string {
	return typeof entry === "string" ? entry : entry.spec;
}

/** Extract the optional alias from any entry, or undefined. */
export function entryName(entry: RawLocationEntry | RawRemoteEntry): string | undefined {
	return typeof entry === "string" ? undefined : entry.name;
}

/**
 * Build a stored location entry. Emits the object form iff `name` is set;
 * otherwise a plain string for backward-compat with old configs.
 */
function makeLocationEntry(path: string, name?: string): RawLocationEntry {
	return name ? { path, name } : path;
}

/** Build a stored remote entry. Same shape rules as locations. */
function makeRemoteEntry(spec: string, name?: string): RawRemoteEntry {
	return name ? { spec, name } : spec;
}

// ── detectSpecKind ───────────────────────────────────────────────────────

const REMOTE_PREFIX_RE = /^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/i;
// SCP-style: `git@host:user/repo`. Requires `:` *not* followed by `/`.
const SCP_LIKE_RE = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+:[^/]/;

/**
 * Heuristic: distinguish a local directory path from a remote package spec.
 *
 * Treated as remote:
 *   - `npm:` prefix (e.g. `npm:@scope/pkg`, `npm:pkg@1.2.3`)
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

function asEntryArray<T extends RawLocationEntry | RawRemoteEntry>(v: unknown, pathKey: "path" | "spec"): T[] {
	if (!Array.isArray(v)) return [];
	const out: T[] = [];
	for (const x of v) {
		if (typeof x === "string") {
			if (x.length > 0) out.push(x as T);
			continue;
		}
		if (x && typeof x === "object") {
			const o = x as Record<string, unknown>;
			const p = o[pathKey];
			if (typeof p !== "string" || p.length === 0) continue;
			const name = typeof o.name === "string" && o.name.length > 0 ? o.name : undefined;
			out.push((name ? { [pathKey]: p, name } : { [pathKey]: p }) as T);
		}
	}
	return out;
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
		locations: asEntryArray<RawLocationEntry>(obj.locations, "path"),
		remotes: asEntryArray<RawRemoteEntry>(obj.remotes, "spec"),
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
	name?: string,
): { ok: true; result: AddResult } | { ok: false; error: string } {
	const kind = detectSpecKind(input);
	const alias = name && name.length > 0 ? name : undefined;
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

	if (kind === "local") {
		const idx = config.locations.findIndex((e) => locationEntryPath(e) === stored);
		if (idx >= 0) {
			const existingName = entryName(config.locations[idx]);
			// Same path AND same alias → no-op.
			if (existingName === alias) {
				return { ok: true, result: { added: false, kind, stored, name: alias } };
			}
			// Same path, different alias → update in place.
			config.locations = [
				...config.locations.slice(0, idx),
				makeLocationEntry(stored, alias),
				...config.locations.slice(idx + 1),
			];
		} else {
			config.locations = [...config.locations, makeLocationEntry(stored, alias)];
		}
	} else {
		const idx = config.remotes.findIndex((e) => remoteEntrySpec(e) === stored);
		if (idx >= 0) {
			const existingName = entryName(config.remotes[idx]);
			if (existingName === alias) {
				return { ok: true, result: { added: false, kind, stored, name: alias } };
			}
			config.remotes = [...config.remotes.slice(0, idx), makeRemoteEntry(stored, alias), ...config.remotes.slice(idx + 1)];
		} else {
			config.remotes = [...config.remotes, makeRemoteEntry(stored, alias)];
		}
	}
	writeConfigRaw(configPath, config);
	return { ok: true, result: { added: true, kind, stored, name: alias } };
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
	// Match against the path/spec field of each entry, *or* the alias — so
	// `/loader-with remove plan` removes the entry named "plan" without
	// requiring the full path.
	const matches = (value: string, name: string | undefined) =>
		candidates.has(value) || (name !== undefined && candidates.has(name));
	const afterLoc = beforeLoc.filter((e) => !matches(locationEntryPath(e), entryName(e)));
	const afterRem = beforeRem.filter((e) => !matches(remoteEntrySpec(e), entryName(e)));
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

/** Render one entry for `/loader-with` list output. */
function renderEntry(value: string, name: string | undefined): string {
	return name ? `${value}  (as ${name})` : value;
}

export function formatList(config: RawConfigShape, configPath: string): string {
	const lines: string[] = [`Config: ${configPath}`];
	lines.push("", `locations (${config.locations.length}):`);
	if (config.locations.length === 0) lines.push("  (none)");
	else for (const e of config.locations) lines.push(`  - ${renderEntry(locationEntryPath(e), entryName(e))}`);
	lines.push("", `remotes (${config.remotes.length}):`);
	if (config.remotes.length === 0) lines.push("  (none)");
	else for (const e of config.remotes) lines.push(`  - ${renderEntry(remoteEntrySpec(e), entryName(e))}`);
	return lines.join("\n");
}

/**
 * Split a `/loader-with add` argument string into `(value, name?)`.
 *
 * Supports two trailing-suffix forms:
 *   - `<value> as <name>`
 *   - `<value> --name <name>`
 *
 * The keyword is only consumed at the very end of the argument string, so
 * inputs like `git:github.com/foo/bar` (no suffix) parse as `{ value, name: undefined }`.
 */
export function parseAddArgs(input: string): { value: string; name?: string } {
	const raw = (input ?? "").trim();
	if (!raw) return { value: "" };
	let m = raw.match(/^(.+?)\s+--name\s+(\S+)\s*$/);
	if (m) return { value: m[1].trim(), name: m[2] };
	m = raw.match(/^(.+?)\s+as\s+(\S+)\s*$/i);
	if (m) return { value: m[1].trim(), name: m[2] };
	return { value: raw };
}
