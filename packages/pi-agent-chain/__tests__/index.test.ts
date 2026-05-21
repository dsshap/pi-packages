import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const agentsDir = resolve(pkgRoot, "agents");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");
const chainYaml = resolve(agentsDir, "agent-chain.yaml");

describe("@dsshap/pi-agent-chain package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("ships the bundled agents directory", () => {
		expect(existsSync(agentsDir)).toBe(true);
		const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
		// builder, reviewer, planner, scout, plan-reviewer, documenter, red-team, bowser
		expect(files.length).toBeGreaterThanOrEqual(8);
		for (const required of [
			"builder.md",
			"reviewer.md",
			"planner.md",
			"scout.md",
			"plan-reviewer.md",
			"documenter.md",
			"red-team.md",
			"bowser.md",
		]) {
			expect(files).toContain(required);
		}
	});

	it("ships the bundled agent-chain.yaml", () => {
		expect(existsSync(chainYaml)).toBe(true);
		const raw = readFileSync(chainYaml, "utf-8");
		// Sanity: must define at least one chain with a steps block
		expect(raw).toMatch(/^plan-build-review:/m);
		expect(raw).toMatch(/steps:/);
	});

	it("resolves the agents directory relative to the extension (no absolute paths)", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).not.toMatch(/\/Users\//);
		expect(src).toMatch(/BUNDLED_AGENTS_DIR\s*=\s*resolve\(/);
		expect(src).toContain("import.meta.url");
	});

	it("registers the run_chain tool and chain commands", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/registerTool\(\s*\{\s*name:\s*"run_chain"/);
		expect(src).toMatch(/registerCommand\("chain"/);
		expect(src).toMatch(/registerCommand\("chain-list"/);
	});

	it("uses the @earendil-works package namespace, not @mariozechner", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/@earendil-works\/pi-coding-agent/);
		expect(src).toMatch(/@earendil-works\/pi-tui/);
		expect(src).not.toMatch(/@mariozechner/);
		expect(src).not.toMatch(/@sinclair\/typebox/);
	});
});

describe("agent persona frontmatter", () => {
	const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		it(`parses frontmatter for ${file}`, () => {
			const raw = readFileSync(resolve(agentsDir, file), "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			expect(match, `${file} missing frontmatter`).not.toBeNull();
			if (!match) throw new Error(`${file} missing frontmatter`);
			const fm = match[1];
			expect(fm).toMatch(/name:\s*\S+/);
			expect(fm).toMatch(/description:\s*\S+/);
		});
	}
});

describe("per-agent model frontmatter", () => {
	const src = readFileSync(extEntry, "utf-8");

	it("declares an optional `model` field on AgentDef", () => {
		expect(src).toMatch(/interface AgentDef\s*\{[^}]*model\?: string/);
	});

	it("parses the `model:` frontmatter key in parseAgentFile", () => {
		expect(src).toMatch(/frontmatter\.model/);
		// `*/*` is treated as "no preference"
		expect(src).toMatch(/\*\/\*/);
	});

	it("prefers agentDef.model over orchestrator ctx.model when spawning", () => {
		// Precedence chain: agentDef.model ?? orchestratorModel ?? fallback
		expect(src).toMatch(/agentDef\.model\s*\?\?\s*orchestratorModel/);
	});

	it("includes per-agent model in the orchestrator system-prompt catalog", () => {
		expect(src).toMatch(/\*\*Model:\*\*/);
		expect(src).toMatch(/inherits orchestrator/);
	});
});
