import * as vscode from "vscode";

import { QueryExecutionResult } from "../db/resultMapper";

const PLAN_COLUMN = "PLAN_TABLE_OUTPUT";

function extractPlanLines(result: QueryExecutionResult): string[] {
  return result.rows
    .map((row) => row[PLAN_COLUMN])
    .filter((value): value is string => typeof value === "string");
}

export function createPlanOutput(
  result: QueryExecutionResult
): vscode.NotebookCellOutput {
  const lines = extractPlanLines(result);

  const payload = {
    lines,
    rowCount: lines.length,
    truncated: result.truncated,
    executionMs: result.executionMs
  };

  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(
      payload,
      "application/vnd.oracle-sql-notebook.plan+json"
    ),
    vscode.NotebookCellOutputItem.json(payload, "application/json")
  ]);
}
