import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type * as ObserverModule from "../src/agents/observer/agent.js";
import type { OmpExtensionContext } from "../src/runtime.js";

const workers = vi.hoisted(() => ({ observe: vi.fn(), reflect: vi.fn(), drop: vi.fn() }));
vi.mock("../src/agents/observer/agent.js", async (original) => ({
	...(await original<typeof ObserverModule>()), runObserver: workers.observe,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: workers.reflect }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: workers.drop }));

import { Runtime } from "../src/runtime.js";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

function setup(entries: TestEntry[] = [rawMessage("raw-1", "Remember the deployment decision: use region eu-west-1.")]) {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...runtime.config, model: "magpie/codex/gpt-6-luna:medium", observeAfterTokens: 1, reflectAfterTokens: 99999, showWorkerNotifications: false };
	const ctx = {
		cwd: "/tmp/omp-om-test", hasUI: true, ui: { notify: vi.fn() },
		models: { resolve: vi.fn<() => unknown>(() => ({ provider: "magpie", id: "codex/gpt-6-luna", contextWindow: 65536 })) },
		modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })) },
		sessionManager: { getBranch: () => entries, getSessionId: () => "failure-test" },
	};
	let compact!: (event: SessionBeforeCompactEvent, ctx: OmpExtensionContext) => Promise<unknown>;
	const pi = {
		on: (_name: string, handler: typeof compact) => { compact = handler; },
		appendEntry: vi.fn(),
	};
	// Host interfaces include unrelated methods; this fixture supplies the exercised surface.
	const extension = pi as unknown as ExtensionAPI;
	const context = ctx as unknown as OmpExtensionContext;
	registerCompactionHook(extension, runtime);
	return {
		runtime, ctx, pi,
		consolidate: () => runtime.launchConsolidationTask(ctx, () => runConsolidationPipeline(extension, runtime, ctx)),
		compact: () => {
			// The hook only reads these preparation fields in this fixture.
			const event = { preparation: { firstKeptEntryId: "raw-1", tokensBefore: 1000 }, branchEntries: entries } as unknown as SessionBeforeCompactEvent;
			return compact(event, context);
		},
	};
}

beforeEach(() => {
	workers.observe.mockReset().mockResolvedValue([]);
	workers.reflect.mockReset().mockResolvedValue(undefined);
	workers.drop.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe("memory failure leaves native omp running", () => {
	it("checks model availability with complete coverage and catch-up disabled", async () => {
		const app = setup();
		app.runtime.config.compactionCatchUpMaxChunks = 0;
		app.ctx.models.resolve.mockReturnValue(undefined);
		await expect(app.compact()).resolves.toBeUndefined();
		expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("normal compaction"), "warning");
		expect(workers.observe).not.toHaveBeenCalled();
	});

	it("bounds a hanging auth lookup and does not start a late worker", async () => {
		vi.useFakeTimers();
		const app = setup();
		const auth = Promise.withResolvers<{ ok: boolean; apiKey: string }>();
		app.ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValue(auth.promise);
		const pending = app.compact();
		await vi.advanceTimersByTimeAsync(20000);
		await expect(pending).resolves.toBeUndefined();
		auth.resolve({ ok: true, apiKey: "test" });
		await vi.advanceTimersByTimeAsync(0);
		expect(workers.observe).not.toHaveBeenCalled();
		expect(app.pi.appendEntry).not.toHaveBeenCalled();
		expect(app.runtime.compactHookInFlight).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("honors a background failure while compaction authenticates", async () => {
		const app = setup();
		const auth = Promise.withResolvers<{ ok: boolean; apiKey: string }>();
		app.ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValue(auth.promise);
		const pending = app.compact();
		app.runtime.recordConsolidationStageError(app.ctx, "reflector", "provider unavailable");
		auth.resolve({ ok: true, apiKey: "test" });
		await expect(pending).resolves.toBeUndefined();
		expect(workers.observe).not.toHaveBeenCalled();
	});
	it("keeps an observer outage across launch and resolution, then recovers after a successful request", async () => {
		const app = setup();
		workers.observe.mockRejectedValueOnce(new Error("connection refused"));
		await app.consolidate();
		expect(app.runtime.memoryFailureReason).toContain("connection refused");
		expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("normal compaction"), "warning");
		expect(app.pi.appendEntry).not.toHaveBeenCalled();
		await expect(app.compact()).resolves.toBeUndefined();
		await app.runtime.resolveModel(app.ctx);
		await app.runtime.launchConsolidationTask(app.ctx, async () => {});
		expect(app.runtime.memoryFailureReason).toContain("connection refused");
		await app.consolidate();
		expect(app.runtime.memoryFailureReason).toBeUndefined();
		await expect(app.compact()).resolves.toMatchObject({ compaction: { firstKeptEntryId: "raw-1" } });
	});

	it("warns and skips the pass when the memory model cannot resolve", async () => {
		const app = setup();
		app.ctx.models.resolve.mockReturnValue(undefined);
		await expect(app.consolidate()).resolves.toBeUndefined();
		expect(app.runtime.memoryFailureReason).toContain("did not resolve");
		expect(workers.observe).not.toHaveBeenCalled();
		expect(workers.reflect).not.toHaveBeenCalled();
		expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("normal compaction"), "warning");
		await expect(app.compact()).resolves.toBeUndefined();
	});

	it("hands compaction back to omp after a reflector failure despite complete observation coverage", async () => {
		const entries = [rawMessage("raw-1", "deployment region"), observationsRecordedEntry("obs", {
			coversUpToId: "raw-1", observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 })],
		})];
		const app = setup(entries);
		app.runtime.config.reflectAfterTokens = 1;
		workers.reflect.mockRejectedValueOnce(new Error("provider unavailable"));
		await app.consolidate();
		expect(app.runtime.lastReflectorError).toBe("provider unavailable");
		await expect(app.compact()).resolves.toBeUndefined();
		expect(app.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let a broken UI reject background work or native fallback", async () => {
		const app = setup();
		app.ctx.ui.notify.mockImplementation(() => { throw new Error("UI gone"); });
		workers.observe.mockRejectedValueOnce(new Error("connection refused"));
		await expect(app.consolidate()).resolves.toBeUndefined();
		expect(app.runtime.memoryFailureReason).toContain("connection refused");
		await expect(app.compact()).resolves.toBeUndefined();
		expect(app.runtime.consolidationInFlight).toBe(false);
	});
});
