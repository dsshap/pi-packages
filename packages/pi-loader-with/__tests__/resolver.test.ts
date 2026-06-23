import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configSearchPaths,
	ensureDefaultConfig,
	expandHome,
	getRemoteScheme,
	isPinnedGitSpec,
	isPinnedNpmSpec,
	isPinnedRemoteSpec,
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
		expect(result.config?.locations).toEqual([{ path: "/abs/path" }, { path: "/another" }]);
	});

	it("expands ~ in locations", () => {
		const p = join(tmp, "tilde.json");
		writeFileSync(p, JSON.stringify({ locations: ["~/code"] }));
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.locations).toEqual([{ path: join(homedir(), "code") }]);
	});

	it("parses object-form locations with name aliases", () => {
		const p = join(tmp, "obj.json");
		writeFileSync(
			p,
			JSON.stringify({
				locations: [
					{ path: "/foo", name: "plan" },
					{ path: "/bar" },
					{ name: "orphan" }, // missing path — dropped
					{ path: "", name: "empty" }, // empty path — dropped
				],
			}),
		);
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.locations).toEqual([{ path: "/foo", name: "plan" }, { path: "/bar" }]);
	});

	it("parses object-form remotes with name aliases", () => {
		const p = join(tmp, "obj-remotes.json");
		writeFileSync(
			p,
			JSON.stringify({
				locations: [],
				remotes: ["git:github.com/foo/bar", { spec: "git:github.com/baz/qux", name: "qux-alias" }, { name: "orphan" }],
			}),
		);
		const result = loadConfigFrom(p, tmp);
		expect(result.config?.remotes).toEqual([
			{ spec: "git:github.com/foo/bar" },
			{ spec: "git:github.com/baz/qux", name: "qux-alias" },
		]);
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
		expect(result.config.locations).toEqual([{ path: "/first" }]);
		expect(result.created).toBe(false);
		expect(existsSync(second)).toBe(false);
	});

	it("returns the second path when only the second exists", () => {
		const first = join(tmp, "nonexistent.json");
		const second = join(tmp, "second.json");
		writeFileSync(second, JSON.stringify({ locations: ["/second"] }));
		const result = ensureDefaultConfig([first, second], tmp);
		expect(result.sourcePath).toBe(second);
		expect(result.config.locations).toEqual([{ path: "/second" }]);
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
		const { candidates } = listCandidates([loc]);
		expect([...candidates.keys()]).toEqual(["ext-a"]);
	});

	it("skips node_modules", () => {
		const loc = join(tmp, "loc");
		mkdirSync(join(loc, "node_modules"), { recursive: true });
		mkdirSync(join(loc, "ext-b"), { recursive: true });
		const { candidates } = listCandidates([loc]);
		expect([...candidates.keys()]).toEqual(["ext-b"]);
	});

	it("skips files (non-dirs)", () => {
		const loc = join(tmp, "loc");
		mkdirSync(loc, { recursive: true });
		writeFileSync(join(loc, "file.ts"), "");
		mkdirSync(join(loc, "ext-c"), { recursive: true });
		const { candidates } = listCandidates([loc]);
		expect([...candidates.keys()]).toEqual(["ext-c"]);
	});

	it("first location wins on name collision", () => {
		const loc1 = join(tmp, "loc1");
		const loc2 = join(tmp, "loc2");
		mkdirSync(join(loc1, "shared"), { recursive: true });
		mkdirSync(join(loc2, "shared"), { recursive: true });
		const { candidates } = listCandidates([loc1, loc2]);
		expect(candidates.get("shared")).toBe(join(loc1, "shared"));
	});

	it("missing locations are skipped silently", () => {
		const missing = join(tmp, "does-not-exist");
		const existing = join(tmp, "loc");
		mkdirSync(join(existing, "ext-d"), { recursive: true });
		const { candidates } = listCandidates([missing, existing]);
		expect([...candidates.keys()]).toEqual(["ext-d"]);
	});

	it("treats a location with a root package.json as a single-package candidate (keyed by basename)", () => {
		const single = join(tmp, "plannotator");
		mkdirSync(single);
		writeFileSync(join(single, "package.json"), "{}");
		// Sibling subdirs must NOT be treated as separate candidates.
		mkdirSync(join(single, "src"), { recursive: true });
		const { candidates, warnings } = listCandidates([single]);
		expect([...candidates.entries()]).toEqual([["plannotator", single]]);
		expect(warnings).toEqual([]);
	});

	it("honors an alias on a single-package location", () => {
		const single = join(tmp, "plannotator");
		mkdirSync(single);
		writeFileSync(join(single, "package.json"), "{}");
		const { candidates, warnings } = listCandidates([{ path: single, name: "plan" }]);
		expect([...candidates.entries()]).toEqual([["plan", single]]);
		expect(warnings).toEqual([]);
	});

	it("warns and ignores an alias on a multi-package container location", () => {
		const loc = join(tmp, "container");
		mkdirSync(join(loc, "ext-a"), { recursive: true });
		mkdirSync(join(loc, "ext-b"), { recursive: true });
		const { candidates, warnings } = listCandidates([{ path: loc, name: "ignored" }]);
		expect(new Set(candidates.keys())).toEqual(new Set(["ext-a", "ext-b"]));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/alias "ignored" ignored/);
	});

	it("mixes single-package and multi-package locations", () => {
		const single = join(tmp, "plannotator");
		mkdirSync(single);
		writeFileSync(join(single, "package.json"), "{}");
		const container = join(tmp, "container");
		mkdirSync(join(container, "ext-x"), { recursive: true });
		const { candidates } = listCandidates([single, container]);
		expect(candidates.get("plannotator")).toBe(single);
		expect(candidates.get("ext-x")).toBe(join(container, "ext-x"));
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

// ── getRemoteScheme ───────────────────────────────────────────────────────

describe("getRemoteScheme", () => {
	it("classifies npm: specs as npm", () => {
		expect(getRemoteScheme("npm:foo")).toBe("npm");
		expect(getRemoteScheme("npm:@scope/pkg")).toBe("npm");
		expect(getRemoteScheme("npm:@scope/pkg@1.2.3")).toBe("npm");
	});

	it("classifies everything else as git", () => {
		expect(getRemoteScheme("git:github.com/foo/bar")).toBe("git");
		expect(getRemoteScheme("https://github.com/foo/bar")).toBe("git");
		expect(getRemoteScheme("ssh://git@github.com/foo/bar")).toBe("git");
		expect(getRemoteScheme("git@github.com:foo/bar")).toBe("git");
	});
});

// ── isPinnedNpmSpec ─────────────────────────────────────────────────────

describe("isPinnedNpmSpec", () => {
	it("returns false for unpinned npm specs", () => {
		expect(isPinnedNpmSpec("npm:foo")).toBe(false);
		expect(isPinnedNpmSpec("npm:@scope/pkg")).toBe(false);
	});

	it("returns false for @latest dist-tag", () => {
		expect(isPinnedNpmSpec("npm:foo@latest")).toBe(false);
		expect(isPinnedNpmSpec("npm:@scope/pkg@latest")).toBe(false);
	});

	it("returns true for explicit versions", () => {
		expect(isPinnedNpmSpec("npm:foo@1.2.3")).toBe(true);
		expect(isPinnedNpmSpec("npm:@scope/pkg@1.2.3")).toBe(true);
		expect(isPinnedNpmSpec("npm:foo@~2.0.0")).toBe(true);
	});

	it("returns true for non-`latest` dist-tags", () => {
		expect(isPinnedNpmSpec("npm:foo@next")).toBe(true);
		expect(isPinnedNpmSpec("npm:@scope/pkg@beta")).toBe(true);
	});

	it("does not mistake the scope `@` for a version separator", () => {
		// Scoped without version: only @ is at index 0.
		expect(isPinnedNpmSpec("npm:@only-scope/no-version")).toBe(false);
	});

	it("returns false for non-npm specs", () => {
		expect(isPinnedNpmSpec("git:github.com/foo/bar@v1")).toBe(false);
		expect(isPinnedNpmSpec("/abs/path")).toBe(false);
	});
});

// ── isPinnedRemoteSpec ───────────────────────────────────────────────────

describe("isPinnedRemoteSpec", () => {
	it("routes git specs to isPinnedGitSpec", () => {
		expect(isPinnedRemoteSpec("git:github.com/foo/bar")).toBe(false);
		expect(isPinnedRemoteSpec("git:github.com/foo/bar@v1")).toBe(true);
	});

	it("routes npm specs to isPinnedNpmSpec", () => {
		expect(isPinnedRemoteSpec("npm:foo")).toBe(false);
		expect(isPinnedRemoteSpec("npm:foo@1.2.3")).toBe(true);
		expect(isPinnedRemoteSpec("npm:@scope/pkg@latest")).toBe(false);
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
		const { candidates, isMonorepo } = scanCloneForCandidates(tmp);
		expect([...candidates.keys()]).toEqual([]);
		expect(isMonorepo).toBe(false);
	});

	it("detects monorepo via packages/ and walks subdirs", () => {
		mkdirSync(join(tmp, "packages", "alpha"), { recursive: true });
		mkdirSync(join(tmp, "packages", "beta"), { recursive: true });
		writeFileSync(join(tmp, "package.json"), "{}");
		const { candidates, isMonorepo } = scanCloneForCandidates(tmp);
		expect(new Set(candidates.keys())).toEqual(new Set(["alpha", "beta"]));
		expect(candidates.get("alpha")).toBe(join(tmp, "packages", "alpha"));
		expect(isMonorepo).toBe(true);
	});

	it("skips dotfiles and node_modules under packages/", () => {
		mkdirSync(join(tmp, "packages", ".hidden"), { recursive: true });
		mkdirSync(join(tmp, "packages", "node_modules"), { recursive: true });
		mkdirSync(join(tmp, "packages", "keep"), { recursive: true });
		const { candidates } = scanCloneForCandidates(tmp);
		expect([...candidates.keys()]).toEqual(["keep"]);
	});

	it("treats a clone without packages/ but with package.json as a single candidate", () => {
		const clone = join(tmp, "single-pkg-repo");
		mkdirSync(clone, { recursive: true });
		writeFileSync(join(clone, "package.json"), "{}");
		const { candidates, isMonorepo } = scanCloneForCandidates(clone);
		expect([...candidates.entries()]).toEqual([["single-pkg-repo", clone]]);
		expect(isMonorepo).toBe(false);
	});

	it("honors alias on a single-package clone", () => {
		const clone = join(tmp, "some-repo");
		mkdirSync(clone, { recursive: true });
		writeFileSync(join(clone, "package.json"), "{}");
		const { candidates } = scanCloneForCandidates(clone, "my-alias");
		expect([...candidates.entries()]).toEqual([["my-alias", clone]]);
	});

	it("ignores alias on a monorepo clone", () => {
		mkdirSync(join(tmp, "packages", "alpha"), { recursive: true });
		const { candidates, isMonorepo } = scanCloneForCandidates(tmp, "ignored");
		expect([...candidates.keys()]).toEqual(["alpha"]);
		expect(isMonorepo).toBe(true);
	});

	it("returns empty when no packages/ and no root package.json", () => {
		const clone = join(tmp, "nothing");
		mkdirSync(clone, { recursive: true });
		const { candidates } = scanCloneForCandidates(clone);
		expect([...candidates.keys()]).toEqual([]);
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
		expect(result.config?.remotes).toEqual([{ spec: "git:github.com/foo/bar" }, { spec: "git:github.com/baz/qux@v1" }]);
	});
});
