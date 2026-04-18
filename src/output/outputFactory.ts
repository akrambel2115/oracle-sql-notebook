import * as vscode from "vscode";

import { QueryExecutionResult, summarizeQueryResult } from "../db/resultMapper";
import { createErrorOutput } from "./errorOutput";
import { createPlanOutput } from "./planOutput";
import { createTableOutput } from "./tableOutput";
import { createTextOutput } from "./textOutput";

export function buildSuccessOutputs(
  result: QueryExecutionResult
): vscode.NotebookCellOutput[] {
  return buildSuccessOutputsForBatch([result]);
}

export function buildSuccessOutputsForBatch(
  results: QueryExecutionResult[]
): vscode.NotebookCellOutput[] {
  if (results.length === 0) {
    return [createTextOutput("No statements were executed.")];
  }

  if (results.length === 1) {
    const onlyResult = results[0];

    if (!onlyResult) {
      return [createTextOutput("No statements were executed.")];
    }

    return buildSingleStatementOutputs(onlyResult);
  }

  const outputs: vscode.NotebookCellOutput[] = [];

  for (const result of results) {
    outputs.push(...buildSingleStatementOutputs(result));
  }

  return outputs;
}

function buildSingleStatementOutputs(
  result: QueryExecutionResult
): vscode.NotebookCellOutput[] {
  const outputs: vscode.NotebookCellOutput[] = [];

  if (result.statementType === "SELECT") {
    if (result.view === "plan") {
      outputs.push(createPlanOutput(result));
    } else {
      outputs.push(createTableOutput(result));
    }
  }

  outputs.push(createTextOutput(summarizeQueryResult(result)));

  return outputs;
}

export function buildErrorOutputs(message: string): vscode.NotebookCellOutput[] {
  return [createErrorOutput(message)];
}
