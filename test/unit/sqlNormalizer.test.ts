import { describe, expect, it } from "vitest";

import { normalizeSqlForExecution } from "../../src/db/sqlNormalizer";

describe("normalizeSqlForExecution", () => {
  it("strips trailing semicolon from plain SELECT", () => {
    const normalized = normalizeSqlForExecution(
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY());",
      "SELECT"
    );

    expect(normalized).toBe("SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())");
  });

  it("strips SQL*Plus slash terminator", () => {
    const normalized = normalizeSqlForExecution(
      "SELECT * FROM dual;\n/",
      "SELECT"
    );

    expect(normalized).toBe("SELECT * FROM dual");
  });

  it("keeps trailing semicolon for PL/SQL blocks", () => {
    const normalized = normalizeSqlForExecution("BEGIN NULL; END;\n/", "PLSQL");

    expect(normalized).toBe("BEGIN NULL; END;");
  });
});
