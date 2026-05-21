#!/usr/bin/env -S npx tsx
/**
 * Loader validation — confirms that loadAndRunExtension correctly loads a
 * fixture extension via jiti and routes calls through the passthrough shim.
 *
 * Run from repo root:
 *   npx tsx packages/pi-loader-with/__tests__/loader-validate.mts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

// ── Fixture factories ─────────────────────────────────────────────────────

function createFixtureWithPackageJson(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "extensions"), { recursive: true });
	mkdirSync(join(dir, "prompts"), { recursive: true });
	mkdirSync(join(dir, "skills", "sample"), { recursive: true });

	// package.json pointing at ./extensions/index.ts and declaring resources
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name,
				pi: {
					extensions: ["./extensions/index.ts"],
					prompts: ["./prompts"],
					skills: ["./skills"],
				},
			},
			null,
			2,
		),
	);

	// Extension entry — uses `typebox` to exercise the virtual-module wiring
	writeFileSync(
		join(dir, "extensions", "index.ts"),
		`
import { Type } from "typebox";
export default async function(pi) {
  pi.registerTool({
    name: "fixture_tool",
    description: "Test tool",
    parameters: Type.Object({}),
    execute: async () => "ok",
  });
  pi.registerCommand("fixture", {
    description: "Test command",
    handler: async () => {},
  });
  pi.on("session_start", () => {});
}
`.trimStart(),
	);

	return dir;
}

function createFixtureWithoutPackageJson(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });

	// No package.json — entry at index.ts (first fallback)
	writeFileSync(
		join(dir, "index.ts"),
		`
export default async function(pi) {
  pi.registerTool({
    name: "fallback_tool",
    description: "Fallback fixture tool",
    parameters: {},
    execute: async () => "ok",
  });
}
`.trimStart(),
	);

	return dir;
}

// ── Mock ExtensionAPI ─────────────────────────────────────────────────────

interface CallRecord {
	args: unknown[];
}

function makeMockPi() {
	const calls: Record<string, CallRecord[]> = {};
	const record = (method: string, args: unknown[]) => {
		calls[method] ??= [];
		calls[method].push({ args });
	};
	const mock = {
		on: (...args: unknown[]) => record("on", args),
		registerTool: (...args: unknown[]) => record("registerTool", args),
		registerCommand: (...args: unknown[]) => record("registerCommand", args),
		registerShortcut: (...args: unknown[]) => record("registerShortcut", args),
		registerFlag: (...args: unknown[]) => record("registerFlag", args),
		registerMessageRenderer: (...args: unknown[]) => record("registerMessageRenderer", args),
		registerProvider: (...args: unknown[]) => record("registerProvider", args),
		unregisterProvider: (...args: unknown[]) => record("unregisterProvider", args),
		getFlag: (...args: unknown[]) => { record("getFlag", args); return undefined; },
		sendMessage: (...args: unknown[]) => record("sendMessage", args),
		sendUserMessage: (...args: unknown[]) => record("sendUserMessage", args),
		appendEntry: (...args: unknown[]) => record("appendEntry", args),
		setSessionName: (...args: unknown[]) => record("setSessionName", args),
		getSessionName: () => { record("getSessionName", []); return undefined; },
		setLabel: (...args: unknown[]) => record("setLabel", args),
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		exec: (...args: unknown[]) => { record("exec", args); return Promise.resolve({} as any); },
		getActiveTools: () => { record("getActiveTools", []); return []; },
		getAllTools: () => { record("getAllTools", []); return []; },
		setActiveTools: (...args: unknown[]) => record("setActiveTools", args),
		getCommands: () => { record("getCommands", []); return []; },
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		setModel: (...args: unknown[]) => { record("setModel", args); return Promise.resolve(false as any); },
		getThinkingLevel: () => { record("getThinkingLevel", []); return "none" as const; },
		setThinkingLevel: (...args: unknown[]) => record("setThinkingLevel", args),
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		events: {} as any,
	};
	return { mock, calls };
}

// ── Assertions ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

// ── Main ──────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "ext-res-loader-"));

try {
	// Dynamically import loader from the package (jiti will handle .ts → .js)
	// We import from the .ts source directly since we're running under tsx.
	const loaderPath = join(pkgRoot, "extensions", "loader.ts");
	const { loadAndRunExtension, buildPassthroughShim } = await import(loaderPath);

	// ── Test 1: fixture with package.json ──────────────────────────────────
	console.log("\n── Test 1: fixture with package.json ──");
	const fix1 = createFixtureWithPackageJson(tmp, "fixture-ext");
	const { mock: mock1, calls: calls1 } = makeMockPi();

	// biome-ignore lint/suspicious/noExplicitAny: test driver
	const result1 = await loadAndRunExtension(fix1, mock1 as any);

	assert("ok: true", result1.ok === true, JSON.stringify(result1));
	assert(
		"registerTool called once",
		calls1.registerTool?.length === 1,
		`calls: ${calls1.registerTool?.length}`,
	);
	assert(
		"registerTool called with fixture_tool",
		// biome-ignore lint/suspicious/noExplicitAny: test driver
		(calls1.registerTool?.[0]?.args[0] as any)?.name === "fixture_tool",
		JSON.stringify(calls1.registerTool?.[0]?.args[0]),
	);
	assert(
		"registerCommand called once",
		calls1.registerCommand?.length === 1,
		`calls: ${calls1.registerCommand?.length}`,
	);
	assert(
		"registerCommand called with 'fixture'",
		calls1.registerCommand?.[0]?.args[0] === "fixture",
		JSON.stringify(calls1.registerCommand?.[0]?.args[0]),
	);
	assert(
		"on('session_start') called",
		calls1.on?.some((c) => c.args[0] === "session_start"),
		JSON.stringify(calls1.on),
	);
	assert(
		"manifest promptPaths surfaced",
		result1.ok === true && Array.isArray((result1 as any).promptPaths) && (result1 as any).promptPaths.length === 1,
		JSON.stringify(result1),
	);
	assert(
		"manifest skillPaths surfaced",
		result1.ok === true && Array.isArray((result1 as any).skillPaths) && (result1 as any).skillPaths.length === 1,
		JSON.stringify(result1),
	);
	assert(
		"manifest promptPaths absolute & point at ./prompts",
		result1.ok === true && (result1 as any).promptPaths[0] === join(fix1, "prompts"),
		JSON.stringify((result1 as any).promptPaths),
	);

	// ── Test 2: buildPassthroughShim delegates to real pi ─────────────────
	console.log("\n── Test 2: buildPassthroughShim ──");
	const { mock: mock2, calls: calls2 } = makeMockPi();
	// biome-ignore lint/suspicious/noExplicitAny: test driver
	const shim = buildPassthroughShim(mock2 as any);

	shim.registerTool({ name: "shim_tool", description: "", parameters: {}, execute: async () => "" });
	assert("shim.registerTool → real pi", calls2.registerTool?.length === 1);

	shim.registerCommand("shim_cmd", { description: "", handler: async () => {} });
	assert("shim.registerCommand → real pi", calls2.registerCommand?.length === 1);

	// ── Test 3: fixture without package.json (fallback entry resolution) ──
	console.log("\n── Test 3: fixture without package.json ──");
	const fix2 = createFixtureWithoutPackageJson(tmp, "no-pkg-ext");
	const { mock: mock3, calls: calls3 } = makeMockPi();

	// biome-ignore lint/suspicious/noExplicitAny: test driver
	const result2 = await loadAndRunExtension(fix2, mock3 as any);

	assert("ok: true (no package.json)", result2.ok === true, JSON.stringify(result2));
	assert(
		"registerTool called (fallback_tool)",
		// biome-ignore lint/suspicious/noExplicitAny: test driver
		calls3.registerTool?.some((c) => (c.args[0] as any)?.name === "fallback_tool"),
		JSON.stringify(calls3.registerTool),
	);
	assert(
		"no-package.json bundle yields empty promptPaths/skillPaths",
		result2.ok === true &&
			(result2 as any).promptPaths?.length === 0 &&
			(result2 as any).skillPaths?.length === 0,
		JSON.stringify(result2),
	);

	// ── Test 4: non-existent bundle → ok: false ───────────────────────────
	console.log("\n── Test 4: non-existent bundle ──");
	const { mock: mock4 } = makeMockPi();
	// biome-ignore lint/suspicious/noExplicitAny: test driver
	const result3 = await loadAndRunExtension(join(tmp, "does-not-exist"), mock4 as any);
	assert("ok: false for missing bundle", result3.ok === false);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
	console.error("FAIL");
	process.exit(1);
} else {
	console.log("PASS ✓ loader validation complete");
	process.exit(0);
}
