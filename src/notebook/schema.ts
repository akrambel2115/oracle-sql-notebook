import * as vscode from "vscode";

export const NOTEBOOK_SCHEMA_VERSION = 1;

export interface RawNotebookCellV1 {
  kind: "code" | "markup";
  language: string;
  value: string;
  metadata: Record<string, unknown>;
}

export interface RawNotebookV1 {
  schemaVersion: typeof NOTEBOOK_SCHEMA_VERSION;
  metadata: Record<string, unknown>;
  cells: RawNotebookCellV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCellMetadata(metadata: unknown): Record<string, unknown> {
  return isRecord(metadata) ? metadata : {};
}

export function createDefaultRawNotebook(): RawNotebookV1 {
  return {
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    metadata: {},
    cells: [
      {
        kind: "code",
        language: "sql",
        value: "",
        metadata: {}
      }
    ]
  };
}

export function toNotebookData(rawNotebook: RawNotebookV1): vscode.NotebookData {
  const cells = rawNotebook.cells.map((rawCell) => {
    const kind =
      rawCell.kind === "code"
        ? vscode.NotebookCellKind.Code
        : vscode.NotebookCellKind.Markup;

    const cell = new vscode.NotebookCellData(kind, rawCell.value, rawCell.language);
    cell.metadata = normalizeCellMetadata(rawCell.metadata);

    return cell;
  });

  const data = new vscode.NotebookData(cells);
  data.metadata = normalizeCellMetadata(rawNotebook.metadata);

  return data;
}

export function fromNotebookData(data: vscode.NotebookData): RawNotebookV1 {
  const cells: RawNotebookCellV1[] = data.cells.map((cell) => ({
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
    language: cell.languageId ||
      (cell.kind === vscode.NotebookCellKind.Code ? "sql" : "markdown"),
    value: cell.value,
    metadata: normalizeCellMetadata(cell.metadata)
  }));

  return {
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    metadata: normalizeCellMetadata(data.metadata),
    cells
  };
}
