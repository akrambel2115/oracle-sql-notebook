import {
  createDefaultRawNotebook,
  NOTEBOOK_SCHEMA_VERSION,
  RawNotebookCellV1,
  RawNotebookV1
} from "./schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCell(raw: unknown): RawNotebookCellV1 | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const rawKind =
    typeof raw.kind === "string"
      ? raw.kind
      : typeof raw.cell_type === "string"
        ? raw.cell_type
        : "code";

  const kind: RawNotebookCellV1["kind"] =
    rawKind === "markup" || rawKind === "markdown" ? "markup" : "code";

  const language =
    typeof raw.language === "string" && raw.language.trim().length > 0
      ? raw.language.trim()
      : kind === "code"
        ? "sql"
        : "markdown";

  let value = "";

  if (typeof raw.value === "string") {
    value = raw.value;
  } else if (typeof raw.source === "string") {
    value = raw.source;
  } else if (Array.isArray(raw.source)) {
    value = raw.source
      .filter((part): part is string => typeof part === "string")
      .join("");
  }

  const metadata = isRecord(raw.metadata) ? raw.metadata : {};

  return {
    kind,
    language,
    value,
    metadata
  };
}

export function migrateNotebookPayload(parsed: unknown): RawNotebookV1 {
  if (!isRecord(parsed)) {
    return createDefaultRawNotebook();
  }

  const schemaVersion =
    typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;

  if (schemaVersion !== NOTEBOOK_SCHEMA_VERSION && schemaVersion !== 0) {
    throw new Error(`Unsupported notebook schema version: ${schemaVersion}.`);
  }

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};

  const normalizedCells = Array.isArray(parsed.cells)
    ? parsed.cells
        .map((rawCell) => normalizeCell(rawCell))
        .filter((cell): cell is RawNotebookCellV1 => cell !== undefined)
    : [];

  return {
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    metadata,
    cells:
      normalizedCells.length > 0
        ? normalizedCells
        : createDefaultRawNotebook().cells
  };
}
