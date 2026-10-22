import { describe, expect, it } from "vitest";

import {
	compactionRangeStartIndex,
	observedTokensSinceLastCompaction,
	observedTokensSinceReflectionCoverage,
	rawTokensSinceLastCompaction,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

function coverage(id: string, coversUpToId: string) {
	return observationsRecordedEntry(id, { observations: [observation("aaaaaaaaaaaa")], coversUpToId });
}

describe("compaction range start", () => {
	it("starts at the branch root before any compaction", () => {
		expect(compactionRangeStartIndex([textCustomMessage("raw-1", "aaaa")])).toBe(0);
	});

	it("starts at the latest compaction's first kept entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "aaaa"),
		];

		expect(compactionRangeStartIndex(entries)).toBe(2);
		expect(rawTokensSinceLastCompaction(entries)).toBe(2);
	});

	it("starts after the compaction entry when its first kept id is missing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "gone" }),
			textCustomMessage("raw-2", "aaaa"),
		];

		expect(compactionRangeStartIndex(entries)).toBe(2);
		expect(rawTokensSinceLastCompaction(entries)).toBe(1);
	});
});

describe("observed tokens since the latest compaction", () => {
	it("is zero without observation coverage", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaaaaaa")];

		expect(observedTokensSinceLastCompaction(entries)).toBe(0);
	});

	it("counts only source tokens through the observation frontier", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"), // 3
			textCustomMessage("raw-2", "aaaaaaaa"), // 2
			coverage("om-1", "raw-1"),
			textCustomMessage("raw-3", "aaaa"), // 1
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-3" }),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(3);
		expect(rawTokensSinceLastCompaction(entries)).toBe(6);
	});

	it("ignores coverage that precedes the compaction boundary", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			coverage("om-1", "raw-1"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaaaaaa"),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(0);
	});

	it("counts from the compaction boundary once coverage passes it", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaaaaaa"), // 2
			textCustomMessage("raw-3", "aaaa"), // 1
			coverage("om-1", "raw-3"),
			textCustomMessage("raw-4", "aaaaaaaaaaaa"),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(3);
	});
});

describe("observed tokens since reflection coverage", () => {
	function reflections(id: string, coversUpToId: string) {
		return reflectionsRecordedEntry(id, { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId });
	}

	it("is zero without observation coverage", () => {
		expect(observedTokensSinceReflectionCoverage([textCustomMessage("raw-1", "aaaaaaaaaaaa")])).toBe(0);
	});

	it("counts everything observed before any reflection", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"), // 3
			textCustomMessage("raw-2", "aaaaaaaa"), // 2, unobserved
			coverage("om-1", "raw-1"),
		];

		expect(observedTokensSinceReflectionCoverage(entries)).toBe(3);
	});

	it("counts only source between the reflection marker and the observation frontier", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"), // 3
			coverage("om-1", "raw-1"),
			reflections("om-ref", "raw-1"),
			textCustomMessage("raw-2", "aaaaaaaa"), // 2
			textCustomMessage("raw-3", "aaaa"), // 1
			coverage("om-2", "raw-2"),
			textCustomMessage("raw-4", "aaaaaaaaaaaaaaaa"), // 4, unobserved backlog
		];

		expect(observedTokensSinceReflectionCoverage(entries)).toBe(2);
	});

	it("is zero when reflection coverage has caught up with observation coverage", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			coverage("om-1", "raw-1"),
			reflections("om-ref", "raw-1"),
			textCustomMessage("raw-2", "aaaaaaaaaaaaaaaaaaaaaaaa"),
		];

		expect(observedTokensSinceReflectionCoverage(entries)).toBe(0);
	});
});
