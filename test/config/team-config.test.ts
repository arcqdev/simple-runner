import { describe, expect, it } from "vitest";

import { buildRuntimeTeamConfig } from "../../src/config/team-config.js";

describe("buildRuntimeTeamConfig", () => {
  it("injects runtime defaults and prunes invalid verifier references", () => {
    const result = buildRuntimeTeamConfig(
      {
        agents: {
          tester: {
            backend: "codex",
          },
        },
        verifiers: {
          reviewers: ["missing"],
          testers: ["tester", "missing"],
        },
      },
      "memory:team.json",
      {
        claude: false,
        codex: true,
        cursor: false,
        "gemini-cli": false,
        opencode: false,
        kimi: false,
      },
    );

    expect(result.config.agents.tester).toMatchObject({
      backend: "codex",
      chrome: false,
      description: "",
      max_turns: 15,
      model: "gpt-5.4",
      session_timeout_s: 7200,
    });
    expect(result.config.agents.tester.system_prompt).toContain("implementation verifier");
    expect(result.config.agents.tester.system_prompt).toContain("Agent notes:");
    expect(result.config.verifiers).toEqual({
      testers: ["tester"],
    });
  });

  it("fails clearly for invalid agent backends", () => {
    expect(() =>
      buildRuntimeTeamConfig(
        {
          agents: {
            worker_fast: {
              backend: "not-a-backend" as "codex",
            },
          },
        },
        "memory:team.json",
      ),
    ).toThrowError("unknown backend");
  });

  it("accepts opencode teams and injects the ACP-backed default model", () => {
    const result = buildRuntimeTeamConfig(
      {
        agents: {
          worker_fast: {
            backend: "opencode",
          },
        },
      },
      "memory:team.json",
      {
        claude: false,
        codex: false,
        cursor: false,
        "gemini-cli": false,
        opencode: true,
        kimi: false,
      },
    );

    expect(result.config.agents.worker_fast).toMatchObject({
      backend: "opencode",
      model: "gemini-2.5-flash",
    });
  });
});
