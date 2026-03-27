import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CliError } from "../core/errors.js";
import type { RunDir } from "../logging/log.js";
import type { SpecializedGoalPlan } from "./specialized.js";
import { getPromptAdapter } from "./prompts.js";
import { printLines } from "./ui.js";

export type IntakeSession = {
  answers: Array<{ answer: string; prompt: string }>;
  goalText: string;
  summary: string;
};

export type IntakeOfferResult = {
  notices: string[];
  plan: SpecializedGoalPlan | null;
  refinedGoal: string | null;
  session: IntakeSession | null;
};

type StoredIntakeArtifacts = {
  plan: SpecializedGoalPlan | null;
  refinedGoal: string | null;
};

type IntakeArtifacts = {
  plan: SpecializedGoalPlan | null;
  refinedGoal: string | null;
};

type StageSeed = {
  acceptanceCriteria: string;
  description: string;
  name: string;
};

const GOAL_PREVIEW_LIMIT = 500;
const INTERVIEW_QUESTIONS = [
  "Constraints or non-negotiables",
  "Preferred approach or technical boundaries",
  "Definition of done",
] as const;

function normalizeGoalText(text: string): string {
  return text.replace(/\r\n/gu, "\n").trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function safeReadTrimmed(filePath: string): string | null {
  try {
    const content = normalizeGoalText(readFileSync(filePath, "utf8"));
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function intakeStoreDir(projectDir: string): string {
  return path.join(projectDir, ".simple-runner", "intake");
}

function intakeGoalFile(projectDir: string): string {
  return path.join(intakeStoreDir(projectDir), "goal.md");
}

function intakeRefinedFile(projectDir: string): string {
  return path.join(intakeStoreDir(projectDir), "goal-refined.md");
}

function intakePlanFile(projectDir: string): string {
  return path.join(intakeStoreDir(projectDir), "goal-plan.json");
}

function looksLikeBrowserGoal(goalText: string): boolean {
  return /\b(ui|ux|frontend|front-end|browser|page|screen|react|vue|angular|next|website|web app)\b/iu.test(
    goalText,
  );
}

function inferProjectContext(projectDir: string): string {
  const entries = existsSync(projectDir)
    ? readdirSync(projectDir, { withFileTypes: true })
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("."))
        .slice(0, 8)
    : [];
  return entries.length > 0
    ? `Project root: ${projectDir}. Top-level files/directories: ${entries.join(", ")}.`
    : `Project root: ${projectDir}.`;
}

function stageNameFromText(text: string, index: number): string {
  const cleaned = text
    .replace(/^[\s*-]+/u, "")
    .replace(/^\d+[.)]\s*/u, "")
    .trim();
  if (cleaned.length === 0) {
    return `Stage ${index}`;
  }
  const words = cleaned.split(/\s+/u).slice(0, 5);
  return words
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 48);
}

function buildAcceptanceCriteria(description: string): string {
  const normalized = normalizeWhitespace(description);
  if (normalized.length === 0) {
    return "The intended change is implemented and verified.";
  }
  return `The repository reflects "${normalized}" and the result is verified in the relevant workflow.`;
}

function extractListedStages(goalText: string): StageSeed[] {
  const lines = goalText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidates = lines.filter((line) => /^(\d+[.)]|-|\*)\s+/u.test(line));
  if (candidates.length < 2) {
    return [];
  }
  return candidates.slice(0, 5).map((line, index) => {
    const description = line.replace(/^(\d+[.)]|-|\*)\s+/u, "").trim();
    return {
      acceptanceCriteria: buildAcceptanceCriteria(description),
      description,
      name: stageNameFromText(description, index + 1),
    };
  });
}

function buildDefaultStages(goalText: string): StageSeed[] {
  const summary = normalizeWhitespace(goalText).slice(0, 120);
  return [
    {
      acceptanceCriteria:
        "Relevant code paths, constraints, and integration points are identified before editing.",
      description:
        "Inspect the current implementation, map the relevant code paths, and confirm the smallest viable change.",
      name: "Inspect Current State",
    },
    {
      acceptanceCriteria: `The repository contains the core change needed to "${summary}".`,
      description: `Implement the core change required to "${summary}".`,
      name: "Implement Core Change",
    },
    {
      acceptanceCriteria:
        "The new behavior is validated and the run artifacts explain what changed.",
      description:
        "Verify the result with targeted tests or checks, then tighten any rough edges before finishing.",
      name: "Verify And Finish",
    },
  ];
}

function buildInterviewSummary(
  goalText: string,
  answers: Array<{ answer: string; prompt: string }>,
): string {
  const answered = answers
    .filter((entry) => entry.answer.length > 0)
    .map((entry) => `${entry.prompt}: ${entry.answer}`);
  return [normalizeGoalText(goalText), ...answered].join("\n");
}

function generateRefinedGoal(
  goalText: string,
  projectDir: string,
  session?: IntakeSession | null,
): string {
  const sections: string[] = [normalizeGoalText(goalText)];
  const context: string[] = [];

  if (session !== null && session !== undefined) {
    const constraints = session.answers.find(
      (entry) => entry.prompt === INTERVIEW_QUESTIONS[0],
    )?.answer;
    const approach = session.answers.find(
      (entry) => entry.prompt === INTERVIEW_QUESTIONS[1],
    )?.answer;
    const done = session.answers.find((entry) => entry.prompt === INTERVIEW_QUESTIONS[2])?.answer;
    if (constraints && constraints.length > 0) {
      context.push(`Constraints: ${constraints}`);
    }
    if (approach && approach.length > 0) {
      context.push(`Preferred approach: ${approach}`);
    }
    if (done && done.length > 0) {
      context.push(`Done means: ${done}`);
    }
  } else {
    context.push(
      "Constraints: stay within the existing project structure unless the goal explicitly requires a larger refactor.",
    );
    context.push(
      "Preferred approach: choose the smallest coherent implementation path and keep the surface area tight.",
    );
    context.push(
      "Done means: the behavior is implemented, verified, and explained in the run artifacts.",
    );
  }

  sections.push("# Pre-implementation analysis");
  sections.push(...context.map((entry) => `- ${entry}`));
  sections.push(`- Project context: ${inferProjectContext(projectDir)}`);
  sections.push(
    "- Common traps: avoid speculative abstractions, broad rewrites, and verification gaps that leave the goal half-finished.",
  );
  return `${sections.join("\n\n")}\n`;
}

function generatePlan(
  goalText: string,
  projectDir: string,
  session?: IntakeSession | null,
): SpecializedGoalPlan {
  const seeds = extractListedStages(goalText);
  const stageSeeds = seeds.length > 0 ? seeds : buildDefaultStages(goalText);
  const contextLines = [
    inferProjectContext(projectDir),
    `Goal summary: ${normalizeWhitespace(goalText)}`,
  ];
  if (session !== null && session !== undefined) {
    for (const answer of session.answers) {
      if (answer.answer.length > 0) {
        contextLines.push(`${answer.prompt}: ${answer.answer}`);
      }
    }
  }
  return {
    context: contextLines.join("\n"),
    stages: stageSeeds.map((stage, index) => ({
      acceptance_criteria: stage.acceptanceCriteria,
      browser_testing: looksLikeBrowserGoal(goalText) && index === stageSeeds.length - 1,
      description: stage.description,
      index: index + 1,
      name: stage.name,
    })),
  };
}

function writeArtifacts(runDir: RunDir, artifacts: IntakeArtifacts): void {
  if (artifacts.refinedGoal !== null) {
    writeFileSync(runDir.goalRefinedFile, `${normalizeGoalText(artifacts.refinedGoal)}\n`, "utf8");
  }
  if (artifacts.plan !== null) {
    writeFileSync(runDir.goalPlanFile, `${JSON.stringify(artifacts.plan, null, 2)}\n`, "utf8");
  }
}

function persistProjectArtifacts(
  projectDir: string,
  goalText: string,
  artifacts: IntakeArtifacts,
): void {
  const storeDir = intakeStoreDir(projectDir);
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(intakeGoalFile(projectDir), `${normalizeGoalText(goalText)}\n`, "utf8");
  if (artifacts.refinedGoal !== null) {
    writeFileSync(
      intakeRefinedFile(projectDir),
      `${normalizeGoalText(artifacts.refinedGoal)}\n`,
      "utf8",
    );
  }
  if (artifacts.plan !== null) {
    writeFileSync(
      intakePlanFile(projectDir),
      `${JSON.stringify(artifacts.plan, null, 2)}\n`,
      "utf8",
    );
  }
}

function parsePlan(text: string): SpecializedGoalPlan | null {
  try {
    const parsed = JSON.parse(text) as Partial<SpecializedGoalPlan>;
    if (typeof parsed.context !== "string" || !Array.isArray(parsed.stages)) {
      return null;
    }
    const stages = parsed.stages.filter(
      (stage): stage is NonNullable<SpecializedGoalPlan["stages"][number]> =>
        typeof stage === "object" &&
        stage !== null &&
        typeof stage.index === "number" &&
        typeof stage.name === "string" &&
        typeof stage.description === "string",
    );
    return stages.length > 0 ? { context: parsed.context, stages } : null;
  } catch {
    return null;
  }
}

function storedArtifactsForGoal(
  projectDir: string,
  goalText: string,
): StoredIntakeArtifacts | null {
  const storedGoal = safeReadTrimmed(intakeGoalFile(projectDir));
  if (storedGoal === null || normalizeGoalText(storedGoal) !== normalizeGoalText(goalText)) {
    return null;
  }

  const refinedGoal = safeReadTrimmed(intakeRefinedFile(projectDir));
  const plan = existsSync(intakePlanFile(projectDir))
    ? parsePlan(readFileSync(intakePlanFile(projectDir), "utf8"))
    : null;
  if (refinedGoal === null && plan === null) {
    return null;
  }
  return { plan, refinedGoal };
}

function printPlanPreview(plan: SpecializedGoalPlan, heading: string): void {
  printLines([
    "",
    heading,
    "----------------------------------------",
    ...plan.stages.flatMap((stage) => [
      `  ${stage.index}. ${stage.name}`,
      ...(stage.acceptance_criteria === undefined
        ? []
        : [`     Done when: ${stage.acceptance_criteria.slice(0, 100)}`]),
    ]),
    "----------------------------------------",
  ]);
}

function useStoredArtifactsInteractively(
  projectDir: string,
  goalText: string,
): { notices: string[]; plan: SpecializedGoalPlan | null; refinedGoal: string | null } | null {
  const stored = storedArtifactsForGoal(projectDir, goalText);
  if (stored === null) {
    return null;
  }

  const prompt = getPromptAdapter();
  if (stored.plan !== null) {
    printPlanPreview(
      stored.plan,
      `Found existing goal plan (${stored.plan.stages.length} stages):`,
    );
    const usePlan = prompt.confirm("Use this goal plan?", true);
    if (usePlan === null) {
      throw new CliError("Cancelled.");
    }
    if (usePlan) {
      return {
        notices: [`Reusing stored intake plan (${stored.plan.stages.length} stages).`],
        plan: stored.plan,
        refinedGoal: stored.refinedGoal,
      };
    }
  } else if (stored.refinedGoal !== null) {
    printLines([
      "",
      "Found existing refined goal:",
      "----------------------------------------",
      stored.refinedGoal.slice(0, GOAL_PREVIEW_LIMIT),
      ...(stored.refinedGoal.length > GOAL_PREVIEW_LIMIT ? ["..."] : []),
      "----------------------------------------",
    ]);
    const useRefined = prompt.confirm("Use this refined goal?", true);
    if (useRefined === null) {
      throw new CliError("Cancelled.");
    }
    if (useRefined) {
      return {
        notices: ["Reusing stored refined goal."],
        plan: null,
        refinedGoal: stored.refinedGoal,
      };
    }
  }

  return null;
}

export function findProjectGoalFile(projectDir: string): string | null {
  const direct = path.join(projectDir, "goal.md");
  if (existsSync(direct)) {
    return direct;
  }
  try {
    const match = readdirSync(projectDir, { withFileTypes: true }).find(
      (entry) => entry.isFile() && entry.name.toLowerCase() === "goal.md",
    );
    return match ? path.join(projectDir, match.name) : null;
  } catch {
    return null;
  }
}

export function previewExistingGoal(goalFile: string): string | null {
  const content = safeReadTrimmed(goalFile);
  if (content === null) {
    return null;
  }
  printLines([
    "",
    `Found existing goal in ${goalFile}:`,
    "----------------------------------------",
    content.slice(0, GOAL_PREVIEW_LIMIT),
    ...(content.length > GOAL_PREVIEW_LIMIT ? ["..."] : []),
    "----------------------------------------",
  ]);
  return content;
}

export function runIntakeAuto(
  runDir: RunDir,
  goalText: string,
): { notices: string[]; refinedGoal: string } {
  const refinedGoal = generateRefinedGoal(goalText, runDir.projectDir, null);
  const artifacts = { plan: null, refinedGoal };
  writeArtifacts(runDir, artifacts);
  persistProjectArtifacts(runDir.projectDir, goalText, artifacts);
  return {
    notices: [
      "Auto-refine: surfaced implicit constraints, preferred implementation shape, and verification expectations.",
    ],
    refinedGoal,
  };
}

export function runIntakeNoninteractive(
  runDir: RunDir,
  goalText: string,
): { notices: string[]; plan: SpecializedGoalPlan | null; refinedGoal: string | null } {
  const stored = storedArtifactsForGoal(runDir.projectDir, goalText);
  if (stored !== null && stored.plan !== null) {
    writeArtifacts(runDir, stored);
    return {
      notices: [`Using existing goal plan (${stored.plan.stages.length} stages)`],
      plan: stored.plan,
      refinedGoal: stored.refinedGoal,
    };
  }

  const plan = generatePlan(goalText, runDir.projectDir, null);
  const refinedGoal = generateRefinedGoal(goalText, runDir.projectDir, null);
  const artifacts = { plan, refinedGoal };
  writeArtifacts(runDir, artifacts);
  persistProjectArtifacts(runDir.projectDir, goalText, artifacts);
  return {
    notices: [
      "Running intake (non-interactive)...",
      `Generated goal plan with ${plan.stages.length} stages.`,
    ],
    plan,
    refinedGoal,
  };
}

export function offerInteractiveIntake(runDir: RunDir, goalText: string): IntakeOfferResult {
  const reused = useStoredArtifactsInteractively(runDir.projectDir, goalText);
  if (reused !== null) {
    writeArtifacts(runDir, reused);
    return {
      notices: reused.notices,
      plan: reused.plan,
      refinedGoal: reused.refinedGoal,
      session: null,
    };
  }

  const prompt = getPromptAdapter();
  const choice = prompt.select(
    "Refine goal before launch?",
    [
      "Quick refine — surfaces implicit constraints, no conversation",
      "Interview — interactive Q&A, optionally break into stages",
      "Skip",
    ],
    "Quick refine — surfaces implicit constraints, no conversation",
  );
  if (choice === null) {
    throw new CliError("Cancelled.");
  }
  if (choice === "Skip") {
    return {
      notices: ["Skipping intake; using the goal as provided."],
      plan: null,
      refinedGoal: null,
      session: null,
    };
  }

  printLines([
    "",
    `  After refinement, agents run with full permissions in ${runDir.projectDir}`,
    "  Make sure you have a git commit or backup.",
  ]);
  const confirmed = prompt.confirm("  Continue?", true);
  if (confirmed === null) {
    throw new CliError("Cancelled.");
  }
  if (!confirmed) {
    throw new CliError("Cancelled.");
  }

  if (choice.startsWith("Quick refine")) {
    const result = runIntakeAuto(runDir, goalText);
    return { notices: result.notices, plan: null, refinedGoal: result.refinedGoal, session: null };
  }

  const answers = INTERVIEW_QUESTIONS.map((question) => ({
    answer: (prompt.text(question, "") ?? "").trim(),
    prompt: question,
  }));
  const session: IntakeSession = {
    answers,
    goalText,
    summary: buildInterviewSummary(goalText, answers),
  };
  const defaultBreakIntoStages = extractListedStages(goalText).length >= 2;
  const staged = prompt.confirm("Break into stages?", defaultBreakIntoStages);
  if (staged === null) {
    throw new CliError("Cancelled.");
  }

  if (staged) {
    const plan = generatePlan(goalText, runDir.projectDir, session);
    const refinedGoal = generateRefinedGoal(goalText, runDir.projectDir, session);
    const artifacts = { plan, refinedGoal };
    writeArtifacts(runDir, artifacts);
    persistProjectArtifacts(runDir.projectDir, goalText, artifacts);
    return {
      notices: [`Interview captured planning context and produced ${plan.stages.length} stages.`],
      plan,
      refinedGoal,
      session,
    };
  }

  const refinedGoal = generateRefinedGoal(goalText, runDir.projectDir, session);
  const artifacts = { plan: null, refinedGoal };
  writeArtifacts(runDir, artifacts);
  persistProjectArtifacts(runDir.projectDir, goalText, artifacts);
  return {
    notices: ["Interview captured planning context and refined the goal."],
    plan: null,
    refinedGoal,
    session,
  };
}
