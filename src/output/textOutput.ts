import * as vscode from "vscode";

export function createTextOutput(text: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.text(`${text}\n`)
  ]);
}
