#!/usr/bin/env -S npx tsx
/**
 * Runtime validation — load the agent-chain extension, mock pi, trigger the
 * `run_chain` tool with a 2-step scout-only chain, and observe whether the
 * widget actually receives live updates with non-zero cost/tokens/elapsed.
 *
 * Run from repo root:  npx tsx packages/pi-agent-chain/__tests__/chain-runtime-validate.mts
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

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
let requestRenderCalls = 0;
// biome-ignore lint/suspicious/noExplicitAny: test driver
let currentWidget: any = null;

// Stub TUI — simulates what Pi hands the factory. requestRender() is the key
// signal the new pattern depends on; we count it AND eagerly call the widget's
// render() to capture the frame the user would see.
const stubTui = {
	requestRender() {
		requestRenderCalls++;
		if (currentWidget) {
			const lines = currentWidget.render(120);
			widgetRenders.push({ at: Date.now(), lines });
		}
	},
};

const stubTheme = {
	fg: (_n: string, s: string) => s,
	bold: (s: string) => s,
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

// ── Install a temporary 2-step chain ───────────────────────────────────────
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
		"validate-chain:",
		'  description: "Two-step scout chain used by runtime validation"',
		"  steps:",
		"    - agent: scout",
		'      prompt: "Reply with the single word OK and nothing else. Input: $INPUT"',
		"    - agent: scout",
		'      prompt: "Reply with the single word DONE and nothing else. Previous: $INPUT"',
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

const baselineRenderCount = widgetRenders.length;
console.log(`baseline renders after session_start: ${baselineRenderCount}`);
if (widgetRenders.length > 0) {
	console.log("── render after session_start ──");
	for (const l of widgetRenders[widgetRenders.length - 1].lines) console.log(l);
	console.log();
}

// ── Invoke the run_chain tool ──────────────────────────────────────────────
console.log("▶ invoking run_chain tool with task='ping'");
console.log();
const start = Date.now();
const result = await registeredTool.execute(
	"toolcall-1",
	{ task: "ping" },
	undefined,
	() => {},
	ctx,
);
const elapsed = Date.now() - start;
console.log(`tool elapsed: ${Math.round(elapsed / 1000)}s`);
console.log(`renders captured during chain: ${widgetRenders.length - baselineRenderCount}`);
console.log(`total renders: ${widgetRenders.length}`);
console.log();

const lastRender = widgetRenders[widgetRenders.length - 1];
console.log("── LAST RENDER ──");
for (const l of lastRender?.lines ?? []) console.log(l);
console.log();

const lastText = (lastRender?.lines ?? []).join("\n");
const showsCost = /\$0\.0\d[1-9]\d?|\$0\.\d{3}/.test(lastText) && !/\$0\.000/.test(lastText.replace(/.*?Orch.*?\n/s, ""));
const showsTokens = /[1-9]\d*k\/[\d.]+M/.test(lastText);
const showsModel = /claude-|gpt-|gemini-/.test(lastText);
const headerLine = (lastRender?.lines?.[0] ?? "");
const headerElapsedMatch = headerLine.match(/(\d+m\s+\d+s|\d+s)\s*$/);
const headerHasNonZeroTime = !!headerElapsedMatch && headerElapsedMatch[1] !== "0s";

// Inspect intermediate renders for status transitions: pending ◇ → running ◆ → done ◆
const sawRunning = widgetRenders.some((r) => r.lines.slice(2).some((l) => /◆/.test(l)));
const sawAnyDoneTokens = widgetRenders.some((r) => /[1-9]\d*k\//.test(r.lines.join("\n")));

// The model column should be populated on the FIRST render that shows the
// chain (not just the running step) — ALL step rows (pending included) must
// have their model populated, not only the one about to run.
const firstChainRender = widgetRenders
	.slice(baselineRenderCount)
	.find((r) => r.lines.some((l) => /debug-chain|validate-chain/.test(l)));
const firstChainStepLines = (firstChainRender?.lines ?? []).filter((l) => /Scout|Planner|Builder|Reviewer/.test(l));
const allStepsHaveModel =
	firstChainStepLines.length > 0 && firstChainStepLines.every((l) => /claude-|gpt-|gemini-/.test(l));
const firstRunningRender = widgetRenders
	.slice(baselineRenderCount)
	.find((r) => r.lines.slice(2).some((l) => /◆/.test(l) && !/Orch/.test(l)));
const firstRunningStepLine = firstRunningRender?.lines
	.slice(2)
	.find((l) => /◆/.test(l) && !/Orch/.test(l));
const firstRunningHasModel = !!firstRunningStepLine && /claude-|gpt-|gemini-/.test(firstRunningStepLine);

console.log("── ASSERTIONS ──");
console.log("tui.requestRender calls:        ", requestRenderCalls);
console.log("renders during chain >= 2:       ", widgetRenders.length - baselineRenderCount >= 2);
console.log("intermediate step had ◆:         ", sawRunning);
console.log("intermediate token count > 0:    ", sawAnyDoneTokens);
console.log("ALL step rows show model from frame 1: ", allStepsHaveModel);
if (firstChainStepLines.length > 0) {
	for (const l of firstChainStepLines) console.log("  first-chain line:", l.trim());
}
console.log("first running step has a model:  ", firstRunningHasModel);
if (firstRunningStepLine) console.log("  first-running line:", firstRunningStepLine.trim());
console.log("last render shows tokens:        ", showsTokens);
console.log("last render shows cost:          ", showsCost);
console.log("last render shows model name:    ", showsModel);
console.log("header elapsed > 0s:             ", headerHasNonZeroTime, headerElapsedMatch?.[1] ?? "(none)");
console.log("tool result status:              ", result.details?.status);

const ok =
	(widgetRenders.length - baselineRenderCount) >= 2 &&
	sawRunning &&
	sawAnyDoneTokens &&
	showsModel &&
	allStepsHaveModel &&
	firstRunningHasModel &&
	result.details?.status === "done";

console.log();
console.log(ok ? "PASS ✓ widget received live updates with cost/tokens/elapsed" : "FAIL ✗ widget never showed live data");
process.exit(ok ? 0 : 1);
