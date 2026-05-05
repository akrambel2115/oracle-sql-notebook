import * as vscode from "vscode";

import { findConnectionProfile, resolveConnectionAlias } from "./config/profileStore";
import {
  ConnectionProfile,
  EXTENSION_ID,
  getConnectionProfiles,
  getDefaultConnectionAlias,
  getLoggingLevel,
  NOTEBOOK_TYPE
} from "./config/settings";
import {
  convertNotebookToSqlCommand,
  convertSqlToNotebookCommand
} from "./conversion/commands";
import { SqlNotebookValidationProvider } from "./conversion/validation";
import { OraclePoolManager } from "./db/poolManager";
import { OracleQueryExecutor, QueryExecutor } from "./db/queryExecutor";
import { NotebookExportFormat, exportNotebook } from "./export/notebookExporter";
import { Logger } from "./logging/logger";
import { OracleNotebookController } from "./notebook/controller";
import { OracleSqlNotebookSerializer } from "./notebook/serializer";
import { SecretStore } from "./security/secrets";
import { promptWorkspaceTrustIfNeeded } from "./security/workspaceTrust";
import { FakeQueryExecutor } from "./testing/fakeQueryExecutor";

export interface OracleSqlNotebookExtensionApi {
  runNotebookCellsForTesting?: (
    notebook: vscode.NotebookDocument,
    start?: number,
    end?: number
  ) => Promise<void>;
}

function getAvailableAliases(): string[] {
  return getConnectionProfiles().map((profile) => profile.alias);
}

async function pickAlias(title: string): Promise<string | undefined> {
  const aliases = getAvailableAliases();

  if (aliases.length === 0) {
    void vscode.window.showWarningMessage(
      "No Oracle connection aliases found. Add oracleSqlNotebook.connections in settings first."
    );
    return undefined;
  }

  if (aliases.length === 1) {
    return aliases[0];
  }

  return vscode.window.showQuickPick(aliases, {
    title,
    canPickMany: false,
    ignoreFocusOut: true
  });
}

async function ensureTrustedWorkspaceForCommand(): Promise<boolean> {
  if (vscode.workspace.isTrusted) {
    return true;
  }

  await promptWorkspaceTrustIfNeeded();
  return false;
}

function getSettingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasIsqlnbExtension(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith(".isqlnb");
}

function isOracleSqlNotebookDocument(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === NOTEBOOK_TYPE || hasIsqlnbExtension(notebook.uri);
}

async function updateNotebookConnectionAlias(
  notebook: vscode.NotebookDocument,
  alias: string
): Promise<void> {
  const currentMetadata = isRecord(notebook.metadata) ? notebook.metadata : {};
  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    connectionAlias: alias
  };
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(nextMetadata)]);
  await vscode.workspace.applyEdit(edit);
}

function tryGetNotebookDocument(
  commandArg: unknown
): vscode.NotebookDocument | undefined {
  if (!isRecord(commandArg)) {
    return undefined;
  }

  const notebookType = commandArg.notebookType;
  const uri = commandArg.uri;
  const getCells = commandArg.getCells;

  if (
    typeof notebookType !== "string" ||
    !(uri instanceof vscode.Uri) ||
    typeof getCells !== "function"
  ) {
    return undefined;
  }

  return commandArg as unknown as vscode.NotebookDocument;
}

function tryGetNotebookUri(commandArg: unknown): vscode.Uri | undefined {
  if (commandArg instanceof vscode.Uri) {
    return commandArg;
  }

  if (Array.isArray(commandArg) && commandArg.length > 0) {
    return tryGetNotebookUri(commandArg[0]);
  }

  if (!isRecord(commandArg)) {
    return undefined;
  }

  const nestedUri =
    ("uri" in commandArg ? commandArg.uri : undefined) ??
    ("resourceUri" in commandArg ? commandArg.resourceUri : undefined);

  return nestedUri instanceof vscode.Uri ? nestedUri : undefined;
}

async function resolveNotebookForExportCommand(
  commandArg?: unknown
): Promise<vscode.NotebookDocument | undefined> {
  let targetNotebook = tryGetNotebookDocument(commandArg);

  if (!targetNotebook && isRecord(commandArg) && "notebook" in commandArg) {
    targetNotebook = tryGetNotebookDocument(commandArg.notebook);
  }

  const notebookUri = targetNotebook ? undefined : tryGetNotebookUri(commandArg);

  if (!targetNotebook && notebookUri) {
    targetNotebook = vscode.workspace.notebookDocuments.find(
      (document) => document.uri.toString() === notebookUri.toString()
    );

    if (!targetNotebook) {
      try {
        targetNotebook = await vscode.workspace.openNotebookDocument(notebookUri);
      } catch {
        targetNotebook = undefined;
      }
    }
  }

  if (!targetNotebook) {
    targetNotebook = vscode.window.activeNotebookEditor?.notebook;
  }

  if (!targetNotebook) {
    void vscode.window.showErrorMessage(
      "Open an Oracle SQL Notebook (.isqlnb) to export it."
    );
    return undefined;
  }

  if (!isOracleSqlNotebookDocument(targetNotebook)) {
    void vscode.window.showErrorMessage(
      "The selected notebook is not an Oracle SQL Notebook (.isqlnb)."
    );
    return undefined;
  }

  return targetNotebook;
}

async function runNotebookExportCommand(
  format: NotebookExportFormat,
  logger: Logger,
  commandArg?: unknown
): Promise<void> {
  const targetNotebook = await resolveNotebookForExportCommand(commandArg);

  if (!targetNotebook) {
    return;
  }

  const formatLabel = format === "html" ? "HTML" : "PDF";

  try {
    const destination = await exportNotebook(targetNotebook, format);

    if (!destination) {
      return;
    }

    const destinationLabel =
      destination.scheme === "file" ? destination.fsPath : destination.toString();

    void vscode.window.showInformationMessage(
      `Oracle SQL Notebook exported as ${formatLabel}: ${destinationLabel}`
    );
  } catch (error) {
    logger.error(`Failed to export notebook as ${formatLabel}.`, error);
    void vscode.window.showErrorMessage(
      `Failed to export notebook as ${formatLabel}: ${getErrorMessage(error)}`
    );
  }
}

async function runConfigureConnectionWizard(
  secretStore: SecretStore,
  notebook?: vscode.NotebookDocument
): Promise<void> {
  if (!(await ensureTrustedWorkspaceForCommand())) {
    return;
  }

  const config = vscode.workspace.getConfiguration(EXTENSION_ID);
  const profiles = getConnectionProfiles(config);
  const fallbackAlias = getDefaultConnectionAlias(config);
  const initialAlias = notebook
    ? resolveConnectionAlias(notebook, fallbackAlias) ?? fallbackAlias ?? "dev"
    : fallbackAlias ?? "dev";

  const aliasInput = await vscode.window.showInputBox({
    title: "Configure Oracle Connection",
    prompt: "Connection alias",
    value: initialAlias,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length > 0 ? undefined : "Alias is required."
  });

  if (aliasInput === undefined) {
    return;
  }

  const alias = aliasInput.trim();
  const existingProfile = profiles.find(
    (profile) => profile.alias.toLowerCase() === alias.toLowerCase()
  );

  const userInput = await vscode.window.showInputBox({
    title: `Configure '${alias}'`,
    prompt: "Oracle user",
    value: existingProfile?.user ?? "imijdbManager",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length > 0 ? undefined : "User is required."
  });

  if (userInput === undefined) {
    return;
  }

  const connectStringInput = await vscode.window.showInputBox({
    title: `Configure '${alias}'`,
    prompt: "Connect string (example: localhost:1521/XE)",
    value: existingProfile?.connectString ?? "localhost:1521/XE",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length > 0 ? undefined : "Connect string is required."
  });

  if (connectStringInput === undefined) {
    return;
  }

  const existingPassword = await secretStore.getConnectionPassword(alias);
  const passwordInput = await vscode.window.showInputBox({
    title: `Configure '${alias}'`,
    prompt: existingPassword
      ? "Password (leave empty to keep current secret)"
      : "Password",
    password: true,
    ignoreFocusOut: true
  });

  if (passwordInput === undefined) {
    return;
  }

  const password = passwordInput.trim();

  if (!existingPassword && password.length === 0) {
    void vscode.window.showErrorMessage(
      "Password is required for a new Oracle connection."
    );
    return;
  }

  const updatedProfile: ConnectionProfile = {
    alias,
    user: userInput.trim(),
    connectString: connectStringInput.trim()
  };

  if (existingProfile?.poolMin !== undefined) {
    updatedProfile.poolMin = existingProfile.poolMin;
  }

  if (existingProfile?.poolMax !== undefined) {
    updatedProfile.poolMax = existingProfile.poolMax;
  }

  if (existingProfile?.poolIncrement !== undefined) {
    updatedProfile.poolIncrement = existingProfile.poolIncrement;
  }

  const updatedProfiles = profiles.filter(
    (profile) => profile.alias.toLowerCase() !== alias.toLowerCase()
  );
  updatedProfiles.push(updatedProfile);

  const target = getSettingsTarget();
  const defaultAlias = getDefaultConnectionAlias(config);

  await config.update("connections", updatedProfiles, target);

  if (!defaultAlias) {
    await config.update("defaultConnectionAlias", alias, target);
  }

  if (password.length > 0) {
    await secretStore.setConnectionPassword(alias, password);
  }

  if (notebook && isOracleSqlNotebookDocument(notebook)) {
    await updateNotebookConnectionAlias(notebook, alias);
  }

  void vscode.window.showInformationMessage(
    `Oracle connection '${alias}' has been configured.`
  );
}

export function activate(
  context: vscode.ExtensionContext
): OracleSqlNotebookExtensionApi {
  const testMode =
    context.extensionMode === vscode.ExtensionMode.Test ||
    process.env.ORACLE_SQL_NOTEBOOK_TEST_MODE === "1";
  const logger = new Logger(getLoggingLevel());
  const secretStore = new SecretStore(context.secrets);
  let queryExecutor: QueryExecutor;

  if (testMode) {
    queryExecutor = new FakeQueryExecutor();
  } else {
    const poolManager = new OraclePoolManager(logger);
    queryExecutor = new OracleQueryExecutor(poolManager, logger);
    context.subscriptions.push({ dispose: () => poolManager.dispose() });
  }

  const notebookController = new OracleNotebookController({
    queryExecutor,
    secretStore,
    logger,
    testMode
  });
  const sqlNotebookValidation = new SqlNotebookValidationProvider();

  context.subscriptions.push(logger);
  context.subscriptions.push(notebookController);
  context.subscriptions.push(sqlNotebookValidation);

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      NOTEBOOK_TYPE,
      new OracleSqlNotebookSerializer(),
      {
        transientOutputs: true
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${EXTENSION_ID}.logging.level`)) {
        logger.setLevel(getLoggingLevel());
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: "sql" },
      sqlNotebookValidation,
      {
        providedCodeActionKinds: SqlNotebookValidationProvider.providedCodeActionKinds
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      sqlNotebookValidation.validateDocument(document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      sqlNotebookValidation.debounceValidateDocument(event.document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      sqlNotebookValidation.validateDocument(document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      sqlNotebookValidation.clearDocument(document.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.configureConnection",
      async (notebook?: vscode.NotebookDocument) => {
        const targetNotebook =
          notebook ??
          (vscode.window.activeNotebookEditor?.notebook &&
          isOracleSqlNotebookDocument(vscode.window.activeNotebookEditor.notebook)
            ? vscode.window.activeNotebookEditor.notebook
            : undefined);

        await runConfigureConnectionWizard(secretStore, targetNotebook);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.setConnectionPassword",
      async () => {
        if (!(await ensureTrustedWorkspaceForCommand())) {
          return;
        }

        const alias = await pickAlias("Select Oracle alias for password update");

        if (!alias) {
          return;
        }

        const profile = findConnectionProfile(alias);

        if (!profile) {
          void vscode.window.showErrorMessage(
            `Connection alias '${alias}' was not found.`
          );
          return;
        }

        const password = await vscode.window.showInputBox({
          title: `Set password for alias '${profile.alias}'`,
          password: true,
          ignoreFocusOut: true,
          prompt: "Password is stored securely in VS Code SecretStorage."
        });

        if (password === undefined) {
          return;
        }

        if (!password.trim()) {
          void vscode.window.showErrorMessage("Password cannot be empty.");
          return;
        }

        await secretStore.setConnectionPassword(profile.alias, password);
        void vscode.window.showInformationMessage(
          `Password saved for alias '${profile.alias}'.`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.clearConnectionPassword",
      async () => {
        if (!(await ensureTrustedWorkspaceForCommand())) {
          return;
        }

        const alias = await pickAlias("Select Oracle alias to clear password");

        if (!alias) {
          return;
        }

        await secretStore.clearConnectionPassword(alias);
        void vscode.window.showInformationMessage(
          `Password cleared for alias '${alias}'.`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.exportHtml",
      async (commandArg?: unknown) => {
        await runNotebookExportCommand("html", logger, commandArg);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.exportPdf",
      async (commandArg?: unknown) => {
        await runNotebookExportCommand("pdf", logger, commandArg);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.convertNotebookToSql",
      async (commandArg?: unknown) => {
        await convertNotebookToSqlCommand(logger, commandArg);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "oracleSqlNotebook.convertSqlToNotebook",
      async (commandArg?: unknown) => {
        await convertSqlToNotebookCommand(logger, commandArg);
      }
    )
  );

  logger.info("Oracle SQL Notebook extension activated.");

  if (!testMode) {
    return {};
  }

  return {
    runNotebookCellsForTesting: async (
      notebook: vscode.NotebookDocument,
      start?: number,
      end?: number
    ): Promise<void> => {
      await notebookController.runCellsForTesting(notebook, start, end);
    }
  };
}

export function deactivate(): void {
  // Resource disposal is handled via ExtensionContext subscriptions.
}
