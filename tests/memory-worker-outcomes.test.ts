import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { EventStream } from "@earendil-works/pi-ai";
import type * as LoopModule from "../src/agents/agent-loop.js";
import type { WorkerAgentLoop } from "../src/agents/agent-loop.js";
import type { OmpExtensionContext } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

const loop = vi.hoisted(() => vi.fn<WorkerAgentLoop>());
vi.mock("../src/agents/agent-loop.js", async (original) => ({
	...(await original<typeof LoopModule>()), agentLoop: loop,
}));

import { Runtime } from "../src/runtime.js";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";

const partialFailure: WorkerAgentLoop = (_prompts, context) => ({
	async *[Symbol.asyncIterator]() {
		await context.tools[0].execute("partial", {
			observations: [{ timestamp: "2026-10-21 10:00", content: "Deployment uses eu-west-1", relevance: "high", sourceEntryIds: ["raw-1"] }],
		});
		yield { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider disconnected after tool output" } };
	},
	result: async () => [],
}) as unknown as EventStream<AgentEvent, AgentMessage[]>;

function setup(entries: TestEntry[] = [rawMessage("raw-1", "Deploy to eu-west-1"), rawMessage("raw-2", "Use Postgres 17")]) {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...runtime.config, observeAfterTokens: 1, reflectAfterTokens: 99999, showWorkerNotifications: false };
	const ctx = {
		cwd: "/tmp/omp-om-worker-test", hasUI: true, ui: { notify: vi.fn() },
		models: { resolve: () => ({ provider: "magpie", id: "codex/gpt-6-luna", contextWindow: 65536 }) },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
		sessionManager: { getBranch: () => entries, getSessionId: () => "worker-outcome-test" },
	};
	let compact!: (event: SessionBeforeCompactEvent, ctx: OmpExtensionContext) => Promise<unknown>;
	const pi = { on: (_name: string, handler: typeof compact) => { compact = handler; }, appendEntry: vi.fn() };
	const extension = pi as unknown as ExtensionAPI;
	registerCompactionHook(extension, runtime);
	return {
		runtime, ctx, pi,
		consolidate: () => runtime.launchConsolidationTask(ctx, () => runConsolidationPipeline(extension, runtime, ctx)),
		compact: () => compact({ preparation: { firstKeptEntryId: "raw-2", tokensBefore: 1000 }, branchEntries: entries } as unknown as SessionBeforeCompactEvent, ctx as unknown as OmpExtensionContext),
	};
}

beforeEach(() => loop.mockReset().mockImplementation(partialFailure));

describe("real background worker outcomes", () => {
	it("keeps an outage when bounded reflector input skips the request", async () => {
		const app = setup([
			rawMessage("raw-1", "Deploy to eu-west-1"),
			observationsRecordedEntry("obs", { coversUpToId: "raw-1", observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })] }),
		]);
		app.runtime.config.reflectAfterTokens = 1;
		app.runtime.config.workerMemoryMaxTokens = 1;
		app.runtime.memoryFailureReason = "earlier provider failure";
		await app.consolidate();
		expect(app.runtime.memoryFailureReason).toBe("earlier provider failure");
		await expect(app.compact()).resolves.toBeUndefined();
		expect(loop).not.toHaveBeenCalled();
	});

	it("stops background consolidation without coverage after tool output followed by provider failure", async () => {
		const app = setup();
		await app.consolidate();
		expect(app.runtime.memoryFailureReason).toContain("provider disconnected after tool output");
		expect(app.pi.appendEntry).not.toHaveBeenCalled();
		expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Memory updates stopped"), "warning");
		await expect(app.compact()).resolves.toBeUndefined();
	});

});
