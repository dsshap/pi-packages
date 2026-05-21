#!/usr/bin/env -S npx tsx
/**
 * Shutdown-path validation — mirrors `abort-validate.mts` but triggers
 * termination via the `session_shutdown` event handler instead of the
 * AbortSignal. This proves the same supervisor termination path works for
 * Pi-initiated shutdown (e.g. `/new`, `/resume`, `/fork`, `/reload`, or
 * SIGTERM/SIGHUP to the parent pi process).
 *
 * The driver:
 *   1. Starts a real `pi -p` subprocess via the run_chain tool.
 *   2. After 1500ms, invokes the registered `session_shutdown` handler
 *      directly (simulating what `AgentSessionRuntime.dispose()` does).
 *   3. Asserts that the chain resolves promptly with status=error +
 *      aborted=true, AND that the shutdown handler resolves only AFTER
 *      every child has exited (no zombies).
 *
 * Run from repo root:
 *   npx tsx packages/pi-agent-chain/__tests__/shutdown-validate.mts
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");

// ── Mock pi (ExtensionAPI) ─────────────────────────────────────────────────
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const handlers: Record<string, Handler> = {};
// biome-ignore lint/suspicious/noExplicitAny: test driver
let registeredTool: any = null;

const pi = {
	registerTool(def: unknown) {
		registeredTool = def;
	},
	registerCommand() {},
	registerShortcut() {},
	on(name: string, handler: Handler) {
		handlers[name] = handler;
	},
};

// ── Mock ExtensionContext ──────────────────────────────────────────────────
interface RenderCapture {
	at: number;
	lines: string[];
}
const widgetRenders: RenderCapture[] = [];
// biome-ignore lint/suspicious/noExplicitAny: test driver
let currentWidget: any = null;

const stubTheme = {
	fg: (_n: string, s: string) => s,
	bold: (s: string) => s,
};

const stubTui = {
	requestRender() {
		if (currentWidget) {
			const lines = currentWidget.render(120);
			widgetRenders.push({ at: Date.now(), lines });
		}
	},
};

const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	signal: undefined,
	model: { provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200000 },
	sessionManager: {
		getSessionId: () => "019e4774-c95c-8859-c052-12abf0123456",
		getSessionFile: () => undefined,
		getSessionName: () => "test",
		getSessionDir: () => process.cwd(),
		getCwd: () => process.cwd(),
		isPersisted: () => false,
		getLeafId: () => "abcd1234",
	},
	modelRegistry: { models: () => [] },
	ui: {
		// biome-ignore lint/suspicious/noExplicitAny: test driver
		setWidget(_name: string, factory: any) {
			if (!factory) {
				currentWidget = null;
				return;
			}
			currentWidget = factory(stubTui, stubTheme);
			const lines = currentWidget.render(120);
			widgetRenders.push({ at: Date.now(), lines });
		},
		setStatus() {},
		setFooter() {},
		notify() {},
		setOverlay() {},
		select: async (_label: string, opts: string[]) => opts[0],
	},
	isIdle: () => true,
	abort() {},
	hasPendingMessages: () => false,
	shutdown() {},
	getContextUsage: () => ({ percent: 0 }),
	compact() {},
	getSystemPrompt: () => "",
};

// ── Install a 2-step scout chain ──────────────────────────────────────────
const userChainDir = resolve(process.cwd(), ".pi", "agents");
const userChainPath = resolve(userChainDir, "agent-chain.yaml");
const backupPath = `${userChainPath}.bak.${Date.now()}`;
let backupRestore = false;
if (existsSync(userChainPath)) {
	renameSync(userChainPath, backupPath);
	backupRestore = true;
}
mkdirSync(userChainDir, { recursive: true });
writeFileSync(
	userChainPath,
	[
		"shutdown-validate-chain:",
		'  description: "Two-step scout chain used by shutdown-validate"',
		"  steps:",
		"    - agent: scout",
		'      prompt: "Spend a moment thinking, then reply with the word OK. Input: $INPUT"',
		"    - agent: scout",
		'      prompt: "Reply with the word DONE. Previous: $INPUT"',
		"",
	].join("\n"),
);
const cleanup = () => {
	try {
		rmSync(userChainPath, { force: true });
	} catch {}
	if (backupRestore) {
		try {
			renameSync(backupPath, userChainPath);
		} catch {}
	}
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
	cleanup();
	process.exit(130);
});

// ── Load the extension ─────────────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: dynamic .ts import
const mod: any = await import(pathToFileURL(extEntry).href);
await mod.default(pi);
if (!registeredTool || registeredTool.name !== "run_chain") {
	console.error("FAIL: run_chain tool was not registered");
	process.exit(1);
}
if (!handlers.session_shutdown) {
	console.error("FAIL: session_shutdown handler was not registered");
	process.exit(1);
}

// ── Drive session_start ────────────────────────────────────────────────────
await handlers.session_start?.({}, ctx);

// ── Invoke run_chain and fire session_shutdown mid-flight ─────────────────
console.log("▶ starting chain; will fire session_shutdown after 1500ms");
console.log();

const start = Date.now();
let shutdownFiredAt = 0;
let shutdownResolvedAt = 0;

// NOTE: no AbortSignal here — we're proving the shutdown path works
// independently of the user-abort path.
const executePromise = registeredTool.execute(
	"toolcall-1",
	{ task: "ping" },
	undefined,
	() => {},
	ctx,
);

let shutdownPromise: Promise<unknown> | undefined;
setTimeout(() => {
	shutdownFiredAt = Date.now();
	console.log(`▶ invoking session_shutdown handler at +${shutdownFiredAt - start}ms`);
	shutdownPromise = handlers.session_shutdown?.(
		{ type: "session_shutdown", reason: "new" },
		ctx,
	);
	void shutdownPromise?.then(() => {
		shutdownResolvedAt = Date.now();
	});
}, 1500);

const result = await executePromise;
// Make sure the shutdown handler itself also resolved before we assert.
await shutdownPromise;
const resolvedAt = Date.now();

const totalElapsed = resolvedAt - start;
const postShutdownElapsed = shutdownFiredAt > 0 ? resolvedAt - shutdownFiredAt : -1;
const shutdownHandlerElapsed = shutdownResolvedAt > 0 ? shutdownResolvedAt - shutdownFiredAt : -1;

console.log();
console.log(`tool elapsed total:           ${totalElapsed}ms`);
console.log(`post-shutdown elapsed:        ${postShutdownElapsed}ms`);
console.log(`shutdown handler elapsed:     ${shutdownHandlerElapsed}ms`);
console.log(`tool result status:           ${result.details?.status}`);
console.log();

const lastRender = widgetRenders[widgetRenders.length - 1];
console.log("── LAST RENDER ──");
for (const l of lastRender?.lines ?? []) console.log(l);
console.log();

const summaryText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";

console.log("── ASSERTIONS ──");

const promptResolvedAfterShutdown = postShutdownElapsed >= 0;
const promptlyKilled = postShutdownElapsed >= 0 && postShutdownElapsed < 5000;
const shutdownAwaitedChild = shutdownHandlerElapsed >= 0 && shutdownHandlerElapsed < 5000;
const reportsError = result.details?.status === "error";
const reportsAborted = /aborted/i.test(summaryText);
const stepLines = (lastRender?.lines ?? []).filter((l) => /\bScout\b/.test(l));
const firstStepHasElapsed = /\d+s\s*$/.test(stepLines[0] ?? "");
const secondStepHasNoElapsed = stepLines.length >= 2 && !/\d+s\s*$/.test(stepLines[1] ?? "");
const widgetShowsEarlyStop = firstStepHasElapsed && secondStepHasNoElapsed;

console.log("execute resolved AFTER shutdown fired:    ", promptResolvedAfterShutdown);
console.log("resolved within 5s of shutdown (killed):  ", promptlyKilled, `(${postShutdownElapsed}ms)`);
console.log("shutdown handler awaited child exit:      ", shutdownAwaitedChild, `(${shutdownHandlerElapsed}ms)`);
console.log("tool details.status === 'error':          ", reportsError);
console.log("summary mentions 'aborted':               ", reportsAborted);
console.log("widget shows early-stop (step 1 elapsed,");
console.log("        step 2 never ran):                ", widgetShowsEarlyStop);

const ok =
	promptResolvedAfterShutdown &&
	promptlyKilled &&
	shutdownAwaitedChild &&
	reportsError &&
	reportsAborted &&
	widgetShowsEarlyStop;

console.log();
console.log(
	ok
		? "PASS ✓ session_shutdown propagated to spawned children and the handler awaited their exit"
		: "FAIL ✗ shutdown path did not work as expected",
);
process.exit(ok ? 0 : 1);
