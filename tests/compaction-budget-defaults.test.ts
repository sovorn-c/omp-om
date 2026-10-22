import { describe, expect, it } from "vitest";

import { DEFAULTS, resolveCompactionMaxRetainedTokens, resolveCompactionSummaryMaxTokens } from "../src/config.js";

// omp treats a compaction as no progress when the context lands above
// 0.8 x its threshold, so the default retained tail plus summary must fit there.
const RECOVERY_BAND_TOKENS = 0.8 * 100_000;

describe("default compaction budgets", () => {
	it.each([200_000, 1_000_000, undefined])("keep tail plus summary inside the recovery band of a 100K threshold (window %s)", (window) => {
		const total = resolveCompactionMaxRetainedTokens(DEFAULTS, window) + resolveCompactionSummaryMaxTokens(DEFAULTS, window);
		expect(total).toBeLessThan(RECOVERY_BAND_TOKENS);
	});
});
