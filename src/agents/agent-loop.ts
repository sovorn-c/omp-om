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
