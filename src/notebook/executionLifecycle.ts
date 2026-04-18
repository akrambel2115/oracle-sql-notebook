import * as vscode from "vscode";

export function startCellExecution(
  controller: vscode.NotebookController,
  cell: vscode.NotebookCell,
  executionOrder: number
): vscode.NotebookCellExecution {
  const execution = controller.createNotebookCellExecution(cell);
  execution.executionOrder = executionOrder;
  execution.start(Date.now());

  return execution;
}

export function completeCellExecution(
  execution: vscode.NotebookCellExecution,
  outputs: vscode.NotebookCellOutput[],
  success: boolean
): void {
  execution.replaceOutput(outputs);
  execution.end(success, Date.now());
}
