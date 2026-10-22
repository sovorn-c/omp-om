import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	rawMessage,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; runtime?: Partial<any>; model?: unknown; contextUsage?: unknown }) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:status");
			handler = command.handler;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observeAfterTokens: 10,
			reflectAfterTokens: 20,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
			passive: false,
		},
		observerInFlight: false,
		maintenanceInFlight: false,
		maintenancePhase: undefined,
		compactHookInFlight: false,
		configWarnings: [],
		lastObserverError: undefined,
		lastReflectorError: undefined,
		lastDropperError: undefined,
		...args.runtime,
	};
	registerStatusCommand(pi as any, runtime as any);
	if (!handler) throw new Error("status handler not registered");
	const notify = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: { getBranch: () => args.entries },
		model: args.model,
		getContextUsage: () => args.contextUsage,
	};
	const run = async () => {
		await handler!(undefined, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
	return { run, notify };
}

describe("V3 /om:status", () => {
	it("renders concise no-memory status without V2 committed/pending language", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).toContain("── Memory ──");
		expect(output).toContain("Observations: 0 recorded / 0 dropped / 0 active / 0 visible");
		expect(output).toContain("Reflections:  0 recorded / 0 visible");
		expect(output).toContain("Next observation:");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
	});

	it("reports V3 ledger counts, visible/full drift, and ignores old V2 memory", async () => {
		const obsA = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obsB = observation("bbbbbbbbbbbb", { tokenCount: 7 });
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			compactionEntry("cmp-visible", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA], reflections: [] }) }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Observations: 2 recorded / 1 dropped / 1 active / 1 visible +1 -1");
		expect(output).toContain("Reflections:  1 recorded / 0 visible +1");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		// Active pool counts the full rendered line (id + timestamp + relevance + content).
		expect(output).toContain("Active observation pool: ~19 / 20 target tokens (95%)");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("full truth");
		expect(output).not.toContain("v2-obs");
		expect(output).not.toContain("observational-memory");
	});

	it("shows separate progress clocks, visible pool, active observation pool, and reflection pool", async () => {
		const obs = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp", { firstKeptEntryId: "raw-2", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Next observation:");
		expect(output).toContain("/ 10 tokens");
		expect(output).toContain("Next reflection:");
		expect(output).toContain("/ 20 observed tokens");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		// Active pool counts the full rendered line, unlike the visible pool's stored tokenCount.
		expect(output).toContain("Active observation pool: ~19 / 20 target tokens (95%)");
		expect(output).toContain("Reflection pool:         ~3 tokens");
		expect(output).not.toContain("Observation pool:");
		expect(output).not.toContain("Full fold pool:");
		expect(output).not.toContain("visible observation tokens");
	});

	it("shows raw source backlog and ignores provider context", async () => {
		const entries = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 60072 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-cov", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		];

		const output = await setup({
			entries,
			contextUsage: { tokens: 135636, contextWindow: 200000 },
		}).run();

		expect(output).toContain("Observer backlog: ~0 unobserved source tokens since the compaction boundary");
	});

	it("reports the unobserved backlog since the compaction boundary", async () => {
		const entries = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-cov", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbbbbbbbbbb"),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Observer backlog: ~4 unobserved source tokens since the compaction boundary");
	});

	it("shows over-target active observation pool in the Activity section", async () => {
		// Pad content so the rendered line is exactly 25 tokens (100 chars).
		const obs = observation("aaaaaaaaaaaa", { content: "x".repeat(51) });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Active observation pool: ~25 / 20 target tokens (125%)");
	});

	it("shows passive mode, maintenance in flight, compaction hook in flight, and stage-specific last errors", async () => {
		const output = await setup({
			entries: [],
			runtime: {
				config: { observeAfterTokens: 10, reflectAfterTokens: 20, observationsPoolMaxTokens: 40, observationsPoolTargetTokens: 20, passive: true },
				observerInFlight: false,
				maintenanceInFlight: true,
				maintenancePhase: "reflector",
				compactHookInFlight: true,
				lastObserverError: "observer failed",
				lastReflectorError: "reflect failed",
				lastDropperError: "drop failed",
			},
		}).run();

		expect(output).toContain("Passive: automatic memory workers disabled");
		expect(output).toContain("Maintenance: running (reflector)");
		expect(output).not.toContain("Observer: running");
		expect(output).not.toContain("Reflect/drop: running");
		expect(output).toContain("Compaction hook: running");
		expect(output).not.toContain("Auto-compaction");
		expect(output).toContain("Observer: observer failed");
		expect(output).toContain("Reflector: reflect failed");
		expect(output).toContain("Dropper: drop failed");
	});

	it("shows observer and maintenance lanes in flight separately", async () => {
		const output = await setup({ entries: [], runtime: { observerInFlight: true, maintenanceInFlight: true, maintenancePhase: "dropper" } }).run();

		expect(output).toContain("Observer: running");
		expect(output).toContain("Maintenance: running (dropper)");
	});

	it("shows maintenance in flight without phase when phase is unavailable", async () => {
		const output = await setup({ entries: [], runtime: { maintenanceInFlight: true } }).run();

		expect(output).toContain("Maintenance: running");
		expect(output).not.toContain("Maintenance: running (");
	});

	it("lists config warnings and omits the section when there are none", async () => {
		const withWarnings = await setup({
			entries: [],
			runtime: { configWarnings: ['omp-om.yml: "fallbackModel" is no longer supported and was ignored'] },
		}).run();
		const without = await setup({ entries: [] }).run();

		expect(withWarnings).toContain("── Config warnings ──");
		expect(withWarnings).toContain('"fallbackModel" is no longer supported');
		expect(without).not.toContain("Config warnings");
	});
});
