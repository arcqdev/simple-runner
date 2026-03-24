import { describe, expect, it } from "vitest";

import {
  buildImproveFallbackPlan,
  buildTestFallbackPlan,
  extractFixableFindings,
  parseTestReportSummary,
} from "../../src/cli/specialized.js";

describe("specialized mode helpers", () => {
  it("parses Python-style test report summaries", () => {
    const summary = parseTestReportSummary(`
# Test Report

## Summary
- **Features tested:** 4
- **Findings:** 2
- **Regression tests written:** 1

## Findings
- **F1:** Login fails
- **F2:** Export hangs

## Regression Tests & Fixes
- **F1:** test/auth.test.ts:expires-session

## Blocked Workflows
- OAuth login — provider sandbox unavailable
`);

    expect(summary.findings_count).toBe(2);
    expect(summary.findings_item_count).toBe(2);
    expect(summary.regression_tests).toBe(1);
    expect(summary.regression_count).toBe(1);
    expect(summary.blocked_count).toBe(1);
    expect(summary.blocked_details).toEqual(["- OAuth login — provider sandbox unavailable"]);
  });

  it("extracts fixable findings from structured test reports", () => {
    const findings = extractFixableFindings(`
# Test Report

## Findings
- **F1:** CLI crashes on empty config
  - **Workflow:** startup
  - **Severity:** critical
- **F2:** Retry loop never exits
  - **Workflow:** flaky network recovery
`);

    expect(findings).toEqual([
      "- **F1:** CLI crashes on empty config - **Workflow:** startup - **Severity:** critical",
      "- **F2:** Retry loop never exits - **Workflow:** flaky network recovery",
    ]);
  });

  it("assigns reduced verification to analysis stages and full verification to fix stages", () => {
    const improvePlan = buildImproveFallbackPlan("/tmp/run/improve-report.md");
    expect(Array.isArray(improvePlan.stages[0]?.verification)).toBe(true);
    expect(Array.isArray(improvePlan.stages[3]?.verification)).toBe(true);
    expect(improvePlan.stages[4]?.verification).toBe("full");

    const testPlan = buildTestFallbackPlan("/tmp/run/test-report.md");
    expect(Array.isArray(testPlan.stages[0]?.verification)).toBe(true);
    expect(Array.isArray(testPlan.stages[1]?.verification)).toBe(true);
    expect(Array.isArray(testPlan.stages[2]?.verification)).toBe(true);
    expect(testPlan.stages[3]?.verification).toBe("full");
  });
});
