import { SqlStatementType } from "./sqlClassifier";

export type QueryResultView = "table" | "plan";

export interface QueryExecutionResult {
  statementType: SqlStatementType;
  rows: Record<string, unknown>[];
  columns: string[];
  view: QueryResultView;
  rowsAffected: number;
  truncated: boolean;
  executionMs: number;
}

export function detectResultView(
  columns: string[],
  rows: Record<string, unknown>[]
): QueryResultView {
  if (columns.length !== 1) {
    return "table";
  }

  const onlyColumnKey = columns[0];

  if (!onlyColumnKey) {
    return "table";
  }

  const onlyColumn = onlyColumnKey.toUpperCase();

  if (onlyColumn !== "PLAN_TABLE_OUTPUT") {
    return "table";
  }

  for (const row of rows) {
    const value = row[onlyColumnKey];

    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value !== "string") {
      return "table";
    }
  }

  return "plan";
}

export function summarizeQueryResult(result: QueryExecutionResult): string {
  if (result.statementType === "SELECT") {
    const truncationNote = result.truncated ? " (truncated)" : "";

    if (result.view === "plan") {
      return `Returned ${result.rows.length} plan line(s)${truncationNote} in ${result.executionMs} ms.`;
    }

    return `Returned ${result.rows.length} row(s)${truncationNote} in ${result.executionMs} ms.`;
  }

  if (result.statementType === "DML") {
    return `DML statement affected ${result.rowsAffected} row(s) in ${result.executionMs} ms.`;
  }

  if (result.statementType === "DDL") {
    return `DDL statement completed in ${result.executionMs} ms.`;
  }

  if (result.statementType === "PLSQL") {
    return `PL/SQL block completed in ${result.executionMs} ms.`;
  }

  return `Statement completed in ${result.executionMs} ms.`;
}
