#!/usr/bin/env -S npx tsx
/**
 * Abort validation — confirms that aborting the run signal kills in-flight
 * spawned `pi` subprocesses promptly. Mirrors the real `run_chain` execution
 * path the same way `chain-runtime-validate.mts` does, then asserts:
 *
 *   1. Sending `controller.abort()` while a chain step is running causes the
 *      tool's execute promise to resolve with status=error + aborted=true.
 *   2. The wall-clock time between abort and resolution is short (< ~5s),
 *      meaning the subprocess was actually killed rather than left to run.
 *   3. The widget reflects the aborted step in its final render.
 *
 * Run from repo root:
 *   npx tsx packages/pi-agent-chain/__tests__/abort-validate.mts
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

// ── Capture renders so we can inspect final state after abort ─────────────
interface RenderCapture {
	at: number;
	lines: string[];
}
const widgetRenders: RenderCapture[] = [];
// biome-ignore lint/suspicious/noExplicitAny: test driver
let currentWidget: any = null;
let requestRenderCalls = 0;

const stubTheme = {
	fg: (_n: string, s: string) => s,
	bold: (s: string) => s,
};

const stubTui = {
	requestRender() {
		requestRenderCalls++;
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
		"abort-validate-chain:",
		'  description: "Two-step scout chain used by abort-validate"',
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

// ── Drive session_start ────────────────────────────────────────────────────
await handlers.session_start?.({}, ctx);

// ── Invoke run_chain and abort mid-flight ─────────────────────────────────
const controller = new AbortController();
console.log("▶ starting chain; will abort after 1500ms");
console.log();

const start = Date.now();
let abortFiredAt = 0;

const executePromise = registeredTool.execute(
	"toolcall-1",
	{ task: "ping" },
	controller.signal,
	() => {},
	ctx,
);

// Fire abort after 1.5s — enough time for the first scout subprocess to be
// actively streaming, before it can complete naturally (scouts take ~3s).
setTimeout(() => {
	abortFiredAt = Date.now();
	console.log(`▶ firing controller.abort() at +${abortFiredAt - start}ms`);
	controller.abort();
}, 1500);

const result = await executePromise;
const resolvedAt = Date.now();
const totalElapsed = resolvedAt - start;
const postAbortElapsed = abortFiredAt > 0 ? resolvedAt - abortFiredAt : -1;

console.log();
console.log(`tool elapsed total:   ${totalElapsed}ms`);
console.log(`post-abort elapsed:   ${postAbortElapsed}ms`);
console.log(`tool result status:   ${result.details?.status}`);
console.log(`requestRender calls:  ${requestRenderCalls}`);
console.log();

const lastRender = widgetRenders[widgetRenders.length - 1];
console.log("── LAST RENDER ──");
for (const l of lastRender?.lines ?? []) console.log(l);
console.log();

const lastText = (lastRender?.lines ?? []).join("\n");
const summaryText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";

console.log("── ASSERTIONS ──");

const promptResolvedAfterAbort = postAbortElapsed >= 0;
const promptlyKilled = postAbortElapsed >= 0 && postAbortElapsed < 5000;
const reportsError = result.details?.status === "error";
const reportsAborted = /aborted/i.test(summaryText);
// The new tree widget conveys aborted state via the bullet COLOR (red ◆)
// rather than free-text — the stub theme strips colors so we can't grep for
// it. Instead, verify the chain stopped early: only the first step ran (got
// non-zero elapsed), while subsequent steps stayed pending (elapsed = 0).
const stepLines = (lastRender?.lines ?? []).filter((l) => /\bScout\b/.test(l));
const firstStepHasElapsed = /\d+s\s*$/.test(stepLines[0] ?? "");
const secondStepHasNoElapsed = stepLines.length >= 2 && !/\d+s\s*$/.test(stepLines[1] ?? "");
const widgetShowsEarlyStop = firstStepHasElapsed && secondStepHasNoElapsed;

console.log("execute resolved AFTER abort fired:        ", promptResolvedAfterAbort);
console.log("resolved within 5s of abort (killed):      ", promptlyKilled, `(${postAbortElapsed}ms)`);
console.log("tool details.status === 'error':           ", reportsError);
console.log("summary mentions 'aborted':                ", reportsAborted);
console.log("widget shows early-stop (step 1 elapsed,   ");
console.log("        step 2 never ran):                 ", widgetShowsEarlyStop);

const ok =
	promptResolvedAfterAbort &&
	promptlyKilled &&
	reportsError &&
	reportsAborted &&
	widgetShowsEarlyStop;

console.log();
console.log(ok ? "PASS ✓ abort signal killed the running subprocess promptly" : "FAIL ✗ abort did not propagate");
process.exit(ok ? 0 : 1);
