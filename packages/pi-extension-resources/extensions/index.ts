/**
 * Pi Extension Resources
 *
 * Auto-loads the `prompts/` and `skills/` folders that ship alongside any
 * extension Pi has loaded — whether via `pi -e <path>`, `settings.json`
 * `extensions`, or `settings.json` `packages`.
 *
 * Why: many Pi extension packages ship companion prompts and skills inside
 * the same directory (e.g. `<pkg>/prompts/*.md`, `<pkg>/skills/<name>/SKILL.md`),
 * but Pi's default resource loader only scans `~/.pi/agent/{prompts,skills}/`
 * and `.pi/{prompts,skills}/`. Without this extension you'd have to symlink
 * each package's resource folders into one of those locations by hand. With
 * it, just load the extension and its companions follow.
 *
 * Additionally, the `--with` flag (and `PI_WITH` env var) lets you load
 * extensions by short name, resolved against a config file's `locations[]`.
 *
 * Surface:
 *   /ext-resources       diagnostic — show what got contributed and where
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAndRunExtension } from "./loader.js";
import {
	configSearchPaths,
	ensureDefaultConfig,
	listCandidates,
	parseWithFromArgv,
	parseWithFromEnv,
	resolveAll,
} from "./resolver.js";

// ── Types ────────────────────────────────────────────────────────────────

interface SourceInfoLike {
	source?: string;
	path?: string;
	baseDir?: string;
}

interface SourceInfoCarrier {
	sourceInfo?: SourceInfoLike;
}

export interface ContributedResources {
	roots: string[];
	promptPaths: string[];
	skillPaths: string[];
}

// ── Pure helpers (exported for tests) ────────────────────────────────────

/**
 * Walk up from a file or directory to the nearest enclosing `package.json`
 * directory. Returns null if none found before hitting the filesystem root.
 */
export function findPackageRoot(start: string): string | null {
	let dir: string;
	try {
		const stat = statSync(start);
		dir = stat.isDirectory() ? resolve(start) : dirname(resolve(start));
	} catch {
		// Path doesn't exist — treat the seed as a directory.
		dir = resolve(start);
	}
	while (true) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Given the source-info carriers from `pi.getAllTools()` and
 * `pi.getCommands()`, derive the unique extension package roots and any
 * `prompts/` / `skills/` subfolders that exist on disk.
 *
 * Order is stable: first occurrence wins per root, in the order items are
 * passed in.
 */
export function collectResourcePaths(items: Iterable<SourceInfoCarrier>): ContributedResources {
	const roots: string[] = [];
	const promptPaths: string[] = [];
	const skillPaths: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const src = item.sourceInfo;
		if (!src) continue;
		if (src.source === "builtin" || src.source === "sdk") continue;
		const seed = src.baseDir ?? (src.path ? dirname(src.path) : null);
		if (!seed) continue;
		const root = findPackageRoot(seed);
		if (!root || seen.has(root)) continue;
		seen.add(root);
		roots.push(root);
		const promptsDir = join(root, "prompts");
		const skillsDir = join(root, "skills");
		if (existsSync(promptsDir)) promptPaths.push(promptsDir);
		if (existsSync(skillsDir)) skillPaths.push(skillsDir);
	}
	return { roots, promptPaths, skillPaths };
}

export function summarizeContribution(report: ContributedResources): Array<{ root: string; kinds: string[] }> {
	const out: Array<{ root: string; kinds: string[] }> = [];
	const prompts = new Set(report.promptPaths);
	const skills = new Set(report.skillPaths);
	for (const root of report.roots) {
		const kinds: string[] = [];
		if (prompts.has(join(root, "prompts"))) kinds.push("prompts");
		if (skills.has(join(root, "skills"))) kinds.push("skills");
		if (kinds.length > 0) out.push({ root, kinds });
	}
	return out;
}

// ── Module-level state for --with ────────────────────────────────────────

/** Bundle paths that were successfully loaded via --with. */
const LOADED_VIA_WITH: string[] = [];

let withProcessed = false;
let withNotified = false;
let withStartupSummary: {
	loaded: string[];
	errors: Array<{ name: string; message: string }>;
} | null = null;

// ── Extension entry ──────────────────────────────────────────────────────

export default async function extensionResources(pi: ExtensionAPI): Promise<void> {
	// ── 1. Register --with flag (for --help visibility) ──────────────────
	try {
		pi.registerFlag("with", {
			type: "string",
			default: "",
			description:
				"Comma-separated bundle names to load via pi-extension-resources (e.g. --with pi-experts,agent-chain). Resolved against locations in ~/.pi/agent/extensions/pi-extension-resources.json. Repeatable.",
		});
	} catch {
		// benign on reload — flag already registered
	}

	// ── 2. One-shot --with processing (startup only) ──────────────────────
	if (!withProcessed) {
		withProcessed = true;
		try {
			// Parse names from argv and env, deduped, argv order first.
			const argvNames = parseWithFromArgv(process.argv.slice(2));
			const envNames = parseWithFromEnv(process.env);
			// Merge: argv first, then env entries not already seen.
			const seen = new Set(argvNames);
			const allNames = [...argvNames];
			for (const n of envNames) {
				if (!seen.has(n)) {
					seen.add(n);
					allNames.push(n);
				}
			}

			if (allNames.length > 0) {
				const home = homedir();
				const searchPaths = configSearchPaths(process.env, home);
				const { config, warnings } = ensureDefaultConfig(searchPaths, home);

				const startupErrors: Array<{ name: string; message: string }> = [];
				for (const w of warnings) {
					startupErrors.push({ name: "(config)", message: w });
				}

				const candidates = listCandidates(config.locations);
				const { resolved, errors } = resolveAll(allNames, candidates);
				startupErrors.push(...errors);

				const loadedNames: string[] = [];
				for (const { name, path } of resolved) {
					const result = await loadAndRunExtension(path, pi);
					if (result.ok) {
						LOADED_VIA_WITH.push(path);
						loadedNames.push(name);
					} else {
						startupErrors.push({ name, message: result.error });
					}
				}

				withStartupSummary = { loaded: loadedNames, errors: startupErrors };
			}
		} catch (e) {
			// Loader failure must not abort the host extension.
			const msg = e instanceof Error ? e.message : String(e);
			withStartupSummary = { loaded: [], errors: [{ name: "(loader)", message: msg }] };
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	const computeReport = (): ContributedResources => {
		const items: SourceInfoCarrier[] = [
			...pi.getAllTools().map((t) => ({ sourceInfo: t.sourceInfo as SourceInfoLike })),
			...pi.getCommands().map((c) => ({ sourceInfo: c.sourceInfo as SourceInfoLike })),
		];
		const report = collectResourcePaths(items);

		// Augment with companion resources from --with-loaded extensions.
		// Their tools appear sourced from pi-extension-resources, so the normal
		// walk won't find them — we contribute their paths directly.
		const existingRoots = new Set(report.roots);
		for (const bundlePath of LOADED_VIA_WITH) {
			const root = findPackageRoot(bundlePath);
			if (!root || existingRoots.has(root)) continue;
			existingRoots.add(root);
			report.roots.push(root);
			const promptsDir = join(root, "prompts");
			const skillsDir = join(root, "skills");
			if (existsSync(promptsDir) && !report.promptPaths.includes(promptsDir)) {
				report.promptPaths.push(promptsDir);
			}
			if (existsSync(skillsDir) && !report.skillPaths.includes(skillsDir)) {
				report.skillPaths.push(skillsDir);
			}
		}

		return report;
	};

	// ── Event handlers ────────────────────────────────────────────────────

	pi.on("resources_discover", async (_event, _ctx) => {
		const report = computeReport();
		return { promptPaths: report.promptPaths, skillPaths: report.skillPaths };
	});

	pi.on("session_start", (event, ctx) => {
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "reload") return; // quiet on reload

		// Existing companion-resources summary.
		const contributed = summarizeContribution(computeReport());
		if (contributed.length > 0) {
			const lines = [`[ext-resources] auto-loaded companion resources from ${contributed.length} extension(s):`];
			for (const c of contributed) lines.push(`  • ${basename(c.root)} [${c.kinds.join(" + ")}]`);
			ctx.ui.notify(lines.join("\n"), "info");
		}

		// --with startup notification (one-shot).
		if (reason === "startup" && !withNotified && withStartupSummary !== null) {
			withNotified = true;
			const { loaded, errors } = withStartupSummary;
			if (loaded.length > 0) {
				ctx.ui.notify(`[ext-resources] loaded via --with: ${loaded.join(", ")}`, "info");
			}
			if (errors.length > 0) {
				const lines = ["[ext-resources] --with errors:"];
				for (const { name, message } of errors) lines.push(`  • ${name}: ${message}`);
				ctx.ui.notify(lines.join("\n"), "warning");
			}
		}
	});

	// ── /ext-resources command ────────────────────────────────────────────

	pi.registerCommand("ext-resources", {
		description: "Show prompt/skill paths auto-loaded by pi-extension-resources",
		handler: async (_args, ctx) => {
			const report = computeReport();
			const lines: string[] = [`Detected ${report.roots.length} loaded extension package(s):`];
			const prompts = new Set(report.promptPaths);
			const skills = new Set(report.skillPaths);
			for (const root of report.roots) {
				const kinds: string[] = [];
				if (prompts.has(join(root, "prompts"))) kinds.push("prompts");
				if (skills.has(join(root, "skills"))) kinds.push("skills");
				const tag = kinds.length > 0 ? ` [${kinds.join(" + ")}]` : " (no companion resources)";
				lines.push(`  - ${root}${tag}`);
			}
			lines.push("", `Contributed prompt paths (${report.promptPaths.length}):`);
			for (const p of report.promptPaths) lines.push(`  - ${p}`);
			lines.push("", `Contributed skill paths (${report.skillPaths.length}):`);
			for (const p of report.skillPaths) lines.push(`  - ${p}`);

			// --with section
			lines.push("", `Loaded via --with (${LOADED_VIA_WITH.length}):`);
			if (LOADED_VIA_WITH.length === 0) {
				lines.push("  (none)");
			} else {
				for (const p of LOADED_VIA_WITH) lines.push(`  - ${p}`);
			}
			if (withStartupSummary && withStartupSummary.errors.length > 0) {
				lines.push("", "--with errors:");
				for (const { name, message } of withStartupSummary.errors) {
					lines.push(`  • ${name}: ${message}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
