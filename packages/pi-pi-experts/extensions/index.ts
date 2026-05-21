/**
 * Pi Pi — Meta-agent that builds Pi agents
 *
 * A team of domain-specific research experts (extensions, themes, skills,
 * settings, TUI) operate in PARALLEL to gather documentation and patterns.
 * The primary agent synthesizes their findings and WRITES the actual files.
 *
 * Each expert fetches fresh Pi documentation via firecrawl on first query.
 * Experts are read-only researchers. The primary agent is the only writer.
 *
 * Commands:
 *   /experts          — list available experts and their status
 *
 * Usage: pi -e .
 *
 * ---------------------------------------------------------------------------
 * ORIGIN & ATTRIBUTION
 *
 * Derivative work of the "Pi Pi" meta-agent originally created by IndyDevDan
 * (https://github.com/disler) as part of the pi-vs-claude-code project:
 *   https://github.com/disler/pi-vs-claude-code
 *     - extensions/pi-pi.ts            (this file's ancestor)
 *     - .pi/agents/pi-pi/*.md          (bundled verbatim in ../agents/)
 *
 * Original work copyright (c) 2026 IndyDevDan, MIT License.
 * Modifications copyright (c) 2025 dsshap, MIT License.
 * See ../LICENSE for combined notice.
 * ---------------------------------------------------------------------------
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSubagentExtraArgs } from "@dsshap/pi-subagent-flags";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ────────────────────────────────────────

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	// Cumulative USD across every query this expert has answered in this session.
	// Sourced from `message_end` events' `message.usage.cost.total` field.
	costUsd: number;
	timer?: ReturnType<typeof setInterval>;
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

// Shape of the `query_experts` tool args and result.details. Kept here so
// renderCall/renderResult can stay strictly typed without `any` casts.
interface QueryItem {
	expert: string;
	question?: string;
}

interface QueryExpertsArgs {
	queries: QueryItem[];
}

interface ExpertResultRow {
	expert: string;
	question?: string;
	status: "done" | "error" | "researching" | string;
	elapsed: number;
	exitCode?: number;
	output?: string;
	fullOutput?: string;
}

interface QueryExpertsDetails {
	queries?: QueryItem[];
	results: ExpertResultRow[];
	status?: string;
}

// Subagent flags hook: lets local users splice extra `pi` flags into every
// sub-agent spawn from this extension via ~/.pi/agent/subagent-flags.json.
// See @dsshap/pi-subagent-flags for the schema and supported config paths.
const EXTENSION_NAME = "pi-pi-experts";

// Safely extract a human-readable message from a Promise rejection reason
// without resorting to `any`.
function reasonMessage(reason: unknown): string {
	if (reason && typeof reason === "object" && "message" in reason) {
		const m = (reason as { message?: unknown }).message;
		if (m !== undefined) return String(m);
	}
	return String(reason);
}

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function parseAgentFile(filePath: string): ExpertDef | null {
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

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// Formatters reused inside the widget rebuild. Private to this file — per
// repo convention, extensions opt-in by copying these snippets rather than
// coupling to a shared display module.

function shortSessionId(uuid: string | undefined | null): string {
	if (!uuid) return "";
	return uuid.replace(/-/g, "").slice(0, 12);
}

function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.000";
	return `$${usd.toFixed(3)}`;
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

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	// Captured from whichever context first activates the widget — both
	// command handlers (ExtensionCommandContext) and event handlers like
	// session_start (ExtensionContext) flow through here, so we widen to the
	// common base type that both extend.
	let widgetCtx: ExtensionContext | undefined;
	// `pushUpdate` is assigned by the widget factory on mount. Calling it from
	// async code (queryExpert's stdout handler, the per-expert 1Hz timer) is
	// what tells Pi to repaint. Without this, `setWidget` calls don't trigger
	// a re-render — Pi's render loop is demand-driven via `tui.requestRender()`.
	let pushUpdate: (() => void) | null = null;

	// Agents ship bundled inside this package, alongside the extension file.
	const PI_PI_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");

	// Discover bundled expert .md files. This is one-time startup work
	// independent of session/cwd: the directory is computed from import.meta.url
	// and its contents only change between extension reloads (which re-run the
	// factory). Per the Pi extensions docs ("Async factory functions"), this kind
	// of static, session-independent setup belongs in the factory body so the
	// tool's `execute` closure has a populated `experts` map from the moment
	// `registerTool` returns — not only after `session_start` fires.
	function loadExperts() {
		const piPiDir = PI_PI_AGENTS_DIR;

		experts.clear();

		if (!existsSync(piPiDir)) return;
		try {
			for (const file of readdirSync(piPiDir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "pi-orchestrator.md") continue;
				const fullPath = resolve(piPiDir, file);
				const def = parseAgentFile(fullPath);
				if (def) {
					const key = def.name.toLowerCase();
					if (!experts.has(key)) {
						experts.set(key, {
							def,
							status: "idle",
							question: "",
							elapsed: 0,
							lastLine: "",
							queryCount: 0,
							costUsd: 0,
						});
					}
				}
			}
		} catch {}
	}

	function statusBullet(status: ExpertState["status"], theme: Theme): string {
		switch (status) {
			case "idle":
				return theme.fg("dim", "◇");
			case "researching":
				return theme.fg("accent", "◆");
			case "done":
				return theme.fg("success", "◆");
			case "error":
				return theme.fg("error", "◆");
		}
	}

	function statusColor(status: ExpertState["status"]): "dim" | "accent" | "success" | "error" {
		return status === "idle" ? "dim" : status === "researching" ? "accent" : status === "done" ? "success" : "error";
	}

	function updateWidget() {
		pushUpdate?.();
	}

	function mountWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("pi-pi", (tui: TUI, theme: Theme) => {
			const text = new Text("", 0, 1);
			// Cached terminal width — captured every time Pi calls render(width),
			// so async repaints triggered by `pushUpdate()` can use the same width
			// without waiting for the next render() call to thread it through.
			let lastWidth = 80;

			const rebuild = (width: number): void => {
				if (experts.size === 0) {
					text.setText(theme.fg("dim", `  No experts found. Add agent .md files to ${PI_PI_AGENTS_DIR}/`));
					return;
				}

				const all = Array.from(experts.values());

				// ── Column widths driven by data ──
				const labelWidth = Math.max(...all.map((s) => visibleWidth(`\u25c6 ${displayName(s.def.name)}`)));

				const statusTexts = all.map((s) => {
					const q = s.queryCount > 0 ? ` \u00b7 ${s.queryCount}q` : "";
					return `${s.status}${q}`;
				});
				const statusWidth = Math.max(...statusTexts.map((t) => t.length), 1);

				const costStrings = all.map((s) => formatCost(s.costUsd));
				const costWidth = Math.max(...costStrings.map((c) => c.length));

				const elapsedStrings = all.map((s) => (s.status === "idle" ? "" : formatElapsed(s.elapsed)));
				const elapsedWidth = Math.max(...elapsedStrings.map((e) => e.length), 1);

				const GAP = "  ";
				// Width reserved by everything left of the description column.
				const reserved = labelWidth + GAP.length + statusWidth + GAP.length + costWidth + GAP.length + elapsedWidth + GAP.length;
				const descWidth = Math.max(20, width - reserved);

				const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}\u2026` : s);

				// ── Header: Pi Pi │ short-session │ counters ──
				const sessionShort = widgetCtx ? shortSessionId(widgetCtx.sessionManager?.getSessionId?.()) : "";
				const activeCount = all.filter((s) => s.status === "researching").length;
				const totalQueries = all.reduce((a, s) => a + s.queryCount, 0);
				const totalCost = all.reduce((a, s) => a + s.costUsd, 0);
				const counterParts: string[] = [`${all.length} experts`];
				if (activeCount > 0) counterParts.push(`${activeCount} active`);
				if (totalCost > 0) counterParts.push(formatCost(totalCost));
				if (totalQueries > 0) counterParts.push(`${totalQueries} queries`);
				const counters = counterParts.join(" \u00b7 ");

				const sep = theme.fg("muted", " \u2502 ");
				const headerPieces: string[] = [theme.fg("accent", theme.bold("Pi Pi"))];
				if (sessionShort) headerPieces.push(theme.fg("dim", sessionShort));
				headerPieces.push(theme.fg("dim", counters));
				const header = headerPieces.join(sep);

				// ── Row builder ──
				const buildRow = (s: ExpertState, statusText: string, costText: string, elapsedText: string): string => {
					const name = displayName(s.def.name);
					const rawLabel = `\u25c6 ${name}`;
					const styledLabel = statusBullet(s.status, theme) + " " + theme.fg("accent", theme.bold(name));
					const labelCell = styledLabel + " ".repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));

					const statusCell = padCell(theme.fg(statusColor(s.status), statusText), statusWidth);
					const costCell = padCell(theme.fg("warning", costText), costWidth, "right");
					const elapsedCell = elapsedText
						? padCell(theme.fg("dim", elapsedText), elapsedWidth, "right")
						: " ".repeat(elapsedWidth);

					// Description column doubles as a live work view:
					//   idle   → static .md frontmatter description (gives context per expert)
					//   other  → last meaningful line of streamed assistant text from
					//            the spawned subprocess (state.lastLine), falling back to
					//            the static description if the child hasn't streamed yet.
					const rawDesc = s.status === "idle" ? s.def.description : s.lastLine || s.def.description;
					const descText = truncate(rawDesc || "", descWidth);
					// Slightly dim the live-work view so the eye picks up the static
					// description rows (idle, contextual) vs. the working rows.
					const descColor: "muted" | "dim" = s.status === "researching" && s.lastLine ? "dim" : "muted";
					const descCell = theme.fg(descColor, descText);

					return [labelCell, statusCell, costCell, elapsedCell, descCell].join(GAP);
				};

				const lines: string[] = [];
				lines.push(truncateToWidth(header, width));
				all.forEach((s, i) => {
					lines.push(truncateToWidth(buildRow(s, statusTexts[i], costStrings[i], elapsedStrings[i]), width));
				});

				text.setText(lines.join("\n"));
			};

			rebuild(lastWidth);

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

	// ── Query Expert ─────────────────────────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: ExtensionContext,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Expert "${expertName}" not found. Available: ${Array.from(experts.values())
					.map((s) => s.def.name)
					.join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `Expert "${displayName(state.def.name)}" is already researching. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model",
			model,
			"--tools",
			state.def.tools,
			"--thinking",
			"off",
			"--append-system-prompt",
			state.def.systemPrompt,
			...loadSubagentExtraArgs(EXTENSION_NAME, ctx.cwd),
			question,
		];

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			proc.stdout?.setEncoding("utf-8");
			// Each spawned `pi` emits a JSON event stream. We care about two:
			//   - message_update with text_delta → streaming text for `state.lastLine`
			//   - message_end (assistant) → final usage; accumulate `cost.total`
			// See pi-mono/packages/ai/src/types.ts (Usage + AssistantMessage).
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
						state.lastLine = last;
						updateWidget();
					}
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const costTotal = Number(event.message.usage?.cost?.total) || 0;
					if (costTotal > 0) {
						state.costUsd += costTotal;
						updateWidget();
					}
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

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						handleEvent(JSON.parse(buffer));
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				const full = textChunks.join("");
				state.lastLine =
					full
						.split("\n")
						.filter((l: string) => l.trim())
						.pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					// Note: upstream pi-pi.ts uses "success" here, but @earendil-works/pi-coding-agent
					// removed that level from notify(); accepted values are "error" | "warning" | "info".
					state.status === "done" ? "info" : "error",
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastLine = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning expert: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// Eager initialization: populate the experts map at factory time so that
	//   (a) the `query_experts` tool description below can list every bundled
	//       expert (avoiding the drift bug where a hardcoded list omitted
	//       newly-added experts the model never learned about), and
	//   (b) tool calls work the instant `registerTool` returns — no race with
	//       `session_start`.
	loadExperts();

	// Build the LLM-facing description dynamically from the loaded experts so
	// adding/removing a bundled `.md` file auto-syncs the tool definition.
	const expertList = Array.from(experts.values())
		.map((s) => `- ${s.def.name}: ${s.def.description}`)
		.join("\n");

	// ── query_experts Tool (parallel) ───────────

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: `Query one or more Pi domain experts IN PARALLEL. All experts run simultaneously as concurrent subprocesses.

Pass an array of queries — each with an expert name and a specific question. All experts start at the same time and their results are returned together.

Available experts:
${expertList}

Ask specific questions about what you need to BUILD. Each expert will return documentation excerpts, code patterns, and implementation guidance.`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description:
							"Expert name: ext-expert, theme-expert, skill-expert, config-expert, tui-expert, prompt-expert, or agent-expert",
					}),
					question: Type.String({
						description: "Specific question about what you need to build. Include context about the target component.",
					}),
				}),
				{ description: "Array of expert queries to run in parallel" },
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { queries } = params as { queries: { expert: string; question: string }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "No queries provided." }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map((q) => displayName(q.expert)).join(", ");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Querying ${queries.length} experts in parallel: ${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			// Launch ALL experts concurrently — allSettled so one failure
			// never discards results from the others
			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question }) => {
					const result = await queryExpert(expert, question, ctx);
					const truncated =
						result.output.length > 12000
							? `${result.output.slice(0, 12000)}\n\n... [truncated — ask follow-up for more]`
							: result.output;
					const status = result.exitCode === 0 ? "done" : "error";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: truncated,
						fullOutput: result.output,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
							expert: queries[i].expert,
							question: queries[i].question,
							status: "error" as const,
							elapsed: 0,
							exitCode: 1,
							output: `Error: ${reasonMessage(s.reason)}`,
							fullOutput: "",
						},
			);

			// Build combined response
			const sections = results.map((r) => {
				const icon = r.status === "done" ? "✓" : "✗";
				return `## [${icon}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: results.every((r) => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args, theme) {
			const queries = (args as QueryExpertsArgs).queries ?? [];
			const names = queries.map((q) => displayName(q.expert || "?")).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("query_experts ")) +
					theme.fg("accent", `${queries.length} parallel`) +
					theme.fg("dim", " — ") +
					theme.fg("muted", names),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as QueryExpertsDetails | undefined;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length ?? "?";
				return new Text(theme.fg("accent", `◉ ${count} experts`) + theme.fg("dim", " researching in parallel..."), 0, 0);
			}

			const lines = details.results.map((r) => {
				const icon = r.status === "done" ? "✓" : "✗";
				const color = r.status === "done" ? "success" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) + theme.fg("dim", ` ${elapsed}s`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = details.results.map((r) => {
					const output = r.fullOutput
						? r.fullOutput.length > 4000
							? `${r.fullOutput.slice(0, 4000)}\n... [truncated]`
							: r.fullOutput
						: r.output || "";
					return `${theme.fg("accent", `── ${displayName(r.expert)} ──`)}\n${theme.fg("muted", output)}`;
				});
				return new Text(`${header}\n\n${expanded.join("\n\n")}`, 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and their status",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map((s) => `${displayName(s.def.name)} (${s.status}, queries: ${s.queryCount}): ${s.def.description}`)
				.join("\n");
			_ctx.ui.notify(lines || "No experts loaded", "info");
		},
	});

	// ── System Prompt ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map((s) => `### ${displayName(s.def.name)}\n**Query as:** \`${s.def.name}\`\n${s.def.description}`)
			.join("\n\n");

		const expertNames = Array.from(experts.values())
			.map((s) => displayName(s.def.name))
			.join(", ");

		const orchestratorPath = join(PI_PI_AGENTS_DIR, "pi-orchestrator.md");
		let systemPrompt = "";
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			const template = match ? match[2].trim() : raw;

			systemPrompt = template
				.replace("{{EXPERT_COUNT}}", experts.size.toString())
				.replace("{{EXPERT_NAMES}}", expertNames)
				.replace("{{EXPERT_CATALOG}}", expertCatalog);
		} catch (_err) {
			systemPrompt = `Error: Could not load pi-orchestrator.md. Make sure it exists in ${PI_PI_AGENTS_DIR}/.`;
		}

		return { systemPrompt };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		if (widgetCtx) {
			widgetCtx.ui.setWidget("pi-pi", undefined);
		}
		// Drop the stale closure that pointed at the previous ctx's tui.
		pushUpdate = null;
		widgetCtx = _ctx;

		// Mount the widget ONCE per session ctx. Subsequent state changes call
		// `pushUpdate()` (via `updateWidget()`) which invalidates + requests a
		// render — the demand-driven repaint Pi's TUI expects.
		mountWidget();

		const expertNames = Array.from(experts.values())
			.map((s) => displayName(s.def.name))
			.join(", ");
		_ctx.ui.setStatus("pi-pi", `Pi Pi (${experts.size} experts)`);
		_ctx.ui.notify(
			`Pi Pi loaded — ${experts.size} experts: ${expertNames}\n\n` +
				`/experts          List experts and status\n\n` +
				`Ask me to build any Pi agent component!`,
			"info",
		);

		// Custom footer
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage?.percent ?? 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter((e) => e.status === "researching").length;
				const done = Array.from(experts.values()).filter((e) => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + theme.fg("accent", "Pi Pi");
				const mid =
					active > 0 ? theme.fg("accent", ` ◉ ${active} researching`) : done > 0 ? theme.fg("success", ` ✓ ${done} done`) : "";
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
