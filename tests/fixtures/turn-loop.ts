export interface EndlessLoopProbe {
	/** `turn_end` events the fake loop emitted before it stopped. */
	turns: number;
	/** Signal the worker passed to the loop. */
	signal?: AbortSignal;
}

/**
 * Fake agent loop that keeps emitting assistant `turn_end` events until the
 * signal it was given aborts, like a model that never stops calling its tool.
 * It ends with an aborted assistant message, as omp's loop does on abort.
 */
export function endlessTurnLoop(probe: EndlessLoopProbe, hardLimit = 100): any {
	return ((_prompts: unknown, _context: unknown, _config: unknown, signal?: AbortSignal) => {
		probe.signal = signal;
		return {
			async *[Symbol.asyncIterator]() {
				while (!signal?.aborted && probe.turns < hardLimit) {
					probe.turns++;
					yield { type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] };
				}
				if (signal?.aborted) yield { type: "message_end", message: { role: "assistant", stopReason: "aborted" } };
			},
			result: async () => ({}),
		};
	}) as any;
}
