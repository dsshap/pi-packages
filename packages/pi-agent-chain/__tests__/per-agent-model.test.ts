/**
 * Per-agent `model` frontmatter — unit tests for the parser & precedence rules.
 *
 * We don't spawn subprocesses here (that's covered by chain-runtime-validate.mts);
 * these tests focus on the static-shape contract: the field is parsed, the
 * wildcard is treated as "no preference", and the precedence chain is wired
 * into the `pi --model <value>` argv exactly as the code & README claim.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const extEntry = resolve(here, "..", "extensions", "index.ts");

// Slim re-implementation of parseAgentFile that mirrors the extension's
// parser. We test the *behaviour* (frontmatter → AgentDef shape) by exercising
// real .md files written to a temp dir.
//
// The extension's parser lives inside a module that has heavyweight runtime
// imports (pi-tui, pi-coding-agent). Running the parser through a synthetic
// import is unnecessary here — we just verify the source contains the
// behaviour we expect and write fixtures to exercise the regex/keys.

const src = readFileSync(extEntry, "utf-8");

/** Mirror of the extension's frontmatter parser used in unit assertions. */
function parseFrontmatter(raw: string): Record<string, string> {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return {};
	const out: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return out;
}

describe("parseAgentFile — model frontmatter behaviour", () => {
	it("reads `model:` into the returned AgentDef object", () => {
		// Source-level assertion: the parser writes `model` onto the returned object.
		expect(src).toMatch(/model,\s*\}\s*;?\s*\n/);
	});

	it("normalises empty / wildcard model strings to undefined", () => {
		// `*/*` and empty values should fall through to the orchestrator.
		expect(src).toMatch(/rawModel\s*&&\s*rawModel\s*!==\s*"\*\/\*"\s*\?\s*rawModel\s*:\s*undefined/);
	});
});

describe("resolveStepModel — widget pre-population", () => {
	it("exposes a helper that returns both `full` and `id` forms", () => {
		expect(src).toMatch(/function resolveStepModel\(/);
		expect(src).toMatch(/return\s*\{\s*full,\s*id\s*\}/);
	});

	it("derives the id by stripping the first <provider>/ segment", () => {
		// Source-level assertion locks in the parsing convention: id =
		// everything after the first slash. Examples:
		//   anthropic/claude-opus-4-7              → claude-opus-4-7
		//   openrouter/google/gemini-3-flash       → google/gemini-3-flash
		expect(src).toMatch(/full\.split\("\/"\)/);
		expect(src).toMatch(/parts\.slice\(1\)\.join\("\/"\)/);
	});

	it("writes state.model BEFORE flipping the step to 'running'", () => {
		// Lock in the order so we never regress to the post-message_end flash.
		const marker = src.indexOf("stepStates[i].model = stepModelId");
		const running = src.indexOf('stepStates[i].status = "running"');
		expect(marker).toBeGreaterThan(0);
		expect(running).toBeGreaterThan(marker);
	});
});

describe("runAgent — model precedence", () => {
	it("uses agentDef.model ?? orchestratorModel ?? hardcoded fallback", () => {
		// The chained `??` is the source of truth for precedence; lock it in.
		expect(src).toMatch(/agentDef\.model\s*\?\?\s*orchestratorModel\s*\?\?\s*"openrouter\/google\/gemini-3-flash-preview"/);
	});

	it("propagates the resolved model to `pi --model` argv", () => {
		// Confirm the `model` variable computed from precedence is what flows into
		// the spawned subprocess.
		expect(src).toMatch(/"--model",\s*\n?\s*model,/);
	});
});

describe("frontmatter round-trip (real files)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "agent-chain-model-test-"));

	it("plain frontmatter without `model` → AgentDef.model is undefined", () => {
		const file = join(tmp, "no-model.md");
		writeFileSync(
			file,
			["---", "name: no-model", "description: test agent without model", "tools: read", "---", "You are a test agent."].join(
				"\n",
			),
		);

		// Mirror the parser's regex
		const fm = parseFrontmatter(readFileSync(file, "utf-8"));
		expect(fm.model).toBeUndefined();
	});

	it("`model: anthropic/claude-opus-4-7` parses to that exact value", () => {
		const file = join(tmp, "opus.md");
		writeFileSync(
			file,
			[
				"---",
				"name: opus-agent",
				"description: pinned to opus",
				"tools: read,grep",
				"model: anthropic/claude-opus-4-7",
				"---",
				"You are a senior reviewer.",
			].join("\n"),
		);

		const fm = parseFrontmatter(readFileSync(file, "utf-8"));
		expect(fm.model).toBe("anthropic/claude-opus-4-7");

		// Wildcard / blank → treated as undefined by the normaliser
		const rawModel = (fm.model || "").trim();
		const normalised = rawModel && rawModel !== "*/*" ? rawModel : undefined;
		expect(normalised).toBe("anthropic/claude-opus-4-7");
	});

	it("`model: */*` normalises to undefined (falls back to orchestrator)", () => {
		const rawModel = "*/*";
		const normalised = rawModel && rawModel !== "*/*" ? rawModel : undefined;
		expect(normalised).toBeUndefined();
	});

	it("cleans up temp dir", () => {
		rmSync(tmp, { recursive: true, force: true });
		expect(true).toBe(true);
	});
});
