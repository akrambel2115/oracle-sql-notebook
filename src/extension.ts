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
import { OraclePoolManager } from "./db/poolManager";
import { OracleQueryExecutor, QueryExecutor } from "./db/queryExecutor";
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
    value: existingProfile?.user ?? "",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length > 0 ? undefined : "User is required."
  });

  if (userInput === undefined) {
    return;
  }

  const connectStringInput = await vscode.window.showInputBox({
    title: `Configure '${alias}'`,
    prompt: "Connect string (example: localhost:1521/XEPDB1)",
    value: existingProfile?.connectString ?? "",
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

  context.subscriptions.push(logger);
  context.subscriptions.push(notebookController);

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
    vscode.commands.registerCommand(
      "oracleSqlNotebook.configureConnection",
      async (notebook?: vscode.NotebookDocument) => {
        await runConfigureConnectionWizard(secretStore, notebook);
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
