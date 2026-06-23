import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addToConfig,
	detectSpecKind,
	formatList,
	parseAddArgs,
	parseSubcommand,
	readConfigRaw,
	removeFromConfig,
	validateLocalPath,
	writeConfigRaw,
} from "../extensions/commands.js";

// ── detectSpecKind ────────────────────────────────────────────────────────

describe("detectSpecKind", () => {
	it("classifies git: prefix as remote", () => {
		expect(detectSpecKind("git:github.com/foo/bar")).toBe("remote");
		expect(detectSpecKind("git:github.com/foo/bar@v1")).toBe("remote");
	});

	it("classifies npm: prefix as remote", () => {
		expect(detectSpecKind("npm:foo")).toBe("remote");
		expect(detectSpecKind("npm:@scope/pkg")).toBe("remote");
		expect(detectSpecKind("npm:@plannotator/pi-extension")).toBe("remote");
		expect(detectSpecKind("npm:foo@1.2.3")).toBe("remote");
	});

	it("classifies https://, http://, ssh://, git:// as remote", () => {
		expect(detectSpecKind("https://github.com/foo/bar")).toBe("remote");
		expect(detectSpecKind("http://example.com/foo/bar")).toBe("remote");
		expect(detectSpecKind("ssh://git@github.com/foo/bar")).toBe("remote");
		expect(detectSpecKind("git://github.com/foo/bar")).toBe("remote");
	});

	it("classifies SCP-style git@host:user/repo as remote", () => {
		expect(detectSpecKind("git@github.com:foo/bar")).toBe("remote");
		expect(detectSpecKind("git@gitlab.example.com:foo/bar.git")).toBe("remote");
	});

	it("classifies absolute paths as local", () => {
		expect(detectSpecKind("/abs/path")).toBe("local");
		expect(detectSpecKind("/Users/dsshap/code")).toBe("local");
	});

	it("classifies ~-paths as local", () => {
		expect(detectSpecKind("~/my-extensions")).toBe("local");
		expect(detectSpecKind("~/code/pi-packages/packages")).toBe("local");
	});

	it("classifies relative paths as local", () => {
		expect(detectSpecKind("./local")).toBe("local");
		expect(detectSpecKind("../sibling")).toBe("local");
		expect(detectSpecKind("just-a-name")).toBe("local");
	});

	it("does not mistake colons in paths for SCP", () => {
		// A path like `/tmp/foo:bar` shouldn't trigger SCP detection.
		expect(detectSpecKind("/tmp/foo:bar")).toBe("local");
	});

	it("trims whitespace before classifying", () => {
		expect(detectSpecKind("  git:github.com/foo/bar  ")).toBe("remote");
		expect(detectSpecKind("  /abs  ")).toBe("local");
	});
});

// ── validateLocalPath ────────────────────────────────────────────────────

describe("validateLocalPath", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "loader-cmd-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("accepts an existing directory (absolute)", () => {
		const r = validateLocalPath(tmp, tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.abs).toBe(tmp);
	});

	it("resolves a relative path against cwd", () => {
		const sub = join(tmp, "child");
		mkdirSync(sub);
		const r = validateLocalPath("./child", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.abs).toBe(sub);
	});

	it("expands ~ to the home directory", () => {
		const r = validateLocalPath("~", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.abs).toBe(homedir());
	});

	it("rejects a non-existent path", () => {
		const r = validateLocalPath(join(tmp, "does-not-exist"), tmp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/does not exist/);
	});

	it("rejects a file (not a directory)", () => {
		const f = join(tmp, "file.txt");
		writeFileSync(f, "");
		const r = validateLocalPath(f, tmp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not a directory/);
	});
});

// ── readConfigRaw / writeConfigRaw ───────────────────────────────────────

describe("readConfigRaw / writeConfigRaw", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "loader-cmd-rw-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty config when file is absent", () => {
		const c = readConfigRaw(join(tmp, "missing.json"));
		expect(c).toEqual({ locations: [], remotes: [] });
	});

	it("throws on malformed JSON", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "{ not json");
		expect(() => readConfigRaw(p)).toThrow(/not valid JSON/);
	});

	it("filters non-string entries from locations/remotes", () => {
		const p = join(tmp, "mixed.json");
		writeFileSync(p, JSON.stringify({ locations: ["/a", 42, "/b"], remotes: ["git:x", null] }));
		const c = readConfigRaw(p);
		expect(c).toEqual({ locations: ["/a", "/b"], remotes: ["git:x"] });
	});

	it("preserves object entries with aliases, drops malformed objects", () => {
		const p = join(tmp, "objs.json");
		writeFileSync(
			p,
			JSON.stringify({
				locations: [{ path: "/p1", name: "alpha" }, { path: "/p2" }, { name: "orphan" }, "/p3"],
				remotes: [{ spec: "git:foo/bar", name: "fb" }, { spec: "git:no-name" }],
			}),
		);
		const c = readConfigRaw(p);
		expect(c.locations).toEqual([{ path: "/p1", name: "alpha" }, { path: "/p2" }, "/p3"]);
		expect(c.remotes).toEqual([{ spec: "git:foo/bar", name: "fb" }, { spec: "git:no-name" }]);
	});

	it("writes back a normalized config and creates parent dirs", () => {
		const p = join(tmp, "nested", "config.json");
		writeConfigRaw(p, { locations: ["/a"], remotes: ["git:x"] });
		const back = JSON.parse(readFileSync(p, "utf8"));
		expect(back).toEqual({ locations: ["/a"], remotes: ["git:x"] });
	});
});

// ── addToConfig ──────────────────────────────────────────────────────────

describe("addToConfig", () => {
	let tmp: string;
	let cfgPath: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "loader-cmd-add-"));
		cfgPath = join(tmp, "config.json");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("adds an existing local directory to locations", () => {
		const dir = join(tmp, "ext-dir");
		mkdirSync(dir);
		const r = addToConfig(cfgPath, dir, tmp);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.result.added).toBe(true);
			expect(r.result.kind).toBe("local");
			expect(r.result.stored).toBe(dir);
		}
		expect(readConfigRaw(cfgPath).locations).toEqual([dir]);
	});

	it("expands ~ when adding a local path", () => {
		const r = addToConfig(cfgPath, "~", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result.stored).toBe(homedir());
	});

	it("resolves relative paths against cwd before storing", () => {
		const dir = join(tmp, "rel");
		mkdirSync(dir);
		const r = addToConfig(cfgPath, "./rel", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result.stored).toBe(dir);
	});

	it("adds a git spec to remotes verbatim", () => {
		const r = addToConfig(cfgPath, "git:github.com/foo/bar@v1", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.result.kind).toBe("remote");
			expect(r.result.stored).toBe("git:github.com/foo/bar@v1");
		}
		expect(readConfigRaw(cfgPath).remotes).toEqual(["git:github.com/foo/bar@v1"]);
	});

	it("adds an npm spec to remotes verbatim (with alias)", () => {
		const r = addToConfig(cfgPath, "npm:@plannotator/pi-extension", tmp, "plannotator");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.result.kind).toBe("remote");
			expect(r.result.stored).toBe("npm:@plannotator/pi-extension");
			expect(r.result.name).toBe("plannotator");
		}
		expect(readConfigRaw(cfgPath).remotes).toEqual([{ spec: "npm:@plannotator/pi-extension", name: "plannotator" }]);
	});

	it("reports added=false when entry is already present", () => {
		const dir = join(tmp, "ext-dir");
		mkdirSync(dir);
		expect(addToConfig(cfgPath, dir, tmp).ok).toBe(true);
		const r2 = addToConfig(cfgPath, dir, tmp);
		expect(r2.ok).toBe(true);
		if (r2.ok) expect(r2.result.added).toBe(false);
		expect(readConfigRaw(cfgPath).locations).toEqual([dir]);
	});

	it("fails when local path does not exist", () => {
		const r = addToConfig(cfgPath, join(tmp, "missing"), tmp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/does not exist/);
	});

	it("preserves existing entries when adding a new one", () => {
		writeConfigRaw(cfgPath, { locations: ["/keep"], remotes: ["git:keep/me"] });
		const dir = join(tmp, "new");
		mkdirSync(dir);
		addToConfig(cfgPath, dir, tmp);
		expect(readConfigRaw(cfgPath)).toEqual({
			locations: ["/keep", dir],
			remotes: ["git:keep/me"],
		});
	});

	it("stores an object entry when name is provided (local)", () => {
		const dir = join(tmp, "plannotator");
		mkdirSync(dir);
		const r = addToConfig(cfgPath, dir, tmp, "plan");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.result.added).toBe(true);
			expect(r.result.name).toBe("plan");
		}
		expect(readConfigRaw(cfgPath).locations).toEqual([{ path: dir, name: "plan" }]);
	});

	it("stores an object entry when name is provided (remote)", () => {
		const r = addToConfig(cfgPath, "git:github.com/foo/bar", tmp, "fb");
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).remotes).toEqual([{ spec: "git:github.com/foo/bar", name: "fb" }]);
	});

	it("updates an existing entry in place when alias changes", () => {
		const dir = join(tmp, "ext");
		mkdirSync(dir);
		addToConfig(cfgPath, dir, tmp); // no alias
		addToConfig(cfgPath, dir, tmp, "renamed");
		expect(readConfigRaw(cfgPath).locations).toEqual([{ path: dir, name: "renamed" }]);
	});

	it("reports added=false when path+alias match an existing entry exactly", () => {
		const dir = join(tmp, "ext");
		mkdirSync(dir);
		addToConfig(cfgPath, dir, tmp, "x");
		const r = addToConfig(cfgPath, dir, tmp, "x");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result.added).toBe(false);
		expect(readConfigRaw(cfgPath).locations).toEqual([{ path: dir, name: "x" }]);
	});
});

// ── removeFromConfig ─────────────────────────────────────────────────────

describe("removeFromConfig", () => {
	let tmp: string;
	let cfgPath: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "loader-cmd-rm-"));
		cfgPath = join(tmp, "config.json");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("removes a verbatim match from remotes", () => {
		writeConfigRaw(cfgPath, { locations: [], remotes: ["git:github.com/foo/bar"] });
		const r = removeFromConfig(cfgPath, "git:github.com/foo/bar", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result.removedFrom).toEqual(["remote"]);
		expect(readConfigRaw(cfgPath).remotes).toEqual([]);
	});

	it("removes a local entry matched by expanded ~ form", () => {
		const stored = join(homedir(), "fake-extensions");
		writeConfigRaw(cfgPath, { locations: [stored], remotes: [] });
		const r = removeFromConfig(cfgPath, "~/fake-extensions", tmp);
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).locations).toEqual([]);
	});

	it("removes a local entry matched by cwd-resolved relative form", () => {
		const dir = join(tmp, "rel");
		writeConfigRaw(cfgPath, { locations: [dir], remotes: [] });
		const r = removeFromConfig(cfgPath, "./rel", tmp);
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).locations).toEqual([]);
	});

	it("returns an error when nothing matched", () => {
		writeConfigRaw(cfgPath, { locations: ["/a"], remotes: ["git:x"] });
		const r = removeFromConfig(cfgPath, "/nope", tmp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/no matching entry/);
	});

	it("removes an object-form entry by path", () => {
		writeConfigRaw(cfgPath, { locations: [{ path: "/abs/plannotator", name: "plan" }], remotes: [] });
		const r = removeFromConfig(cfgPath, "/abs/plannotator", tmp);
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).locations).toEqual([]);
	});

	it("removes an object-form entry by alias", () => {
		writeConfigRaw(cfgPath, { locations: [{ path: "/abs/plannotator", name: "plan" }], remotes: [] });
		const r = removeFromConfig(cfgPath, "plan", tmp);
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).locations).toEqual([]);
	});

	it("removes an object-form remote by alias", () => {
		writeConfigRaw(cfgPath, { locations: [], remotes: [{ spec: "git:github.com/foo/bar", name: "fb" }] });
		const r = removeFromConfig(cfgPath, "fb", tmp);
		expect(r.ok).toBe(true);
		expect(readConfigRaw(cfgPath).remotes).toEqual([]);
	});

	it("can remove an entry that appears in both locations and remotes", () => {
		// Pathological: same string in both lists. Both should be removed.
		writeConfigRaw(cfgPath, { locations: ["weirdvalue"], remotes: ["weirdvalue"] });
		const r = removeFromConfig(cfgPath, "weirdvalue", tmp);
		expect(r.ok).toBe(true);
		if (r.ok) expect(new Set(r.result.removedFrom)).toEqual(new Set(["local", "remote"]));
		expect(readConfigRaw(cfgPath)).toEqual({ locations: [], remotes: [] });
	});
});

// ── parseSubcommand ──────────────────────────────────────────────────────

describe("parseSubcommand", () => {
	it("splits subcommand and rest on first whitespace", () => {
		expect(parseSubcommand("add /foo")).toEqual({ sub: "add", rest: "/foo" });
		expect(parseSubcommand("remove   git:github.com/foo/bar")).toEqual({
			sub: "remove",
			rest: "git:github.com/foo/bar",
		});
	});

	it("returns empty sub for empty input", () => {
		expect(parseSubcommand("")).toEqual({ sub: "", rest: "" });
		expect(parseSubcommand("   ")).toEqual({ sub: "", rest: "" });
	});

	it("lowercases the subcommand only", () => {
		expect(parseSubcommand("ADD /Foo")).toEqual({ sub: "add", rest: "/Foo" });
	});
});

// ── formatList ───────────────────────────────────────────────────────────

describe("formatList", () => {
	it("renders both lists with counts", () => {
		const out = formatList({ locations: ["/a", "/b"], remotes: ["git:x"] }, "/cfg/path");
		expect(out).toContain("Config: /cfg/path");
		expect(out).toContain("locations (2):");
		expect(out).toContain("  - /a");
		expect(out).toContain("  - /b");
		expect(out).toContain("remotes (1):");
		expect(out).toContain("  - git:x");
	});

	it("shows (none) when a list is empty", () => {
		const out = formatList({ locations: [], remotes: [] }, "/p");
		expect(out).toContain("locations (0):\n  (none)");
		expect(out).toContain("remotes (0):\n  (none)");
	});

	it("renders aliased entries with the `(as <name>)` suffix", () => {
		const out = formatList(
			{
				locations: [{ path: "/a", name: "plan" }, "/b"],
				remotes: [{ spec: "git:foo/bar", name: "fb" }],
			},
			"/cfg",
		);
		expect(out).toContain("  - /a  (as plan)");
		expect(out).toContain("  - /b");
		expect(out).toContain("  - git:foo/bar  (as fb)");
	});
});

// ── parseAddArgs ────────────────────────────────────────────────────────

describe("parseAddArgs", () => {
	it("returns just the value when no suffix", () => {
		expect(parseAddArgs("~/code/foo")).toEqual({ value: "~/code/foo" });
	});

	it("parses `<value> as <name>`", () => {
		expect(parseAddArgs("~/code/plannotator as plan")).toEqual({ value: "~/code/plannotator", name: "plan" });
	});

	it("parses `<value> --name <name>`", () => {
		expect(parseAddArgs("git:github.com/foo/bar --name fb")).toEqual({
			value: "git:github.com/foo/bar",
			name: "fb",
		});
	});

	it("is case-insensitive on the `as` keyword", () => {
		expect(parseAddArgs("/foo AS bar")).toEqual({ value: "/foo", name: "bar" });
	});

	it("only consumes a trailing `as` clause (path containing 'as' word in the middle is preserved)", () => {
		// Trailing `as plan` should still parse — the regex is non-greedy on value.
		expect(parseAddArgs("/some path as plan")).toEqual({ value: "/some path", name: "plan" });
	});

	it("returns empty value for empty input", () => {
		expect(parseAddArgs("")).toEqual({ value: "" });
		expect(parseAddArgs("   ")).toEqual({ value: "" });
	});
});
