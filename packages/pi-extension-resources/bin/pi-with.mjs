#!/usr/bin/env node
/**
 * pi-with — wrapper that expands `--with <names>` into `pi -e <path>` flags.
 *
 * Usage:
 *   pi-with --with pi-experts,agent-chain [other pi args...]
 *   pi-with --with pi-experts --with agent-chain [other pi args...]
 *   pi-with --with-help
 *
 * Anything that isn't `--with` / `--with-help` is passed through to `pi`
 * unchanged. Resolved `-e <path>` pairs are inserted immediately after the
 * `pi` argv0, so the rest of your flags stay in the same order.
 *
 * Configuration:
 *   ~/.pi/agent/extensions/ext-resources.json    (or $PI_EXT_RESOURCES_CONFIG)
 *   {
 *     "locations": ["/abs/path/to/packages-dir", ...]
 *   }
 *
 * Name resolution (per name, tiered, first tier with a unique match wins):
 *   1. exact folder name
 *   2. case-insensitive exact
 *   3. case-insensitive substring
 * Ambiguous and missing names cause exit code 2 with a clear message.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HELP_TEXT = `pi-with — short-name wrapper around \`pi -e <path>\`

USAGE
  pi-with [--with <names>]... [pi flags...]

WRAPPER FLAGS
  --with <names>     Comma-separated extension names to resolve. Repeatable.
  --with-help        Show this message and exit.

ALL OTHER ARGS pass through to \`pi\` unchanged.

CONFIG
  ~/.pi/agent/extensions/ext-resources.json (or \$PI_EXT_RESOURCES_CONFIG)
  { "locations": ["/abs/path/to/packages-dir", ...] }

EXAMPLES
  pi-with --with pi-experts,agent-chain --model claude-opus-4
  pi-with --with pi-experts -p "Audit src/" --no-tools
  pi-with                                  # transparent passthrough\n`;

// ── Helpers ──────────────────────────────────────────────────────────────

function expandHome(p) {
	if (p === "~") return homedir();
	if (typeof p === "string" && p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function configSearchPaths(env = process.env) {
	const out = [];
	if (env.PI_EXT_RESOURCES_CONFIG) out.push(env.PI_EXT_RESOURCES_CONFIG);
	out.push(join(homedir(), ".pi", "agent", "extensions", "ext-resources.json"));
	return out;
}

function loadConfig() {
	for (const p of configSearchPaths()) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			return {
				locations: (raw.locations ?? []).map(expandHome),
				configPath: p,
			};
		} catch (e) {
			console.error(`pi-with: failed to parse ${p}: ${e.message}`);
		}
	}
	return { locations: [], configPath: null };
}

function listCandidates(locations) {
	const out = [];
	const seen = new Set();
	for (const loc of locations) {
		if (!existsSync(loc)) continue;
		let entries;
		try {
			entries = readdirSync(loc, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			const isDirLike = ent.isDirectory() || ent.isSymbolicLink();
			if (!isDirLike) continue;
			if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
			if (seen.has(ent.name)) continue;
			seen.add(ent.name);
			out.push({ name: ent.name, path: join(loc, ent.name) });
		}
	}
	return out;
}

function resolveName(name, candidates) {
	const exact = candidates.filter((c) => c.name === name);
	if (exact.length === 1) return { resolved: exact[0] };
	if (exact.length > 1) return ambig(name, exact);

	const lower = name.toLowerCase();
	const ciExact = candidates.filter((c) => c.name.toLowerCase() === lower);
	if (ciExact.length === 1) return { resolved: ciExact[0] };
	if (ciExact.length > 1) return ambig(name, ciExact);

	const substring = candidates.filter((c) => c.name.toLowerCase().includes(lower));
	if (substring.length === 1) return { resolved: substring[0] };
	if (substring.length > 1) return ambig(name, substring);

	return { error: `no candidate matches "${name}"` };
}

function ambig(name, hits) {
	return {
		error: `"${name}" is ambiguous — matches: ${hits.map((h) => h.name).join(", ")}`,
	};
}

// ── Argv split ────────────────────────────────────────────────────────────

/**
 * Extract `--with <value>` / `--with=<value>` occurrences from argv and
 * return both the collected name list and the remaining args (in original
 * order, with the consumed flags removed). Also handles `--with-help`.
 */
export function splitArgv(argv) {
	const names = [];
	const rest = [];
	let helpRequested = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--with-help") {
			helpRequested = true;
			continue;
		}
		if (a === "--with") {
			const next = argv[i + 1];
			if (next === undefined) {
				throw new Error(`--with requires a value`);
			}
			names.push(next);
			i++;
			continue;
		}
		if (a.startsWith("--with=")) {
			names.push(a.slice("--with=".length));
			continue;
		}
		rest.push(a);
	}
	const flatNames = names
		.flatMap((v) => v.split(","))
		.map((s) => s.trim())
		.filter(Boolean);
	return { names: flatNames, rest, helpRequested };
}

// ── Main ──────────────────────────────────────────────────────────────────

function which(cmd) {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
	if (r.status !== 0) return null;
	return r.stdout.split(/\r?\n/)[0].trim() || null;
}

function main() {
	const argv = process.argv.slice(2);
	let parsed;
	try {
		parsed = splitArgv(argv);
	} catch (e) {
		console.error(`pi-with: ${e.message}`);
		console.error(`pi-with: try --with-help for usage`);
		process.exit(2);
	}

	if (parsed.helpRequested) {
		process.stdout.write(HELP_TEXT);
		process.exit(0);
	}

	const piBin = process.env.PI_BIN || which("pi");
	if (!piBin) {
		console.error(`pi-with: \`pi\` not found on PATH (set PI_BIN to override)`);
		process.exit(127);
	}

	// Fast path: no --with given. Transparent passthrough.
	if (parsed.names.length === 0) {
		const r = spawnSync(piBin, parsed.rest, { stdio: "inherit" });
		process.exit(r.status ?? 0);
	}

	// Resolve each name.
	const cfg = loadConfig();
	if (cfg.locations.length === 0) {
		console.error(
			`pi-with: no \`locations\` configured. Edit ${cfg.configPath ?? join(homedir(), ".pi", "agent", "extensions", "ext-resources.json")}:`,
		);
		console.error(`  { "locations": ["/abs/path/to/packages-dir", ...] }`);
		process.exit(2);
	}
	const candidates = listCandidates(cfg.locations);

	const resolved = [];
	const errors = [];
	const seenPaths = new Set();
	for (const name of parsed.names) {
		const r = resolveName(name, candidates);
		if (r.error) {
			errors.push(r.error);
			continue;
		}
		if (seenPaths.has(r.resolved.path)) continue;
		seenPaths.add(r.resolved.path);
		resolved.push(r.resolved);
	}

	if (errors.length > 0) {
		console.error(`pi-with: resolution failed:`);
		for (const e of errors) console.error(`  • ${e}`);
		if (candidates.length > 0) {
			console.error(`pi-with: known candidates (${candidates.length}):`);
			for (const c of candidates) console.error(`  • ${c.name}`);
		} else {
			console.error(`pi-with: no candidates found under any of:`);
			for (const l of cfg.locations) console.error(`  • ${l}`);
		}
		process.exit(2);
	}

	const eFlags = resolved.flatMap((r) => ["-e", r.path]);
	const finalArgs = [...eFlags, ...parsed.rest];

	if (process.env.PI_WITH_DEBUG) {
		console.error(`pi-with: resolved ${parsed.names.length} → ${resolved.map((r) => r.name).join(", ")}`);
		console.error(`pi-with: exec ${piBin} ${finalArgs.map((a) => JSON.stringify(a)).join(" ")}`);
	}

	const r = spawnSync(piBin, finalArgs, { stdio: "inherit" });
	process.exit(r.status ?? 0);
}

main();
