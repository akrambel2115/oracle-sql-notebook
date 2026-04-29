import * as path from "node:path";
import * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../config/settings";
import { Logger } from "../logging/logger";
import { fromNotebookData, RawNotebookV1 } from "../notebook/schema";
import {
  analyzeSqlNotebookText,
  hasBlockingSqlNotebookIssues,
  serializeNotebookToSql
} from "./sqlNotebookText";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExtension(uri: vscode.Uri, extension: string): boolean {
  return uri.path.toLowerCase().endsWith(extension);
}

function tryGetUri(commandArg: unknown): vscode.Uri | undefined {
  if (commandArg instanceof vscode.Uri) {
    return commandArg;
  }

  if (Array.isArray(commandArg) && commandArg.length > 0) {
    return tryGetUri(commandArg[0]);
  }

  if (!isRecord(commandArg)) {
    return undefined;
  }

  const nestedUri =
    ("uri" in commandArg ? commandArg.uri : undefined) ??
    ("resourceUri" in commandArg ? commandArg.resourceUri : undefined);

  return nestedUri instanceof vscode.Uri ? nestedUri : undefined;
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

function isOracleSqlNotebookDocument(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === NOTEBOOK_TYPE || hasExtension(notebook.uri, ".isqlnb");
}

function getSiblingUri(uri: vscode.Uri, extension: "isqlnb" | "sql"): vscode.Uri {
  const parsedPath = path.posix.parse(uri.path);
  return uri.with({
    path: path.posix.join(parsedPath.dir, `${parsedPath.name}.${extension}`)
  });
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function confirmOverwrite(uri: vscode.Uri): Promise<boolean> {
  if (!(await pathExists(uri))) {
    return true;
  }

  const label = uri.scheme === "file" ? uri.fsPath : uri.toString();
  const choice = await vscode.window.showWarningMessage(
    `${label} already exists. Overwrite it?`,
    { modal: true },
    "Overwrite"
  );

  return choice === "Overwrite";
}

async function showConvertedMessage(
  message: string,
  destination: vscode.Uri
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, "Open");

  if (choice === "Open") {
    await vscode.commands.executeCommand("vscode.open", destination);
  }
}

async function confirmStructuredSqlWarnings(messages: string[]): Promise<boolean> {
  const uniqueMessages = [...new Set(messages)];

  if (uniqueMessages.length === 0) {
    return true;
  }

  const details = uniqueMessages.slice(0, 3).join("\n- ");
  const suffix =
    uniqueMessages.length > 3
      ? `\n- ...and ${uniqueMessages.length - 3} more warning(s)`
      : "";
  const choice = await vscode.window.showWarningMessage(
    `This SQL file does not fully follow the Oracle SQL Notebook conversion format.\n\n- ${details}${suffix}`,
    { modal: true },
    "Convert Anyway"
  );

  return choice === "Convert Anyway";
}

async function resolveNotebookForConversion(
  commandArg?: unknown
): Promise<vscode.NotebookDocument | undefined> {
  let targetNotebook = tryGetNotebookDocument(commandArg);

  if (!targetNotebook && isRecord(commandArg) && "notebook" in commandArg) {
    targetNotebook = tryGetNotebookDocument(commandArg.notebook);
  }

  const notebookUri = targetNotebook ? undefined : tryGetUri(commandArg);

  if (!targetNotebook && notebookUri) {
    targetNotebook = vscode.workspace.notebookDocuments.find(
      (document) => document.uri.toString() === notebookUri.toString()
    );

    if (!targetNotebook) {
      targetNotebook = await vscode.workspace.openNotebookDocument(notebookUri);
    }
  }

  if (!targetNotebook) {
    targetNotebook = vscode.window.activeNotebookEditor?.notebook;
  }

  if (!targetNotebook || !isOracleSqlNotebookDocument(targetNotebook)) {
    void vscode.window.showErrorMessage(
      "Open or select an Oracle SQL Notebook (.isqlnb) to convert it to SQL."
    );
    return undefined;
  }

  return targetNotebook;
}

async function showBlockingSqlIssues(messages: string[]): Promise<void> {
  const uniqueMessages = [...new Set(messages)];
  const details = uniqueMessages.slice(0, 3).join("\n- ");
  const suffix =
    uniqueMessages.length > 3
      ? `\n- ...and ${uniqueMessages.length - 3} more blocking issue(s)`
      : "";

  await vscode.window.showErrorMessage(
    `Fix the notebook SQL conversion format issues before converting.\n\n- ${details}${suffix}`,
    { modal: true }
  );
}

function resolveSqlUri(commandArg?: unknown): vscode.Uri | undefined {
  const uri = tryGetUri(commandArg) ?? vscode.window.activeTextEditor?.document.uri;

  if (!uri || !hasExtension(uri, ".sql")) {
    void vscode.window.showErrorMessage(
      "Open or select a SQL file (.sql) to convert it to an Oracle SQL Notebook."
    );
    return undefined;
  }

  return uri;
}

function notebookToRawNotebook(notebook: vscode.NotebookDocument): RawNotebookV1 {
  return fromNotebookData(
    new vscode.NotebookData(
      notebook.getCells().map((cell) => {
        const data = new vscode.NotebookCellData(
          cell.kind,
          cell.document.getText(),
          cell.document.languageId
        );
        data.metadata = cell.metadata;
        return data;
      })
    )
  );
}

export async function convertNotebookToSqlCommand(
  logger: Logger,
  commandArg?: unknown
): Promise<void> {
  try {
    const notebook = await resolveNotebookForConversion(commandArg);

    if (!notebook) {
      return;
    }

    const destination = getSiblingUri(notebook.uri, "sql");

    if (!(await confirmOverwrite(destination))) {
      return;
    }

    const rawNotebook = notebookToRawNotebook(notebook);
    rawNotebook.metadata = isRecord(notebook.metadata) ? notebook.metadata : {};

    await vscode.workspace.fs.writeFile(
      destination,
      textEncoder.encode(serializeNotebookToSql(rawNotebook))
    );

    await showConvertedMessage(
      `Oracle SQL Notebook converted to SQL: ${
        destination.scheme === "file" ? destination.fsPath : destination.toString()
      }`,
      destination
    );
  } catch (error) {
    logger.error("Failed to convert notebook to SQL.", error);
    void vscode.window.showErrorMessage(
      `Failed to convert notebook to SQL: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function convertSqlToNotebookCommand(
  logger: Logger,
  commandArg?: unknown
): Promise<void> {
  try {
    const source = resolveSqlUri(commandArg);

    if (!source) {
      return;
    }

    const destination = getSiblingUri(source, "isqlnb");

    if (!(await confirmOverwrite(destination))) {
      return;
    }

    const sqlText = textDecoder.decode(await vscode.workspace.fs.readFile(source));
    const analysis = analyzeSqlNotebookText(sqlText);

    if (!analysis.isPairedFormat) {
      await vscode.workspace.fs.writeFile(
        destination,
        textEncoder.encode(JSON.stringify(analysis.notebook, null, 2))
      );

      await showConvertedMessage(
        `SQL converted to Oracle SQL Notebook: ${
          destination.scheme === "file" ? destination.fsPath : destination.toString()
        }`,
        destination
      );
      return;
    }

    const blockingMessages = analysis.issues
      .filter((issue) => issue.isBlocking)
      .map((issue) => issue.message);

    if (hasBlockingSqlNotebookIssues(analysis.issues)) {
      await showBlockingSqlIssues(blockingMessages);
      return;
    }

    const warningMessages = analysis.issues
      .filter((issue) => !issue.isBlocking)
      .map((issue) => issue.message);

    if (!(await confirmStructuredSqlWarnings(warningMessages))) {
      return;
    }

    await vscode.workspace.fs.writeFile(
      destination,
      textEncoder.encode(JSON.stringify(analysis.notebook, null, 2))
    );

    await showConvertedMessage(
      `SQL converted to Oracle SQL Notebook: ${
        destination.scheme === "file" ? destination.fsPath : destination.toString()
      }`,
      destination
    );
  } catch (error) {
    logger.error("Failed to convert SQL to notebook.", error);
    void vscode.window.showErrorMessage(
      `Failed to convert SQL to notebook: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
