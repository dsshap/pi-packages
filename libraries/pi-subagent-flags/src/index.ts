/**
 * @dsshap/pi-subagent-flags
 *
 * Shared helper for Pi extensions that spawn `pi` as a subprocess to run
 * sub-agents (e.g. @dsshap/pi-pi-experts, @dsshap/pi-agent-chain). Lets local
 * users splice extra `pi` flags into every sub-agent spawn from a named
 * extension — without forking or rebuilding the extension itself.
 *
 * Canonical use case: inject `-e <path-to-pi-claude-code-use>` so the protection
 * extension loads inside the child process and rewrites brand strings in
 * outbound Anthropic Claude Code OAuth requests. See the README for details.
 *
 * The package ships TypeScript source directly (no build step). Both producers
 * and consumers in this monorepo are Pi extensions loaded via jiti, which
 * handles `.ts` transitively.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape of a single per-extension entry inside `subagent-flags.json`. */
export interface SubagentFlags {
	extraArgs?: string[];
}

/**
 * Pure resolver — testable in isolation. Given an ordered list of raw
 * config-file contents (typically: global first, then project) and the calling
 * extension's name, returns the concatenated `extraArgs` for that extension.
 *
 * Later entries fully replace earlier entries at the per-extension level
 * (shallow merge by top-level key — project overrides global).
 *
 * Malformed JSON, non-object roots, missing entries, and non-array `extraArgs`
 * values are all silently ignored — the resolver is best-effort and never
 * throws.
 *
 * @param rawConfigs Ordered list of raw JSON file contents. `undefined`
 *                   entries (e.g. for missing files) are skipped.
 * @param extensionName Exact top-level key to look up in each config object.
 * @returns Resolved `extraArgs` for the named extension, or `[]` if none.
 */
export function resolveSubagentExtras(
	rawConfigs: ReadonlyArray<string | undefined>,
	extensionName: string,
): string[] {
	let resolved: SubagentFlags | undefined;
	for (const raw of rawConfigs) {
		if (!raw) continue;
		try {
			const data = JSON.parse(raw) as unknown;
			if (!data || typeof data !== "object" || Array.isArray(data)) continue;
			const entry = (data as Record<string, unknown>)[extensionName];
			if (entry && typeof entry === "object" && !Array.isArray(entry)) {
				resolved = entry as SubagentFlags;
			}
		} catch {}
	}
	return Array.isArray(resolved?.extraArgs) ? [...resolved.extraArgs] : [];
}

/**
 * Convenience filesystem wrapper. Reads `~/.pi/agent/subagent-flags.json`
 * (global) and `<cwd>/.pi/subagent-flags.json` (project, overrides global),
 * then resolves the `extraArgs` for the named extension.
 *
 * Returns `[]` when no config file exists, the file is unreadable or
 * malformed, or no entry matches the extension name. Never throws.
 *
 * Schema for each config file:
 *
 *   {
 *     "<extension-name>": {
 *       "extraArgs": ["-e", "/absolute/path/to/some/pi-extension"]
 *     }
 *   }
 *
 * @param extensionName Exact name to look up in the config (typically the
 *                      consumer package's short name, e.g. "pi-pi-experts").
 * @param cwd Current working directory of the parent Pi process — usually
 *            `ctx.cwd` from the extension's session/event handler.
 */
export function loadSubagentExtraArgs(extensionName: string, cwd: string): string[] {
	const paths = [
		join(homedir(), ".pi", "agent", "subagent-flags.json"),
		join(cwd, ".pi", "subagent-flags.json"),
	];
	const raws = paths.map((p) => {
		try {
			return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
		} catch {
			return undefined;
		}
	});
	return resolveSubagentExtras(raws, extensionName);
}
