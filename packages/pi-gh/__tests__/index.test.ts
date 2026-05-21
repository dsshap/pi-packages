import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piGh, { classifyGhAuthOutput, formatGhStatusMessage, type GhStatus } from "../extensions/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const extEntry = resolve(pkgRoot, "extensions", "index.ts");
const pkgJson = resolve(pkgRoot, "package.json");

// ── Package layout ────────────────────────────────────────────────────────

describe("@dsshap/pi-gh package layout", () => {
	it("has the extension entry point", () => {
		expect(existsSync(extEntry)).toBe(true);
	});

	it("declares the entry in package.json's pi.extensions and has correct name", () => {
		const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
			name?: string;
			pi?: { extensions?: string[] };
			files?: string[];
		};
		expect(pkg.name).toBe("@dsshap/pi-gh");
		expect(pkg.pi?.extensions).toEqual(["./extensions/index.ts"]);
		expect(pkg.files).toContain("prompts/");
	});

	it("ships both prompt files", () => {
		expect(existsSync(resolve(pkgRoot, "prompts", "pr.md"))).toBe(true);
		expect(existsSync(resolve(pkgRoot, "prompts", "triage-pr-feedback.md"))).toBe(true);
	});
});

// ── Extension registration ────────────────────────────────────────────────

describe("piGh extension registration", () => {
	it("registers the /gh command with a description and handler", () => {
		const registerCommand = vi.fn();
		const mockPi = {
			registerCommand,
			registerTool: vi.fn(),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			on: vi.fn(),
			getFlag: vi.fn(),
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			setSessionName: vi.fn(),
			getSessionName: vi.fn(),
			setLabel: vi.fn(),
			exec: vi.fn(),
			getActiveTools: vi.fn(),
			getAllTools: vi.fn(() => []),
			setActiveTools: vi.fn(),
			getCommands: vi.fn(() => []),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
			events: {} as ExtensionAPI["events"],
		} as unknown as ExtensionAPI;

		piGh(mockPi);

		expect(registerCommand).toHaveBeenCalledOnce();
		const [name, opts] = registerCommand.mock.calls[0] as [string, { description: string; handler: unknown }];
		expect(name).toBe("gh");
		expect(typeof opts.description).toBe("string");
		expect(opts.description.length).toBeGreaterThan(0);
		expect(typeof opts.handler).toBe("function");
	});
});

// ── classifyGhAuthOutput ──────────────────────────────────────────────────

describe("classifyGhAuthOutput", () => {
	it("returns missing when error.code is ENOENT", () => {
		const error = Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException;
		expect(classifyGhAuthOutput({ error, stdout: "", stderr: "" })).toEqual({ kind: "missing" });
	});

	it("returns unauthenticated when stderr mentions 'not logged into'", () => {
		const error = Object.assign(new Error("exit 1"), { code: "1" }) as NodeJS.ErrnoException;
		const stderr = "You are not logged into any GitHub hosts. Run `gh auth login` to authenticate.";
		const result = classifyGhAuthOutput({ error, stdout: "", stderr });
		expect(result.kind).toBe("unauthenticated");
		expect((result as Extract<GhStatus, { kind: "unauthenticated" }>).detail).toBe(stderr.trim());
	});

	it("returns authenticated when there is no error", () => {
		const stderr = "github.com\n  ✓ Logged in to github.com as dsshap";
		const result = classifyGhAuthOutput({ error: null, stdout: "", stderr });
		expect(result.kind).toBe("authenticated");
		expect((result as Extract<GhStatus, { kind: "authenticated" }>).detail).toBe(stderr.trim());
	});

	it("returns error for non-ENOENT failures without 'not logged' text (e.g. timeout)", () => {
		const error = Object.assign(new Error("Process timed out"), { killed: true, code: undefined }) as NodeJS.ErrnoException;
		const result = classifyGhAuthOutput({ error, stdout: "", stderr: "" });
		expect(result.kind).toBe("error");
	});
});

// ── formatGhStatusMessage ─────────────────────────────────────────────────

describe("formatGhStatusMessage", () => {
	it("always includes both prompt names in the output", () => {
		const statuses: GhStatus[] = [
			{ kind: "missing" },
			{ kind: "unauthenticated", detail: "not logged in" },
			{ kind: "authenticated", detail: "Logged in as dsshap" },
			{ kind: "error", detail: "something went wrong" },
		];
		for (const status of statuses) {
			const msg = formatGhStatusMessage(status);
			expect(msg).toContain("/pr");
			expect(msg).toContain("/triage-pr-feedback");
		}
	});
});
