import type { JsonObject, JsonValue } from "./json.js";

export type RuntimeMode =
  | "goal"
  | "goal-file"
  | "improve"
  | "test"
  | "fix-from"
  | "interactive"
  | "resume";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type SessionStatus =
  | "starting"
  | "active"
  | "complete"
  | "failed"
  | "cancelled"
  | "timed_out";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type ReportKind = "goal" | "improve" | "test" | "issue";

export type RuntimeRef = {
  id: string;
  label?: string;
};

export type RuntimeGoal = {
  id?: string;
  mode: RuntimeMode;
  source: RuntimeMode;
  text: string;
  focus?: string | null;
  targets?: string[];
  metadata?: JsonObject;
};

export type RuntimeMessage = {
  id?: string;
  role: MessageRole;
  content: string;
  agent?: string;
  createdAt?: string;
  metadata?: JsonObject;
};

export type RuntimeSession = {
  id: string;
  backend: string;
  status: SessionStatus;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  messages?: RuntimeMessage[];
  metadata?: JsonObject;
};

export type RuntimePlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary?: string;
  owner?: string;
  metadata?: JsonObject;
};

export type RuntimePlan = {
  id?: string;
  summary?: string;
  steps: RuntimePlanStep[];
  metadata?: JsonObject;
};

export type RuntimeFinding = {
  id?: string;
  severity: FindingSeverity;
  summary: string;
  detail?: string;
  location?: string;
  source?: RuntimeRef;
  metadata?: JsonObject;
};

export type RuntimeReport = {
  id?: string;
  kind: ReportKind;
  title: string;
  path?: string | null;
  summary?: string;
  findings?: RuntimeFinding[];
  metadata?: JsonObject;
};

export type RunArtifacts = {
  reportPath: string | null;
  reportTitle: string | null;
};

export type RunRecord = {
  id: string;
  root: string;
  projectDir: string;
  status: RunStatus;
  mode: RuntimeMode;
  goal: RuntimeGoal;
  plan?: RuntimePlan;
  sessions?: RuntimeSession[];
  reports?: RuntimeReport[];
  metadata?: JsonObject;
};

export type ExecutionArtifacts = RunArtifacts;

export type ExecutionResult = {
  artifacts: ExecutionArtifacts;
  cyclesCompleted: number;
  finished: boolean;
  message: string;
  runId: string;
  runRoot: string;
  summary: string;
  details?: JsonObject;
};

export type MachineReadableResult = {
  status: "ok" | "error";
  message?: string;
  error?: string;
  run_id?: string;
  goal_source?: RuntimeMode;
  goal_text?: string | null;
  summary?: string;
  report_path?: string | null;
  data?: JsonObject;
};

export function isPlanStepStatus(value: string): value is PlanStepStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "blocked"
  );
}

export function isFindingSeverity(value: string): value is FindingSeverity {
  return (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
  );
}

export function createRuntimeGoal(
  text: string,
  source: RuntimeMode,
  overrides: Partial<RuntimeGoal> = {},
): RuntimeGoal {
  return {
    mode: source,
    source,
    text,
    ...overrides,
    metadata: overrides.metadata,
  };
}

export function createExecutionResult(
  result: Omit<ExecutionResult, "details"> & { details?: Record<string, JsonValue> },
): ExecutionResult {
  return {
    ...result,
    details: result.details,
  };
}
