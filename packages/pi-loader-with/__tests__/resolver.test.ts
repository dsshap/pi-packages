import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configSearchPaths,
	ensureDefaultConfig,
	expandHome,
	isPinnedGitSpec,
	listCandidates,
	loadConfigFrom,
	parseWithFromArgv,
	parseWithFromEnv,
	resolveAll,
	resolveName,
	scanCloneForCandidates,
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
		expect(paths).toEqual([join(home, ".pi", "agent", "extensions", "pi-loader-with.json")]);
	});

	it("puts the env path first when set", () => {
		const home = "/fake/home";
		const env = { PI_EXTENSION_LOADER_WITH_CONFIG: "/custom/config.json" };
		const paths = configSearchPaths(env, home);
		expect(paths[0]).toBe("/custom/config.json");
		expect(paths[1]).toBe(join(home, ".pi", "agent", "extensions", "pi-loader-with.json"));
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

// ── isPinnedGitSpec ────────────────────────────────────────────────────────

describe("isPinnedGitSpec", () => {
	it("returns true for branch refs", () => {
		expect(isPinnedGitSpec("git:github.com/foo/bar@main")).toBe(true);
		expect(isPinnedGitSpec("https://github.com/foo/bar@develop")).toBe(true);
	});

	it("returns true for tag refs", () => {
		expect(isPinnedGitSpec("git:github.com/foo/bar@v1.2.3")).toBe(true);
	});

	it("returns true for commit SHAs", () => {
		expect(isPinnedGitSpec("git:github.com/foo/bar@abc1234")).toBe(true);
	});

	it("returns false for unpinned specs", () => {
		expect(isPinnedGitSpec("git:github.com/foo/bar")).toBe(false);
		expect(isPinnedGitSpec("https://github.com/foo/bar")).toBe(false);
	});

	it("does not mistake SCP-style user@host for a ref", () => {
		// In SCP form `git@github.com:foo/bar`, the `@` is part of the host,
		// not a ref. The path-portion after the last `/` is `bar`, no `@`.
		expect(isPinnedGitSpec("git:git@github.com:foo/bar")).toBe(false);
		expect(isPinnedGitSpec("ssh://git@github.com/foo/bar")).toBe(false);
	});

	it("returns true when SCP-style spec has a trailing @ref", () => {
		expect(isPinnedGitSpec("git:git@github.com:foo/bar@v1")).toBe(true);
	});
});

// ── scanCloneForCandidates ─────────────────────────────────────────────────

describe("scanCloneForCandidates", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-scan-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty for an empty dir", () => {
		const result = scanCloneForCandidates(tmp);
		expect([...result.keys()]).toEqual([]);
	});

	it("detects monorepo via packages/ and walks subdirs", () => {
		mkdirSync(join(tmp, "packages", "alpha"), { recursive: true });
		mkdirSync(join(tmp, "packages", "beta"), { recursive: true });
		writeFileSync(join(tmp, "package.json"), "{}");
		const result = scanCloneForCandidates(tmp);
		expect(new Set(result.keys())).toEqual(new Set(["alpha", "beta"]));
		expect(result.get("alpha")).toBe(join(tmp, "packages", "alpha"));
	});

	it("skips dotfiles and node_modules under packages/", () => {
		mkdirSync(join(tmp, "packages", ".hidden"), { recursive: true });
		mkdirSync(join(tmp, "packages", "node_modules"), { recursive: true });
		mkdirSync(join(tmp, "packages", "keep"), { recursive: true });
		const result = scanCloneForCandidates(tmp);
		expect([...result.keys()]).toEqual(["keep"]);
	});

	it("treats a clone without packages/ but with package.json as a single candidate", () => {
		const clone = join(tmp, "single-pkg-repo");
		mkdirSync(clone, { recursive: true });
		writeFileSync(join(clone, "package.json"), "{}");
		const result = scanCloneForCandidates(clone);
		expect([...result.entries()]).toEqual([["single-pkg-repo", clone]]);
	});

	it("returns empty when no packages/ and no root package.json", () => {
		const clone = join(tmp, "nothing");
		mkdirSync(clone, { recursive: true });
		const result = scanCloneForCandidates(clone);
		expect([...result.keys()]).toEqual([]);
	});
});

// ── loadConfigFrom (remotes) ───────────────────────────────────────────────

describe("loadConfigFrom (remotes)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-res-rem-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("defaults remotes to [] when absent", () => {
		const p = join(tmp, "no-remotes.json");
		writeFileSync(p, JSON.stringify({ locations: ["/foo"] }));
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.remotes).toEqual([]);
	});

	it("parses remotes array, filtering non-strings and empties", () => {
		const p = join(tmp, "with-remotes.json");
		writeFileSync(
			p,
			JSON.stringify({
				locations: [],
				remotes: ["git:github.com/foo/bar", "git:github.com/baz/qux@v1", 42, "", null],
			}),
		);
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.remotes).toEqual(["git:github.com/foo/bar", "git:github.com/baz/qux@v1"]);
	});
});
