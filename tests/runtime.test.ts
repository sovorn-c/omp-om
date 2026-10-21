import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { auth?: unknown } = {}) {
	return {
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

/** `ctx.models` stub shaped like omp's: sync `resolve(spec)` returning the Model or `undefined`. */
function models(resolved: unknown) {
	return { resolve: vi.fn((_spec: string) => resolved) };
}

describe("Runtime single-model resolution", () => {
	it('resolves "@smol" through ctx.models.resolve', async () => {
		const runtime = new Runtime();
		const smol = { provider: "anthropic", id: "haiku" };
		const ctxModels = models(smol);
		const registry = modelRegistry();

		const result = await runtime.resolveModel({ models: ctxModels, modelRegistry: registry, hasUI: false });

		expect(runtime.config.model).toBe("@smol");
		expect(ctxModels.resolve).toHaveBeenCalledTimes(1);
		expect(ctxModels.resolve).toHaveBeenCalledWith("@smol");
		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(smol);
		expect(result).toEqual({ ok: true, model: smol, apiKey: "key", headers: { test: "yes" } });
	});

	it("resolves the configured spec, not the session model", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const ctxModels = models(configured);
		runtime.config = { ...runtime.config, model: "anthropic/configured" };

		const result = await runtime.resolveModel({ models: ctxModels, modelRegistry: modelRegistry(), hasUI: false });

		expect(ctxModels.resolve).toHaveBeenCalledWith("anthropic/configured");
		expect(result).toMatchObject({ ok: true, model: configured });
	});

	it("unresolvable spec returns ok:false with reason naming the spec", async () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, model: "nonsense/does-not-exist" };
		const registry = modelRegistry();

		const result = await runtime.resolveModel({ models: models(undefined), modelRegistry: registry, hasUI: false });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.reason).toContain('"nonsense/does-not-exist"');
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("does not notify or fall back to another model when the spec is unresolvable", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		const result = await runtime.resolveModel({ models: models(undefined), modelRegistry: modelRegistry(), hasUI: true, ui: { notify } });

		expect(result.ok).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("never throws: a throwing resolver, auth lookup, or missing facade becomes ok:false", async () => {
		const runtime = new Runtime();
		const model = { provider: "anthropic", id: "haiku" };

		const throwingResolve = await runtime.resolveModel({
			models: { resolve: () => { throw new Error("boom"); } },
			modelRegistry: modelRegistry(),
			hasUI: false,
		});
		expect(throwingResolve).toMatchObject({ ok: false });
		if (throwingResolve.ok) throw new Error("expected failure");
		expect(throwingResolve.reason).toContain("boom");

		const throwingAuth = await runtime.resolveModel({
			models: models(model),
			modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("auth boom"); } },
			hasUI: false,
		});
		expect(throwingAuth).toMatchObject({ ok: false });
		if (throwingAuth.ok) throw new Error("expected failure");
		expect(throwingAuth.reason).toContain("auth boom");

		const noFacade = await runtime.resolveModel({ modelRegistry: modelRegistry(), hasUI: false });
		expect(noFacade).toMatchObject({ ok: false });
		if (noFacade.ok) throw new Error("expected failure");
		expect(noFacade.reason).toContain("ctx.models is unavailable");
	});

	it("returns auth failures", async () => {
		const runtime = new Runtime();
		const registry = modelRegistry({ auth: { ok: false, error: 'No API key found for "anthropic"' } });

		await expect(runtime.resolveModel({ models: models({ provider: "anthropic" }), modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key or auth headers for provider "anthropic"',
		});
	});

	it("accepts OAuth-shaped auth (headers only, no apiKey)", async () => {
		const runtime = new Runtime();
		const model = { provider: "kimi-coding", id: "kimi-for-coding" };
		const registry = modelRegistry({
			auth: { ok: true, apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } },
		});

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model,
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});
	});

	it("accepts apiKey auth unchanged", async () => {
		const runtime = new Runtime();
		const model = { provider: "anthropic", id: "claude" };
		const registry = modelRegistry({ auth: { ok: true, apiKey: "sk-ant-key" } });

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(result).toEqual({ ok: true, model, apiKey: "sk-ant-key", headers: undefined });
	});

	it("accepts ambient-auth providers (ok:true, apiKey undefined) when pi reports a configured credential", async () => {
		const runtime = new Runtime();
		const model = { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-4-5" };
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: undefined, headers: undefined })),
			hasConfiguredAuth: vi.fn((candidate: unknown) => candidate === model),
			isUsingOAuth: vi.fn(() => false),
		};

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(registry.hasConfiguredAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({ ok: true, model, apiKey: undefined, headers: undefined, env: undefined, baseUrl: undefined });
	});

	it("still rejects an empty resolution when pi reports no credential source", async () => {
		const runtime = new Runtime();
		const model = { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-4-5" };
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: undefined, headers: undefined })),
			hasConfiguredAuth: vi.fn(() => false),
			isUsingOAuth: vi.fn(() => false),
		};

		await expect(runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key or auth headers for provider "amazon-bedrock"',
		});
	});

	it.each([
		{ headersOnly: false },
		{ headersOnly: true },
	])("applies auth baseUrl without mutating the model (headersOnly=$headersOnly)", async ({ headersOnly }) => {
		const runtime = new Runtime();
		const model = Object.freeze({
			provider: "github-copilot",
			id: "gpt-4.1",
			baseUrl: "https://api.individual.githubcopilot.com",
			api: "openai-completions",
			contextWindow: 128000,
		});
		const baseUrl = "https://api.business.githubcopilot.com";
		const apiKey = headersOnly ? undefined : "test-key";
		const headers = { Authorization: "Bearer test-token" };
		const registry = modelRegistry({ auth: { ok: true, apiKey, headers, baseUrl } });

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(result).toMatchObject({ ok: true, model: { ...model, baseUrl }, apiKey, headers });
		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).not.toBe(model);
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it.each([undefined, ""])("keeps the original model when auth baseUrl is %j", async (baseUrl) => {
		const runtime = new Runtime();
		const model = Object.freeze({ provider: "openai", id: "test-model", baseUrl: "https://example.com/v1" });
		const registry = modelRegistry({ auth: { ok: true, apiKey: "test-key", baseUrl } });

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).toBe(model);
	});

	it("rejects auth that carries neither apiKey nor usable headers", async () => {
		const runtime = new Runtime();
		const model = { provider: "xai" };

		for (const auth of [
			{ ok: true },
			{ ok: true, apiKey: "" },
			{ ok: true, headers: {} },
			{ ok: true, headers: { Authorization: "" } },
		]) {
			const registry = modelRegistry({ auth });
			await expect(runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: 'no API key or auth headers for provider "xai"',
			});
		}
	});

	it("points OAuth providers at /login when auth resolution fails", async () => {
		const runtime = new Runtime();
		const model = { provider: "openai-codex", id: "gpt-5-codex" };
		const registry = {
			...modelRegistry({ auth: { ok: false, error: "refresh failed" } }),
			isUsingOAuth: vi.fn((candidate: { provider?: string }) => candidate?.provider === "openai-codex"),
		};

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(registry.isUsingOAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({
			ok: false,
			reason: 'authentication failed for provider "openai-codex" — OAuth credentials may have expired; run \'/login openai-codex\' to re-authenticate',
		});
	});

	it("forwards env and baseUrl from model registry", async () => {
		const runtime = new Runtime();
		const model = { provider: "cloudflare-workers-ai", id: "@cf/mistralai/mistral-small-3.1-24b-instruct" };
		const registry = modelRegistry({
			auth: {
				ok: true,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
			}
		});

		const result = await runtime.resolveModel({ models: models(model), modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model: { ...model, baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" },
			apiKey: "test-key",
			headers: { Authorization: "Bearer test" },
			env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
		});
	});
});

describe("Runtime task state", () => {
	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		const { promise: work, resolve: release } = Promise.withResolvers<void>();

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
	});

	it("keeps the compaction hook flag independent of consolidation", () => {
		const runtime = new Runtime();
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});
});
