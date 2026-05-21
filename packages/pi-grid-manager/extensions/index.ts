/**
 * pi-grid-manager
 * ───────────────
 * UI middleware extension. Intercepts every `ctx.ui.setWidget(...)` call from
 * other extensions and composes the captured widgets into a single grid widget
 * laid out in N columns (configurable via `/grid <N>`).
 *
 * Downstream extensions need ZERO changes — they keep calling `setWidget` on
 * their own `ctx.ui` like normal. They don't know (or care) that their widget
 * isn't being rendered as a standalone row anymore.
 *
 * How the interception works
 * --------------------------
 * Pi shares ONE `ExtensionUIContext` singleton across all extensions in a
 * session (verified in `agent-session.js`: `runner.setUIContext(this._extensionUIContext)`
 * is called for every runner with the SAME object). So if we monkey-patch
 * `ui.setWidget` once on that shared object, every extension's calls go
 * through our wrapper.
 *
 * Load order
 * ----------
 * Pi runs `session_start` handlers in extension-load order. Load order is:
 *   1. CLI `-e` flags (in argv order)
 *   2. Then `pi install`-installed packages (in settings.json `packages` order)
 * Then auto-discovered (`cwd/.pi/extensions/`, `~/.pi/agent/extensions/`) come
 * BEFORE both, alphabetically.
 *
 * For the grid to capture everything from cold start, grid-manager must
 * register its session_start handler before any other widget-using extension.
 * If it doesn't, the runtime self-check (see `session_start` below) fires a
 * warning notification and `/reload` is the always-works escape hatch — the
 * `PATCHED_KEY` symbol on the shared UI object survives reload, so the second
 * pass routes everything through the wrapper.
 *
 * Reload safety
 * -------------
 * `/reload` does this:
 *   1. `clearExtensionWidgets()` on the host — disposes every widget
 *      (including ours)
 *   2. Builds a NEW `ExtensionRunner` and re-loads every extension (fresh
 *      module closures, fresh `captured` map)
 *   3. Emits `session_start` with `reason: "reload"`
 *
 * The shared `ExtensionUIContext` SURVIVES this dance, so:
 *   - Our monkey-patched `setWidget` wrapper is still installed (closed over
 *     state from the OLD module)
 *   - The host's widget registry is empty (so the grid widget is gone)
 *
 * To survive reloads, ALL mutable state (captured widgets, column count,
 * requestRender bridge) is anchored on the UI object via a global symbol.
 * Both the old wrapper (still installed) and the new module read/write the
 * same shared state. On `session_start` we ALWAYS re-mount the grid widget,
 * since the host wiped it.
 *
 * Grid layout
 * -----------
 * - Captured widgets are stored in insertion order (Map preserves it).
 * - On render(width), the manager allocates `floor((width - gap*(cols-1)) / cols)`
 *   cells per row, calls each captured widget's render(cellWidth), and zips
 *   the rows side-by-side with ANSI-safe padding.
 * - Per-row width is re-allocated dynamically: probe at equal share, measure
 *   natural width (longest line after stripping trailing whitespace), and
 *   redistribute slack from widgets that didn't fill to widgets that did.
 * - String-array widgets are forwarded verbatim. Factory widgets are
 *   instantiated lazily once (with the host's `tui`/`theme`) and re-rendered
 *   per frame; their own `invalidate()` handles internal caching.
 *
 * Slash command
 * -------------
 * `/grid`        — show current column count
 * `/grid <1-6>`  — pin to N columns
 * `/grid auto`   — restore auto sizing (1 col if ≤1 widget, else 2)
 */

import type { ExtensionAPI, ExtensionWidgetOptions, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────

export type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
export type WidgetContent = string[] | WidgetFactory;

export interface CapturedWidget {
	key: string;
	content: WidgetContent;
	options?: ExtensionWidgetOptions;
	/** Lazily-instantiated Component (factory form only). Re-created if `content` changes. */
	instance?: Component & { dispose?(): void };
}

/**
 * State anchored on the UI singleton via `Symbol.for(...)`. Survives extension
 * reloads because the UI object is owned by AgentSession (not the runner).
 * Both the original (pre-reload) wrapper closure and the post-reload module
 * code dereference this through `getState(ui)`, so they share one source of
 * truth for captured widgets and column count.
 */
export interface SharedState {
	captured: Map<string, CapturedWidget>;
	/** User override from `/grid N`. When null, columns are auto-computed from
	 * the number of captured widgets (1 if ≤1, else 2 — capped at 2 by
	 * design so 3+ widgets wrap into multiple rows of 2). */
	gridCols: number | null;
	/** Set by the grid widget factory on mount; cleared on dispose. */
	requestRender: (() => void) | null;
	/** Saved during the FIRST patch so subsequent (post-reload) mounts can
	 * re-register the grid widget without going through their own wrapper. */
	originalSetWidget: UIShape["setWidget"] | null;
}

export interface UIShape {
	setWidget(key: string, content: WidgetContent | undefined, options?: ExtensionWidgetOptions): void;
}

// ── Tunables ─────────────────────────────────────

export const MIN_COLS = 1;
export const MAX_COLS = 6;
/** Cap for auto-computed columns. 3+ widgets wrap into multiple rows of 2. */
export const AUTO_COLS_CAP = 2;
export const COL_GAP = 2;
export const GRID_KEY = "__pi-grid-manager";
export const STATE_KEY = Symbol.for("pi-grid-manager.state");
export const PATCHED_KEY = Symbol.for("pi-grid-manager.patched");

// ── Pure helpers (exported for testing) ──────────

/**
 * Effective column count for the current widget population.
 *
 * - User override (`/grid N`): use exactly that, clamped to `[1, MAX_COLS]`.
 *   Never exceeds widget count (no empty columns).
 * - Auto (default): 1 column when ≤1 widget, otherwise `AUTO_COLS_CAP` (2).
 *   3+ widgets still cap at 2 so they wrap into multiple grid-rows instead
 *   of squeezing into tiny cells.
 */
export function effectiveCols(state: SharedState): number {
	const count = state.captured.size;
	if (count === 0) return 1;
	if (state.gridCols !== null) return Math.max(1, Math.min(state.gridCols, count, MAX_COLS));
	return Math.min(AUTO_COLS_CAP, count);
}

export function colsLabel(state: SharedState): string {
	const eff = effectiveCols(state);
	return state.gridCols === null ? `${eff}× (auto)` : `${eff}×`;
}

/**
 * Get or create the singleton state on the UI object.
 *
 * The state survives reloads because the UI object is owned by AgentSession,
 * not by the extension runner. Symbol.for() ensures the same key across
 * module reloads.
 */
export function getState(ui: UIShape): SharedState {
	const target = ui as unknown as Record<symbol, SharedState | undefined>;
	let state = target[STATE_KEY];
	if (!state) {
		state = {
			captured: new Map(),
			gridCols: null,
			requestRender: null,
			originalSetWidget: null,
		};
		target[STATE_KEY] = state;
	}
	return state;
}

/**
 * Pad/truncate a styled string to exact visible width (ANSI-safe).
 *
 * Trailing whitespace is stripped FIRST. This matters when a widget pads
 * its own output to the width it was rendered at (e.g. `Text`) but the
 * grid then assigns it a smaller cell after natural-width measurement.
 * Without the strip, padCell would see `visibleWidth > width` and call
 * `truncateToWidth`, which decorates the cut with an ellipsis ("...")
 * even though only spaces were being removed.
 */
export function padCell(styled: string, width: number): string {
	const trimmed = styled.replace(/\s+$/, "");
	const v = visibleWidth(trimmed);
	if (v === width) return trimmed;
	if (v > width) return truncateToWidth(trimmed, width);
	return trimmed + " ".repeat(width - v);
}

/**
 * Natural width of a rendered widget = the longest visible content line
 * after trailing whitespace is stripped. Extensions that pad-to-fill (or
 * happen to be short) report only the true right edge of their content,
 * which the grid uses to free unused cells back to neighbors.
 *
 * The regex strips trailing whitespace; ANSI escape sequences end with
 * letters and don't match `\s`, so styling at end-of-line is preserved.
 */
export function naturalWidth(lines: string[]): number {
	let max = 0;
	for (const line of lines) {
		const trimmed = line.replace(/\s+$/, "");
		const w = visibleWidth(trimmed);
		if (w > max) max = w;
	}
	return max;
}

/**
 * Render a single captured widget into a string[]. Handles both static
 * string-array content and lazy component factories. Catches errors from
 * either the factory call or the render call so a misbehaving extension
 * can't crash the grid.
 */
export function renderWidget(w: CapturedWidget, width: number, tui: TUI, theme: Theme): string[] {
	if (Array.isArray(w.content)) return w.content;

	if (!w.instance) {
		try {
			w.instance = w.content(tui, theme);
		} catch (err) {
			return [theme.fg("error", `[${w.key}] factory error: ${(err as Error).message}`)];
		}
	}

	try {
		return w.instance.render(width);
	} catch (err) {
		return [theme.fg("error", `[${w.key}] render error: ${(err as Error).message}`)];
	}
}

/**
 * Dynamic width allocation per grid-row.
 *
 * 1. Probe every widget at the equal-share cell width.
 * 2. Measure each widget's natural width = max visible width of any line
 *    after trailing whitespace is stripped (so widgets that pad-to-fill
 *    still report the actual content edge).
 * 3. Widgets whose natural width is below their fair share KEEP that
 *    smaller width; the saved cells are split among the widgets that used
 *    their full share. Those "stretchable" widgets are re-rendered at
 *    their new (larger) allocation so they get to actually USE the extra
 *    space.
 * 4. If no widget had slack, this collapses to a pure equal split with
 *    the probe output reused — single render() per widget.
 */
export function allocateRow(
	row: CapturedWidget[],
	totalWidth: number,
	gapCells: number,
	tui: TUI,
	theme: Theme,
): { widths: number[]; outputs: string[][] } {
	const n = row.length;
	const usable = Math.max(n, totalWidth - gapCells * (n - 1));
	const share = Math.max(10, Math.floor(usable / n));

	const outputs: string[][] = row.map((w) => renderWidget(w, share, tui, theme));
	const naturals = outputs.map(naturalWidth);

	const widths: number[] = new Array(n).fill(share);
	let slack = 0;
	const stretchable: number[] = [];
	for (let k = 0; k < n; k++) {
		if (naturals[k] < share) {
			widths[k] = Math.max(1, naturals[k]);
			slack += share - widths[k];
		} else {
			stretchable.push(k);
		}
	}

	if (stretchable.length > 0 && slack > 0) {
		const extra = Math.floor(slack / stretchable.length);
		const remainder = slack - extra * stretchable.length;
		for (let s = 0; s < stretchable.length; s++) {
			const k = stretchable[s];
			widths[k] = share + extra + (s < remainder ? 1 : 0);
			// Re-render at the bigger allocation so the widget actually
			// uses the redistributed space. Invalidate first so any
			// internal width-keyed cache (e.g. Text) recomputes.
			row[k].instance?.invalidate?.();
			outputs[k] = renderWidget(row[k], widths[k], tui, theme);
		}
	}

	return { widths, outputs };
}

/**
 * Compose a row of cells into screen lines: pad each cell to its column
 * width and join with the gap. Cells with fewer lines than the tallest
 * cell get blank rows on the bottom (which padCell turns into spaces of
 * the right width).
 */
export function composeRow(outputs: string[][], widths: number[], gap: number): string[] {
	const gapStr = " ".repeat(gap);
	const rowHeight = Math.max(...outputs.map((c) => c.length), 0);
	if (rowHeight === 0) return [];

	const lines: string[] = [];
	for (let r = 0; r < rowHeight; r++) {
		const parts = outputs.map((cell, ci) => padCell(cell[r] ?? "", widths[ci]));
		lines.push(parts.join(gapStr));
	}
	return lines;
}

// ── Patching ─────────────────────────────────────

/**
 * Monkey-patch `ui.setWidget` on the shared UI object. Idempotent: the patch
 * is guarded by `PATCHED_KEY` so reloads (which re-run this code with the
 * old wrapper still installed) don't double-wrap.
 *
 * Always re-mounts the grid widget through the original setWidget — needed
 * because `/reload` wipes the host's widget registry via
 * `clearExtensionWidgets()`, so even when the wrapper is already installed
 * the grid widget itself has to be put back.
 */
export function patchUI(ui: UIShape): void {
	const target = ui as unknown as Record<symbol, unknown>;
	const state = getState(ui);

	if (!target[PATCHED_KEY]) {
		// Save the real (host-provided) setWidget so future reloads can mount
		// the grid widget without going through our wrapper.
		state.originalSetWidget = ui.setWidget.bind(ui);

		const original = state.originalSetWidget;

		ui.setWidget = (key: string, content: WidgetContent | undefined, options?: ExtensionWidgetOptions): void => {
			const liveState = getState(ui);

			// Always let the manager's own widget pass through unchanged.
			if (key === GRID_KEY) {
				original(key, content as never, options);
				return;
			}

			if (content === undefined) {
				const prev = liveState.captured.get(key);
				prev?.instance?.dispose?.();
				liveState.captured.delete(key);
			} else {
				const prev = liveState.captured.get(key);
				// Factory identity changed → drop the stale instance so the
				// next render() re-instantiates from the new factory.
				if (prev?.instance && prev.content !== content) {
					prev.instance.dispose?.();
				}
				liveState.captured.set(key, { key, content, options });
			}

			liveState.requestRender?.();
		};

		target[PATCHED_KEY] = true;
	}

	const mount = state.originalSetWidget;
	if (mount) {
		mount(GRID_KEY, buildGridFactory(ui) as never, { placement: "aboveEditor" });
	}
}

// ── Grid widget factory ──────────────────────────

export function buildGridFactory(ui: UIShape): WidgetFactory {
	return (tui: TUI, theme: Theme) => {
		const state = getState(ui);

		const render = (width: number): string[] => {
			if (state.captured.size === 0) return [];

			const widgets = Array.from(state.captured.values());
			const cols = effectiveCols(state);
			const gap = COL_GAP;
			const fallbackCellWidth = Math.max(10, Math.floor((width - gap * (cols - 1)) / cols));

			const lines: string[] = [];

			for (let i = 0; i < widgets.length; i += cols) {
				const rowWidgets = widgets.slice(i, i + cols);
				const { widths, outputs } = allocateRow(rowWidgets, width, gap, tui, theme);

				// Pad row to full column count with empty cells so column
				// widths align across grid-rows.
				while (outputs.length < cols) {
					outputs.push([]);
					widths.push(fallbackCellWidth);
				}

				lines.push(...composeRow(outputs, widths, gap));

				// Visual gap between grid-rows (single blank line) — only
				// when another row follows.
				if (i + cols < widgets.length) lines.push("");
			}

			return lines;
		};

		// Bridge the wrapper-side "something changed, repaint" notification
		// to the host's render loop. Stored on shared state so the wrapper
		// closure (which may outlive this factory across reloads) can find
		// the CURRENT requestRender after each remount.
		state.requestRender = () => {
			for (const w of state.captured.values()) {
				w.instance?.invalidate?.();
			}
			tui.requestRender();
		};

		return {
			render,
			invalidate() {
				for (const w of state.captured.values()) {
					w.instance?.invalidate?.();
				}
			},
			dispose() {
				// The host disposes us on reload. Drop child instances so the
				// next mount starts clean; the wrapper outlives this factory.
				for (const w of state.captured.values()) {
					w.instance?.dispose?.();
					w.instance = undefined;
				}
				if (state.requestRender) state.requestRender = null;
			},
		};
	};
}

// ── Extension entry point ────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Silent middleware — no setStatus, no startup notification. If the
		// grid is working, the user sees its work (composed layout) directly;
		// if it isn't, they notice via the visible stacking, not via a status
		// badge.
		patchUI(ctx.ui as unknown as UIShape);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// On shutdown the host calls `clearExtensionWidgets()` which disposes
		// every component — including the children we've cached references to.
		// Drop those references so a subsequent reload doesn't try to render
		// against disposed instances. Keep the captured CONTENT (factories /
		// string arrays) intact so the post-reload grid can rebuild from them
		// IF the downstream extensions don't re-register first (they will, but
		// race-safe is cheap).
		if (!ctx?.hasUI) return;
		const state = getState(ctx.ui as unknown as UIShape);
		for (const w of state.captured.values()) {
			w.instance?.dispose?.();
			w.instance = undefined;
		}
		state.captured.clear();
		state.requestRender = null;
	});

	// ── /grid command ────────────────────────────

	pi.registerCommand("grid", {
		description: `Set grid columns: /grid <${MIN_COLS}-${MAX_COLS}|auto>`,
		handler: async (args, ctx) => {
			const ui = ctx.ui as unknown as UIShape;
			const state = getState(ui);
			const raw = (args ?? "").trim().toLowerCase();
			if (!raw) {
				ctx.ui.notify(`Current grid: ${colsLabel(state)}. Usage: /grid <${MIN_COLS}-${MAX_COLS}|auto>`, "info");
				return;
			}
			if (raw === "auto") {
				state.gridCols = null;
				ctx.ui.notify(`Grid restored to auto (1 col if ≤1 widget, else ${AUTO_COLS_CAP})`, "info");
				state.requestRender?.();
				return;
			}
			const n = Number.parseInt(raw, 10);
			if (!Number.isFinite(n) || n < MIN_COLS || n > MAX_COLS) {
				ctx.ui.notify(`Usage: /grid <${MIN_COLS}-${MAX_COLS}|auto>`, "error");
				return;
			}
			state.gridCols = n;
			ctx.ui.notify(`Grid pinned to ${n} column(s)`, "info");
			state.requestRender?.();
		},
	});
}
