import * as vscode from "vscode";

export class WorkspaceTrustError extends Error {
  public constructor() {
    super(
      "Oracle SQL Notebook execution requires a trusted workspace. Use Workspace Trust to continue."
    );
    this.name = "WorkspaceTrustError";
  }
}

export function ensureTrustedWorkspace(): void {
  if (!vscode.workspace.isTrusted) {
    throw new WorkspaceTrustError();
  }
}

export async function promptWorkspaceTrustIfNeeded(): Promise<void> {
  if (vscode.workspace.isTrusted) {
    return;
  }

  const selection = await vscode.window.showWarningMessage(
    "Oracle SQL Notebook actions require a trusted workspace.",
    "Manage Workspace Trust"
  );

  if (selection) {
    await vscode.commands.executeCommand("workbench.trust.manage");
  }
}
