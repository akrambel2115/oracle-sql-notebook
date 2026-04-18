import * as vscode from "vscode";

export function createErrorOutput(message: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.stderr(`${message}\n`)
  ]);
}
