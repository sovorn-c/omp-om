import { describe, expect, it } from "vitest";

import { renderSummary } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

describe("session-ledger V3 summary rendering", () => {
	it("renders empty memory as an empty summary", () => {
		expect(renderSummary([], [])).toBe("");
	});

	it("renders reflections with recallable ids", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });
		const summary = renderSummary([ref], []);
		expect(summary).toContain(`[${ref.id}] ${ref.content}`);
	});

	it("renders observations with ids, timestamps, relevance, and complete content", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: `User confirmed recall should use exact source entry ids. ${"source details ".repeat(1000)} Final decision.`,
			timestamp: "2026-05-02 10:30",
			relevance: "high",
		});
		const summary = renderSummary([], [obs]);
		expect(summary).toContain(`[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`);
	});

	it("keeps raw provenance metadata out of the compact summary", () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["entry-user", "entry-tool"] });
		const ref = reflection("eeeeeeeeeeee", [obs.id]);
		const summary = renderSummary([ref], [obs]);
		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("supportingObservationIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
	});
});
