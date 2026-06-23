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
import {
	addToConfig,
	formatList,
	parseAddArgs,
	parseSubcommand,
	type RawConfigShape,
	readConfigRaw,
	removeFromConfig,
} from "./commands.js";
import { loadAndRunExtension } from "./loader.js";
import { ensureRemote, getPackageManager } from "./remotes.js";
import {
	configSearchPaths,
	ensureDefaultConfig,
	listCandidates,
	parseWithFromArgv,
	parseWithFromEnv,
	resolveName,
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

/** Path to the config file resolved at factory time, used by the /loader-with command. */
let configSourcePath: string | null = null;

// ── Extension entry ──────────────────────────────────────────────────────

export default async function extensionResources(pi: ExtensionAPI): Promise<void> {
	// ── 1. Register --with flag (for --help visibility) ──────────────────
	try {
		pi.registerFlag("with", {
			type: "string",
			default: "",
			description:
				"Comma-separated bundle names to load via pi-loader-with (e.g. --with pi-experts,agent-chain). Resolved against `locations` (local) and `remotes` (git/npm) declared in ~/.pi/agent/extensions/pi-loader-with.json. Repeatable.",
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

			const home = homedir();
			const searchPaths = configSearchPaths(process.env, home);
			if (allNames.length > 0) {
				const { config, sourcePath, warnings } = ensureDefaultConfig(searchPaths, home);
				configSourcePath = sourcePath;

				const startupErrors: Array<{ name: string; message: string }> = [];
				for (const w of warnings) {
					startupErrors.push({ name: "(config)", message: w });
				}

				// Local candidates: walked eagerly (cheap filesystem read).
				const { candidates: localCandidates, warnings: locWarnings } = listCandidates(config.locations);
				for (const w of locWarnings) startupErrors.push({ name: "(locations)", message: w });

				// Remote candidates: walked lazily, on first miss against locals.
				const remoteCandidateCache = new Map<string, Map<string, string>>();
				const remoteEntries = config.remotes;
				const pm = remoteEntries.length > 0 ? getPackageManager() : null;
				const reportProgress = (line: string) => process.stderr.write(`${line}\n`);

				const resolved: Array<{ name: string; path: string }> = [];
				const seenPaths = new Set<string>();

				for (const name of allNames) {
					// 1. Try local locations first.
					let hit = resolveName(name, localCandidates);
					let ambiguousReported = false;

					if (!hit.ok && hit.reason === "ambiguous") {
						startupErrors.push({
							name,
							message: `ambiguous in local locations — matches: ${(hit.matches ?? []).join(", ")}`,
						});
						ambiguousReported = true;
					}

					// 2. If no local hit, walk remotes in declared order, ensuring each
					//    one (clone + lazy refresh) on first use this session.
					if (!hit.ok && !ambiguousReported && pm !== null) {
						for (const remote of remoteEntries) {
							const remoteSpec = remote.spec;
							let candidates = remoteCandidateCache.get(remoteSpec);
							if (!candidates) {
								try {
									const result = await ensureRemote(remoteSpec, pm, { reportProgress, alias: remote.name });
									candidates = result.candidates;
									remoteCandidateCache.set(remoteSpec, candidates);
									if (remote.name && result.isMonorepo) {
										startupErrors.push({
											name: remoteSpec,
											message: `alias "${remote.name}" ignored — remote is a monorepo (each sub-package is its own candidate)`,
										});
									}
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									startupErrors.push({ name: remoteSpec, message: `remote ensure failed: ${msg}` });
									remoteCandidateCache.set(remoteSpec, new Map());
									continue;
								}
							}
							const r = resolveName(name, candidates);
							if (r.ok) {
								hit = r;
								break;
							}
							if (r.reason === "ambiguous") {
								startupErrors.push({
									name,
									message: `ambiguous in remote ${remoteSpec} — matches: ${(r.matches ?? []).join(", ")}`,
								});
								ambiguousReported = true;
								break;
							}
						}
					}

					if (!hit.ok) {
						if (!ambiguousReported) {
							startupErrors.push({ name, message: "no matching extension found" });
						}
						continue;
					}
					if (seenPaths.has(hit.path)) continue;
					seenPaths.add(hit.path);
					resolved.push({ name, path: hit.path });
				}

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
			} else {
				// No --with names this session, but still ensure the config file
				// exists so /loader-with has a target to write to.
				const { sourcePath } = ensureDefaultConfig(searchPaths, home);
				configSourcePath = sourcePath;
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

	// ── /loader-with command ─────────────────────────────────────────────────

	pi.registerCommand("loader-with", {
		description:
			"Manage pi-loader-with's config (`add <path>`, `remove <path>`, or no args for list). Changes take effect on next session.",
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);
			const cfgPath = configSourcePath ?? configSearchPaths(process.env, homedir()).slice(-1)[0];
			const cwd = process.cwd();

			if (sub === "" || sub === "list" || sub === "ls") {
				let config: RawConfigShape;
				try {
					config = readConfigRaw(cfgPath);
				} catch (e) {
					ctx.ui.notify(`[loader-with] ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				ctx.ui.notify(formatList(config, cfgPath), "info");
				return;
			}

			if (sub === "add") {
				if (!rest) {
					ctx.ui.notify("Usage: /loader-with add <path-or-git-spec> [as <name>]", "warning");
					return;
				}
				const { value, name } = parseAddArgs(rest);
				if (!value) {
					ctx.ui.notify("Usage: /loader-with add <path-or-git-spec> [as <name>]", "warning");
					return;
				}
				const r = addToConfig(cfgPath, value, cwd, name);
				if (!r.ok) {
					ctx.ui.notify(`[loader-with] add failed: ${r.error}`, "error");
					return;
				}
				const tag = r.result.kind === "local" ? "location" : "remote";
				const aliasNote = r.result.name ? ` (as ${r.result.name})` : "";
				if (r.result.added) {
					ctx.ui.notify(
						`[loader-with] added ${tag}: ${r.result.stored}${aliasNote}\nRestart pi for changes to take effect.`,
						"info",
					);
				} else {
					ctx.ui.notify(`[loader-with] ${tag} already present: ${r.result.stored}${aliasNote}`, "info");
				}
				return;
			}

			if (sub === "remove" || sub === "rm") {
				if (!rest) {
					ctx.ui.notify("Usage: /loader-with remove <path-or-git-spec>", "warning");
					return;
				}
				const r = removeFromConfig(cfgPath, rest, cwd);
				if (!r.ok) {
					ctx.ui.notify(`[loader-with] remove failed: ${r.error}`, "error");
					return;
				}
				ctx.ui.notify(
					`[loader-with] removed from ${r.result.removedFrom.join(" + ")}: ${r.result.matchedValue}\nRestart pi for changes to take effect.`,
					"info",
				);
				return;
			}

			if (sub === "help" || sub === "?") {
				ctx.ui.notify(
					[
						"/loader-with usage:",
						"  /loader-with                          Show current config",
						"  /loader-with add <value> [as <name>]  Add a local dir or git spec (auto-detected)",
						"  /loader-with remove <value>           Remove a location or remote (matches path, spec, or alias)",
						"  /loader-with help                     Show this help",
						"",
						"Examples:",
						"  /loader-with add ~/my-pi-extensions",
						"  /loader-with add ~/code/plannotator as plan",
						"  /loader-with add git:github.com/foo/bar@v1",
						"  /loader-with add npm:@plannotator/pi-extension as plannotator",
						"  /loader-with remove plan",
						"  /loader-with remove git:github.com/foo/bar@v1",
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`[loader-with] unknown subcommand: ${sub}. Try /loader-with help`, "warning");
		},
	});
}
