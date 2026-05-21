import { describe, expect, it } from "vitest";
import { loadSubagentExtraArgs, resolveSubagentExtras } from "../src/index.js";

describe("resolveSubagentExtras", () => {
	const EXT = "some-extension";

	it("returns [] when no configs are provided", () => {
		expect(resolveSubagentExtras([], EXT)).toEqual([]);
	});

	it("returns [] when both configs are undefined", () => {
		expect(resolveSubagentExtras([undefined, undefined], EXT)).toEqual([]);
	});

	it("returns [] when no entry matches the extension name", () => {
		const raw = JSON.stringify({ "some-other-ext": { extraArgs: ["-x"] } });
		expect(resolveSubagentExtras([raw], EXT)).toEqual([]);
	});

	it("returns extraArgs from a global-only config", () => {
		const raw = JSON.stringify({ [EXT]: { extraArgs: ["-e", "/path/to/protection"] } });
		expect(resolveSubagentExtras([raw], EXT)).toEqual(["-e", "/path/to/protection"]);
	});

	it("returns extraArgs from a project-only config when global is undefined", () => {
		const raw = JSON.stringify({ [EXT]: { extraArgs: ["--debug"] } });
		expect(resolveSubagentExtras([undefined, raw], EXT)).toEqual(["--debug"]);
	});

	it("project entry fully replaces global entry for the same extension (shallow merge)", () => {
		const globalRaw = JSON.stringify({ [EXT]: { extraArgs: ["-e", "/global/path"] } });
		const projectRaw = JSON.stringify({ [EXT]: { extraArgs: ["-e", "/project/path"] } });
		expect(resolveSubagentExtras([globalRaw, projectRaw], EXT)).toEqual(["-e", "/project/path"]);
	});

	it("global entry survives if project file has no entry for this extension", () => {
		const globalRaw = JSON.stringify({ [EXT]: { extraArgs: ["-e", "/global/path"] } });
		const projectRaw = JSON.stringify({ "other-ext": { extraArgs: ["-x"] } });
		expect(resolveSubagentExtras([globalRaw, projectRaw], EXT)).toEqual(["-e", "/global/path"]);
	});

	it("returns a fresh array (mutation-safe)", () => {
		const raw = JSON.stringify({ [EXT]: { extraArgs: ["-a", "-b"] } });
		const a = resolveSubagentExtras([raw], EXT);
		a.push("-c");
		const b = resolveSubagentExtras([raw], EXT);
		expect(b).toEqual(["-a", "-b"]);
	});

	it("ignores malformed JSON without throwing", () => {
		expect(resolveSubagentExtras(["{not json"], EXT)).toEqual([]);
	});

	it("ignores non-object top-level JSON", () => {
		expect(resolveSubagentExtras([JSON.stringify(["array"])], EXT)).toEqual([]);
		expect(resolveSubagentExtras([JSON.stringify("string")], EXT)).toEqual([]);
		expect(resolveSubagentExtras([JSON.stringify(42)], EXT)).toEqual([]);
	});

	it("ignores a matching entry whose value is not an object", () => {
		const raw = JSON.stringify({ [EXT]: "not an object" });
		expect(resolveSubagentExtras([raw], EXT)).toEqual([]);
	});

	it("ignores a matching entry whose extraArgs is not an array", () => {
		const raw = JSON.stringify({ [EXT]: { extraArgs: "not an array" } });
		expect(resolveSubagentExtras([raw], EXT)).toEqual([]);
	});

	it("treats missing extraArgs as []", () => {
		const raw = JSON.stringify({ [EXT]: {} });
		expect(resolveSubagentExtras([raw], EXT)).toEqual([]);
	});
});

describe("loadSubagentExtraArgs (fs wrapper)", () => {
	it("returns [] when neither global nor project config exists for a nonsense cwd", () => {
		// Use a cwd that definitely doesn't have a .pi/subagent-flags.json under
		// it, and an extension name unlikely to appear in the user's real global
		// config.
		const out = loadSubagentExtraArgs(
			"__pi_subagent_flags_definitely_no_match_xyz_123__",
			"/tmp/__pi_subagent_flags_no_dir_xyz_123__",
		);
		expect(out).toEqual([]);
	});
});
