import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configSearchPaths,
	ensureDefaultConfig,
	expandHome,
	listCandidates,
	loadConfigFrom,
	parseWithFromArgv,
	parseWithFromEnv,
	resolveAll,
	resolveName,
} from "../extensions/resolver.js";

// ── parseWithFromArgv ──────────────────────────────────────────────────────

describe("parseWithFromArgv", () => {
	it("returns [] for empty argv", () => {
		expect(parseWithFromArgv([])).toEqual([]);
	});

	it("parses --with <value> (space form)", () => {
		expect(parseWithFromArgv(["--with", "foo"])).toEqual(["foo"]);
	});

	it("parses --with=<value> (equals form)", () => {
		expect(parseWithFromArgv(["--with=foo"])).toEqual(["foo"]);
	});

	it("comma-splits a single --with value", () => {
		expect(parseWithFromArgv(["--with", "a,b,c"])).toEqual(["a", "b", "c"]);
	});

	it("handles multiple --with flags", () => {
		expect(parseWithFromArgv(["--with", "a", "--with", "b"])).toEqual(["a", "b"]);
	});

	it("handles mixed --with= and --with space forms", () => {
		expect(parseWithFromArgv(["--with=a", "--with", "b,c"])).toEqual(["a", "b", "c"]);
	});

	it("trims whitespace around comma-separated values", () => {
		expect(parseWithFromArgv(["--with", " a , b "])).toEqual(["a", "b"]);
	});

	it("deduplicates repeated names", () => {
		expect(parseWithFromArgv(["--with", "a", "--with", "a"])).toEqual(["a"]);
	});

	it("ignores --without", () => {
		expect(parseWithFromArgv(["--without", "foo"])).toEqual([]);
	});

	it("ignores --with-cli-flag (not exact --with)", () => {
		expect(parseWithFromArgv(["--with-cli-flag", "foo"])).toEqual([]);
	});

	it("ignores dangling --with at end of argv (no value)", () => {
		expect(parseWithFromArgv(["--with"])).toEqual([]);
	});
});

// ── parseWithFromEnv ───────────────────────────────────────────────────────

describe("parseWithFromEnv", () => {
	it("returns [] when PI_WITH is undefined", () => {
		expect(parseWithFromEnv({})).toEqual([]);
	});

	it("returns [] when PI_WITH is empty string", () => {
		expect(parseWithFromEnv({ PI_WITH: "" })).toEqual([]);
	});

	it("parses a single name", () => {
		expect(parseWithFromEnv({ PI_WITH: "foo" })).toEqual(["foo"]);
	});

	it("comma-splits", () => {
		expect(parseWithFromEnv({ PI_WITH: "a,b,c" })).toEqual(["a", "b", "c"]);
	});

	it("trims whitespace", () => {
		expect(parseWithFromEnv({ PI_WITH: " a , b " })).toEqual(["a", "b"]);
	});

	it("deduplicates", () => {
		expect(parseWithFromEnv({ PI_WITH: "a,a,b" })).toEqual(["a", "b"]);
	});
});

// ── expandHome ─────────────────────────────────────────────────────────────

describe("expandHome", () => {
	it("expands bare ~", () => {
		expect(expandHome("~")).toBe(homedir());
	});

	it("expands ~/foo/bar", () => {
		expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandHome("/abs/path")).toBe("/abs/path");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandHome("rel/path")).toBe("rel/path");
	});

	it("leaves ~user unchanged (not bare ~ or ~/...)", () => {
		expect(expandHome("~user")).toBe("~user");
	});
});

// ── configSearchPaths ──────────────────────────────────────────────────────

describe("configSearchPaths", () => {
	it("returns only the global path when env var is unset", () => {
		const home = "/fake/home";
		const paths = configSearchPaths({}, home);
		expect(paths).toEqual([join(home, ".pi", "agent", "extensions", "pi-extension-resources.json")]);
	});

	it("puts the env path first when set", () => {
		const home = "/fake/home";
		const env = { PI_EXTENSION_RESOURCES_CONFIG: "/custom/config.json" };
		const paths = configSearchPaths(env, home);
		expect(paths[0]).toBe("/custom/config.json");
		expect(paths[1]).toBe(join(home, ".pi", "agent", "extensions", "pi-extension-resources.json"));
	});
});

// ── loadConfigFrom ─────────────────────────────────────────────────────────

describe("loadConfigFrom", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-cfg-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns { config: null } for a missing file", () => {
		const result = loadConfigFrom(join(tmp, "missing.json"), tmp);
		expect(result.config).toBeNull();
		expect(result.warning).toBeUndefined();
	});

	it("returns { config: null, warning } for malformed JSON", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "{ not valid json");
		const result = loadConfigFrom(p, tmp);
		expect(result.config).toBeNull();
		expect(result.warning).toMatch(/Failed to parse/);
	});

	it("parses a valid config with mixed string/non-string locations", () => {
		const p = join(tmp, "good.json");
		writeFileSync(p, JSON.stringify({ locations: ["/abs/path", 42, "/another", null] }));
		const result = loadConfigFrom(p, tmp);
		expect(result.config).not.toBeNull();
		expect(result.config?.locations).toEqual(["/abs/path", "/another"]);
	});

	it("expands ~ in locations", () => {
		const p = join(tmp, "tilde.json");
		writeFileSync(p, JSON.stringify({ locations: ["~/code"] }));
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.locations).toEqual([join(homedir(), "code")]);
	});
});

// ── ensureDefaultConfig ────────────────────────────────────────────────────

describe("ensureDefaultConfig", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-ens-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the first existing config without touching the second", () => {
		const first = join(tmp, "first.json");
		const second = join(tmp, "second.json");
		writeFileSync(first, JSON.stringify({ locations: ["/first"] }));
		const result = ensureDefaultConfig([first, second], tmp);
		expect(result.sourcePath).toBe(first);
		expect(result.config.locations).toEqual(["/first"]);
		expect(result.created).toBe(false);
		expect(existsSync(second)).toBe(false);
	});

	it("returns the second path when only the second exists", () => {
		const first = join(tmp, "nonexistent.json");
		const second = join(tmp, "second.json");
		writeFileSync(second, JSON.stringify({ locations: ["/second"] }));
		const result = ensureDefaultConfig([first, second], tmp);
		expect(result.sourcePath).toBe(second);
		expect(result.config.locations).toEqual(["/second"]);
		expect(result.created).toBe(false);
	});

	it("creates the last path with { locations: [] } when none exist", () => {
		const first = join(tmp, "missing1.json");
		const second = join(tmp, "subdir", "missing2.json");
		const result = ensureDefaultConfig([first, second], tmp);
		expect(result.created).toBe(true);
		expect(result.sourcePath).toBe(second);
		expect(result.config.locations).toEqual([]);
		expect(existsSync(second)).toBe(true);
	});
});

// ── listCandidates ─────────────────────────────────────────────────────────

describe("listCandidates", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-lst-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("skips dotfiles (.git)", () => {
		const loc = join(tmp, "loc");
		mkdirSync(join(loc, ".git"), { recursive: true });
		mkdirSync(join(loc, "ext-a"), { recursive: true });
		const result = listCandidates([loc]);
		expect([...result.keys()]).toEqual(["ext-a"]);
	});

	it("skips node_modules", () => {
		const loc = join(tmp, "loc");
		mkdirSync(join(loc, "node_modules"), { recursive: true });
		mkdirSync(join(loc, "ext-b"), { recursive: true });
		const result = listCandidates([loc]);
		expect([...result.keys()]).toEqual(["ext-b"]);
	});

	it("skips files (non-dirs)", () => {
		const loc = join(tmp, "loc");
		mkdirSync(loc, { recursive: true });
		writeFileSync(join(loc, "file.ts"), "");
		mkdirSync(join(loc, "ext-c"), { recursive: true });
		const result = listCandidates([loc]);
		expect([...result.keys()]).toEqual(["ext-c"]);
	});

	it("first location wins on name collision", () => {
		const loc1 = join(tmp, "loc1");
		const loc2 = join(tmp, "loc2");
		mkdirSync(join(loc1, "shared"), { recursive: true });
		mkdirSync(join(loc2, "shared"), { recursive: true });
		const result = listCandidates([loc1, loc2]);
		expect(result.get("shared")).toBe(join(loc1, "shared"));
	});

	it("missing locations are skipped silently", () => {
		const missing = join(tmp, "does-not-exist");
		const existing = join(tmp, "loc");
		mkdirSync(join(existing, "ext-d"), { recursive: true });
		const result = listCandidates([missing, existing]);
		expect([...result.keys()]).toEqual(["ext-d"]);
	});
});

// ── resolveName ────────────────────────────────────────────────────────────

describe("resolveName", () => {
	it("exact match wins over substring", () => {
		const m = new Map([
			["foo", "/foo"],
			["foobar", "/foobar"],
		]);
		const result = resolveName("foo", m);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("/foo");
	});

	it("case-insensitive exact match", () => {
		const m = new Map([["foo", "/foo"]]);
		const result = resolveName("FOO", m);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("/foo");
	});

	it("case-insensitive substring match", () => {
		const m = new Map([["pi-pi-experts", "/experts"]]);
		const result = resolveName("exp", m);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("/experts");
	});

	it("ambiguous substring with 2 matches", () => {
		const m = new Map([
			["pi-alpha", "/alpha"],
			["pi-beta", "/beta"],
		]);
		const result = resolveName("pi", m);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("ambiguous");
			expect(result.matches).toHaveLength(2);
		}
	});

	it("no match returns no-match", () => {
		const m = new Map([["ext-a", "/a"]]);
		const result = resolveName("zzz", m);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no-match");
	});
});

// ── resolveAll ─────────────────────────────────────────────────────────────

describe("resolveAll", () => {
	it("resolves multiple names, preserves order, collects errors", () => {
		const m = new Map([
			["good", "/good"],
			["good2", "/good2"],
		]);
		const result = resolveAll(["good", "missing", "good2"], m);
		expect(result.resolved.map((r) => r.name)).toEqual(["good", "good2"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].name).toBe("missing");
	});
});
