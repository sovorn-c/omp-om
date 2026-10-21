import {
	agentLoop as hostAgentLoop,
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { EventStream } from "@earendil-works/pi-ai";

/**
 * Worker loops never pass a `streamFn`: omp's `agentLoop` then falls back to
 * `streamSimple`, which resolves extension-registered providers first. The
 * Pi typings the extension compiles against still declare `streamFn` as
 * required and omit `systemPrompt` from `AgentContext`, so the host function
 * is re-typed here once.
 */
export type WorkerAgentContext = AgentContext & {
	/** omp's `AgentContext` requires the system prompt here, not as a `system` message. */
	systemPrompt: string[];
};

export type WorkerAgentLoop = (
	prompts: AgentMessage[],
	context: WorkerAgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
) => EventStream<AgentEvent, AgentMessage[]>;

export const agentLoop = hostAgentLoop as unknown as WorkerAgentLoop;

/** The slice of a loop event the turn cap reads. */
type TurnCapEvent = { type: string; message?: { role?: string; stopReason?: string } };

export interface TurnCap {
	/** Signal to hand to the loop: the caller's signal, aborted when the cap is hit. */
	readonly signal: AbortSignal | undefined;
	/** True once the cap aborted the loop. */
	readonly capped: boolean;
	/** Feed every loop event; counts assistant `turn_end` events. */
	observe(event: TurnCapEvent): void;
	/** Detach from the caller's signal. */
	dispose(): void;
}

/**
 * omp's `AgentLoopConfig` has no per-turn finish hook, so `agentMaxTurns` is
 * enforced here: after `maxTurns` completed assistant turns the loop's own
 * AbortController fires. Error and aborted turns end the loop anyway and do
 * not count.
 */
export function createTurnCap(maxTurns: number | undefined, parent: AbortSignal | undefined): TurnCap {
	if (maxTurns === undefined || maxTurns <= 0) {
		return { signal: parent, capped: false, observe() {}, dispose() {} };
	}
	const controller = new AbortController();
	const forward = () => controller.abort(parent?.reason);
	if (parent?.aborted) forward();
	else parent?.addEventListener("abort", forward, { once: true });
	let turns = 0;
	let capped = false;
	return {
		signal: controller.signal,
		get capped() {
			return capped;
		},
		observe(event) {
			if (event.type !== "turn_end") return;
			const stopReason = event.message?.stopReason;
			if (stopReason === "error" || stopReason === "aborted") return;
			if (++turns < maxTurns) return;
			capped = true;
			controller.abort();
		},
		dispose() {
			parent?.removeEventListener("abort", forward);
		},
	};
}
