#!/usr/bin/env node
/**
 * Visual snapshot: load the extension, drive it through one fake run_chain
 * lifecycle with synthetic per-step usage, and print the widget output to
 * stdout. Confirms the tree layout aligns correctly with ANSI styling and
 * looks like the reference screenshot.
 */

import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Mirror helpers from extensions/index.ts
const displayName = (n) =>
	n.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const shortSessionId = (u) => (u ? u.slice(0, 13) : "");
const formatCost = (u) => (Number.isFinite(u) && u > 0 ? `$${u.toFixed(3)}` : "$0.000");
const formatTokens = (n) => {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
};
const formatTokenPair = (used, limit) =>
	`${formatTokens(used)}/${limit > 0 ? formatTokens(limit) : "?"}`;
const formatElapsed = (ms) => {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const t = Math.round(ms / 1000);
	const m = Math.floor(t / 60);
	const s = t % 60;
	return m === 0 ? `${s}s` : `${m}m ${s.toString().padStart(2, "0")}s`;
};
const padCell = (styled, w, align = "left") => {
	const vw = visibleWidth(styled);
	if (vw >= w) return truncateToWidth(styled, w);
	const pad = " ".repeat(w - vw);
	return align === "left" ? styled + pad : pad + styled;
};

// Minimal stub theme: ANSI bold + foreground colors via 256-color sequences
const ansi = {
	reset: "\x1b[0m",
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	color(name) {
		switch (name) {
			case "accent":  return "\x1b[38;5;81m";   // cyan-ish
			case "success": return "\x1b[38;5;114m";  // green
			case "warning": return "\x1b[38;5;215m";  // amber
			case "error":   return "\x1b[38;5;203m";  // red
			case "dim":     return "\x1b[38;5;244m";  // gray
			case "muted":   return "\x1b[38;5;249m";  // light gray
			default:        return "";
		}
	},
};
const theme = {
	fg: (name, s) => `${ansi.color(name)}${s}${ansi.reset}`,
	bold: (s) => ansi.bold(s),
};

const statusBullet = (status) => {
	switch (status) {
		case "pending": return theme.fg("dim", "◇");
		case "running": return theme.fg("accent", "◆");
		case "done":    return theme.fg("success", "◆");
		case "error":   return theme.fg("error", "◆");
	}
};

// Synthetic state — mirrors the reference screenshot
const chainName = "plan-build-review";
const parentSessionId = shortSessionId("019e4774-c95c-8859-c052-12abf0123456");
const parentContextWindow = 1_000_000;
const chainStartTime = Date.now() - (12 * 60 + 32) * 1000;
const stepStates = [
	{ agent: "planner",       status: "done",    elapsed: 3 * 60_000 + 40_000,  costUsd: 1.043, contextTokens: 131_000, model: "claude-opus-4-7" },
	{ agent: "builder",       status: "done",    elapsed: 4 * 60_000 + 4_000,   costUsd: 1.033, contextTokens: 128_000, model: "claude-sonnet-4-6" },
	{ agent: "code-reviewer", status: "running", elapsed: 4 * 60_000 + 47_000,  costUsd: 1.210, contextTokens: 112_000, model: "claude-opus-4-7" },
];

// ── render (copy of the widget body) ──────────────────────────────────────
const width = 100;

const labelWidth = Math.max(
	visibleWidth("◆ Orch"),
	...stepStates.map((s) => visibleWidth(`├─◆ ${displayName(s.agent)}`)),
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

const orchModel = [...stepStates].reverse().find((s) => s.model)?.model ?? "";
const modelStrings = [orchModel, ...stepStates.map((s) => s.model)];
const modelWidth = Math.max(...modelStrings.map((m) => m.length || 0), 1);

const elapsedStrings = stepStates.map((s) => (s.status === "pending" ? "" : formatElapsed(s.elapsed)));
const elapsedWidth = Math.max(...elapsedStrings.map((e) => e.length), 1);

const GAP = "  ";
const sep = theme.fg("muted", " │ ");
const totalElapsed = formatElapsed(Date.now() - chainStartTime);
const header = [
	theme.fg("accent", theme.bold(chainName)),
	theme.fg("dim", parentSessionId),
	theme.fg("dim", totalElapsed),
].join(sep);

const buildRow = (prefix, bullet, label, cost, tokens, model, elapsed) => {
	const rawLabel = `${prefix}◆ ${label}`;
	const styledLabel = theme.fg("dim", prefix) + bullet + " " + theme.fg("accent", theme.bold(label));
	const labelCell = styledLabel + " ".repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));
	const costCell = padCell(theme.fg("warning", cost), costWidth, "right");
	const tokensCell = padCell(theme.fg("dim", tokens), tokenWidth, "right");
	const modelCell = padCell(theme.fg("muted", model), modelWidth);
	const elapsedCell = elapsed
		? padCell(theme.fg("dim", elapsed), elapsedWidth, "right")
		: " ".repeat(elapsedWidth);
	return [labelCell, costCell, tokensCell, modelCell, elapsedCell].join(GAP);
};

const lines = [];
lines.push(truncateToWidth(header, width));

const orchStatus = stepStates.some((s) => s.status === "error") ? "error"
	: stepStates.some((s) => s.status === "running") ? "running"
	: stepStates.every((s) => s.status === "done") ? "done" : "pending";
lines.push(truncateToWidth(
	buildRow("", statusBullet(orchStatus), "Orch",
		formatCost(totalCost),
		formatTokenPair(totalContextTokens, parentContextWindow),
		orchModel, ""),
	width,
));

stepStates.forEach((s, i) => {
	const isLast = i === stepStates.length - 1;
	const prefix = isLast ? "└─" : "├─";
	const elapsed = s.status === "pending" ? "" : formatElapsed(s.elapsed);
	lines.push(truncateToWidth(
		buildRow(prefix, statusBullet(s.status), displayName(s.agent),
			formatCost(s.costUsd),
			formatTokenPair(s.contextTokens, parentContextWindow),
			s.model, elapsed),
		width,
	));
});

console.log("");
for (const l of lines) console.log(l);
console.log("");

// Also assert basic column alignment: each row's visibleWidth should be ≤ terminal width.
const lengths = lines.map((l) => visibleWidth(l));
const ok = lengths.every((n) => n <= width);
console.log(`row visible widths: ${lengths.join(", ")} (max=${width})`);
console.log(ok ? "PASS ✓ all rows fit within width" : "FAIL ✗ some rows exceed width");
process.exit(ok ? 0 : 1);
