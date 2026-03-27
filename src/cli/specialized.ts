import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RunDir } from "../logging/log.js";
import { runsRoot } from "../logging/runs.js";

export const IMPROVE_REPORT_FORMAT = `\`\`\`markdown
# Improve Report

## Auto-fixed
- <file>:<line> — <description>

## Needs decision
- <file>:<line> — <description + proposed change + tradeoff>

## Skipped by triage
- <finding title> — <reason>
\`\`\``;

export const IMPROVE_GOAL = `Review this codebase for significant improvements. Focus on simplification, usability, and architecture — not on running tests or finding runtime bugs (use \`kodo test\` for that).

Look for things a senior developer joining the project would notice: unnecessary complexity, confusing interfaces, duplicated concepts, missing abstractions, poor defaults. Be ambitious — propose changes that meaningfully improve the experience of working with or using this software.

Report at \`{report_path}\`.

{report_format}

Commit auto-fixes: "chore: auto-fix issues found by kodo improve".`;

export const TEST_REPORT_FORMAT = `\`\`\`markdown
# Test Report

## Summary
- **Features tested:** <count>
- **Findings:** <count>
- **Regression tests written:** <count>

## Feature Coverage
| Feature / Workflow | Status | Findings | Notes |
|--------------------|--------|----------|-------|
| <feature> | pass / fail / partial | F1,F2 | <what wasn't tested and why> |

## Findings
- **F<n>:** <title>
  - **Workflow:** <which feature or user workflow>
  - **Category:** crash | data-loss | silent-wrong | hang | race | leak | misleading-output | install-failure | usability
  - **Repro steps:**
    1. <step>
    2. <what happens vs what should happen>
  - **Root cause:** <if known>
  - **Severity:** critical | medium | low

## Regression Tests & Fixes
- **F<n>:** <file>:<test_name> — test fails before fix, passes after

## Self-Critique
- What features weren't tested? What assumptions went unchallenged?
- If zero findings: what gives you confidence this is actually correct?

## Blocked Workflows
- <workflow> — <why it couldn't be tested>
\`\`\``;

export const TEST_GOAL = `Test this software the way a real user would — start to finish.

Install it, try every feature, exercise realistic workflows, then probe edge cases. The goal is to find bugs users would actually hit.

For confirmed bugs, write a regression test that fails, then fix the code.

Report at \`{report_path}\`.

{report_format}`;

const MAX_PRIOR_RUNS = 10;

type GoalPlanStage = {
  index: number;
  name: string;
  description: string;
  acceptance_criteria?: string;
  browser_testing?: boolean;
  parallel_group?: number | null;
  persist_changes?: boolean;
  verification?:
    | "full"
    | "skip"
    | Array<{
        description: string;
        error_message: string;
        path: string;
      }>;
};

export type SpecializedGoalPlan = {
  context: string;
  stages: GoalPlanStage[];
};

export type TestReportSummary = {
  blocked_count: number;
  blocked_details: string[];
  findings_count?: number;
  findings_item_count: number;
  regression_count: number;
  regression_tests?: number;
};

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "stage";
}

export function extractSection(text: string, heading: string): string {
  const lines = text.split(/\r?\n/gu);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    return "";
  }

  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      break;
    }
    body.push(lines[index] ?? "");
  }
  return body.join("\n");
}

function collectPriorReportItems(
  currentRunId: string,
  reportFileName: string,
  sections: Record<string, string>,
): string {
  const root = runsRoot();
  if (!existsSync(root)) {
    return "";
  }

  const collected = new Map<string, string[]>();
  for (const heading of Object.keys(sections)) {
    collected.set(heading, []);
  }

  let scanned = 0;
  const runDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const runId of runDirs) {
    if (runId === currentRunId || scanned >= MAX_PRIOR_RUNS) {
      continue;
    }
    scanned += 1;

    const reportPath = path.join(root, runId, reportFileName);
    if (!existsSync(reportPath)) {
      continue;
    }

    let content = "";
    try {
      content = readFileSync(reportPath, "utf8");
    } catch {
      continue;
    }

    for (const heading of Object.keys(sections)) {
      const body = extractSection(content, heading);
      const items = body
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));
      collected.get(heading)?.push(...items);
    }
  }

  return Object.entries(sections)
    .flatMap(([heading, template]) => {
      const items = collected.get(heading) ?? [];
      return items.length > 0 ? [template.replace("{items}", items.join("\n"))] : [];
    })
    .join("");
}

export function collectPriorNeedsDecision(runDir: RunDir): string {
  return collectPriorReportItems(runDir.runId, "improve-report.md", {
    "Needs decision":
      "\n## Prior unresolved items\nPrevious --improve runs flagged these as 'Needs decision'. Re-evaluate each one:\n- If the code has been fixed or the concern is no longer valid, drop it.\n- If you can now auto-fix it safely without human input, fix it and list it under 'Auto-fixed'.\n- Otherwise carry it forward into 'Needs decision'.\n\n{items}\n",
  });
}

export function collectPriorTestWork(runDir: RunDir): string {
  return collectPriorReportItems(runDir.runId, "test-report.md", {
    "Regression Tests & Fixes":
      "\n## Previously Generated Tests\nPrevious runs already added these. Focus on new gaps:\n\n{items}\n",
    "Blocked Workflows":
      "\n## Prior Remaining Gaps\nPrevious runs couldn't cover these. Try to address them or carry forward:\n\n{items}\n",
  });
}

export function formatImproveGoal(reportPath: string, focus: string | null): string {
  const focusLine = focus ? `\n\n**Focus area:** ${focus}` : "";
  return (
    IMPROVE_GOAL.replace("{report_path}", reportPath).replace(
      "{report_format}",
      IMPROVE_REPORT_FORMAT,
    ) + focusLine
  ).trim();
}

export function formatTestGoal(
  reportPath: string,
  focus: string | null,
  targets: string[],
): string {
  const focusLine = focus ? `\n\n**Focus area:** ${focus}` : "";
  const targetLine =
    targets.length > 0
      ? `\n\n**Target files/dirs:** ${targets.map((target) => `\`${target}\``).join(", ")}`
      : "";
  return (
    TEST_GOAL.replace("{report_path}", reportPath).replace("{report_format}", TEST_REPORT_FORMAT) +
    focusLine +
    targetLine
  ).trim();
}

export function buildImproveFallbackPlan(
  reportPath: string,
  priorNeedsDecision = "",
  focus: string | null = null,
): SpecializedGoalPlan {
  const runDir = path.dirname(reportPath);
  const focusContext = focus ? `\n\n**Focus area:** ${focus}` : "";
  const simplificationFindings = path.join(runDir, "findings-simplification.md");
  const usabilityFindings = path.join(runDir, "findings-usability.md");
  const architectureFindings = path.join(runDir, "findings-architecture.md");
  const triagePath = path.join(runDir, "triage-results.md");

  return {
    context:
      'Review this codebase for significant improvements. Think like a senior developer joining the project — what would you change in your first week?\n\nFocus on high-impact findings. A single "this entire module could be replaced by X" is worth more than twenty lint fixes.' +
      focusContext,
    stages: [
      {
        index: 1,
        name: "Simplification & Dead Weight",
        parallel_group: 1,
        description:
          "Read the codebase looking for unnecessary complexity. Abstractions that don't pay for themselves, duplicated logic, dead code, unused dependencies, things that reimplement standard library functionality. For each finding, explain what's simpler and why it's worth changing.\n\nRun linters and type checkers if configured — include any real issues they surface.\n\nWrite findings to `" +
          simplificationFindings +
          "`.\n\n### F<n>: <title>\n- **File:** <file>:<line>\n- **Category:** simplification | usability | architecture | dead-code | security | performance\n- **Impact:** <who benefits and how — users, contributors, or both>\n- **Evidence:** <concrete proof: code snippet, example, or comparison>\n- **Proposed change:** <what to do, with enough detail to act on>",
        acceptance_criteria: `Findings at ${simplificationFindings} with concrete proposals.`,
        verification: [
          {
            description: "Simplification findings file",
            error_message: "Missing simplification findings.",
            path: simplificationFindings,
          },
        ],
      },
      {
        index: 2,
        name: "Usability Review",
        parallel_group: 1,
        description:
          "Review the public interface — whatever users or consumers interact with. Read the README, check CLI help/flags, look at the library API surface, examine error messages.\n\nLook for: redundant options that could be merged or inferred, confusing naming, missing defaults, inconsistent patterns, poor error messages, documentation that contradicts the code, duplicated functionality that confuses users.\n\nThink about the experience of someone using this for the first time. What would confuse them? What friction could be removed?\n\nWrite findings to `" +
          usabilityFindings +
          "`.\n\n### F<n>: <title>\n- **File:** <file>:<line>\n- **Category:** simplification | usability | architecture | dead-code | security | performance\n- **Impact:** <who benefits and how — users, contributors, or both>\n- **Evidence:** <concrete proof: code snippet, example, or comparison>\n- **Proposed change:** <what to do, with enough detail to act on>",
        acceptance_criteria: `Findings at ${usabilityFindings} with concrete proposals.`,
        verification: [
          {
            description: "Usability findings file",
            error_message: "Missing usability findings.",
            path: usabilityFindings,
          },
        ],
      },
      {
        index: 3,
        name: "Architecture & Security",
        parallel_group: 1,
        description:
          "Step back and look at the structure. Module boundaries, dependency directions, separation of concerns. Are there circular dependencies, god modules, responsibilities in the wrong place?\n\nAlso do a lightweight security scan at system boundaries: hardcoded secrets, injection risks on external inputs, resource leaks.\n\nWrite findings to `" +
          architectureFindings +
          "`.\n\n### F<n>: <title>\n- **File:** <file>:<line>\n- **Category:** simplification | usability | architecture | dead-code | security | performance\n- **Impact:** <who benefits and how — users, contributors, or both>\n- **Evidence:** <concrete proof: code snippet, example, or comparison>\n- **Proposed change:** <what to do, with enough detail to act on>",
        acceptance_criteria: `Findings at ${architectureFindings} with concrete proposals.`,
        verification: [
          {
            description: "Architecture findings file",
            error_message: "Missing architecture findings.",
            path: architectureFindings,
          },
        ],
      },
      {
        index: 4,
        name: "Triage & Verify",
        description:
          `Skeptically verify each finding. Read the actual code at the cited location. Default to \`skip\` — most findings don't survive scrutiny.\n\nFor each finding, ask:\n- Is this actually a problem, or does it serve a purpose I'm missing?\n- Would the proposed change make things genuinely better, or just different?\n- Is the impact worth the churn?\n\nWrite \`${triagePath}\`:\n\n### F<n>: <title>\n- **Verdict:** fix | skip | needs-decision\n- **Reason:** <1-2 sentences>\n\nFindings files: \`${simplificationFindings}\`, \`${usabilityFindings}\`, \`${architectureFindings}\`.` +
          priorNeedsDecision,
        acceptance_criteria: `Every finding has a verdict in ${triagePath}.`,
        verification: [
          {
            description: "Triage results file",
            error_message: "Missing triage results.",
            path: triagePath,
          },
        ],
      },
      {
        index: 5,
        name: "Fix & Report",
        description: `Act only on \`fix\` and \`needs-decision\` from \`${triagePath}\`. Ignore \`skip\`.\n\nOriginal findings: \`${simplificationFindings}\`, \`${usabilityFindings}\`, \`${architectureFindings}\`.\n\nAuto-fix safe issues, flag ambiguous ones. Write report to \`${reportPath}\`:\n\n${IMPROVE_REPORT_FORMAT}\n\nCommit auto-fixes: "chore: auto-fix issues found by kodo improve".`,
        acceptance_criteria: `Report at ${reportPath}. Auto-fixes committed. Only triage-approved findings acted on.`,
        verification: "full",
      },
    ],
  };
}

export function buildTestFallbackPlan(
  reportPath: string,
  options: {
    focus?: string | null;
    priorTestWork?: string;
    targets?: string[];
  } = {},
): SpecializedGoalPlan {
  const runDir = path.dirname(reportPath);
  const focusContext = options.focus ? `\n\n**Focus area:** ${options.focus}` : "";
  const targetContext =
    options.targets && options.targets.length > 0
      ? `\n\n**Target scope:** ${options.targets.map((target) => `\`${target}\``).join(", ")} — focus testing on these files/directories.`
      : "";
  const reconPath = path.join(runDir, "test-recon.md");
  const coverageFile = ".simple-runner/test-coverage.md";
  const findingsWorkflows = path.join(runDir, "findings-workflows.md");
  const findingsEdgeCases = path.join(runDir, "findings-edge-cases.md");

  return {
    context:
      "Test this software like a real user. Install it, exercise every feature, try realistic workflows, then probe edge cases. Find bugs users would actually hit.\n\nTime budget: 15% setup and discovery, 60% feature walkthroughs and testing, 15% edge cases and adversarial probing, 10% triage and regression tests." +
      focusContext +
      targetContext +
      (options.priorTestWork ?? ""),
    stages: [
      {
        index: 1,
        name: "Setup & Discovery",
        persist_changes: true,
        description:
          "Build whatever you need to actually use the software: install scripts, CLI wrappers, test fixtures, sample data. The goal is to interact with it like a real user.\n\nIf you need something you can't build (Docker, browser, GPU), say so in the Blocked Workflows section.\n\nMap all user-facing features and workflows:\n\nRead the README, run --help, check examples and docs. What can a user actually do with this software? What are the documented workflows?\n\nWrite feature coverage to `" +
          coverageFile +
          "`:\n# Feature Coverage\n\nTracked across `kodo test` runs.\n\n| Feature / Workflow | Last tested | Status | Findings |\n|--------------------|-------------|--------|----------|\n\nInstall the software following the documented steps. Write discovery notes (features found, what existing tests cover, what's most likely to break) to `" +
          reconPath +
          "`.\n\nSpend no more than 15% of total effort here. Get the software running, then start testing.",
        acceptance_criteria: `Software installed and running. Feature map in ${coverageFile}. Discovery notes at ${reconPath}.`,
        verification: [
          {
            description: "Feature coverage file",
            error_message: "Missing feature coverage file.",
            path: coverageFile,
          },
          {
            description: "Discovery notes file",
            error_message: "Missing discovery notes.",
            path: reconPath,
          },
        ],
      },
      {
        index: 2,
        name: "Feature Walkthroughs",
        persist_changes: false,
        parallel_group: 1,
        description: `Exercise every user-facing feature end-to-end. Follow documented workflows, try the examples from the README, use every CLI command and flag. Test both happy paths and common error cases.\n\nWrite findings to \`${findingsWorkflows}\`.\n\n### F<n>: <title>\n- **Workflow:** <feature or user workflow>\n- **Severity:** critical | medium | low\n- **Category:** crash | data-loss | silent-wrong | hang | race | leak | misleading-output | install-failure | usability\n- **Repro steps:**\n  1. <step>\n  2. <what happens vs what should happen>\n- **Root cause:** <if known>`,
        acceptance_criteria: `Findings with repro steps at ${findingsWorkflows}, or detailed explanation of features tested and why they passed.`,
        verification: [
          {
            description: "Core workflow findings file",
            error_message: "Missing core workflow findings.",
            path: findingsWorkflows,
          },
        ],
      },
      {
        index: 3,
        name: "Edge Cases & Error Paths",
        persist_changes: false,
        parallel_group: 1,
        description: `Probe edge cases and error handling across all features. Try empty inputs, huge inputs, invalid types, missing files, bad configs, unicode edge cases, concurrent usage. Test every error path — are messages helpful? Does it recover or corrupt state?\n\nWrite findings to \`${findingsEdgeCases}\`.\n\n### F<n>: <title>\n- **Workflow:** <feature or user workflow>\n- **Severity:** critical | medium | low\n- **Category:** crash | data-loss | silent-wrong | hang | race | leak | misleading-output | install-failure | usability\n- **Repro steps:**\n  1. <step>\n  2. <what happens vs what should happen>\n- **Root cause:** <if known>`,
        acceptance_criteria: `Findings with repro steps at ${findingsEdgeCases}, or detailed explanation of edge cases tested and why they passed.`,
        verification: [
          {
            description: "Edge case findings file",
            error_message: "Missing edge case findings.",
            path: findingsEdgeCases,
          },
        ],
      },
      {
        index: 4,
        name: "Triage & Regression Tests",
        persist_changes: true,
        description: `For each confirmed bug from \`${findingsWorkflows}\` and \`${findingsEdgeCases}\`:\n1. Write a test that reproduces the bug — verify it fails\n2. Fix the code\n3. Verify the test now passes\n\nCommit test and fix separately:\n- "test: add regression test for F<n> (kodo test)"\n- "fix: <description> (kodo test)"\n\nUpdate feature coverage in \`${coverageFile}\`. Run the full test suite.\n\nWrite report to \`${reportPath}\`:\n\n${TEST_REPORT_FORMAT}`,
        acceptance_criteria: `Report at ${reportPath} with findings, feature coverage, and self-critique. Regression tests committed. Suite passes.`,
        verification: "full",
      },
    ],
  };
}

export function extractFixableFindings(reportContent: string): string[] {
  const findings: string[] = [];
  for (const section of [
    "Critical Findings",
    "Integration & Workflow Findings",
    "Usability Gaps",
    "Needs decision",
  ]) {
    const body = extractSection(reportContent, section);
    findings.push(
      ...body
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- ")),
    );
  }

  if (findings.length > 0) {
    return dedupe(findings);
  }

  const modernFindings = extractStructuredFindings(extractSection(reportContent, "Findings"));
  return dedupe(modernFindings);
}

function extractStructuredFindings(section: string): string[] {
  const lines = section.split(/\r?\n/gu);
  const findings: string[] = [];
  let current: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^- \*\*F\d+:\*\*/u.test(line.trim())) {
      if (current.length > 0) {
        findings.push(normalizeFindingBlock(current));
      }
      current = [line.trim()];
      continue;
    }
    if (current.length > 0) {
      if (/^- \*\*F\d+:\*\*/u.test(line.trim())) {
        findings.push(normalizeFindingBlock(current));
        current = [line.trim()];
      } else if (line.trim().length > 0) {
        current.push(line.trim());
      }
    }
  }
  if (current.length > 0) {
    findings.push(normalizeFindingBlock(current));
  }

  return findings.filter((finding) => finding.length > 0 && !/^- None\b/iu.test(finding));
}

function normalizeFindingBlock(lines: string[]): string {
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}

export function parseTestReportSummary(reportContent: string): TestReportSummary {
  const summary = extractSection(reportContent, "Summary");
  const findings = extractSection(reportContent, "Findings");
  const regression = extractSection(reportContent, "Regression Tests & Fixes");
  const blocked = extractSection(reportContent, "Blocked Workflows");

  const result: TestReportSummary = {
    blocked_count: 0,
    blocked_details: [],
    findings_item_count: (findings.match(/\*\*F\d+/gu) ?? []).length,
    regression_count: (regression.match(/^- .+$/gmu) ?? []).length,
  };

  for (const rawLine of summary.split(/\r?\n/gu)) {
    const line = rawLine.trim().replace(/^[-*]\s*/u, "");
    const numberMatch = line.match(/(\d+)/u);
    if (numberMatch === null) {
      continue;
    }
    const value = Number.parseInt(numberMatch[1] ?? "", 10);
    const lower = line.toLowerCase();
    if (lower.includes("findings")) {
      result.findings_count = value;
    } else if (lower.includes("regression")) {
      result.regression_tests = value;
    }
  }

  result.blocked_details = blocked
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  result.blocked_count = result.blocked_details.length;

  return result;
}
