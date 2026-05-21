/**
 * Dynamic extension loader using jiti.
 *
 * Provides:
 *  - getJitiLoader()          — lazy singleton jiti instance with virtualModules
 *  - loadFactory()            — resolve the entry point and import the factory fn
 *  - buildPassthroughShim()   — create a full-passthrough ExtensionAPI wrapper
 *  - loadAndRunExtension()    — orchestrate load + run for one bundle path
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Static imports of all modules that loaded extensions may use.
// These must be static so the virtualModules map below points at live module
// objects (same identity as what the host pi process uses).
import * as _piAgentCore from "@earendil-works/pi-agent-core";
import * as _piAi from "@earendil-works/pi-ai";
import * as _piAiOauth from "@earendil-works/pi-ai/oauth";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as _piCodingAgent from "@earendil-works/pi-coding-agent";
import * as _piTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import * as _typebox from "typebox";
import * as _typeboxCompile from "typebox/compile";
import * as _typeboxValue from "typebox/value";

// ── Virtual-module map (mirrors pi-coding-agent's loader.js exactly) ──────

const VIRTUAL_MODULES = {
	typebox: _typebox,
	"typebox/compile": _typeboxCompile,
	"typebox/value": _typeboxValue,
	"@sinclair/typebox": _typebox,
	"@sinclair/typebox/compile": _typeboxCompile,
	"@sinclair/typebox/value": _typeboxValue,
	"@earendil-works/pi-agent-core": _piAgentCore,
	"@earendil-works/pi-tui": _piTui,
	"@earendil-works/pi-ai": _piAi,
	"@earendil-works/pi-ai/oauth": _piAiOauth,
	"@earendil-works/pi-coding-agent": _piCodingAgent,
	"@mariozechner/pi-agent-core": _piAgentCore,
	"@mariozechner/pi-tui": _piTui,
	"@mariozechner/pi-ai": _piAi,
	"@mariozechner/pi-ai/oauth": _piAiOauth,
	"@mariozechner/pi-coding-agent": _piCodingAgent,
};

// ── jiti singleton ────────────────────────────────────────────────────────

let _jiti: ReturnType<typeof createJiti> | null = null;

// Detect Bun binary mode the same way pi-coding-agent does (see
// @earendil-works/pi-coding-agent/dist/config.js: `isBunBinary`). Bun does
// NOT expose `process.isBun`; the canonical signal is that import.meta.url
// points into the Bun virtual filesystem.
const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Lazy singleton jiti loader configured with virtualModules for all pi packages. */
export function getJitiLoader(): ReturnType<typeof createJiti> {
	if (_jiti) return _jiti;

	if (isBunBinary) {
		// Bun binary mode: filesystem-resolution of node_modules is unavailable
		// (everything's bundled into the binary). Use virtualModules so jiti
		// short-circuits imports of the pre-imported namespace modules above.
		// tryNative must be false here so jiti handles ALL imports (otherwise
		// it'd try to load extensions natively against $bunfs paths and fail).
		_jiti = createJiti(import.meta.url, {
			moduleCache: false,
			virtualModules: VIRTUAL_MODULES,
			tryNative: false,
		});
		return _jiti;
	}

	// Node.js / dev mode: resolve real filesystem paths for jiti's alias map.
	// These resolutions can only run in Node — in Bun binary they'd throw
	// because the node_modules tree doesn't exist as filesystem paths.
	const require = createRequire(import.meta.url);
	const resolveModule = (specifier: string): string => {
		try {
			return fileURLToPath(import.meta.resolve(specifier));
		} catch {
			return require.resolve(specifier);
		}
	};

	const piCodingAgentEntry = resolveModule("@earendil-works/pi-coding-agent");
	const piAgentCoreEntry = resolveModule("@earendil-works/pi-agent-core");
	const piTuiEntry = resolveModule("@earendil-works/pi-tui");
	const piAiEntry = resolveModule("@earendil-works/pi-ai");
	const piAiOauthEntry = resolveModule("@earendil-works/pi-ai/oauth");
	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const alias: Record<string, string> = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai": piAiEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai": piAiEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	_jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias,
	});
	return _jiti;
}

// ── loadFactory ───────────────────────────────────────────────────────────

const FALLBACK_ENTRIES = ["index.ts", "extensions/index.ts", "extensions/index.js", "index.js"];

export interface LoadFactoryResult {
	factory: ExtensionFactory;
	entryPath: string;
}

/**
 * Resolve and import the factory function from a bundle directory.
 *
 * Resolution order:
 *  1. `package.json` → `pi.extensions[0]` (resolved relative to bundle dir)
 *  2. Fallback list: index.ts, extensions/index.ts, extensions/index.js, index.js
 *
 * Returns undefined if no factory is found (all candidates tried).
 */
export async function loadFactory(bundlePath: string): Promise<LoadFactoryResult | undefined> {
	const loader = getJitiLoader();
	const absBundle = resolve(bundlePath);

	// Collect candidate entry paths in priority order.
	const candidates: string[] = [];

	const pkgJsonPath = join(absBundle, "package.json");
	if (existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
				pi?: { extensions?: string[] };
			};
			const declared = pkg?.pi?.extensions?.[0];
			if (declared) {
				candidates.push(resolve(absBundle, declared));
			}
		} catch {
			// ignore parse errors, fall through to fallbacks
		}
	}

	for (const rel of FALLBACK_ENTRIES) {
		candidates.push(join(absBundle, rel));
	}

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const mod = await loader.import(candidate, { default: true });
			if (typeof mod === "function") {
				return { factory: mod as ExtensionFactory, entryPath: candidate };
			}
		} catch {
			// try next candidate
		}
	}

	return undefined;
}

// ── buildPassthroughShim ──────────────────────────────────────────────────

/**
 * Build a full-passthrough ExtensionAPI shim that delegates every method to
 * the real `pi` instance. Used so that dynamically loaded extensions register
 * their tools/commands/handlers on the host session.
 */
export function buildPassthroughShim(realPi: ExtensionAPI): ExtensionAPI {
	return {
		on: (...args: Parameters<ExtensionAPI["on"]>) => (realPi.on as (...a: unknown[]) => void)(...args),
		registerTool: (...args) => realPi.registerTool(...args),
		registerCommand: (...args) => realPi.registerCommand(...args),
		registerShortcut: (...args) => realPi.registerShortcut(...args),
		registerFlag: (...args) => realPi.registerFlag(...args),
		registerMessageRenderer: (...args) => realPi.registerMessageRenderer(...args),
		registerProvider: (...args) => realPi.registerProvider(...args),
		unregisterProvider: (...args) => realPi.unregisterProvider(...args),
		getFlag: (...args) => realPi.getFlag(...args),
		sendMessage: (...args) => realPi.sendMessage(...args),
		sendUserMessage: (...args) => realPi.sendUserMessage(...args),
		appendEntry: (...args) => realPi.appendEntry(...args),
		setSessionName: (...args) => realPi.setSessionName(...args),
		getSessionName: () => realPi.getSessionName(),
		setLabel: (...args) => realPi.setLabel(...args),
		exec: (...args) => realPi.exec(...args),
		getActiveTools: () => realPi.getActiveTools(),
		getAllTools: () => realPi.getAllTools(),
		setActiveTools: (...args) => realPi.setActiveTools(...args),
		getCommands: () => realPi.getCommands(),
		setModel: (...args) => realPi.setModel(...args),
		getThinkingLevel: () => realPi.getThinkingLevel(),
		setThinkingLevel: (...args) => realPi.setThinkingLevel(...args),
		events: realPi.events,
	} as ExtensionAPI;
}

// ── loadAndRunExtension ───────────────────────────────────────────────────

export type LoadAndRunResult = { ok: true; entryPath: string } | { ok: false; error: string };

/**
 * Load and immediately run one extension by bundle path.
 * All errors are caught and returned as `{ ok: false, error }` — never thrown.
 */
export async function loadAndRunExtension(bundlePath: string, realPi: ExtensionAPI): Promise<LoadAndRunResult> {
	try {
		const found = await loadFactory(bundlePath);
		if (!found) {
			return { ok: false, error: `No factory function found in ${bundlePath}` };
		}
		const shim = buildPassthroughShim(realPi);
		await found.factory(shim);
		return { ok: true, entryPath: found.entryPath };
	} catch (e) {
		return {
			ok: false,
			error: `Failed to load ${bundlePath}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
