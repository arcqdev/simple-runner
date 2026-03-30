import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedGoal, ResolvedRuntimeParams } from "../../src/cli/runtime.js";
import { RunDir, init } from "../../src/logging/log.js";
import {
  ApiToolStageAdvisor,
  ApiRuntimeOrchestrator,
  buildRuntimeOrchestrator,
  GeminiCliRuntimeOrchestrator,
  OpencodeRuntimeOrchestrator,
  PiRuntimeOrchestrator,
  PiToolStageAdvisor,
  parseDoneDirective,
  verificationPassed,
} from "../../src/runtime/orchestration.js";
import { executePendingRun } from "../../src/runtime/engine.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_STATE_DIR = process.env.FAKE_AGENT_STATE_DIR;

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function initTempRun(prefix: string): RunDir {
  const projectDir = makeTempDir(prefix);
  const runDir = RunDir.create(projectDir, prefix);
  init(runDir);
  return runDir;
}

function projectFlags(projectDir: string): {
  autoRefine: false;
  cycles: number;
  debug: false;
  effort: null;
  exchanges: number;
  fixFrom: null;
  focus: null;
  goal: string;
  goalFile: null;
  help: false;
  improve: false;
  json: false;
  noAutoCommit: boolean;
  orchestrator: string;
  project: string;
  resume: null;
  skipIntake: true;
  target: [];
  team: string;
  test: false;
  version: false;
  yes: true;
} {
  return {
    autoRefine: false,
    cycles: 4,
    debug: false,
    effort: null,
    exchanges: 3,
    fixFrom: null,
    focus: null,
    goal: "Ship it",
    goalFile: null,
    help: false,
    improve: false,
    json: false,
    noAutoCommit: true,
    orchestrator: "gemini-cli:gemini-3-flash",
    project: projectDir,
    resume: null,
    skipIntake: true,
    target: [],
    team: "full",
    test: false,
    version: false,
    yes: true,
  };
}

function buildParams(
  orchestrator: string,
  model: string,
): ResolvedRuntimeParams {
  return {
    autoCommit: false,
    maxCycles: 4,
    maxExchanges: 3,
    orchestrator,
    orchestratorModel: model,
    team: "full",
  };
}

function buildGoal(goalText = "Ship it"): ResolvedGoal {
  return { goalText, source: "goal" };
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.FAKE_AGENT_STATE_DIR;
  } else {
    process.env.FAKE_AGENT_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("orchestration helpers", () => {
  it("parses done directives and recognizes passing verification text", () => {
    expect(parseDoneDirective("GOAL_DONE: shipped")).toMatchObject({
      explicit: true,
      terminal: "goal_done",
    });
    expect(verificationPassed("ALL CHECKS PASS. Browser verified.")).toBe(true);
    expect(verificationPassed("Found regressions.")).toBe(false);
  });

  it("builds runtime orchestrators for API, PI, Gemini, and OpenCode", () => {
    expect(buildRuntimeOrchestrator(buildParams("api", "gpt-5.4"))).toBeInstanceOf(
      ApiRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("pi", "gemini-2.5-flash"))).toBeInstanceOf(
      PiRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("gemini-cli", "gemini-3-flash"))).toBeInstanceOf(
      GeminiCliRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("opencode", "gemini-2.5-flash"))).toBeInstanceOf(
      OpencodeRuntimeOrchestrator,
    );
  });
});

describe("ACP orchestration", () => {
  it("falls back to the synthetic runtime when a legacy orchestrator is selected", () => {
    const projectDir = makeTempDir("legacy-project");
    const runDir = RunDir.create(projectDir, "legacy_runtime");
    init(runDir);
    writeFileSync(
      runDir.teamFile,
      `${JSON.stringify(
        {
          agents: {
            worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
          },
          verifiers: { testers: [], browser_testers: [], reviewers: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = executePendingRun(runDir, buildParams("codex", "gpt-5.4"), buildGoal(), {
      ...projectFlags(projectDir),
      orchestrator: "codex:gpt-5.4",
    });

    expect(result.finished).toBe(true);
    expect(result.summary).toContain("codex");
    expect(readFileSync(runDir.logFile, "utf8")).toContain('"event":"orchestrator_fallback"');
  });
});

describe("API tool advisor", () => {
  it("selects the stage group returned by the implement_goal tool call", () => {
    initTempRun("api_tool_select");
    const advisor = new ApiToolStageAdvisor(
      {
        context: "Test plan",
        stages: [
          { description: "First", index: 1, name: "Stage 1" },
          { description: "Second", index: 2, name: "Stage 2" },
        ],
      },
      "gemini-flash",
      {
        env: { ...process.env, GEMINI_API_KEY: "test-key" },
        requestJson: () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        args: { reasoning: "Stage 2 is next", stageIndexes: [2] },
                        name: "implement_goal",
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }),
      },
    );

    const decision = advisor.assess("Ship it", ["Completed stage 1"], [1], makeTempDir("project"));

    expect(decision.action).toBe("run_group");
    if (decision.action === "run_group") {
      expect(decision.group.map((stage) => stage.index)).toEqual([2]);
      expect(decision.reasoning).toContain("API advisor selected");
    }
  });

  it("marks the goal done when the API advisor returns ADVISOR_DONE text", () => {
    initTempRun("api_tool_done");
    const advisor = new ApiToolStageAdvisor(
      {
        context: "Test plan",
        stages: [{ description: "First", index: 1, name: "Stage 1" }],
      },
      "gemini-flash",
      {
        env: { ...process.env, GEMINI_API_KEY: "test-key" },
        requestJson: () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "ADVISOR_DONE: all stages are complete" }],
                },
              },
            ],
          }),
        }),
      },
    );

    const decision = advisor.assess("Ship it", [], [], makeTempDir("project"));

    expect(decision).toEqual({
      action: "done",
      reasoning: "API advisor marked the goal complete.",
      summary: "all stages are complete",
    });
  });
});

describe("PI tool advisor", () => {
  it("selects the stage group returned by the implement_goal tool call", () => {
    initTempRun("pi_tool_select");
    const advisor = new PiToolStageAdvisor(
      {
        context: "Test plan",
        stages: [
          { description: "First", index: 1, name: "Stage 1" },
          { description: "Second", index: 2, name: "Stage 2" },
        ],
      },
      "gemini-2.5-flash",
      {
        runPi: () => ({
          exitCode: 0,
          stderr: "",
          stdout: "Selected stages: [2]",
          toolOutput: JSON.stringify({ reasoning: "Stage 2 is next", stageIndexes: [2] }),
        }),
      },
    );

    const decision = advisor.assess("Ship it", ["Completed stage 1"], [1], makeTempDir("project"));

    expect(decision.action).toBe("run_group");
    if (decision.action === "run_group") {
      expect(decision.group.map((stage) => stage.index)).toEqual([2]);
      expect(decision.reasoning).toContain("PI advisor selected");
    }
  });
});
