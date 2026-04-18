import { describe, expect, it } from "vitest";

import { detectResultView, summarizeQueryResult } from "../../src/db/resultMapper";

describe("detectResultView", () => {
  it("returns plan for DBMS_XPLAN-like output", () => {
    const view = detectResultView(
      ["PLAN_TABLE_OUTPUT"],
      [{ PLAN_TABLE_OUTPUT: "Plan hash value: 123" }]
    );

    expect(view).toBe("plan");
  });

  it("returns table for regular SELECT result", () => {
    const view = detectResultView(["ID", "NAME"], [{ ID: 1, NAME: "A" }]);

    expect(view).toBe("table");
  });
});

describe("summarizeQueryResult", () => {
  it("uses plan wording for plan view", () => {
    const summary = summarizeQueryResult({
      statementType: "SELECT",
      rows: [{ PLAN_TABLE_OUTPUT: "line" }],
      columns: ["PLAN_TABLE_OUTPUT"],
      view: "plan",
      rowsAffected: 0,
      truncated: false,
      executionMs: 9
    });

    expect(summary).toContain("plan line(s)");
  });
});
