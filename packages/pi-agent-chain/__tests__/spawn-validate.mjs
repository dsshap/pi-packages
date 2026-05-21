#!/usr/bin/env node
/**
 * Validation: spawn `pi` exactly the way agent-chain.ts does and confirm a
 * bundled agent (scout) produces text output AND a `message_end` event with
 * the usage/cost shape the new tree widget depends on.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const agentsDir = resolve(pkgRoot, "agents");

const raw = readFileSync(join(agentsDir, "scout.md"), "utf-8");
const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) {
	console.error("FAIL: scout.md missing frontmatter");
	process.exit(2);
}
const fm = Object.fromEntries(
	m[1]
		.split("\n")
		.map((l) => l.match(/^([^:]+):\s*(.+)$/))
		.filter(Boolean)
		.map((mm) => [mm[1].trim(), mm[2].trim()]),
);
const agent = {
	name: fm.name,
	tools: fm.tools || "read,grep,find,ls",
	systemPrompt: m[2].trim(),
};

const sessionDir = mkdtempSync(join(tmpdir(), "agent-chain-validate-"));
const sessionFile = join(sessionDir, `chain-${agent.name}.json`);

const args = [
	"--mode", "json",
	"-p",
	"--no-extensions",
	"--tools", agent.tools,
	"--thinking", "off",
	"--system-prompt", agent.systemPrompt,
	"--session", sessionFile,
	"Reply with a single short sentence describing what you are. Do not call any tools.",
];

console.log("→ spawning: pi", args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a)).join(" "));
console.log();

const start = Date.now();
const proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });

let buffer = "";
let stderr = "";
const textChunks = [];
const eventTypes = new Set();
let sawTextDelta = false;
let sawAnyEvent = false;
let capturedUsage = null;
let capturedModel = "";
let capturedSessionId = "";

proc.stdout.setEncoding("utf-8");
proc.stdout.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const ev = JSON.parse(line);
			sawAnyEvent = true;
			eventTypes.add(ev.type);
			if (ev.type === "session" && ev.id) capturedSessionId = ev.id;
			if (ev.type === "message_update") {
				const d = ev.assistantMessageEvent;
				if (d?.type === "text_delta" && d.delta) {
					sawTextDelta = true;
					textChunks.push(d.delta);
				}
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				capturedUsage = ev.message.usage || capturedUsage;
				capturedModel = ev.message.model || capturedModel;
			}
		} catch {}
	}
});

proc.stderr.setEncoding("utf-8");
proc.stderr.on("data", (c) => { stderr += c; });

const timeout = setTimeout(() => {
	console.error("FAIL: timeout after 120s — killing");
	proc.kill("SIGTERM");
}, 120_000);

proc.on("close", (code) => {
	clearTimeout(timeout);
	const elapsed = Date.now() - start;
	const output = textChunks.join("");

	console.log("event types seen:", [...eventTypes].join(", ") || "(none)");
	console.log("text bytes:", output.length);
	console.log("exit code:", code);
	console.log("elapsed:", `${Math.round(elapsed / 1000)}s`);
	console.log("session id:", capturedSessionId || "(none)");
	console.log("assistant model:", capturedModel || "(none)");
	if (capturedUsage) {
		console.log("usage:", JSON.stringify({
			input: capturedUsage.input,
			output: capturedUsage.output,
			cacheRead: capturedUsage.cacheRead,
			cacheWrite: capturedUsage.cacheWrite,
			costTotal: capturedUsage.cost?.total,
		}));
	} else {
		console.log("usage: (none captured)");
	}
	if (stderr.trim()) {
		console.log("--- stderr ---");
		console.log(stderr.trim().slice(0, 600));
	}
	if (output) {
		console.log("--- output ---");
		console.log(output.slice(0, 300));
	}

	const ok =
		code === 0 &&
		sawAnyEvent &&
		sawTextDelta &&
		output.trim().length > 0 &&
		capturedSessionId.length > 0 &&
		capturedUsage !== null &&
		typeof capturedUsage.input === "number" &&
		typeof capturedUsage.cost?.total === "number";

	console.log();
	console.log(ok
		? "PASS ✓ agent produced text + usage event with cost/tokens — widget tracking will work"
		: "FAIL ✗ missing required fields (text/usage/session)");
	process.exit(ok ? 0 : 1);
});

proc.on("error", (err) => {
	clearTimeout(timeout);
	console.error("FAIL: spawn error:", err.message);
	process.exit(1);
});
