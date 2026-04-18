import { describe, expect, it } from "vitest";

import { classifySql } from "../../src/db/sqlClassifier";

describe("classifySql", () => {
  it("detects SELECT statements", () => {
    expect(classifySql("select * from dual")).toBe("SELECT");
    expect(classifySql("with t as (select 1 from dual) select * from t")).toBe(
      "SELECT"
    );
  });

  it("detects DML statements", () => {
    expect(classifySql("insert into t(id) values (1)")).toBe("DML");
    expect(classifySql("update t set name = 'x'")).toBe("DML");
  });

  it("detects DDL statements", () => {
    expect(classifySql("create table t(id number)")).toBe("DDL");
    expect(classifySql("alter table t add name varchar2(20)")).toBe("DDL");
  });

  it("detects PL/SQL blocks", () => {
    expect(classifySql("begin null; end;")).toBe("PLSQL");
    expect(classifySql("declare x number; begin x := 1; end;")).toBe("PLSQL");
  });

  it("ignores leading comments", () => {
    expect(
      classifySql("-- a comment\n/* and another */\nSELECT * FROM dual")
    ).toBe("SELECT");
  });
});
