import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContributedResources, collectResourcePaths, findPackageRoot, summarizeContribution } from "../extensions/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");
const pkgJson = resolve(pkgRoot, "package.json");

describe("@dsshap/pi-extension-resources package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("declares the entry in package.json's pi.extensions", () => {
		const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string; pi?: { extensions?: string[] } };
		expect(pkg.name).toBe("@dsshap/pi-extension-resources");
		expect(pkg.pi?.extensions).toEqual(["./extensions/index.ts"]);
	});
});

describe("findPackageRoot", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the directory containing package.json when given a nested file", () => {
		const pkg = join(tmp, "pkg");
		mkdirSync(join(pkg, "extensions"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), "{}");
		writeFileSync(join(pkg, "extensions", "index.ts"), "");
		expect(findPackageRoot(join(pkg, "extensions", "index.ts"))).toBe(pkg);
	});

	it("returns the directory itself when given a directory containing package.json", () => {
		const pkg = join(tmp, "pkg");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), "{}");
		expect(findPackageRoot(pkg)).toBe(pkg);
	});

	it("walks past intermediate dirs without package.json", () => {
		const pkg = join(tmp, "pkg");
		mkdirSync(join(pkg, "a", "b", "c"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), "{}");
		expect(findPackageRoot(join(pkg, "a", "b", "c"))).toBe(pkg);
	});

	it("returns null when no enclosing package.json exists", () => {
		const lonely = join(tmp, "no-package");
		mkdirSync(lonely, { recursive: true });
		expect(findPackageRoot(lonely)).toBeNull();
	});

	it("handles a non-existent seed path by treating it as a directory", () => {
		const pkg = join(tmp, "pkg");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), "{}");
		const missing = join(pkg, "does", "not", "exist");
		expect(findPackageRoot(missing)).toBe(pkg);
	});
});

describe("collectResourcePaths", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-collect-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function makePackage(name: string, opts: { prompts?: boolean; skills?: boolean } = {}): string {
		const dir = join(tmp, name);
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
		writeFileSync(join(dir, "extensions", "index.ts"), "");
		if (opts.prompts) mkdirSync(join(dir, "prompts"), { recursive: true });
		if (opts.skills) mkdirSync(join(dir, "skills"), { recursive: true });
		return dir;
	}

	it("skips built-in and SDK source-infos", () => {
		const result = collectResourcePaths([
			{ sourceInfo: { source: "builtin", baseDir: tmp } },
			{ sourceInfo: { source: "sdk", baseDir: tmp } },
		]);
		expect(result).toEqual({ roots: [], promptPaths: [], skillPaths: [] });
	});

	it("ignores items without sourceInfo or path/baseDir", () => {
		const result = collectResourcePaths([{}, { sourceInfo: undefined }, { sourceInfo: { source: "local" } }]);
		expect(result.roots).toEqual([]);
	});

	it("contributes prompts and skills folders when they exist", () => {
		const dir = makePackage("alpha", { prompts: true, skills: true });
		const result = collectResourcePaths([{ sourceInfo: { source: "local", baseDir: join(dir, "extensions") } }]);
		expect(result.roots).toEqual([dir]);
		expect(result.promptPaths).toEqual([join(dir, "prompts")]);
		expect(result.skillPaths).toEqual([join(dir, "skills")]);
	});

	it("contributes only the folder(s) that actually exist", () => {
		const promptsOnly = makePackage("p-only", { prompts: true });
		const skillsOnly = makePackage("s-only", { skills: true });
		const neither = makePackage("neither");
		const result = collectResourcePaths([
			{ sourceInfo: { source: "local", baseDir: join(promptsOnly, "extensions") } },
			{ sourceInfo: { source: "local", baseDir: join(skillsOnly, "extensions") } },
			{ sourceInfo: { source: "local", baseDir: join(neither, "extensions") } },
		]);
		expect(result.roots).toEqual([promptsOnly, skillsOnly, neither]);
		expect(result.promptPaths).toEqual([join(promptsOnly, "prompts")]);
		expect(result.skillPaths).toEqual([join(skillsOnly, "skills")]);
	});

	it("dedupes when multiple tools/commands point at the same package", () => {
		const dir = makePackage("dup", { prompts: true });
		const result = collectResourcePaths([
			{ sourceInfo: { source: "local", baseDir: join(dir, "extensions") } },
			{ sourceInfo: { source: "local", baseDir: join(dir, "extensions") } },
			{ sourceInfo: { source: "local", path: join(dir, "extensions", "index.ts") } },
		]);
		expect(result.roots).toEqual([dir]);
		expect(result.promptPaths).toEqual([join(dir, "prompts")]);
	});

	it("falls back to dirname of sourceInfo.path when baseDir is missing", () => {
		const dir = makePackage("by-path", { skills: true });
		const result = collectResourcePaths([{ sourceInfo: { source: "local", path: join(dir, "extensions", "index.ts") } }]);
		expect(result.roots).toEqual([dir]);
		expect(result.skillPaths).toEqual([join(dir, "skills")]);
	});

	it("ignores tools whose path is not inside any package.json tree", () => {
		const orphan = join(tmp, "orphan-dir");
		mkdirSync(orphan, { recursive: true });
		const result = collectResourcePaths([{ sourceInfo: { source: "local", baseDir: orphan } }]);
		expect(result.roots).toEqual([]);
	});
});

describe("summarizeContribution", () => {
	it("emits per-root kinds for roots that contributed at least one folder", () => {
		const report: ContributedResources = {
			roots: ["/r/a", "/r/b", "/r/c"],
			promptPaths: ["/r/a/prompts", "/r/c/prompts"],
			skillPaths: ["/r/b/skills", "/r/c/skills"],
		};
		expect(summarizeContribution(report)).toEqual([
			{ root: "/r/a", kinds: ["prompts"] },
			{ root: "/r/b", kinds: ["skills"] },
			{ root: "/r/c", kinds: ["prompts", "skills"] },
		]);
	});

	it("omits roots with no contributing folders", () => {
		const report: ContributedResources = {
			roots: ["/r/empty", "/r/has-prompts"],
			promptPaths: ["/r/has-prompts/prompts"],
			skillPaths: [],
		};
		expect(summarizeContribution(report)).toEqual([{ root: "/r/has-prompts", kinds: ["prompts"] }]);
	});
});
