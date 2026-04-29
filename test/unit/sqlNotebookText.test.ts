import { describe, expect, it } from "vitest";

import {
  analyzeSqlNotebookText,
  applySqlNotebookQuickFix,
  hasBlockingSqlNotebookIssues,
  parseSqlToNotebook,
  serializeNotebookToSql
} from "../../src/conversion/sqlNotebookText";
import { RawNotebookV1 } from "../../src/notebook/schema";

describe("SQL notebook text conversion", () => {
  it("serializes notebook metadata and cells to Jupytext-style SQL", () => {
    const notebook: RawNotebookV1 = {
      schemaVersion: 1,
      metadata: { connectionAlias: "dev" },
      cells: [
        {
          kind: "code",
          language: "sql",
          value: "select *\nfrom dual",
          metadata: { name: "query" }
        },
        {
          kind: "markup",
          language: "markdown",
          value: "# Notes\nThis is markdown.",
          metadata: {}
        }
      ]
    };

    const sql = serializeNotebookToSql(notebook);

    expect(sql).toContain(
      '-- oracle-sql-notebook: {"schemaVersion":1,"metadata":{"connectionAlias":"dev"}}'
    );
    expect(sql).toContain('-- %% [sql] {"metadata":{"name":"query"}}');
    expect(sql).toContain("select *\nfrom dual");
    expect(sql).toContain("-- %% [markdown] {\"metadata\":{}}");
    expect(sql).toContain("-- # Notes\n-- This is markdown.");
  });

  it("analyzes valid paired SQL without issues", () => {
    const analysis = analyzeSqlNotebookText(
      [
        '-- oracle-sql-notebook: {"schemaVersion":1,"metadata":{"connectionAlias":"dev"}}',
        '-- %% [sql] {"metadata":{"name":"query"}}',
        "select *",
        "from dual",
        "",
        '-- %% [markdown] {"metadata":{"collapsed":true}}',
        "-- # Notes",
        "-- This is markdown."
      ].join("\n")
    );

    expect(analysis.isPairedFormat).toBe(true);
    expect(analysis.issues).toHaveLength(0);
    expect(analysis.notebook.metadata).toEqual({ connectionAlias: "dev" });
    expect(analysis.notebook.cells).toEqual([
      {
        kind: "code",
        language: "sql",
        value: "select *\nfrom dual",
        metadata: { name: "query" }
      },
      {
        kind: "markup",
        language: "markdown",
        value: "# Notes\nThis is markdown.",
        metadata: { collapsed: true }
      }
    ]);
  });

  it("accepts percent-cell SQL without a notebook header and warns with a fix", () => {
    const analysis = analyzeSqlNotebookText(
      ["-- %% [sql]", "select 1 from dual;", "", "-- %% [sql]", "select 2 from dual;"].join(
        "\n"
      )
    );

    expect(analysis.notebook.metadata).toEqual({});
    expect(analysis.notebook.cells).toHaveLength(2);
    expect(analysis.notebook.cells[0]?.value).toBe("select 1 from dual;");
    expect(analysis.notebook.cells[1]?.value).toBe("select 2 from dual;");

    const missingHeader = analysis.issues.find((issue) => issue.code === "missingHeader");
    expect(missingHeader?.isBlocking).toBe(false);
    expect(missingHeader?.quickFix).toBeDefined();
  });

  it("converts plain SQL without markers into one SQL cell and no paired issues", () => {
    const analysis = analyzeSqlNotebookText("select user from dual;\n");

    expect(analysis.isPairedFormat).toBe(false);
    expect(analysis.issues).toHaveLength(0);
    expect(analysis.notebook).toEqual({
      schemaVersion: 1,
      metadata: {},
      cells: [
        {
          kind: "code",
          language: "sql",
          value: "select user from dual;",
          metadata: {}
        }
      ]
    });
  });

  it("reports malformed header JSON as a blocking issue", () => {
    const analysis = analyzeSqlNotebookText(
      "-- oracle-sql-notebook: {bad json}\n-- %% [sql]\nselect 1 from dual;"
    );

    const issue = analysis.issues.find((entry) => entry.code === "invalidHeaderJson");
    expect(issue?.isBlocking).toBe(true);
    expect(hasBlockingSqlNotebookIssues(analysis.issues)).toBe(true);
    expect(issue?.quickFix).toBeDefined();
    expect(() =>
      parseSqlToNotebook("-- oracle-sql-notebook: {bad json}\n-- %% [sql]\nselect 1 from dual;")
    ).toThrow(/header JSON is malformed/i);
  });

  it("reports malformed marker JSON as a blocking issue", () => {
    const analysis = analyzeSqlNotebookText("-- %% [sql] {bad json}\nselect 1 from dual;");

    const issue = analysis.issues.find((entry) => entry.code === "invalidCellMarkerJson");
    expect(issue?.isBlocking).toBe(true);
    expect(issue?.quickFix).toBeDefined();
  });

  it("reports unsupported schema versions as blocking issues", () => {
    const analysis = analyzeSqlNotebookText(
      '-- oracle-sql-notebook: {"schemaVersion":99,"metadata":{}}\n-- %% [sql]'
    );

    expect(
      analysis.issues.some(
        (issue) =>
          issue.code === "unsupportedSchemaVersion" && issue.isBlocking
      )
    ).toBe(true);
  });

  it("warns when percent-format SQL contains text outside cell markers", () => {
    const analysis = analyzeSqlNotebookText(
      ["intro text", "-- %% [sql]", "select * from dual;"].join("\n")
    );

    expect(
      analysis.issues.some((issue) => issue.code === "strayTextOutsideCells")
    ).toBe(true);
    expect(analysis.notebook.cells[0]?.value).toBe("select * from dual;");
  });

  it("warns when markdown cells contain non-comment lines", () => {
    const analysis = analyzeSqlNotebookText(
      ["-- %% [markdown]", "## heading", "-- body"].join("\n")
    );

    const issue = analysis.issues.find(
      (entry) => entry.code === "markdownLineMissingCommentPrefix"
    );
    expect(issue?.quickFix).toBeDefined();
  });

  it("warns when a cell uses unsupported non-sql languages", () => {
    const analysis = analyzeSqlNotebookText(
      ["-- %% [python]", "print('hello')"].join("\n")
    );

    expect(
      analysis.issues.some((issue) => issue.code === "unsupportedCellLanguage")
    ).toBe(true);
  });

  it("offers a quick fix for non-canonical markup markers", () => {
    const analysis = analyzeSqlNotebookText(
      ["-- %% [markup] {\"metadata\":{}}", "-- hello"].join("\n")
    );

    const issue = analysis.issues.find(
      (entry) => entry.code === "nonCanonicalMarkupLanguage"
    );
    expect(issue?.quickFix).toBeDefined();

    const fixed = applySqlNotebookQuickFix(
      ["-- %% [markup] {\"metadata\":{}}", "-- hello"].join("\n"),
      issue!.quickFix!
    );
    expect(fixed).toContain("-- %% [markdown] {\"metadata\":{}}");
  });

  it("applies a quick fix to add a missing header", () => {
    const analysis = analyzeSqlNotebookText("-- %% [sql]\nselect 1 from dual;");
    const issue = analysis.issues.find((entry) => entry.code === "missingHeader");

    const fixed = applySqlNotebookQuickFix(
      "-- %% [sql]\nselect 1 from dual;",
      issue!.quickFix!
    );

    expect(fixed).toContain("-- oracle-sql-notebook:");
    expect(fixed.startsWith("-- oracle-sql-notebook:")).toBe(true);
  });

  it("applies a quick fix to canonicalize malformed marker metadata", () => {
    const analysis = analyzeSqlNotebookText("-- %% [sql] {bad json}\nselect 1 from dual;");
    const issue = analysis.issues.find((entry) => entry.code === "invalidCellMarkerJson");

    const fixed = applySqlNotebookQuickFix(
      "-- %% [sql] {bad json}\nselect 1 from dual;",
      issue!.quickFix!
    );

    expect(fixed).toContain('-- %% [sql] {"metadata":{}}');
  });

  it("applies a quick fix to prefix markdown lines with comments", () => {
    const analysis = analyzeSqlNotebookText("-- %% [markdown]\nHello");
    const issue = analysis.issues.find(
      (entry) => entry.code === "markdownLineMissingCommentPrefix"
    );

    const fixed = applySqlNotebookQuickFix("-- %% [markdown]\nHello", issue!.quickFix!);

    expect(fixed).toContain("-- Hello");
  });

  it("round-trips safe notebook data", () => {
    const notebook: RawNotebookV1 = {
      schemaVersion: 1,
      metadata: { connectionAlias: "dev", owner: "analytics" },
      cells: [
        {
          kind: "code",
          language: "sql",
          value: "begin\n  null;\nend;\n/",
          metadata: { run: true }
        },
        {
          kind: "markup",
          language: "markdown",
          value: "## Heading\n-- literal comment text",
          metadata: { note: "kept" }
        }
      ]
    };

    expect(parseSqlToNotebook(serializeNotebookToSql(notebook))).toEqual(notebook);
  });
});
