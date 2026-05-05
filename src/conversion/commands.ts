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

type DestinationExtension = "isqlnb" | "sql";

interface ConversionPaths {
  source: vscode.Uri;
  destination: vscode.Uri;
}

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

function getUriLabel(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function getSiblingUri(uri: vscode.Uri, extension: DestinationExtension): vscode.Uri {
  const parsedPath = path.posix.parse(uri.path);
  return uri.with({
    path: path.posix.join(parsedPath.dir, `${parsedPath.name}.${extension}`)
  });
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return false;
    }

    throw new Error(
      `Could not check whether '${getUriLabel(uri)}' exists: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function pickDestinationUri(
  defaultUri: vscode.Uri,
  extension: DestinationExtension
): Promise<vscode.Uri | undefined> {
  const destination = await vscode.window.showSaveDialog({
    defaultUri,
    filters: {
      [extension === "sql" ? "SQL" : "Oracle SQL Notebook"]: [extension]
    },
    saveLabel: extension === "sql" ? "Convert to SQL" : "Convert to Notebook"
  });

  if (!destination) {
    return undefined;
  }

  if (!hasExtension(destination, `.${extension}`)) {
    void vscode.window.showErrorMessage(
      `Choose a destination file ending in .${extension}.`
    );
    return undefined;
  }

  return destination;
}

async function resolveDestinationUri(
  defaultUri: vscode.Uri,
  extension: DestinationExtension
): Promise<vscode.Uri | undefined> {
  const destination = await pickDestinationUri(defaultUri, extension);

  if (!destination) {
    return undefined;
  }

  if (!(await pathExists(destination))) {
    return destination;
  }

  const choice = await vscode.window.showWarningMessage(
    `${getUriLabel(destination)} already exists. Overwrite it?`,
    { modal: true },
    "Overwrite"
  );

  if (choice !== "Overwrite") {
    return undefined;
  }

  return destination;
}

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  try {
    await vscode.workspace.fs.writeFile(uri, textEncoder.encode(contents));
  } catch (error) {
    throw new Error(
      `Could not write '${getUriLabel(uri)}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  try {
    return textDecoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    throw new Error(
      `Could not read '${getUriLabel(uri)}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function formatConversionError(
  direction: string,
  error: unknown,
  paths?: Partial<ConversionPaths>
): string {
  const details = error instanceof Error ? error.message : String(error);
  const source = paths?.source ? `\nSource: ${getUriLabel(paths.source)}` : "";
  const destination = paths?.destination
    ? `\nDestination: ${getUriLabel(paths.destination)}`
    : "";

  return `Failed to convert ${direction}.${source}${destination}\n\n${details}`;
}

async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function stringifyNotebook(rawNotebook: RawNotebookV1): string {
  return JSON.stringify(rawNotebook);
}

async function runConversionWithProgress<T>(
  title: string,
  task: () => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    async () => task()
  );
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
  const paths: Partial<ConversionPaths> = {};

  try {
    const notebook = await resolveNotebookForConversion(commandArg);

    if (!notebook) {
      return;
    }

    paths.source = notebook.uri;
    const destination = await resolveDestinationUri(getSiblingUri(notebook.uri, "sql"), "sql");

    if (!destination) {
      return;
    }

    paths.destination = destination;

    await runConversionWithProgress(
      "Converting Oracle SQL Notebook to SQL",
      async () => {
        await yieldToUi();
        const rawNotebook = notebookToRawNotebook(notebook);
        rawNotebook.metadata = isRecord(notebook.metadata) ? notebook.metadata : {};
        await writeTextFile(destination, serializeNotebookToSql(rawNotebook));
      }
    );

    await showConvertedMessage(
      `Oracle SQL Notebook converted to SQL: ${getUriLabel(destination)}`,
      destination
    );
  } catch (error) {
    logger.error("Failed to convert notebook to SQL.", error);
    void vscode.window.showErrorMessage(formatConversionError("notebook to SQL", error, paths));
  }
}

export async function convertSqlToNotebookCommand(
  logger: Logger,
  commandArg?: unknown
): Promise<void> {
  const paths: Partial<ConversionPaths> = {};

  try {
    const source = resolveSqlUri(commandArg);

    if (!source) {
      return;
    }

    paths.source = source;
    const destination = await resolveDestinationUri(getSiblingUri(source, "isqlnb"), "isqlnb");

    if (!destination) {
      return;
    }

    paths.destination = destination;

    const analysis = await runConversionWithProgress(
      "Reading and analyzing SQL",
      async () => {
        const sqlText = await readTextFile(source);
        await yieldToUi();
        return analyzeSqlNotebookText(sqlText);
      }
    );

    if (!analysis.isPairedFormat) {
      await writeTextFile(destination, stringifyNotebook(analysis.notebook));

      await showConvertedMessage(
        `SQL converted to Oracle SQL Notebook: ${getUriLabel(destination)}`,
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

    await writeTextFile(destination, stringifyNotebook(analysis.notebook));

    await showConvertedMessage(
      `SQL converted to Oracle SQL Notebook: ${getUriLabel(destination)}`,
      destination
    );
  } catch (error) {
    logger.error("Failed to convert SQL to notebook.", error);
    void vscode.window.showErrorMessage(formatConversionError("SQL to notebook", error, paths));
  }
}
