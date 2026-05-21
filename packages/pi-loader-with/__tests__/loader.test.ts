import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifest } from "../extensions/loader.js";

describe("readManifest", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-manifest-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function mk(name: string, pkg: Record<string, unknown>): string {
		const dir = join(tmp, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
		return dir;
	}

	it("returns empty manifest when there is no package.json", () => {
		const dir = join(tmp, "no-pkg");
		mkdirSync(dir, { recursive: true });
		expect(readManifest(dir)).toEqual({ extensions: [], promptPaths: [], skillPaths: [] });
	});

	it("returns empty manifest when package.json is malformed", () => {
		const dir = join(tmp, "bad");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(readManifest(dir)).toEqual({ extensions: [], promptPaths: [], skillPaths: [] });
	});

	it("returns empty manifest when there is no `pi` field", () => {
		const dir = mk("plain", { name: "plain" });
		expect(readManifest(dir)).toEqual({ extensions: [], promptPaths: [], skillPaths: [] });
	});

	it("resolves pi.extensions relative to the bundle dir", () => {
		const dir = mk("ext", { pi: { extensions: ["./extensions/index.ts"] } });
		const m = readManifest(dir);
		expect(m.extensions).toEqual([resolve(dir, "./extensions/index.ts")]);
	});

	it("accepts string form for pi.prompts and pi.skills", () => {
		const dir = mk("str", { pi: { prompts: "./prompts", skills: "./skills" } });
		const m = readManifest(dir);
		expect(m.promptPaths).toEqual([resolve(dir, "./prompts")]);
		expect(m.skillPaths).toEqual([resolve(dir, "./skills")]);
	});

	it("accepts array form for pi.prompts and pi.skills", () => {
		const dir = mk("arr", {
			pi: { prompts: ["./a", "./b"], skills: ["./s1", "./s2"] },
		});
		const m = readManifest(dir);
		expect(m.promptPaths).toEqual([resolve(dir, "./a"), resolve(dir, "./b")]);
		expect(m.skillPaths).toEqual([resolve(dir, "./s1"), resolve(dir, "./s2")]);
	});

	it("ignores non-string entries in arrays", () => {
		const dir = mk("dirty", {
			pi: { prompts: ["./ok", 42, null, "", "./also-ok"] },
		});
		expect(readManifest(dir).promptPaths).toEqual([resolve(dir, "./ok"), resolve(dir, "./also-ok")]);
	});

	it("returns empty arrays when pi.prompts / pi.skills are unrelated types", () => {
		const dir = mk("weird", { pi: { prompts: 123, skills: { wat: true } } });
		const m = readManifest(dir);
		expect(m.promptPaths).toEqual([]);
		expect(m.skillPaths).toEqual([]);
	});

	it("supports absolute paths verbatim", () => {
		const abs = join(tmp, "abs", "prompts");
		const dir = mk("abs-host", { pi: { prompts: [abs] } });
		expect(readManifest(dir).promptPaths).toEqual([resolve(abs)]);
	});
});
