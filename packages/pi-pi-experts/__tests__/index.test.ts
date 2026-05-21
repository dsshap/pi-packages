import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const agentsDir = resolve(pkgRoot, "agents");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");

describe("@dsshap/pi-pi-experts package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("ships the bundled agents directory", () => {
		expect(existsSync(agentsDir)).toBe(true);
		const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
		// orchestrator + at least 8 experts
		expect(files.length).toBeGreaterThanOrEqual(9);
		expect(files).toContain("pi-orchestrator.md");
	});

	it("resolves the agents directory relative to the extension (no absolute paths)", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).not.toMatch(/\/Users\//);
		expect(src).toMatch(/PI_PI_AGENTS_DIR\s*=\s*resolve\(/);
		expect(src).toContain("import.meta.url");
	});

	it("registers the query_experts tool and the /experts command", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/registerTool\(\s*\{\s*name:\s*"query_experts"/);
		expect(src).toMatch(/registerCommand\("experts"/);
		// /experts-grid was removed when the layout switched from grid to tree.
		expect(src).not.toMatch(/registerCommand\("experts-grid"/);
		// Widget key was renamed from "pi-pi-grid" to "pi-pi" with the new layout.
		expect(src).not.toMatch(/setWidget\("pi-pi-grid"/);
		expect(src).toMatch(/setWidget\("pi-pi"/);
	});

	it("uses the mountWidget + pushUpdate pattern for live repaints", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/function mountWidget\(/);
		expect(src).toMatch(/let pushUpdate: \(\(\) => void\) \| null = null/);
		expect(src).toMatch(/tui\.requestRender\(\)/);
	});

	it("tracks per-expert costUsd from message_end usage events", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/costUsd:\s*number/);
		expect(src).toMatch(/event\.type === "message_end"/);
		expect(src).toMatch(/state\.costUsd \+=/);
	});

	it("description column shows live work (state.lastLine) once an expert is non-idle", () => {
		const src = readFileSync(extEntry, "utf-8");
		// idle → static description; otherwise → lastLine with description fallback.
		expect(src).toMatch(/s\.status === "idle"\s*\?\s*s\.def\.description\s*:\s*s\.lastLine \|\| s\.def\.description/);
	});

	it("builds the query_experts tool description dynamically from the loaded experts", () => {
		const src = readFileSync(extEntry, "utf-8");
		// The list MUST be generated from the experts map at factory time so that
		// adding a bundled `.md` agent doesn't require a parallel edit to the
		// LLM-facing description (the bug that hid cli-expert from the model).
		expect(src).toMatch(/const expertList = Array\.from\(experts\.values\(\)\)/);
		expect(src).toMatch(/\$\{expertList\}/);
		// loadExperts must run BEFORE registerTool so the map is populated when
		// the description is built.
		const loadCall = src.indexOf("loadExperts();");
		const registerCall = src.indexOf("pi.registerTool({");
		expect(loadCall).toBeGreaterThan(0);
		expect(registerCall).toBeGreaterThan(loadCall);
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
			if (file === "pi-orchestrator.md") {
				expect(fm).toMatch(/name:\s*pi-orchestrator/);
			} else {
				expect(fm).toMatch(/name:\s*\S+/);
				expect(fm).toMatch(/description:\s*\S+/);
				expect(fm).toMatch(/tools:\s*\S+/);
			}
		});
	}
});
