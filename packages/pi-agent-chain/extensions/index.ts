/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in YAML —
 * each chain is a sequence of agent steps with prompt templates. The user's
 * original prompt flows into step 1, the output becomes $INPUT for step 2's
 * prompt template, and so on. $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent uses the `run_chain` tool to kick off the pipeline.
 * Agents maintain session context within a Pi session — re-running the chain
 * lets each agent resume where it left off.
 *
 * Commands:
 *   /chain             — switch active chain
 *   /chain-list        — list all available chains
 *
 * Usage: pi -e .
 *
 * ---------------------------------------------------------------------------
 * ORIGIN & ATTRIBUTION
 *
 * Derivative work of the "Agent Chain" extension originally created by
 * IndyDevDan (https://github.com/disler) as part of the pi-vs-claude-code
 * project:
 *   https://github.com/disler/pi-vs-claude-code
 *     - extensions/agent-chain.ts            (this file's ancestor)
 *     - .pi/agents/*.md                      (bundled verbatim in ../agents/)
 *     - .pi/agents/agent-chain.yaml          (bundled verbatim in ../agents/)
 *
 * Original work copyright (c) 2026 IndyDevDan, MIT License.
 * Modifications copyright (c) 2025 dsshap, MIT License.
 * See ../LICENSE for combined notice.
 * ---------------------------------------------------------------------------
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSubagentExtraArgs } from "@dsshap/pi-subagent-flags";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ────────────────────────────────────────

interface ChainStep {
	agent: string;
	prompt: string;
}

interface ChainDef {
	name: string;
	description: string;
	steps: ChainStep[];
}

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	/**
	 * Optional per-agent model spec (`<provider>/<id>`, e.g. `anthropic/claude-opus-4-7`).
	 * Parsed from the `model:` frontmatter key. If absent (or the wildcard star-slash-star),
	 * the subagent spawn falls back to the orchestrator's `ctx.model`.
	 */
	model?: string;
}

interface StepState {
	agent: string;
	status: "pending" | "running" | "done" | "error";
	elapsed: number;
	lastWork: string;
	// Usage tracking — sourced from `message_end` events on the spawned pi.
	costUsd: number;
	contextTokens: number; // input + cacheRead + cacheWrite of the latest assistant message
	model: string;
}

interface RunChainArgs {
	task: string;
}

// Subset of pi-ai's `AssistantMessage` shape we read from the JSON event stream.
// See pi-mono/packages/ai/src/types.ts (Usage + AssistantMessage).
interface AssistantMessageLike {
	role?: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
}

interface RunChainDetails {
	chain?: string;
	task?: string;
	status: "running" | "done" | "error";
	elapsed?: number;
	fullOutput?: string;
}

// ── Helpers ──────────────────────────────────────

// Subagent flags hook: lets local users splice extra `pi` flags into every
// sub-agent spawn from this extension via ~/.pi/agent/extensions/subagent-flags.json.
// See @dsshap/pi-subagent-flags for the schema and supported config paths.
const EXTENSION_NAME = "pi-agent-chain";

function displayName(name: string): string {
	return name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function shortSessionId(uuid: string | undefined | null): string {
	if (!uuid) return "";
	// Keep hyphens so the displayed prefix can be pasted back into
	// `pi --session <id>` — Pi prefix-matches against the canonical UUID
	// form (`019e4b8a-a6b6-...`). Stripping hyphens produces a string that
	// looks like an ID but fails to resolve.
	return uuid.slice(0, 13);
}

function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.000";
	return `$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function formatTokenPair(used: number, limit: number): string {
	const u = formatTokens(used);
	const l = limit > 0 ? formatTokens(limit) : "?";
	return `${u}/${l}`;
}

function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSec = Math.round(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m === 0) return `${s}s`;
	return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function padCell(styled: string, width: number, align: "left" | "right" = "left"): string {
	const w = visibleWidth(styled);
	if (w >= width) return truncateToWidth(styled, width);
	const pad = " ".repeat(width - w);
	return align === "left" ? styled + pad : pad + styled;
}

// ── Chain YAML Parser ────────────────────────────

function parseChainYaml(raw: string): ChainDef[] {
	const chains: ChainDef[] = [];
	let current: ChainDef | null = null;
	let currentStep: ChainStep | null = null;

	for (const line of raw.split("\n")) {
		// Chain name: top-level key
		const chainMatch = line.match(/^(\S[^:]*):$/);
		if (chainMatch) {
			if (current && currentStep) {
				current.steps.push(currentStep);
				currentStep = null;
			}
			current = { name: chainMatch[1].trim(), description: "", steps: [] };
			chains.push(current);
			continue;
		}

		// Chain description
		const descMatch = line.match(/^\s+description:\s+(.+)$/);
		if (descMatch && current && !currentStep) {
			let desc = descMatch[1].trim();
			if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
				desc = desc.slice(1, -1);
			}
			current.description = desc;
			continue;
		}

		// "steps:" label — skip
		if (line.match(/^\s+steps:\s*$/) && current) {
			continue;
		}

		// Step agent line
		const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
		if (agentMatch && current) {
			if (currentStep) {
				current.steps.push(currentStep);
			}
			currentStep = { agent: agentMatch[1].trim(), prompt: "" };
			continue;
		}

		// Step prompt line
		const promptMatch = line.match(/^\s+prompt:\s+(.+)$/);
		if (promptMatch && currentStep) {
			let prompt = promptMatch[1].trim();
			if ((prompt.startsWith('"') && prompt.endsWith('"')) || (prompt.startsWith("'") && prompt.endsWith("'"))) {
				prompt = prompt.slice(1, -1);
			}
			prompt = prompt.replace(/\\n/g, "\n");
			currentStep.prompt = prompt;
		}
	}

	if (current && currentStep) {
		current.steps.push(currentStep);
	}

	return chains;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		// `*/*` is treated as "no preference" — fall back to the orchestrator.
		const rawModel = (frontmatter.model || "").trim();
		const model = rawModel && rawModel !== "*/*" ? rawModel : undefined;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			model,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string, bundledDir: string): Map<string, AgentDef> {
	const dirs = [
		// Bundled agents (lowest priority — user can override by name)
		bundledDir,
		// User-defined agents (later entries override earlier ones)
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents = new Map<string, AgentDef>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (!def) continue;
				// Later dirs override earlier ones (user wins over bundled)
				agents.set(def.name.toLowerCase(), def);
			}
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

// Spawned `pi` subprocesses must die when ANY of these happen:
//
//   (1) The agent run's `AbortSignal` aborts — user hit ESC, ctx.abort(),
//       compaction abort, retry abort, etc. Pi-agent-core hands the signal
//       to `tool.execute(id, args, signal, onUpdate)`.
//
//   (2) Pi itself is shutting down — `session_shutdown` event fires with
//       reason "quit" (Pi process exiting after SIGTERM/SIGHUP, or `/quit`)
//       or reason "new"/"resume"/"fork"/"reload" (session replacement).
//       Pi awaits our handler before tearing down, so we can reap children.
//
// The supervisor abstracts the SIGTERM → grace → SIGKILL protocol so all
// termination sources funnel through the same code path. Idempotent: any
// number of `terminate()` calls and any number of `dispose()` calls converge
// on a single child-exit notification.
//
// Private to this file by design — not exported, not factored into a shared
// module. Other extensions in this monorepo opt in by copying this snippet
// rather than coupling to a shared API surface.

type ChildExitCause = "user" | "shutdown" | "normal" | "spawn_error";

interface ChildExitReason {
	cause: ChildExitCause;
	exitCode: number;
	message?: string;
}

interface ChildSupervisor {
	/** Resolves when the child exits (naturally or via termination). Idempotent. */
	waitForExit(): Promise<ChildExitReason>;
	/** Idempotent. Records `cause` and begins SIGTERM → grace → SIGKILL. */
	terminate(cause: "user" | "shutdown"): void;
	/** Detach all listeners. Safe to call multiple times. */
	dispose(): void;
}

function superviseChild(proc: ChildProcess, opts: { gracePeriodMs: number; signal?: AbortSignal | undefined }): ChildSupervisor {
	const gracePeriodMs = opts.gracePeriodMs;
	let triggeredCause: ChildExitCause | null = null;
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
	let resolved = false;
	const detachers: Array<() => void> = [];

	let resolveExit!: (r: ChildExitReason) => void;
	const exitPromise = new Promise<ChildExitReason>((resolve) => {
		resolveExit = resolve;
	});

	const runDetachers = () => {
		while (detachers.length > 0) {
			const d = detachers.pop();
			try {
				d?.();
			} catch {}
		}
	};

	const terminate = (cause: "user" | "shutdown"): void => {
		if (resolved || triggeredCause !== null) return;
		triggeredCause = cause;
		try {
			proc.kill("SIGTERM");
		} catch {}
		sigkillTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, gracePeriodMs);
	};

	const finalize = (reason: ChildExitReason): void => {
		if (resolved) return;
		resolved = true;
		if (sigkillTimer) {
			clearTimeout(sigkillTimer);
			sigkillTimer = undefined;
		}
		runDetachers();
		resolveExit(reason);
	};

	const onClose = (code: number | null) => {
		finalize({
			cause: triggeredCause ?? "normal",
			exitCode: code ?? 1,
		});
	};
	const onError = (err: Error) => {
		finalize({
			cause: "spawn_error",
			exitCode: 1,
			message: err.message,
		});
	};
	proc.on("close", onClose);
	proc.on("error", onError);
	detachers.push(() => proc.off("close", onClose));
	detachers.push(() => proc.off("error", onError));

	// Wire the run-level AbortSignal so ESC propagates into the child.
	if (opts.signal) {
		const signal = opts.signal;
		if (signal.aborted) {
			// Already aborted before the supervisor was even attached.
			terminate("user");
		} else {
			const onAbort = () => terminate("user");
			signal.addEventListener("abort", onAbort, { once: true });
			detachers.push(() => signal.removeEventListener("abort", onAbort));
		}
	}

	return {
		waitForExit: () => exitPromise,
		terminate,
		dispose: () => {
			if (sigkillTimer) {
				clearTimeout(sigkillTimer);
				sigkillTimer = undefined;
			}
			runDetachers();
		},
	};
}

// Exported for unit tests — NOT public API.
export const _supervisorInternals = { superviseChild };

export default function (pi: ExtensionAPI) {
	let allAgents: Map<string, AgentDef> = new Map();
	let chains: ChainDef[] = [];
	let activeChain: ChainDef | null = null;
	let widgetCtx: ExtensionContext | undefined;
	let sessionDir = "";
	const agentSessions: Map<string, string | null> = new Map();

	// Per-step state for the active chain
	let stepStates: StepState[] = [];
	let pendingReset = false;

	// Chain-level state (resets per `run_chain` invocation)
	let chainStartTime: number | null = null;
	let parentSessionId = "";
	let parentContextWindow = 0;
	let chainTickTimer: ReturnType<typeof setInterval> | null = null;

	// Every spawned child registers its supervisor here so a single
	// `session_shutdown` handler can fan out termination across all of them.
	// Pi awaits the handler before tearing the runtime down, so children get
	// SIGTERM + grace + SIGKILL within the 2s window before any zombies leak.
	const activeSupervisors = new Set<ChildSupervisor>();

	function startChainTick() {
		if (chainTickTimer) return;
		// 1 Hz tick so header total-elapsed and per-step "running" elapsed move
		// while a subprocess is mid-flight and no new events have arrived.
		chainTickTimer = setInterval(() => {
			if (chainStartTime === null) return;
			// Advance the elapsed of whichever step is currently running.
			for (const s of stepStates) {
				if (s.status === "running") {
					// Real elapsed for running steps is owned by runAgent's own timer,
					// but we still need to nudge the widget so the header repaints.
				}
			}
			updateWidget();
		}, 1000);
	}

	function stopChainTick() {
		if (chainTickTimer) {
			clearInterval(chainTickTimer);
			chainTickTimer = null;
		}
	}

	// Bundled agents ship alongside the extension file. Resolve relative to
	// import.meta.url so installed packages (npm or git) Just Work.
	const BUNDLED_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");

	function loadChains(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		allAgents = scanAgentDirs(cwd, BUNDLED_AGENTS_DIR);

		agentSessions.clear();
		for (const [key] of allAgents) {
			const sessionFile = join(sessionDir, `chain-${key}.json`);
			agentSessions.set(key, existsSync(sessionFile) ? sessionFile : null);
		}

		// Prefer user's chain config; fall back to the bundled defaults.
		const userChainPath = join(cwd, ".pi", "agents", "agent-chain.yaml");
		const bundledChainPath = join(BUNDLED_AGENTS_DIR, "agent-chain.yaml");
		const chainPath = existsSync(userChainPath) ? userChainPath : bundledChainPath;

		if (existsSync(chainPath)) {
			try {
				chains = parseChainYaml(readFileSync(chainPath, "utf-8"));
			} catch {
				chains = [];
			}
		} else {
			chains = [];
		}
	}

	function freshStep(agent: string): StepState {
		return {
			agent,
			status: "pending",
			elapsed: 0,
			lastWork: "",
			costUsd: 0,
			contextTokens: 0,
			model: "",
		};
	}

	// Build fresh steps for a chain AND pre-populate each step's `model` cell
	// from `agentDef.model` / orchestrator precedence. Without this, only the
	// running step's model column is filled — pending steps stay blank for the
	// entire chain duration, even though we already know what they'll run on.
	//
	// `ctx` defaults to `widgetCtx` (set in session_start) so callers that don't
	// have a live ExtensionContext can still get correct model resolution; the
	// tool execute path (`runChain`) passes its own `ctx` explicitly.
	function freshStepsForChain(chain: ChainDef, ctx: ExtensionContext | undefined = widgetCtx): StepState[] {
		return chain.steps.map((s) => {
			const step = freshStep(s.agent);
			const agentDef = allAgents.get(s.agent.toLowerCase());
			if (agentDef && ctx) {
				const { id } = resolveStepModel(agentDef, ctx);
				step.model = id;
			}
			return step;
		});
	}

	function activateChain(chain: ChainDef) {
		activeChain = chain;
		stepStates = freshStepsForChain(chain);
		// Skip widget re-registration if reset is pending — let before_agent_start handle it
		if (!pendingReset) {
			updateWidget();
		}
	}

	// ── Card Rendering ──────────────────────────

	function statusBullet(status: StepState["status"], theme: Theme): string {
		switch (status) {
			case "pending":
				return theme.fg("dim", "◇");
			case "running":
				return theme.fg("accent", "◆");
			case "done":
				return theme.fg("success", "◆");
			case "error":
				return theme.fg("error", "◆");
		}
	}

	// `pushUpdate` is assigned by the widget factory on mount. Calling it from
	// async code (runAgent's stdout handler, runChain's status transitions, the
	// 1Hz timer) is what tells Pi to repaint the widget. Without this, calling
	// setWidget repeatedly does NOT trigger a re-render — Pi's render loop is
	// demand-driven, fed by `tui.requestRender()`.
	let pushUpdate: (() => void) | null = null;

	function updateWidget() {
		pushUpdate?.();
	}

	function mountWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-chain", (tui: TUI, theme: Theme) => {
			const text = new Text("", 0, 1);
			// Cached terminal width — captured every time Pi calls render(width),
			// so async repaints triggered by `pushUpdate()` can use the same width
			// without waiting for the next render() call to thread it through.
			let lastWidth = 80;

			const rebuild = (width: number): void => {
				if (!activeChain || stepStates.length === 0) {
					text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
					return;
				}

				// Column widths driven by data
				const labelWidth = Math.max(
					visibleWidth("\u25c6 Orch"),
					...stepStates.map((s) => visibleWidth(`\u251c\u2500\u25c6 ${displayName(s.agent)}`)),
				);
				const totalCost = stepStates.reduce((a, s) => a + s.costUsd, 0);
				const costStrings = [formatCost(totalCost), ...stepStates.map((s) => formatCost(s.costUsd))];
				const costWidth = Math.max(...costStrings.map((c) => c.length));

				const totalContextTokens = stepStates.reduce((a, s) => a + s.contextTokens, 0);
				const tokenStrings = [
					formatTokenPair(totalContextTokens, parentContextWindow),
					...stepStates.map((s) => formatTokenPair(s.contextTokens, parentContextWindow)),
				];
				const tokenWidth = Math.max(...tokenStrings.map((t) => t.length));

				const orchModel = [...stepStates].reverse().find((s) => s.model)?.model || widgetCtx?.model?.id || "";
				const modelStrings = [orchModel, ...stepStates.map((s) => s.model)];
				const modelWidth = Math.max(...modelStrings.map((m) => m.length || 0), 1);

				const elapsedStrings = stepStates.map((s) => (s.status === "pending" ? "" : formatElapsed(s.elapsed)));
				const elapsedWidth = Math.max(...elapsedStrings.map((e) => e.length), 1);

				const GAP = "  ";

				// Header: chain │ session │ total-elapsed
				const chainName = activeChain?.name ?? "";
				const totalElapsed =
					chainStartTime !== null
						? formatElapsed(Date.now() - chainStartTime)
						: formatElapsed(stepStates.reduce((a, s) => a + s.elapsed, 0));
				const sep = theme.fg("muted", " \u2502 ");
				const headerPieces: string[] = [theme.fg("accent", theme.bold(chainName))];
				if (parentSessionId) headerPieces.push(theme.fg("dim", parentSessionId));
				headerPieces.push(theme.fg("dim", totalElapsed));
				const header = headerPieces.join(sep);

				const buildRow = (
					prefix: string,
					bullet: string,
					label: string,
					cost: string,
					tokens: string,
					model: string,
					elapsed: string,
				): string => {
					const rawLabel = `${prefix}\u25c6 ${label}`;
					const styledLabel = theme.fg("dim", prefix) + bullet + " " + theme.fg("accent", theme.bold(label));
					const rawW = visibleWidth(rawLabel);
					const labelCell = styledLabel + " ".repeat(Math.max(0, labelWidth - rawW));

					const costCell = padCell(theme.fg("warning", cost), costWidth, "right");
					const tokensCell = padCell(theme.fg("dim", tokens), tokenWidth, "right");
					const modelCell = padCell(theme.fg("muted", model), modelWidth);
					const elapsedCell = elapsed ? padCell(theme.fg("dim", elapsed), elapsedWidth, "right") : " ".repeat(elapsedWidth);

					return [labelCell, costCell, tokensCell, modelCell, elapsedCell].join(GAP);
				};

				const lines: string[] = [];
				lines.push(truncateToWidth(header, width));

				// Orch row — aggregate of all steps
				const orchStatus: StepState["status"] = stepStates.some((s) => s.status === "error")
					? "error"
					: stepStates.some((s) => s.status === "running")
						? "running"
						: stepStates.every((s) => s.status === "done")
							? "done"
							: "pending";
				lines.push(
					truncateToWidth(
						buildRow(
							"",
							statusBullet(orchStatus, theme),
							"Orch",
							formatCost(totalCost),
							formatTokenPair(totalContextTokens, parentContextWindow),
							orchModel,
							"",
						),
						width,
					),
				);

				// Per-step rows with tree branches
				stepStates.forEach((s, i) => {
					const isLast = i === stepStates.length - 1;
					const prefix = isLast ? "\u2514\u2500" : "\u251c\u2500";
					const elapsed = s.status === "pending" ? "" : formatElapsed(s.elapsed);
					lines.push(
						truncateToWidth(
							buildRow(
								prefix,
								statusBullet(s.status, theme),
								displayName(s.agent),
								formatCost(s.costUsd),
								formatTokenPair(s.contextTokens, parentContextWindow),
								s.model,
								elapsed,
							),
							width,
						),
					);
				});

				text.setText(lines.join("\n"));
			};

			// Initial paint
			rebuild(lastWidth);

			// Wire up the outer-scope updater. Mutating outer state and calling
			// `pushUpdate()` rebuilds the cache, invalidates Text, and asks Pi for
			// a frame — that's what makes long-running async work visible live.
			pushUpdate = () => {
				rebuild(lastWidth);
				text.invalidate();
				tui.requestRender();
			};

			return {
				render(width: number): string[] {
					lastWidth = width;
					rebuild(width);
					return text.render(width);
				},
				invalidate() {
					rebuild(lastWidth);
					text.invalidate();
				},
			};
		});
	}

	// Model precedence shared between `runChain` (pre-populates widget state)
	// and `runAgent` (passes the resolved value to `pi --model`):
	//   1. Per-agent frontmatter `model: <provider>/<id>` — explicit opt-in per
	//      agent (e.g. cheap model for `scout`, opus for `reviewer`).
	//   2. Orchestrator's active model — propagates the user's current choice
	//      so chains follow whatever they're driving the parent agent with.
	//   3. Hardcoded default — last-resort fallback when no parent model is set.
	//
	// Returns both the full `<provider>/<id>` form (for the spawn arg) and the
	// id-only form (for the widget cell, which matches what `message_end`
	// events will later overwrite with `message.model`).
	function resolveStepModel(agentDef: AgentDef, ctx: ExtensionContext): { full: string; id: string } {
		const orchestratorModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const full = agentDef.model ?? orchestratorModel ?? "openrouter/google/gemini-3-flash-preview";
		const parts = full.split("/");
		const id = parts.slice(1).join("/") || full;
		return { full, id };
	}

	// ── Run Agent (subprocess) ──────────────────

	function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<{ output: string; exitCode: number; elapsed: number; aborted: boolean }> {
		const { full: model } = resolveStepModel(agentDef, ctx);

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--model",
			model,
			"--tools",
			agentDef.tools,
			"--thinking",
			"off",
			"--append-system-prompt",
			agentDef.systemPrompt,
			"--session",
			agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		// See ~/.pi/agent/extensions/subagent-flags.json for optional `-e` injection into the child
		args.push(...loadSubagentExtraArgs(EXTENSION_NAME, ctx.cwd));
		args.push(task);

		const textChunks: string[] = [];
		const startTime = Date.now();
		const state = stepStates[stepIndex];

		// Short-circuit when the run signal aborted before we even spawn.
		if (signal?.aborted) {
			return Promise.resolve({
				output: "Aborted before spawn.",
				exitCode: 130,
				elapsed: 0,
				aborted: true,
			});
		}

		const proc = spawn("pi", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		// Hand off termination concerns (AbortSignal + session_shutdown) to the
		// supervisor. It owns proc.on("close"/"error") and exposes a single
		// `waitForExit()` we await below. Register with the factory-level set
		// so the `session_shutdown` handler can reach in and terminate us.
		const supervisor = superviseChild(proc, { gracePeriodMs: 2000, signal });
		activeSupervisors.add(supervisor);

		return new Promise((resolveP) => {
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			let buffer = "";

			proc.stdout?.setEncoding("utf-8");
			// Pull final per-message usage off a `message_end` (assistant) event.
			// Token counts and USD cost both live on `message.usage`; we track the
			// LATEST assistant message's context-tokens (= input + cacheRead +
			// cacheWrite) and accumulate cost across all assistant messages in this
			// step. See `pi-mono/packages/agent/src/types.ts:Usage`.
			const handleEvent = (event: {
				type?: string;
				message?: AssistantMessageLike;
				assistantMessageEvent?: { type?: string; delta?: string };
			}) => {
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						textChunks.push(delta.delta || "");
						const full = textChunks.join("");
						const last =
							full
								.split("\n")
								.filter((l: string) => l.trim())
								.pop() || "";
						state.lastWork = last;
						updateWidget();
					}
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const u = event.message.usage;
					if (u) {
						const input = Number(u.input) || 0;
						const cacheR = Number(u.cacheRead) || 0;
						const cacheW = Number(u.cacheWrite) || 0;
						state.contextTokens = input + cacheR + cacheW;
						const costTotal = Number(u.cost?.total) || 0;
						state.costUsd += costTotal;
					}
					if (event.message.model) state.model = event.message.model;
					updateWidget();
				}
			};

			proc.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						handleEvent(JSON.parse(line));
					} catch {}
				}
			});

			proc.stderr?.setEncoding("utf-8");
			proc.stderr?.on("data", () => {});

			// Single exit path: supervisor resolves when the child exits, with the
			// cause ("normal" / "user" / "shutdown" / "spawn_error") attached.
			void supervisor.waitForExit().then((exit) => {
				// Flush any trailing JSON line still buffered.
				if (buffer.trim()) {
					try {
						handleEvent(JSON.parse(buffer));
					} catch {}
				}

				clearInterval(timer);
				activeSupervisors.delete(supervisor);
				supervisor.dispose();

				const elapsed = Date.now() - startTime;
				state.elapsed = elapsed;
				const output = textChunks.join("");
				state.lastWork =
					output
						.split("\n")
						.filter((l: string) => l.trim())
						.pop() || "";

				const aborted = exit.cause === "user" || exit.cause === "shutdown";
				if (exit.exitCode === 0 && !aborted && exit.cause === "normal") {
					agentSessions.set(agentKey, agentSessionFile);
				}

				// Spawn errors carry the failure message in `exit.message`.
				const finalOutput = exit.cause === "spawn_error" ? `Error spawning agent: ${exit.message ?? "unknown"}` : output;

				resolveP({
					output: finalOutput,
					exitCode: exit.exitCode,
					elapsed,
					aborted,
				});
			});
		});
	}

	// ── Run Chain (sequential pipeline) ─────────

	async function runChain(
		task: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<{ output: string; success: boolean; elapsed: number; aborted: boolean }> {
		if (!activeChain) {
			return { output: "No chain active", success: false, elapsed: 0, aborted: false };
		}

		const chainStart = Date.now();
		chainStartTime = chainStart;
		startChainTick();

		// Capture parent session id + context window for the header / token ratios.
		try {
			const sid = ctx.sessionManager?.getSessionId?.();
			if (sid) parentSessionId = shortSessionId(sid);
		} catch {}
		const maybeWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
		if (maybeWindow > 0) parentContextWindow = maybeWindow;

		// Reset all steps to pending. Pre-populate each step's model cell from
		// the live tool-execute ctx so the widget shows the resolved model on
		// the very first render — not only when each step transitions to running.
		stepStates = freshStepsForChain(activeChain, ctx);
		updateWidget();

		let input = task;
		const originalPrompt = task;

		for (let i = 0; i < activeChain.steps.length; i++) {
			// Pre-step abort check: if the user hit ESC between steps, surface
			// it cleanly without ever spawning the next subprocess.
			if (signal?.aborted) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = "Aborted by user";
				updateWidget();
				stopChainTick();
				return {
					output: `Chain aborted before step ${i + 1} (${activeChain.steps[i].agent}).`,
					success: false,
					elapsed: Date.now() - chainStart,
					aborted: true,
				};
			}

			const step = activeChain.steps[i];

			// Look up the agent BEFORE flipping to running so we can pre-populate
			// the model cell in the same widget render. Without this, the model
			// column stays empty until the first `message_end` event arrives from
			// the subprocess — a visible flash on chain kickoff.
			const agentDef = allAgents.get(step.agent.toLowerCase());
			if (!agentDef) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = `Agent "${step.agent}" not found`;
				updateWidget();
				stopChainTick();
				return {
					output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(
						", ",
					)}`,
					success: false,
					elapsed: Date.now() - chainStart,
					aborted: false,
				};
			}

			// Pre-populate the resolved model so the widget shows it from the
			// instant the step transitions to "running" — not only after the
			// child's first `message_end` event lands. The id form matches what
			// `message.model` will later overwrite, so there's no visual jitter.
			const { id: stepModelId } = resolveStepModel(agentDef, ctx);
			stepStates[i].model = stepModelId;
			stepStates[i].status = "running";
			updateWidget();

			const resolvedPrompt = step.prompt.replace(/\$INPUT/g, input).replace(/\$ORIGINAL/g, originalPrompt);

			const result = await runAgent(agentDef, resolvedPrompt, i, ctx, signal);

			if (result.aborted) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = "Aborted by user";
				updateWidget();
				stopChainTick();
				return {
					output: `Chain aborted during step ${i + 1} (${step.agent}).`,
					success: false,
					elapsed: Date.now() - chainStart,
					aborted: true,
				};
			}

			if (result.exitCode !== 0) {
				stepStates[i].status = "error";
				updateWidget();
				stopChainTick();
				return {
					output: `Error at step ${i + 1} (${step.agent}): ${result.output}`,
					success: false,
					elapsed: Date.now() - chainStart,
					aborted: false,
				};
			}

			stepStates[i].status = "done";
			updateWidget();

			input = result.output;
		}

		stopChainTick();
		return { output: input, success: true, elapsed: Date.now() - chainStart, aborted: false };
	}

	// ── run_chain Tool ──────────────────────────

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description:
			"Execute the active agent chain pipeline. Each step runs sequentially — output from one step feeds into the next. Agents maintain session context across runs.",
		parameters: Type.Object({
			task: Type.String({ description: "The task/prompt for the chain to process" }),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { task } = params as RunChainArgs;

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting chain: ${activeChain?.name}...` }],
					details: { chain: activeChain?.name, task, status: "running" } satisfies RunChainDetails,
				});
			}

			// Pi-agent-core hands us the run's AbortSignal here. Threading it
			// through runChain → runAgent → child process is what makes ESC abort
			// actually kill in-flight subprocesses; without this the chain runs
			// to natural completion regardless of user input.
			const result = await runChain(task, ctx, signal);

			const truncated = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output;

			const status: "done" | "error" = result.success ? "done" : "error";
			const abortedSuffix = result.aborted ? " (aborted)" : "";
			const summary = `[chain:${activeChain?.name}] ${status}${abortedSuffix} in ${Math.round(result.elapsed / 1000)}s`;

			return {
				content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
				details: {
					chain: activeChain?.name,
					task,
					status,
					elapsed: result.elapsed,
					fullOutput: result.output,
				} satisfies RunChainDetails,
			};
		},

		renderCall(args, theme) {
			const task = (args as RunChainArgs).task || "";
			const preview = task.length > 60 ? `${task.slice(0, 57)}...` : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_chain ")) +
					theme.fg("accent", activeChain?.name || "?") +
					theme.fg("dim", " — ") +
					theme.fg("muted", preview),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as RunChainDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "running") {
				return new Text(theme.fg("accent", `● ${details.chain || "chain"}`) + theme.fg("dim", " running..."), 0, 0);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.chain}`) + theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output =
					details.fullOutput.length > 4000 ? `${details.fullOutput.slice(0, 4000)}\n... [truncated]` : details.fullOutput;
				return new Text(`${header}\n${theme.fg("muted", output)}`, 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("chain", {
		description: "Switch active chain",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined. Add .pi/agents/agent-chain.yaml or use the bundled defaults.", "warning");
				return;
			}

			const options = chains.map((c) => {
				const steps = c.steps.map((s) => displayName(s.agent)).join(" → ");
				const desc = c.description ? ` — ${c.description}` : "";
				return `${c.name}${desc} (${steps})`;
			});

			const choice = await ctx.ui.select("Select Chain", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			activateChain(chains[idx]);
			const flow = chains[idx].steps.map((s) => displayName(s.agent)).join(" → ");
			ctx.ui.setStatus("agent-chain", `Chain: ${chains[idx].name} (${chains[idx].steps.length} steps)`);
			ctx.ui.notify(`Chain: ${chains[idx].name}\n${chains[idx].description}\n${flow}`, "info");
		},
	});

	pi.registerCommand("chain-list", {
		description: "List all available chains",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined.", "warning");
				return;
			}

			const list = chains
				.map((c) => {
					const desc = c.description ? `  ${c.description}` : "";
					const steps = c.steps.map((s, i) => `  ${i + 1}. ${displayName(s.agent)}`).join("\n");
					return `${c.name}:${desc ? `\n${desc}` : ""}\n${steps}`;
				})
				.join("\n\n");

			ctx.ui.notify(list, "info");
		},
	});

	// ── System Prompt Override ───────────────────

	// When Pi is exiting (`quit`) or about to replace the current session
	// (`new` / `resume` / `fork` / `reload`), trigger termination on every
	// active spawned child and AWAIT their exits. Pi awaits this handler in
	// `AgentSessionRuntime.dispose()` / `teardownCurrent()`, so we can
	// guarantee no zombie `pi` subprocesses outlive the parent.
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (activeSupervisors.size === 0) return;
		const exits = [...activeSupervisors].map((sup) => {
			sup.terminate("shutdown");
			return sup.waitForExit();
		});
		await Promise.all(exits);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		// Force widget reset on first turn after /new
		if (pendingReset && activeChain) {
			pendingReset = false;
			// If a new ctx arrives, re-mount so `pushUpdate` points at the live
			// `tui.requestRender` of the current frame loop.
			if (widgetCtx !== _ctx) {
				widgetCtx = _ctx;
				pushUpdate = null;
				mountWidget();
			}
			stepStates = freshStepsForChain(activeChain, _ctx);
			chainStartTime = null;
			try {
				const sid = _ctx.sessionManager?.getSessionId?.();
				if (sid) parentSessionId = shortSessionId(sid);
			} catch {}
			const maybeWindow = (_ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
			if (maybeWindow > 0) parentContextWindow = maybeWindow;
			updateWidget();
		}

		if (!activeChain) return {};

		const flow = activeChain.steps.map((s) => displayName(s.agent)).join(" → ");
		const desc = activeChain.description ? `\n${activeChain.description}` : "";

		// Build pipeline steps summary
		const steps = activeChain.steps
			.map((s, i) => {
				const agentDef = allAgents.get(s.agent.toLowerCase());
				const agentDesc = agentDef?.description || "";
				return `${i + 1}. **${displayName(s.agent)}** — ${agentDesc}`;
			})
			.join("\n");

		// Build full agent catalog (dedup by name)
		const seen = new Set<string>();
		const agentCatalog = activeChain.steps
			.filter((s) => {
				const key = s.agent.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map((s) => {
				const agentDef = allAgents.get(s.agent.toLowerCase());
				if (!agentDef) return `### ${displayName(s.agent)}\nAgent not found.`;
				const modelLine = agentDef.model ? `\n**Model:** ${agentDef.model}` : "\n**Model:** (inherits orchestrator)";
				return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}${modelLine}\n**Role:** ${agentDef.systemPrompt}`;
			})
			.join("\n\n");

		const base = event.systemPrompt ?? "";
		const chainPrompt = `You are an agent with a sequential pipeline called "${activeChain.name}" at your disposal.${desc}
You have full access to your own tools AND the run_chain tool to delegate to your team.

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${agentCatalog}

## When to Use run_chain
- Significant work: new features, refactors, multi-file changes, anything non-trivial
- Tasks that benefit from the full pipeline: planning, building, reviewing
- When you want structured, multi-agent collaboration on a problem

## When to Work Directly
- Simple one-off commands: reading a file, checking status, listing contents
- Quick lookups, small edits, answering questions about the codebase
- Anything you can handle in a single step without needing the pipeline

## How run_chain Works
- Pass a clear task description to run_chain
- Each step's output feeds into the next step as $INPUT
- Agents maintain session context — they remember previous work within this session
- You can run the chain multiple times with different tasks if needed
- After the chain completes, review the result and summarize for the user

## Guidelines
- Use your judgment — if it's quick, just do it; if it's real work, run the chain
- Keep chain tasks focused and clearly described
- You can mix direct work and chain runs in the same conversation`;

		return {
			systemPrompt: base ? `${base}\n\n---\n\n${chainPrompt}` : chainPrompt,
		};
	});

	// Eager initialization: populate the agents map and chain list at factory
	// time so that:
	//   (a) the `run_chain` tool works the instant `registerTool` returns —
	//       no race with `session_start`
	//
	// `process.cwd()` is a best-effort stand-in for the session cwd; the real
	// `ctx.cwd` is reapplied in `session_start` below, which re-runs
	// `loadChains` and picks up any user-local overrides under .pi/agents/.
	loadChains(process.cwd());
	if (chains.length > 0) {
		activateChain(chains[0]);
	}

	// ── Session Start ───────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clear widget with both old and new ctx — one of them will be valid
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-chain", undefined);
		}
		_ctx.ui.setWidget("agent-chain", undefined);
		// New ctx → the previous `pushUpdate` closure points at a stale `tui`.
		pushUpdate = null;
		widgetCtx = _ctx;

		// Reset execution state
		stopChainTick();
		stepStates = [];
		activeChain = null;
		pendingReset = true;
		chainStartTime = null;
		parentSessionId = shortSessionId(_ctx.sessionManager?.getSessionId?.());
		parentContextWindow = (_ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;

		// Mount the widget ONCE per session ctx. Subsequent state changes call
		// `pushUpdate()` (via `updateWidget()`) which invalidates + requests a
		// render — the demand-driven repaint Pi's TUI expects.
		mountWidget();

		// Wipe chain session files — reset agent context on /new and launch
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("chain-") && f.endsWith(".json")) {
					try {
						unlinkSync(join(sessDir, f));
					} catch {}
				}
			}
		}

		// Reload chains + clear agentSessions map (all agents start fresh)
		loadChains(_ctx.cwd);

		if (chains.length === 0) {
			_ctx.ui.notify("No chains found. Add .pi/agents/agent-chain.yaml or use the bundled defaults.", "warning");
			return;
		}

		// Default to first chain — use /chain to switch
		const defaultChain = chains[0];
		activateChain(defaultChain);

		const flow = defaultChain.steps.map((s) => displayName(s.agent)).join(" → ");
		const name = defaultChain.name;
		const description = defaultChain.description;
		const stepCount = defaultChain.steps.length;

		_ctx.ui.setStatus("agent-chain", `Chain: ${name} (${stepCount} steps)`);
		_ctx.ui.notify(
			`Chain: ${name}\n${description}\n${flow}\n\n` + `/chain             Switch chain\n` + `/chain-list        List all chains`,
			"info",
		);

		// Footer: model | chain name | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage?.percent ?? 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const chainLabel = activeChain ? theme.fg("accent", activeChain.name) : theme.fg("dim", "no chain");

				const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + chainLabel;
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
