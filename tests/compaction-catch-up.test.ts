import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({ runObserver: vi.fn() }));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));

import { HOOK_CATCH_UP_DEADLINE_MS, HOOK_IN_FLIGHT_WAIT_MS, registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import { compactionEntry, observation, observationsRecordedEntry, rawMessage, resetBoundary, type TestEntry } from "./fixtures/session.js";

function userMessage(id: string, text = `user ${id}`): TestEntry {
	return rawMessage(id, text);
}

function assistantMessage(id: string, text = `assistant ${id}`): TestEntry {
	return rawMessage(id, text, {
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" },
	});
}

function toolResultMessage(id: string, text = `tool result ${id}`): TestEntry {
	return rawMessage(id, text, {
		message: { role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", content: [{ type: "text", text }] },
	});
}

function coverage(id: string, coversUpToId: string, observationId: string): TestEntry {
	return observationsRecordedEntry(id, {
		observations: [observation(observationId, { sourceEntryIds: [coversUpToId], tokenCount: 10 })],
		coversUpToId,
	});
}

/** 0 u0  1 a0  2 u1  3 a1  4 t1  5 a2  6 u2  7 om(a0)  8 om(a1); Pi proposes to keep from u2. */
function laggingBranch(t1Text?: string): TestEntry[] {
	return [
		userMessage("u0"),
		assistantMessage("a0"),
		userMessage("u1"),
		assistantMessage("a1"),
		toolResultMessage("t1", t1Text),
		assistantMessage("a2"),
		userMessage("u2"),
		coverage("om-a0", "a0", "aaaaaaaaaaaa"),
		coverage("om-a1", "a1", "bbbbbbbbbbbb"),
	];
}

function setup(args: {
	entries: TestEntry[];
	maxChunks?: number;
	observerChunkMaxTokens?: number;
	/** A background consolidation still running when compaction starts; setup assigns `finish` to settle it. */
	inFlight?: { finish: () => void };
	resolveOk?: boolean;
	signal?: AbortSignal;
	ensureConfigError?: Error;
}) {
	let entries = [...args.entries];
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((_eventName: string, cb: typeof handler) => {
			handler = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				id: `appended-${pi.appendEntry.mock.calls.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			}];
		}),
	};
	const runtime = {
		config: {
			observationsPoolMaxTokens: 20_000,
			compactionCatchUpMaxChunks: args.maxChunks ?? 2,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			agentMaxTurns: 4,
			agentMaxTokens: 8192,
			showWorkerNotifications: true,
			model: "@smol",
		},
		compactHookInFlight: false,
		consolidationInFlight: false,
		consolidationPromise: null as Promise<void> | null,
		resolveModel: vi.fn(async () => (args.resolveOk === false
			? { ok: false, reason: "no model" }
			: { ok: true, model: { provider: "gtr7", id: "memory", contextWindow: 65536 }, apiKey: "key" })),
		ensureConfig: vi.fn(() => {
			if (args.ensureConfigError) throw args.ensureConfigError;
		}),
	};
	if (args.inFlight) {
		const inFlight = args.inFlight;
		runtime.consolidationInFlight = true;
		runtime.consolidationPromise = new Promise<void>((resolve) => {
			inFlight.finish = () => {
				runtime.consolidationInFlight = false;
				runtime.consolidationPromise = null;
				resolve();
			};
		});
	}
	registerCompactionHook(pi as any, runtime as any);
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { contextWindow: 65536 },
		models: { resolve: vi.fn() },
		modelRegistry: {},
		sessionManager: { getBranch: vi.fn(() => entries) },
	};
	const run = (firstKeptEntryId: string) => handler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		willRetry: false,
		signal: args.signal ?? new AbortController().signal,
	}, ctx);
	return { pi, runtime, ctx, run, getEntries: () => entries, setEntries: (next: TestEntry[]) => { entries = next; } };
}

beforeEach(() => {
	mockAgents.runObserver.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("compaction hook synchronous catch-up", () => {
	it("observes the unobserved gap and then cuts at Pi's proposed boundary", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["t1", "a2"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		const { run, pi, runtime, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["t1", "a2"],
			maxOutputTokens: 8192,
			thinkingLevel: "low",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [gapObs], coversUpToId: "a2" });
		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
			"cccccccccccc",
		]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observing 2 unobserved source entries (~37 tokens) before compacting",
			"info",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("keeping them in context"), "info");
	});

	it("falls back to retaining the tail when the observer records nothing", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([]);
		const { run, pi } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("delegates to native compaction and warns when the observer fails", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("Connection error."));
		const { run, pi, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Connection error."), "warning");
	});

	it("covers one chunk when the chunk cap stops it, then retains the rest", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["t1"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		// t1 alone exceeds the minimum chunk budget, so each chunk carries one entry.
		const { run, pi } = setup({ entries: laggingBranch("x".repeat(4000)), maxChunks: 1, observerChunkMaxTokens: 256 });

		const result = await run("u2") as any;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "t1" }));
		// a2 is still unobserved: the cut lands on it and it stays in context.
		expect(result.compaction.firstKeptEntryId).toBe("a2");
	});

	it("treats entries the serializer skips as covered once the marker passes them", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["a2"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		// An assistant message with no content renders nothing and is never part
		// of a chunk; it must not count as a leftover after coverage passes it.
		const entries = laggingBranch();
		entries.splice(5, 0, rawMessage("empty", "", { message: { role: "assistant", content: [], stopReason: "aborted" } }));
		const { run } = setup({ entries, maxChunks: 1 });

		const result = await run("u2") as any;

		expect(result.compaction.firstKeptEntryId).toBe("u2");
	});

	it("does nothing when disabled", async () => {
		const { run, runtime } = setup({ entries: laggingBranch(), maxChunks: 0 });

		const result = await run("u2") as any;

		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("waits for an in-flight consolidation whose observations cover the gap, then cuts at Pi's boundary", async () => {
		const inFlight = { finish: () => {} };
		const { run, getEntries, setEntries } = setup({ entries: laggingBranch(), inFlight });

		const pending = run("u2");
		await Promise.resolve();
		setEntries([...getEntries(), coverage("om-a2", "a2", "cccccccccccc")]);
		inFlight.finish();
		const result = await pending as any;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(result.compaction.summary).not.toContain("model-free");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toContain("cccccccccccc");
	});

	it("catches up the gap an in-flight consolidation left unobserved once it finishes", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["t1", "a2"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		const inFlight = { finish: () => {} };
		const { run } = setup({ entries: laggingBranch(), inFlight });

		const pending = run("u2");
		await Promise.resolve();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		inFlight.finish();
		const result = await pending as any;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(result.compaction.firstKeptEntryId).toBe("u2");
	});

	it("retains the tail without catch-up when the in-flight consolidation outlasts the wait", async () => {
		vi.useFakeTimers();
		const { run, runtime } = setup({ entries: laggingBranch(), inFlight: { finish: () => {} } });

		const pending = run("u2");
		await vi.advanceTimersByTimeAsync(HOOK_IN_FLIGHT_WAIT_MS);
		const result = await pending as any;

		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("runs catch-up without a coverage marker, observing from the start of the branch", async () => {
		const entries = [userMessage("u0"), assistantMessage("a0"), userMessage("u1")];
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["u0", "a0"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		const { run, pi, runtime } = setup({ entries });

		const result = await run("u1") as any;

		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver.mock.calls[0][0].allowedSourceEntryIds).toEqual(["u0", "a0"]);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [gapObs], coversUpToId: "a0" });
		expect(result.compaction.firstKeptEntryId).toBe("u1");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["cccccccccccc"]);
	});

	it("delegates to native compaction when the ledger is empty and the model is unresolved", async () => {
		const entries = [userMessage("u0", "plan the migration"), assistantMessage("a0"), userMessage("u1")];
		const { run, ctx } = setup({ entries, resolveOk: false });

		const result = await run("u1") as any;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no model"), "warning");
	});

	it("falls back when the memory model is unavailable", async () => {
		const { run, pi } = setup({ entries: laggingBranch(), resolveOk: false });

		const result = await run("u2") as any;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});

describe("catch-up coverage truthfulness (PR #81 review, issue 2)", () => {
	it("starts at the global observation frontier, so unread source before the retained range is read", async () => {
		// Coverage stops at a0 (A). A previous compaction retained raw text from
		// u2 (C). u1/a1 (B) are unread and outside the retained range. The new
		// gap is u2..a2 (C, D). A marker through a2 must not claim B unread.
		const entries = [
			userMessage("u0"),
			assistantMessage("a0"),
			coverage("om-a0", "a0", "aaaaaaaaaaaa"),
			userMessage("u1"),
			assistantMessage("a1"),
			userMessage("u2"),
			assistantMessage("a2"),
			compactionEntry("cmp-0", { firstKeptEntryId: "u2" }),
			userMessage("u3"),
			assistantMessage("a3"),
			userMessage("u4"),
		];
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["u1", "a3"] })]);
		const { run } = setup({ entries });

		await run("u4");

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		const allowed = mockAgents.runObserver.mock.calls[0][0].allowedSourceEntryIds;
		expect(allowed[0]).toBe("u1");
		expect(allowed).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
	});
});

describe("catch-up and reset_boundary", () => {
	it("catch-up starts after the reset boundary", async () => {
		const entries = [
			userMessage("u0"),
			assistantMessage("a0"),
			resetBoundary("rb-1"),
			userMessage("u1"),
			assistantMessage("a1"),
			userMessage("u2"),
		];
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["u1", "a1"] })]);
		const { run, pi } = setup({ entries });

		const result = await run("u2") as any;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver.mock.calls[0][0].allowedSourceEntryIds).toEqual(["u1", "a1"]);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "a1" }));
		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["cccccccccccc"]);
	});

	it("does not catch up on source that exists only before the boundary", async () => {
		const entries = [userMessage("u0"), assistantMessage("a0"), resetBoundary("rb-1"), userMessage("u1")];
		const { run } = setup({ entries });

		const result = await run("u1") as any;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("u1");
	});
});

describe("compaction hook deadline and failure handling", () => {
	const warningsOf = (ctx: { ui: { notify: ReturnType<typeof vi.fn> } }): string[] =>
		ctx.ui.notify.mock.calls.filter(([, level]) => level === "warning").map(([message]) => message as string);

	it("catch-up that never resolves is cut at HOOK_CATCH_UP_DEADLINE_MS", async () => {
		vi.useFakeTimers();
		let observerSignal: AbortSignal | undefined;
		mockAgents.runObserver.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
			observerSignal = signal;
			return new Promise(() => {});
		});
		const { run, ctx, pi } = setup({ entries: laggingBranch() });
		let settled = false;
		const pending = run("u2").then((value) => {
			settled = true;
			return value;
		});

		await vi.advanceTimersByTimeAsync(HOOK_CATCH_UP_DEADLINE_MS - 1);
		expect(settled).toBe(false);
		expect(observerSignal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const result = await pending as any;

		expect(result).toBeUndefined();
		expect(observerSignal?.aborted).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(warningsOf(ctx).some((message) => message.includes("deadline"))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not record observations that arrive after the deadline", async () => {
		vi.useFakeTimers();
		let release: (value: unknown) => void = () => {};
		mockAgents.runObserver.mockImplementation(() => new Promise((resolve) => {
			release = resolve;
		}));
		const { run, pi } = setup({ entries: laggingBranch() });
		const pending = run("u2");

		await vi.advanceTimersByTimeAsync(HOOK_CATCH_UP_DEADLINE_MS);
		await pending;
		release([observation("cccccccccccc", { sourceEntryIds: ["t1", "a2"] })]);
		await vi.advanceTimersByTimeAsync(0);

		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps the observations recorded before the deadline", async () => {
		vi.useFakeTimers();
		const firstObs = observation("cccccccccccc", { sourceEntryIds: ["t1"], tokenCount: 12 });
		mockAgents.runObserver
			.mockResolvedValueOnce([firstObs])
			.mockImplementationOnce(() => new Promise(() => {}));
		const { run, pi } = setup({ entries: laggingBranch("x".repeat(4000)), observerChunkMaxTokens: 256 });
		const pending = run("u2");

		await vi.advanceTimersByTimeAsync(HOOK_CATCH_UP_DEADLINE_MS);
		const result = await pending as any;

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "t1" }));
	});

	it("abort signal during catch-up returns { cancel: true } and does not throw", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		mockAgents.runObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		const { run, pi } = setup({ entries: laggingBranch(), signal: controller.signal });
		const pending = run("u2");
		await vi.advanceTimersByTimeAsync(0);

		controller.abort();

		await expect(pending).resolves.toEqual({ cancel: true });
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels when the signal aborts while an observer that ignores abort is still pending", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		mockAgents.runObserver.mockImplementation(() => new Promise(() => {}));
		const { run } = setup({ entries: laggingBranch(), signal: controller.signal });
		const pending = run("u2");
		await vi.advanceTimersByTimeAsync(0);

		controller.abort();

		await expect(pending).resolves.toEqual({ cancel: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels without running catch-up when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { run, runtime } = setup({ entries: laggingBranch(), signal: controller.signal });

		await expect(run("u2")).resolves.toEqual({ cancel: true });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("clears the deadline timer on the normal path", async () => {
		vi.useFakeTimers();
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["t1", "a2"] })]);
		const { run } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("delegates and warns when model resolution throws", async () => {
		const { run, runtime, ctx } = setup({ entries: laggingBranch() });
		runtime.resolveModel.mockRejectedValueOnce(new Error("registry exploded"));

		const result = await run("u2") as any;

		expect(result).toBeUndefined();
		expect(warningsOf(ctx).some((message) => message.includes("registry exploded"))).toBe(true);
	});

	it("delegates and warns when the hook body throws", async () => {
		const { run, ctx, runtime } = setup({ entries: laggingBranch(), ensureConfigError: new Error("config on fire") });

		const result = await run("u2") as any;

		expect(result).toBeUndefined();
		expect(warningsOf(ctx).some((message) => message.includes("config on fire"))).toBe(true);
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("does not throw when the UI itself fails while warning", async () => {
		const { run, ctx } = setup({ entries: laggingBranch(), resolveOk: false });
		ctx.ui.notify.mockImplementation(() => {
			throw new Error("ui gone");
		});

		const result = await run("u2") as any;

		expect(result).toBeUndefined();
	});
});
