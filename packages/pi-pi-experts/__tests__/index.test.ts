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

	it("registers the query_experts tool and pi-pi commands", () => {
		const src = readFileSync(extEntry, "utf-8");
		expect(src).toMatch(/registerTool\(\s*\{\s*name:\s*"query_experts"/);
		expect(src).toMatch(/registerCommand\("experts"/);
		expect(src).toMatch(/registerCommand\("experts-grid"/);
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
