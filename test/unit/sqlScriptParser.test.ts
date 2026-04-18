import { describe, expect, it } from "vitest";

import { splitSqlScript } from "../../src/db/sqlScriptParser";

describe("splitSqlScript", () => {
  it("splits multiple SQL statements separated by semicolon", () => {
    const statements = splitSqlScript("select 1 from dual; select 2 from dual;");

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toBe("select 1 from dual");
    expect(statements[1]?.sql).toBe("select 2 from dual");
    expect(statements[0]?.mode).toBe("sql");
  });

  it("does not split semicolons inside string literals", () => {
    const statements = splitSqlScript("select ';' as marker from dual;");

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toBe("select ';' as marker from dual");
  });

  it("keeps PL/SQL blocks intact and splits by slash terminator", () => {
    const statements = splitSqlScript(
      "BEGIN\n  NULL;\nEND;\n/\nSELECT * FROM dual;"
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]?.mode).toBe("plsql");
    expect(statements[0]?.sql).toContain("NULL;");
    expect(statements[1]?.sql).toBe("SELECT * FROM dual");
  });
});
