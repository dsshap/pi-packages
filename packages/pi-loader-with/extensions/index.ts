/**
 * Pi Extension Resources
 *
 * Provides the `--with <names>` flag (and `PI_WITH` env var) for loading
 * Pi extensions by short name, resolved against a config file's `locations[]`.
 *
 * For each `--with`-loaded extension, the package's `package.json` is read
 * and any `pi.prompts` / `pi.skills` entries are contributed to Pi's
 * resource discovery — matching the behavior of Pi's native `-e <path>`
 * loader, which our dynamic loader otherwise bypasses.
 *
 * Surface:
 *   --with <names>       load extensions by short name (CLI flag, repeatable)
 *   PI_WITH=<names>      env-var equivalent
 */

import { homedir } from "node:os";
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

/** One extension successfully loaded via --with, with its manifest resources. */
export interface WithLoadedExtension {
	name: string;
	path: string;
	promptPaths: string[];
	skillPaths: string[];
}

/** Aggregated resource paths contributed by all --with-loaded extensions. */
export interface ContributedResources {
	promptPaths: string[];
	skillPaths: string[];
}

// ── Pure helpers (exported for tests) ────────────────────────────────────

/**
 * Aggregate prompt/skill paths across multiple --with-loaded extensions,
 * preserving first-occurrence order and removing duplicates.
 */
export function aggregateResources(entries: Iterable<WithLoadedExtension>): ContributedResources {
	const promptPaths: string[] = [];
	const skillPaths: string[] = [];
	const seenPrompts = new Set<string>();
	const seenSkills = new Set<string>();
	for (const e of entries) {
		for (const p of e.promptPaths) {
			if (!seenPrompts.has(p)) {
				seenPrompts.add(p);
				promptPaths.push(p);
			}
		}
		for (const p of e.skillPaths) {
			if (!seenSkills.has(p)) {
				seenSkills.add(p);
				skillPaths.push(p);
			}
		}
	}
	return { promptPaths, skillPaths };
}

// ── Module-level state for --with ────────────────────────────────────────

const LOADED_VIA_WITH: WithLoadedExtension[] = [];

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
				"Comma-separated bundle names to load via pi-loader-with (e.g. --with pi-experts,agent-chain). Resolved against locations in ~/.pi/agent/extensions/pi-loader-with.json. Repeatable.",
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
						LOADED_VIA_WITH.push({
							name,
							path,
							promptPaths: result.promptPaths,
							skillPaths: result.skillPaths,
						});
						loadedNames.push(name);
					} else {
						startupErrors.push({ name, message: result.error });
					}
				}

				withStartupSummary = { loaded: loadedNames, errors: startupErrors };
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			withStartupSummary = { loaded: [], errors: [{ name: "(loader)", message: msg }] };
		}
	}

	// ── Event handlers ────────────────────────────────────────────────────

	pi.on("resources_discover", async (_event, _ctx) => {
		return aggregateResources(LOADED_VIA_WITH);
	});

	pi.on("session_start", (event, ctx) => {
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "reload") return; // quiet on reload

		// --with startup notification (one-shot).
		if (reason === "startup" && !withNotified && withStartupSummary !== null) {
			withNotified = true;
			const { loaded, errors } = withStartupSummary;
			if (loaded.length > 0) {
				ctx.ui.notify(`[loader-with] loaded: ${loaded.join(", ")}`, "info");
			}
			if (errors.length > 0) {
				const lines = ["[loader-with] --with errors:"];
				for (const { name, message } of errors) lines.push(`  • ${name}: ${message}`);
				ctx.ui.notify(lines.join("\n"), "warning");
			}
		}
	});
}
