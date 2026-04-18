import * as vscode from "vscode";

import { findConnectionProfile, resolveConnectionAlias } from "../config/profileStore";
import {
  ConnectionProfile,
  getDefaultConnectionAlias,
  getExecutionSettings,
  getPoolSettings,
  getSecuritySettings,
  NOTEBOOK_TYPE
} from "../config/settings";
import { QueryExecutor } from "../db/queryExecutor";
import { Logger } from "../logging/logger";
import {
  buildErrorOutputs,
  buildSuccessOutputsForBatch
} from "../output/outputFactory";
import { toSafeErrorMessage } from "../security/redaction";
import { SecretStore } from "../security/secrets";
import { ensureTrustedWorkspace } from "../security/workspaceTrust";
import { completeCellExecution, startCellExecution } from "./executionLifecycle";

interface OracleNotebookControllerDependencies {
  queryExecutor: QueryExecutor;
  secretStore: SecretStore;
  logger: Logger;
  testMode?: boolean;
}

const CONFIGURE_CONNECTION_COMMAND = "oracleSqlNotebook.configureConnection";
const TEST_PROFILE: ConnectionProfile = {
  alias: "__test__",
  user: "test",
  connectString: "test"
};

export class OracleNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly promptedNotebookUris = new Set<string>();
  private executionOrder = 0;

  public constructor(private readonly deps: OracleNotebookControllerDependencies) {
    this.controller = vscode.notebooks.createNotebookController(
      "oracle-sql-notebook-controller",
      NOTEBOOK_TYPE,
      "Oracle SQL"
    );

    this.controller.supportedLanguages = ["sql"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) =>
      this.executeCells(cells, notebook);
    this.controller.interruptHandler = () => this.handleInterrupt();

    this.disposables.push(
      this.controller.onDidChangeSelectedNotebooks((event) => {
        if (event.selected) {
          void this.handleNotebookControllerSelected(event.notebook);
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        if (notebook.notebookType !== NOTEBOOK_TYPE) {
          return;
        }

        const sessionKey = notebook.uri.toString();
        this.promptedNotebookUris.delete(sessionKey);
        void this.deps.queryExecutor.closeSession?.(sessionKey);
      })
    );
  }

  public dispose(): void {
    void this.deps.queryExecutor.closeAllSessions?.();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.controller.dispose();
  }

  public async runCellsForTesting(
    notebook: vscode.NotebookDocument,
    start = 0,
    end = notebook.cellCount
  ): Promise<void> {
    this.controller.updateNotebookAffinity(
      notebook,
      vscode.NotebookControllerAffinity.Preferred
    );

    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(end, notebook.cellCount);
    const cells = notebook.getCells().slice(safeStart, safeEnd);

    await this.executeCells(cells, notebook);
  }

  private async executeCells(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    for (const cell of cells) {
      await this.executeCell(cell, notebook);
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return;
    }

    const execution = startCellExecution(
      this.controller,
      cell,
      ++this.executionOrder
    );

    try {
      if (!this.deps.testMode) {
        ensureTrustedWorkspace();
      }

      const sql = cell.document.getText().trim();

      if (!sql) {
        completeCellExecution(
          execution,
          buildErrorOutputs("The SQL cell is empty."),
          false
        );
        return;
      }

      const { profile, password } = await this.resolveExecutionCredentials(
        notebook
      );

      const results = await this.deps.queryExecutor.executeScript({
        profile,
        password,
        sql,
        sessionKey: notebook.uri.toString(),
        executionSettings: getExecutionSettings(),
        poolSettings: getPoolSettings(),
        securitySettings: getSecuritySettings(),
        cancellationToken: execution.token
      });

      completeCellExecution(
        execution,
        buildSuccessOutputsForBatch(results),
        true
      );
    } catch (error) {
      const safeMessage =
        error instanceof vscode.CancellationError
          ? "Execution canceled by user."
          : toSafeErrorMessage(error);

      this.deps.logger.error("Notebook cell execution failed.", { safeMessage });
      completeCellExecution(execution, buildErrorOutputs(safeMessage), false);
    }
  }

  private handleInterrupt(): void {
    this.deps.logger.info(
      "Interrupt requested. Active Oracle calls receive cancellation signals."
    );
  }

  private async handleNotebookControllerSelected(
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    if (this.deps.testMode) {
      return;
    }

    const notebookKey = notebook.uri.toString();

    if (this.promptedNotebookUris.has(notebookKey)) {
      return;
    }

    const needsSetup = await this.needsConnectionSetup(notebook);

    if (!needsSetup) {
      return;
    }

    this.promptedNotebookUris.add(notebookKey);

    try {
      const selection = await vscode.window.showInformationMessage(
        "Oracle SQL kernel selected. Configure a connection now?",
        "Configure Connection",
        "Later"
      );

      if (selection === "Configure Connection") {
        await vscode.commands.executeCommand(
          CONFIGURE_CONNECTION_COMMAND,
          notebook
        );
      }
    } finally {
      this.promptedNotebookUris.delete(notebookKey);
    }
  }

  private async needsConnectionSetup(
    notebook: vscode.NotebookDocument
  ): Promise<boolean> {
    const alias = resolveConnectionAlias(notebook, getDefaultConnectionAlias());

    if (!alias) {
      return true;
    }

    const profile = findConnectionProfile(alias);

    if (!profile) {
      return true;
    }

    const password = await this.deps.secretStore.getConnectionPassword(profile.alias);
    return !password;
  }

  private async resolveExecutionCredentials(
    notebook: vscode.NotebookDocument
  ): Promise<{ profile: ConnectionProfile; password: string }> {
    if (this.deps.testMode) {
      return {
        profile: TEST_PROFILE,
        password: "test"
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const alias = resolveConnectionAlias(notebook, getDefaultConnectionAlias());

      if (!alias) {
        if (
          attempt === 0 &&
          (await this.promptConnectionSetup(
            notebook,
            "No connection alias configured for this notebook."
          ))
        ) {
          continue;
        }

        throw new Error(
          "No connection alias configured. Set oracleSqlNotebook.defaultConnectionAlias in settings or add notebook metadata.connectionAlias."
        );
      }

      const profile = findConnectionProfile(alias);

      if (!profile) {
        if (
          attempt === 0 &&
          (await this.promptConnectionSetup(
            notebook,
            `Connection alias '${alias}' was not found.`
          ))
        ) {
          continue;
        }

        throw new Error(
          `Connection alias '${alias}' was not found in oracleSqlNotebook.connections.`
        );
      }

      const password = await this.deps.secretStore.getConnectionPassword(
        profile.alias
      );

      if (!password) {
        if (
          attempt === 0 &&
          (await this.promptConnectionSetup(
            notebook,
            `No password stored for alias '${profile.alias}'.`
          ))
        ) {
          continue;
        }

        throw new Error(
          `No password stored for alias '${profile.alias}'. Run 'Oracle SQL Notebook: Set Connection Password'.`
        );
      }

      return {
        profile,
        password
      };
    }

    throw new Error("Unable to resolve Oracle connection credentials.");
  }

  private async promptConnectionSetup(
    notebook: vscode.NotebookDocument,
    reason: string
  ): Promise<boolean> {
    const selection = await vscode.window.showWarningMessage(
      `${reason} Configure Oracle connection now?`,
      "Configure Connection",
      "Cancel"
    );

    if (selection !== "Configure Connection") {
      return false;
    }

    await vscode.commands.executeCommand(CONFIGURE_CONNECTION_COMMAND, notebook);
    return true;
  }
}
