import * as vscode from "vscode";

import { QueryExecutionResult } from "../db/resultMapper";

export function createTableOutput(
  result: QueryExecutionResult
): vscode.NotebookCellOutput {
  const payload = {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    previewRowLimit: result.rows.length,
    truncated: result.truncated,
    executionMs: result.executionMs
  };

  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(
      payload,
      "application/vnd.oracle-sql-notebook.table+json"
    ),
    vscode.NotebookCellOutputItem.json(payload, "application/json")
  ]);
}
