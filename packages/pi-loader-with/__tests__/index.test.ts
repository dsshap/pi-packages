import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregateResources, type WithLoadedExtension } from "../extensions/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");
const pkgJson = resolve(pkgRoot, "package.json");

describe("@dsshap/pi-loader-with package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("declares the entry in package.json's pi.extensions", () => {
		const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string; pi?: { extensions?: string[] } };
		expect(pkg.name).toBe("@dsshap/pi-loader-with");
		expect(pkg.pi?.extensions).toEqual(["./extensions/index.ts"]);
	});
});

describe("aggregateResources", () => {
	const mk = (name: string, prompts: string[], skills: string[]): WithLoadedExtension => ({
		name,
		path: `/pkgs/${name}`,
		promptPaths: prompts,
		skillPaths: skills,
	});

	it("returns empty for no entries", () => {
		expect(aggregateResources([])).toEqual({ promptPaths: [], skillPaths: [] });
	});

	it("concatenates paths in input order", () => {
		const a = mk("a", ["/a/prompts"], ["/a/skills"]);
		const b = mk("b", ["/b/prompts"], ["/b/skills"]);
		expect(aggregateResources([a, b])).toEqual({
			promptPaths: ["/a/prompts", "/b/prompts"],
			skillPaths: ["/a/skills", "/b/skills"],
		});
	});

	it("dedupes identical paths across entries, first occurrence wins", () => {
		const a = mk("a", ["/shared/prompts"], ["/shared/skills"]);
		const b = mk("b", ["/shared/prompts", "/b/prompts"], ["/shared/skills"]);
		expect(aggregateResources([a, b])).toEqual({
			promptPaths: ["/shared/prompts", "/b/prompts"],
			skillPaths: ["/shared/skills"],
		});
	});

	it("handles entries with no manifest resources", () => {
		const a = mk("a", [], []);
		const b = mk("b", ["/b/prompts"], []);
		expect(aggregateResources([a, b])).toEqual({
			promptPaths: ["/b/prompts"],
			skillPaths: [],
		});
	});

	it("dedupes within a single entry", () => {
		const a = mk("a", ["/x", "/x", "/y"], ["/s", "/s"]);
		expect(aggregateResources([a])).toEqual({
			promptPaths: ["/x", "/y"],
			skillPaths: ["/s"],
		});
	});
});
