/**
 * Unit tests for the private `superviseChild` helper.
 *
 * The supervisor abstracts SIGTERM → grace → SIGKILL across multiple
 * termination sources (AbortSignal, session_shutdown). These tests exercise
 * the contract against a fake child process (no real spawn) so we can
 * deterministically inspect kill ordering, idempotency, and listener
 * cleanup.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _supervisorInternals } from "../extensions/index.js";

const { superviseChild } = _supervisorInternals;

// Minimal ChildProcess stand-in: EventEmitter with a `kill` method we can spy
// on. The real ChildProcess type expects a lot more surface area; the
// supervisor only touches `kill`, `on("close")`, `on("error")`, `off(...)`.
interface FakeChild extends EventEmitter {
	kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.kill = vi.fn();
	return child;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("superviseChild", () => {
	describe("natural exit", () => {
		it("resolves waitForExit with cause='normal' and the raw exit code", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			proc.emit("close", 0);
			const exit = await sup.waitForExit();

			expect(exit.cause).toBe("normal");
			expect(exit.exitCode).toBe(0);
			expect(proc.kill).not.toHaveBeenCalled();
		});

		it("maps null exit code to 1 (treats as failure)", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			proc.emit("close", null);
			const exit = await sup.waitForExit();

			expect(exit.exitCode).toBe(1);
		});
	});

	describe("AbortSignal wiring", () => {
		it("terminates the child when the signal aborts mid-run", async () => {
			const proc = makeFakeChild();
			const controller = new AbortController();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000, signal: controller.signal });

			controller.abort();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(proc.kill).toHaveBeenCalledTimes(1);

			// Child eventually exits (post-SIGTERM)
			proc.emit("close", 130);
			const exit = await sup.waitForExit();

			expect(exit.cause).toBe("user");
			expect(exit.exitCode).toBe(130);
		});

		it("terminates immediately when the signal is already aborted at supervise time", () => {
			const proc = makeFakeChild();
			const controller = new AbortController();
			controller.abort();

			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			superviseChild(proc as any, { gracePeriodMs: 2000, signal: controller.signal });

			// SIGTERM fired synchronously on supervise()
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("does nothing when signal is undefined", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000, signal: undefined });

			proc.emit("close", 0);
			const exit = await sup.waitForExit();

			expect(proc.kill).not.toHaveBeenCalled();
			expect(exit.cause).toBe("normal");
		});
	});

	describe("terminate('shutdown')", () => {
		it("SIGTERMs the child and records cause='shutdown'", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			sup.terminate("shutdown");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

			proc.emit("close", 143);
			const exit = await sup.waitForExit();
			expect(exit.cause).toBe("shutdown");
		});

		it("does NOT SIGKILL if child exits within grace period", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 500 });

			sup.terminate("shutdown");
			expect(proc.kill).toHaveBeenCalledTimes(1);
			expect(proc.kill).toHaveBeenLastCalledWith("SIGTERM");

			// Child exits BEFORE grace expires
			proc.emit("close", 0);
			await sup.waitForExit();

			// Advance time past where SIGKILL would have fired — should NOT fire
			vi.advanceTimersByTime(2000);
			expect(proc.kill).toHaveBeenCalledTimes(1);
		});

		it("SIGKILLs if child is still alive past the grace period", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 500 });

			sup.terminate("shutdown");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(proc.kill).toHaveBeenCalledTimes(1);

			// Advance past the grace period — SIGKILL fires
			vi.advanceTimersByTime(500);
			expect(proc.kill).toHaveBeenCalledTimes(2);
			expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");

			// Now child finally exits
			proc.emit("close", 137);
			const exit = await sup.waitForExit();
			expect(exit.cause).toBe("shutdown");
			expect(exit.exitCode).toBe(137);
		});
	});

	describe("idempotency", () => {
		it("double-terminate fires SIGTERM only once", () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			sup.terminate("user");
			sup.terminate("user");
			sup.terminate("shutdown");

			expect(proc.kill).toHaveBeenCalledTimes(1);
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("first cause wins (terminate after abort doesn't overwrite)", async () => {
			const proc = makeFakeChild();
			const controller = new AbortController();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000, signal: controller.signal });

			controller.abort(); // cause="user"
			sup.terminate("shutdown"); // ignored

			proc.emit("close", 130);
			const exit = await sup.waitForExit();
			expect(exit.cause).toBe("user");
		});

		it("waitForExit returns the same reason on every call", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			proc.emit("close", 0);
			const a = await sup.waitForExit();
			const b = await sup.waitForExit();
			expect(a).toBe(b);
		});

		it("dispose() is safe to call multiple times", () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			sup.dispose();
			expect(() => sup.dispose()).not.toThrow();
			expect(() => sup.dispose()).not.toThrow();
		});
	});

	describe("spawn error", () => {
		it("emit('error') resolves waitForExit with cause='spawn_error' and the message", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });

			proc.emit("error", new Error("ENOENT: pi not found"));
			const exit = await sup.waitForExit();

			expect(exit.cause).toBe("spawn_error");
			expect(exit.message).toBe("ENOENT: pi not found");
			expect(exit.exitCode).toBe(1);
		});
	});

	describe("listener cleanup", () => {
		it("removes the AbortSignal listener after exit", async () => {
			const proc = makeFakeChild();
			const controller = new AbortController();
			const addSpy = vi.spyOn(controller.signal, "addEventListener");
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000, signal: controller.signal });
			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });

			proc.emit("close", 0);
			await sup.waitForExit();

			expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
		});

		it("removes proc 'close' and 'error' listeners after exit", async () => {
			const proc = makeFakeChild();
			expect(proc.listenerCount("close")).toBe(0);
			expect(proc.listenerCount("error")).toBe(0);

			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 2000 });
			expect(proc.listenerCount("close")).toBe(1);
			expect(proc.listenerCount("error")).toBe(1);

			proc.emit("close", 0);
			await sup.waitForExit();
			sup.dispose();

			expect(proc.listenerCount("close")).toBe(0);
			expect(proc.listenerCount("error")).toBe(0);
		});

		it("clears the SIGKILL timer when child exits early", async () => {
			const proc = makeFakeChild();
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake for tests
			const sup = superviseChild(proc as any, { gracePeriodMs: 5000 });

			sup.terminate("user");
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			proc.emit("close", 0);
			await sup.waitForExit();

			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
