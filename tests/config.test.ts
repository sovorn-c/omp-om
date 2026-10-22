import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_YAML, DEFAULTS, ensureGlobalConfig, loadConfig, readEnvConfig } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("omp-om config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		globalPath = join(agentDir, "omp-om.yml");
		projectPath = join(cwd, ".omp", "omp-om.yml");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults to model \"@smol\" when no files exist", () => {
		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config.model).toBe("@smol");
		expect(warnings).toEqual([]);
		expect(config).toEqual(DEFAULTS);
	});

	it("keeps the Pi OM trigger defaults and drops the removed keys", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			agentMaxTokens: 32000,
			compactionCatchUpMaxChunks: 2,
			model: "@smol",
			showWorkerNotifications: true,
			passive: false,
			debugLog: false,
		});
	});

	it("reads the global file from the agent dir", () => {
		writeJson(globalPath, { model: "anthropic/claude-haiku-4-5", observeAfterTokens: 50 });

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config).toMatchObject({ model: "anthropic/claude-haiku-4-5", observeAfterTokens: 50 });
		expect(warnings).toEqual([]);
	});

	it("project file overrides global model", () => {
		writeJson(globalPath, { model: "@slow", reflectAfterTokens: 30, debugLog: true });
		writeJson(projectPath, { model: "openai/gpt-5-mini", observeAfterTokens: 100 });

		const { config } = loadConfig(cwd, agentDir, {});

		expect(config).toMatchObject({
			model: "openai/gpt-5-mini",
			observeAfterTokens: 100,
			reflectAfterTokens: 30,
			debugLog: true,
		});
	});

	it("applies the passive env override last", () => {
		writeJson(globalPath, { passive: false });

		expect(loadConfig(cwd, agentDir, { OMP_OM_PASSIVE: "true" }).config.passive).toBe(true);
	});

	it("malformed JSON yields defaults plus one warning", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(globalPath, "{ not json", "utf-8");

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config).toEqual(DEFAULTS);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(globalPath);
	});

	it("a malformed project file does not discard the valid global file", () => {
		writeJson(globalPath, { model: "@slow" });
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(projectPath, "[1,2", "utf-8");

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config.model).toBe("@slow");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(projectPath);
	});

	it("a non-object top-level value yields defaults plus one warning", () => {
		writeJson(globalPath, ["model", "@slow"]);

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config).toEqual(DEFAULTS);
		expect(warnings).toHaveLength(1);
	});

	it("removed keys (compactAfterTokens, consolidateWhenIdle) are ignored with a warning", () => {
		writeJson(globalPath, {
			compactAfterTokens: 30,
			compactAfterTokensMode: "ratio",
			compactAfterTokensRatio: 0.5,
			consolidateWhenIdle: true,
			fallbackModel: { provider: "openai", id: "x" },
			observeAfterTokens: 77,
		});

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config).toEqual({ ...DEFAULTS, observeAfterTokens: 77 });
		for (const key of ["compactAfterTokens", "compactAfterTokensMode", "compactAfterTokensRatio", "consolidateWhenIdle", "fallbackModel"]) {
			expect(warnings.some((warning) => warning.includes(`"${key}"`))).toBe(true);
		}
		expect(warnings).toHaveLength(5);
	});

	it("rejects a non-string model with a warning and keeps the lower layer's model", () => {
		writeJson(globalPath, { model: "@slow" });
		writeJson(projectPath, { model: { provider: "anthropic", id: "claude" } });

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config.model).toBe("@slow");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("model");
	});

	it("rejects an empty model string", () => {
		writeJson(globalPath, { model: "" });

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config.model).toBe("@smol");
		expect(warnings).toHaveLength(1);
	});

	it("ignores invalid numeric and boolean values", () => {
		writeJson(globalPath, {
			observeAfterTokens: -1,
			reflectAfterTokens: 0,
			observationsPoolMaxTokens: "20000",
			observationsPoolTargetTokens: "10000",
			agentMaxTurns: null,
			compactionCatchUpMaxChunks: -1,
			showWorkerNotifications: "no",
			passive: "yes",
			debugLog: "true",
		});

		expect(loadConfig(cwd, agentDir, {}).config).toEqual(DEFAULTS);
	});

	it("accepts compactionCatchUpMaxChunks of 0 to disable catch-up", () => {
		writeJson(globalPath, { compactionCatchUpMaxChunks: 0 });

		expect(loadConfig(cwd, agentDir, {}).config.compactionCatchUpMaxChunks).toBe(0);
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(projectPath, { observationsPoolMaxTokens: 40 });

		expect(loadConfig(cwd, agentDir, {}).config).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(globalPath, { observationsPoolMaxTokens: 100, observationsPoolTargetTokens: 80 });
		writeJson(projectPath, { observationsPoolMaxTokens: 40 });

		expect(loadConfig(cwd, agentDir, {}).config).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("does not read Pi's settings.json namespace", () => {
		writeJson(join(agentDir, "settings.json"), { "observational-memory": { observeAfterTokens: 5, model: { provider: "a", id: "b" } } });

		const { config, warnings } = loadConfig(cwd, agentDir, {});

		expect(config).toEqual(DEFAULTS);
		expect(warnings).toEqual([]);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ OMP_OM_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ OMP_OM_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ OMP_OM_PASSIVE: "maybe" })).toEqual({});
	});

	it("reads YAML syntax including comments, and an all-comment file is not a warning", () => {
		writeFileSync(globalPath, "# note\nmodel: '@slow'\nobserveAfterTokens: 50 # inline\n", "utf-8");
		const { config, warnings } = loadConfig(cwd, agentDir, {});
		expect(config).toMatchObject({ model: "@slow", observeAfterTokens: 50 });
		expect(warnings).toEqual([]);

		writeFileSync(globalPath, "# everything commented out\n", "utf-8");
		expect(loadConfig(cwd, agentDir, {})).toEqual({ config: DEFAULTS, warnings: [] });
	});

	it("the seeded default file loads to exactly the built-in defaults", () => {
		expect(ensureGlobalConfig(agentDir)).toEqual([]);

		expect(readFileSync(globalPath, "utf-8")).toBe(DEFAULT_CONFIG_YAML);
		expect(loadConfig(cwd, agentDir, {})).toEqual({ config: DEFAULTS, warnings: [] });
	});

	it("creates a missing agent dir when seeding", () => {
		rmSync(agentDir, { recursive: true, force: true });

		expect(ensureGlobalConfig(agentDir)).toEqual([]);
		expect(existsSync(globalPath)).toBe(true);
	});

	it("never overwrites an existing settings file", () => {
		writeFileSync(globalPath, "model: '@slow'\n", "utf-8");

		ensureGlobalConfig(agentDir);

		expect(readFileSync(globalPath, "utf-8")).toBe("model: '@slow'\n");
	});

	it("does not seed over a legacy omp-om.json, and warns that it is no longer read", () => {
		const legacy = join(agentDir, "omp-om.json");
		writeFileSync(legacy, '{"model":"@slow"}', "utf-8");

		expect(ensureGlobalConfig(agentDir)).toEqual([]);
		expect(existsSync(globalPath)).toBe(false);
		const { config, warnings } = loadConfig(cwd, agentDir, {});
		expect(config.model).toBe("@smol");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(legacy);
	});

	it("reports a warning instead of throwing when the file cannot be created", () => {
		writeFileSync(join(root, "blocker"), "", "utf-8");

		const warnings = ensureGlobalConfig(join(root, "blocker", "agent"));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not create");
	});
});
