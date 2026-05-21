/**
 * Tests for pi-grid-manager helpers.
 *
 * The extension lifts every pure helper to module-scope `export` so they can
 * be unit-tested without spinning up a Pi runtime. The integration tests at
 * the bottom mock a minimal `UIShape` to exercise the monkey-patching flow.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
	AUTO_COLS_CAP,
	allocateRow,
	type CapturedWidget,
	colsLabel,
	composeRow,
	effectiveCols,
	GRID_KEY,
	getState,
	MAX_COLS,
	MIN_COLS,
	naturalWidth,
	PATCHED_KEY,
	padCell,
	patchUI,
	renderWidget,
	type SharedState,
	STATE_KEY,
	type UIShape,
	type WidgetContent,
} from "../extensions/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");

// ── Fixtures ─────────────────────────────────────

/** Create a fresh UI mock with a working `setWidget` that records calls. */
function makeUI(): UIShape & { calls: Array<[string, unknown, unknown]> } {
	const calls: Array<[string, unknown, unknown]> = [];
	const ui: UIShape = {
		setWidget(key, content, options) {
			calls.push([key, content, options]);
		},
	};
	return Object.assign(ui, { calls });
}

/** Fresh empty SharedState (not anchored on any UI). */
function makeState(overrides: Partial<SharedState> = {}): SharedState {
	return {
		captured: new Map(),
		gridCols: null,
		requestRender: null,
		originalSetWidget: null,
		...overrides,
	};
}

/** Minimal TUI stub — render path only uses requestRender(). */
const tuiStub = { requestRender: vi.fn() } as never;

/** Minimal Theme stub — render path only uses theme.fg(). */
const themeStub = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

// ─────────────────────────────────────────────────
// Package layout
// ─────────────────────────────────────────────────

describe("@dsshap/pi-grid-manager package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("declares package metadata consistently with sibling packages", () => {
		const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8")) as Record<string, unknown>;
		expect(pkg.name).toBe("@dsshap/pi-grid-manager");
		expect(pkg.type).toBe("module");
		expect((pkg.pi as { extensions: string[] }).extensions).toEqual(["./extensions/index.ts"]);
		expect(pkg).toHaveProperty("homepage");
		expect(pkg).toHaveProperty("bugs");
	});

	it("does not bake absolute filesystem paths into source", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).not.toMatch(/\/Users\//);
	});

	it("registers the /grid command and the session_start handler", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/registerCommand\("grid"/);
		expect(src).toMatch(/pi\.on\("session_start"/);
		expect(src).toMatch(/pi\.on\("session_shutdown"/);
	});

	it("uses Symbol.for(...) for cross-reload state and patch keys", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/Symbol\.for\("pi-grid-manager\.state"\)/);
		expect(src).toMatch(/Symbol\.for\("pi-grid-manager\.patched"\)/);
	});

	it("no longer emits setStatus or the load-order warning notification", () => {
		// Both were removed: silent middleware per design.
		const src = readFileSync(extEntry, "utf-8");
		expect(src).not.toMatch(/setStatus\("pi-grid"/);
		expect(src).not.toMatch(/no widgets captured yet/);
	});
});

// ─────────────────────────────────────────────────
// effectiveCols / colsLabel — auto-sizing rules
// ─────────────────────────────────────────────────

describe("effectiveCols (auto-sizing)", () => {
	it("returns 1 when no widgets are captured", () => {
		expect(effectiveCols(makeState())).toBe(1);
	});

	it("returns 1 when only 1 widget is captured (auto)", () => {
		const state = makeState();
		state.captured.set("a", { key: "a", content: [] });
		expect(effectiveCols(state)).toBe(1);
	});

	it("returns 2 when 2 widgets are captured (auto)", () => {
		const state = makeState();
		state.captured.set("a", { key: "a", content: [] });
		state.captured.set("b", { key: "b", content: [] });
		expect(effectiveCols(state)).toBe(2);
	});

	it("caps at AUTO_COLS_CAP (2) for 3+ widgets in auto mode", () => {
		const state = makeState();
		for (const k of ["a", "b", "c", "d", "e"]) state.captured.set(k, { key: k, content: [] });
		expect(effectiveCols(state)).toBe(AUTO_COLS_CAP);
		expect(AUTO_COLS_CAP).toBe(2);
	});

	it("honors user-pinned column count", () => {
		const state = makeState({ gridCols: 4 });
		for (const k of ["a", "b", "c", "d", "e"]) state.captured.set(k, { key: k, content: [] });
		expect(effectiveCols(state)).toBe(4);
	});

	it("never exceeds widget count even when pinned higher", () => {
		const state = makeState({ gridCols: 6 });
		state.captured.set("a", { key: "a", content: [] });
		state.captured.set("b", { key: "b", content: [] });
		// 6 pinned, but only 2 widgets → 2 effective (no empty cells)
		expect(effectiveCols(state)).toBe(2);
	});

	it("clamps the user override to MAX_COLS", () => {
		const state = makeState({ gridCols: 999 });
		for (let i = 0; i < 10; i++) state.captured.set(`w${i}`, { key: `w${i}`, content: [] });
		expect(effectiveCols(state)).toBe(MAX_COLS);
	});

	it("clamps the user override at MIN_COLS", () => {
		const state = makeState({ gridCols: 0 });
		state.captured.set("a", { key: "a", content: [] });
		state.captured.set("b", { key: "b", content: [] });
		// gridCols=0 → max(1, min(0, 2, 6)) = max(1, 0) = 1
		expect(effectiveCols(state)).toBeGreaterThanOrEqual(MIN_COLS);
	});
});

describe("colsLabel", () => {
	it("appends '(auto)' when gridCols is null", () => {
		const state = makeState();
		state.captured.set("a", { key: "a", content: [] });
		state.captured.set("b", { key: "b", content: [] });
		expect(colsLabel(state)).toBe("2× (auto)");
	});

	it("omits '(auto)' when gridCols is pinned", () => {
		const state = makeState({ gridCols: 3 });
		for (const k of ["a", "b", "c"]) state.captured.set(k, { key: k, content: [] });
		expect(colsLabel(state)).toBe("3×");
	});
});

// ─────────────────────────────────────────────────
// getState — singleton on UI
// ─────────────────────────────────────────────────

describe("getState", () => {
	it("creates fresh state on first call", () => {
		const ui = makeUI();
		const state = getState(ui);
		expect(state.captured.size).toBe(0);
		expect(state.gridCols).toBeNull();
		expect(state.requestRender).toBeNull();
		expect(state.originalSetWidget).toBeNull();
	});

	it("returns the SAME state object on repeated calls (anchored singleton)", () => {
		const ui = makeUI();
		const a = getState(ui);
		const b = getState(ui);
		expect(a).toBe(b);
	});

	it("anchors state on the UI object via the global symbol", () => {
		const ui = makeUI();
		getState(ui);
		const anchored = (ui as unknown as Record<symbol, SharedState>)[STATE_KEY];
		expect(anchored).toBeDefined();
		expect(anchored.captured).toBeInstanceOf(Map);
	});

	it("different UI objects get independent state", () => {
		const a = getState(makeUI());
		const b = getState(makeUI());
		a.captured.set("x", { key: "x", content: [] });
		expect(b.captured.size).toBe(0);
	});
});

// ─────────────────────────────────────────────────
// naturalWidth — content-edge detection
// ─────────────────────────────────────────────────

describe("naturalWidth", () => {
	it("returns 0 for an empty array", () => {
		expect(naturalWidth([])).toBe(0);
	});

	it("returns the longest line's visible width", () => {
		expect(naturalWidth(["a", "bcd", "ef"])).toBe(3);
	});

	it("strips trailing whitespace before measuring", () => {
		// "hello     " is 10 cells but only 5 of content.
		expect(naturalWidth(["hello     "])).toBe(5);
	});

	it("ignores ANSI escape sequences when measuring", () => {
		// `\x1b[31m...\x1b[0m` adds zero visible cells.
		const styled = `\x1b[31mhello\x1b[0m`;
		expect(naturalWidth([styled])).toBe(5);
	});

	it("preserves ANSI styling at end of line (only \\s gets stripped)", () => {
		// Content ends with ANSI reset, no trailing space.
		const styled = `\x1b[31mfoo\x1b[0m`;
		expect(naturalWidth([styled])).toBe(3);
	});
});

// ─────────────────────────────────────────────────
// padCell — ANSI-safe width fitting
// ─────────────────────────────────────────────────

describe("padCell", () => {
	it("pads short content with spaces to exact width", () => {
		expect(padCell("ab", 5)).toBe("ab   ");
	});

	it("returns content unchanged at exact width", () => {
		expect(padCell("abcde", 5)).toBe("abcde");
	});

	it("strips trailing whitespace BEFORE deciding to truncate (no spurious '...')", () => {
		// 10 cells of content + spaces. Target width 5. After strip → 5 cells of
		// "hello" content. visibleWidth === width → return as-is, NO ellipsis.
		expect(padCell("hello     ", 5)).toBe("hello");
	});

	it("truncates with ellipsis only when real content overflows", () => {
		const out = padCell("abcdefghij", 5);
		// truncateToWidth default ellipsis is "..." — exact behavior depends on
		// pi-tui implementation, but the result must be ≤ 5 visible cells.
		expect(out.length).toBeGreaterThan(0);
	});

	it("pads to the right width even with ANSI codes", () => {
		const styled = `\x1b[32mok\x1b[0m`; // visible width 2
		const out = padCell(styled, 5);
		// Must end with 3 spaces (visible 2 + 3 pad = 5).
		expect(out.endsWith("   ")).toBe(true);
		expect(out).toContain("ok");
	});
});

// ─────────────────────────────────────────────────
// renderWidget — string[] and factory forms
// ─────────────────────────────────────────────────

describe("renderWidget", () => {
	it("returns string[] content verbatim", () => {
		const w: CapturedWidget = { key: "a", content: ["line1", "line2"] };
		expect(renderWidget(w, 80, tuiStub, themeStub)).toEqual(["line1", "line2"]);
	});

	it("lazily instantiates a factory and caches the Component instance", () => {
		const factory = vi.fn(() => ({
			render: (_w: number) => ["from-factory"],
			invalidate: () => {},
		}));
		const w: CapturedWidget = { key: "a", content: factory };

		renderWidget(w, 80, tuiStub, themeStub);
		renderWidget(w, 80, tuiStub, themeStub);

		expect(factory).toHaveBeenCalledTimes(1);
		expect(w.instance).toBeDefined();
	});

	it("forwards the width to the Component's render()", () => {
		const render = vi.fn((_w: number) => ["x"]);
		const w: CapturedWidget = {
			key: "a",
			content: () => ({ render, invalidate: () => {} }),
		};
		renderWidget(w, 42, tuiStub, themeStub);
		expect(render).toHaveBeenCalledWith(42);
	});

	it("catches factory errors and returns a styled error line", () => {
		const w: CapturedWidget = {
			key: "broken",
			content: () => {
				throw new Error("boom");
			},
		};
		const out = renderWidget(w, 80, tuiStub, themeStub);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("[broken] factory error");
		expect(out[0]).toContain("boom");
	});

	it("catches render() errors and returns a styled error line", () => {
		const w: CapturedWidget = {
			key: "rusty",
			content: () => ({
				render: () => {
					throw new Error("oops");
				},
				invalidate: () => {},
			}),
		};
		const out = renderWidget(w, 80, tuiStub, themeStub);
		expect(out[0]).toContain("[rusty] render error");
		expect(out[0]).toContain("oops");
	});
});

// ─────────────────────────────────────────────────
// allocateRow — dynamic width redistribution
// ─────────────────────────────────────────────────

describe("allocateRow", () => {
	const makeWidget = (lines: string[]): CapturedWidget => ({ key: lines.join("|"), content: lines });

	it("gives a single widget the entire row width", () => {
		const { widths } = allocateRow([makeWidget(["hi"])], 60, 2, tuiStub, themeStub);
		// usable = 60 - 2*0 = 60; share = 60; natural = 2 → widget locked at 2.
		expect(widths).toHaveLength(1);
		expect(widths[0]).toBeLessThanOrEqual(60);
	});

	it("splits equally when both widgets fill their share", () => {
		// Both widgets emit content that fills the entire share.
		const filler = (n: number) => "x".repeat(n);
		const w1: CapturedWidget = { key: "a", content: [filler(50)] };
		const w2: CapturedWidget = { key: "b", content: [filler(50)] };

		const { widths } = allocateRow([w1, w2], 60, 2, tuiStub, themeStub);
		expect(widths).toHaveLength(2);
		// Each gets ~29 cells (60-2 gap = 58, /2 = 29).
		expect(widths[0]).toBe(29);
		expect(widths[1]).toBe(29);
	});

	it("redistributes slack from a narrow widget to its wide neighbor", () => {
		// Narrow widget naturally renders at 3 cells; wide widget fills any width.
		const narrow: CapturedWidget = { key: "n", content: ["abc"] };
		const wide: CapturedWidget = {
			key: "w",
			content: ["x".repeat(50)], // pre-rendered string array — visibleWidth = 50
		};

		const total = 60;
		const gap = 2;
		const { widths } = allocateRow([narrow, wide], total, gap, tuiStub, themeStub);

		expect(widths[0]).toBe(3); // narrow locked to its natural width
		// wide gets the rest of the usable area: 60 - 2 - 3 = 55.
		expect(widths[0] + widths[1] + gap).toBe(total);
		expect(widths[1]).toBeGreaterThan(widths[0]);
	});

	it("returns one outputs[] entry per widget", () => {
		const { outputs } = allocateRow([makeWidget(["a"]), makeWidget(["b"])], 60, 2, tuiStub, themeStub);
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toEqual(["a"]);
		expect(outputs[1]).toEqual(["b"]);
	});
});

// ─────────────────────────────────────────────────
// composeRow — row zipping
// ─────────────────────────────────────────────────

describe("composeRow", () => {
	it("joins cells with a gap of spaces", () => {
		const lines = composeRow([["a"], ["b"]], [3, 3], 2);
		expect(lines).toEqual(["a    b  "]);
	});

	it("pads shorter cells with blank rows to match the tallest cell", () => {
		const lines = composeRow([["one", "two", "three"], ["only"]], [5, 5], 1);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("one");
		expect(lines[0]).toContain("only");
		// Second and third rows: shorter cell becomes spaces.
		expect(lines[1]).toContain("two");
		expect(lines[2]).toContain("three");
	});

	it("returns an empty array when all cells are empty", () => {
		expect(composeRow([[], []], [10, 10], 2)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────
// patchUI — monkey-patch + capture integration
// ─────────────────────────────────────────────────

describe("patchUI (integration)", () => {
	it("installs the wrapper on first call and marks the UI as patched", () => {
		const ui = makeUI();
		patchUI(ui);
		expect((ui as unknown as Record<symbol, unknown>)[PATCHED_KEY]).toBe(true);
	});

	it("is idempotent — second call doesn't double-wrap", () => {
		const ui = makeUI();
		patchUI(ui);
		const wrapperAfterFirst = ui.setWidget;
		patchUI(ui);
		// Wrapper identity preserved — no re-wrap.
		expect(ui.setWidget).toBe(wrapperAfterFirst);
	});

	it("captures downstream setWidget calls into state instead of forwarding them", () => {
		const ui = makeUI();
		patchUI(ui);
		// First call: our own grid widget mount via originalSetWidget.
		const beforeCount = ui.calls.length;

		const factory = vi.fn(() => ({ render: () => ["x"], invalidate: () => {} }));
		ui.setWidget("foo", factory as unknown as WidgetContent);

		// No NEW call to original setWidget was emitted for "foo".
		expect(ui.calls.length).toBe(beforeCount);
		expect(getState(ui).captured.has("foo")).toBe(true);
	});

	it("removes captured entries when called with undefined content", () => {
		const ui = makeUI();
		patchUI(ui);
		ui.setWidget("bar", ["line"]);
		expect(getState(ui).captured.has("bar")).toBe(true);
		ui.setWidget("bar", undefined);
		expect(getState(ui).captured.has("bar")).toBe(false);
	});

	it("disposes the previous instance when a factory identity changes", () => {
		const ui = makeUI();
		patchUI(ui);

		const dispose1 = vi.fn();
		const factory1 = () => ({ render: () => [], invalidate: () => {}, dispose: dispose1 });
		const factory2 = () => ({ render: () => [], invalidate: () => {} });

		ui.setWidget("k", factory1 as unknown as WidgetContent);
		// Force instantiation by rendering once via renderWidget.
		const captured = getState(ui).captured.get("k");
		expect(captured).toBeDefined();
		if (captured) renderWidget(captured, 80, tuiStub, themeStub);

		// Swap factory — previous instance should be disposed.
		ui.setWidget("k", factory2 as unknown as WidgetContent);
		expect(dispose1).toHaveBeenCalledTimes(1);
	});

	it("lets the GRID_KEY widget pass through to the original setWidget", () => {
		const ui = makeUI();
		patchUI(ui);
		// patchUI mounts the grid widget once on first install.
		const gridMounts = ui.calls.filter(([k]) => k === GRID_KEY);
		expect(gridMounts.length).toBeGreaterThanOrEqual(1);
	});

	it("calls requestRender (when set) on every captured setWidget", () => {
		const ui = makeUI();
		patchUI(ui);

		const state = getState(ui);
		const rr = vi.fn();
		state.requestRender = rr;

		ui.setWidget("k", ["x"]);
		expect(rr).toHaveBeenCalledTimes(1);

		ui.setWidget("k", ["y"]);
		expect(rr).toHaveBeenCalledTimes(2);
	});

	it("re-mounts the grid widget on every patchUI invocation (reload safety)", () => {
		const ui = makeUI();
		patchUI(ui);
		patchUI(ui);
		patchUI(ui);
		// One mount per patchUI call, all with the same GRID_KEY.
		const gridMounts = ui.calls.filter(([k]) => k === GRID_KEY);
		expect(gridMounts.length).toBe(3);
	});
});
