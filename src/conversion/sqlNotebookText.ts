import {
  createDefaultRawNotebook,
  NOTEBOOK_SCHEMA_VERSION,
  RawNotebookCellV1,
  RawNotebookV1
} from "../notebook/schema";

export const SQL_NOTEBOOK_HEADER_PREFIX = "-- oracle-sql-notebook:";

const CELL_MARKER_PREFIX = "-- %%";
const CELL_MARKER_PATTERN = /^--\s*%%(?:\s*\[([^\]]+)\])?(?:\s*(.*))?$/u;

export type SqlNotebookValidationSeverity = "warning";

export type SqlNotebookValidationIssueCode =
  | "missingHeader"
  | "invalidHeaderJson"
  | "invalidHeaderMetadata"
  | "unsupportedSchemaVersion"
  | "invalidCellMarkerJson"
  | "invalidCellMarkerMetadata"
  | "strayTextOutsideCells"
  | "markdownLineMissingCommentPrefix"
  | "unsupportedCellLanguage"
  | "nonCanonicalMarkupLanguage"
  | "missingCellMarkers";

export interface SqlNotebookTextRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface SqlNotebookQuickFix {
  title: string;
  replacementText: string;
  range: SqlNotebookTextRange;
}

export interface SqlNotebookValidationIssue {
  code: SqlNotebookValidationIssueCode;
  message: string;
  severity: SqlNotebookValidationSeverity;
  isBlocking: boolean;
  range: SqlNotebookTextRange;
  quickFix?: SqlNotebookQuickFix;
}

export interface SqlNotebookAnalysisResult {
  isPairedFormat: boolean;
  notebook: RawNotebookV1;
  issues: SqlNotebookValidationIssue[];
}

interface HeaderPayload {
  schemaVersion?: unknown;
  metadata?: unknown;
}

interface ParsedCellMarker {
  kind: "code" | "markup";
  language: string;
  metadata: Record<string, unknown>;
}

interface LineEntry {
  lineIndex: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> {
  return isRecord(metadata) ? metadata : {};
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function createRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number
): SqlNotebookTextRange {
  return {
    startLine,
    startCharacter,
    endLine,
    endCharacter
  };
}

function createLineRange(lineIndex: number, lineText: string): SqlNotebookTextRange {
  return createRange(lineIndex, 0, lineIndex, lineText.length);
}

function createInsertionRange(lineIndex: number, character: number): SqlNotebookTextRange {
  return createRange(lineIndex, character, lineIndex, character);
}

function createIssue(
  code: SqlNotebookValidationIssueCode,
  message: string,
  range: SqlNotebookTextRange,
  isBlocking: boolean,
  quickFix?: SqlNotebookQuickFix
): SqlNotebookValidationIssue {
  const issue: SqlNotebookValidationIssue = {
    code,
    message,
    severity: "warning",
    isBlocking,
    range
  };

  if (quickFix) {
    issue.quickFix = quickFix;
  }

  return issue;
}

function buildHeaderLine(metadata: Record<string, unknown>): string {
  return `${SQL_NOTEBOOK_HEADER_PREFIX} ${JSON.stringify({
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    metadata
  })}`;
}

function buildCellMarkerLine(language: string, metadata: Record<string, unknown>): string {
  return `-- %% [${language}] ${JSON.stringify({ metadata })}`;
}

function buildLineReplacementFix(
  title: string,
  lineIndex: number,
  oldText: string,
  newText: string
): SqlNotebookQuickFix {
  return {
    title,
    replacementText: newText,
    range: createLineRange(lineIndex, oldText)
  };
}

function buildHeaderInsertionFix(): SqlNotebookQuickFix {
  return {
    title: "Add notebook header",
    replacementText: `${buildHeaderLine({})}\n`,
    range: createInsertionRange(0, 0)
  };
}

function buildCommentPrefixFix(lineIndex: number): SqlNotebookQuickFix {
  return {
    title: "Prefix markdown line with '-- '",
    replacementText: "-- ",
    range: createInsertionRange(lineIndex, 0)
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseHeaderLine(
  line: LineEntry,
  issues: SqlNotebookValidationIssue[]
): HeaderPayload | undefined {
  const trimmed = line.text.trim();

  if (!trimmed.startsWith(SQL_NOTEBOOK_HEADER_PREFIX)) {
    return undefined;
  }

  const jsonText = trimmed.slice(SQL_NOTEBOOK_HEADER_PREFIX.length).trim();

  if (!jsonText) {
    issues.push(
      createIssue(
        "invalidHeaderJson",
        "The notebook header JSON is missing or malformed.",
        createLineRange(line.lineIndex, line.text),
        true,
        buildLineReplacementFix(
          "Replace with canonical notebook header",
          line.lineIndex,
          line.text,
          buildHeaderLine({})
        )
      )
    );
    return {};
  }

  const parsed = parseJsonObject(jsonText);

  if (!parsed) {
    issues.push(
      createIssue(
        "invalidHeaderJson",
        "The notebook header JSON is malformed.",
        createLineRange(line.lineIndex, line.text),
        true,
        buildLineReplacementFix(
          "Replace with canonical notebook header",
          line.lineIndex,
          line.text,
          buildHeaderLine({})
        )
      )
    );
    return {};
  }

  const schemaVersion =
    typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : undefined;

  if (schemaVersion !== undefined && schemaVersion !== NOTEBOOK_SCHEMA_VERSION) {
    issues.push(
      createIssue(
        "unsupportedSchemaVersion",
        `Unsupported Oracle SQL Notebook SQL schema version: ${schemaVersion}.`,
        createLineRange(line.lineIndex, line.text),
        true
      )
    );
  }

  if ("metadata" in parsed && !isRecord(parsed.metadata)) {
    issues.push(
      createIssue(
        "invalidHeaderMetadata",
        "The notebook header metadata must be a JSON object.",
        createLineRange(line.lineIndex, line.text),
        false,
        buildLineReplacementFix(
          "Normalize notebook header metadata",
          line.lineIndex,
          line.text,
          buildHeaderLine({})
        )
      )
    );
  }

  return {
    schemaVersion,
    metadata: normalizeMetadata(parsed.metadata)
  };
}

function parseCellMarkerLine(
  line: LineEntry,
  issues: SqlNotebookValidationIssue[]
): ParsedCellMarker | undefined {
  const trimmed = line.text.trim();

  if (!trimmed.startsWith(CELL_MARKER_PREFIX)) {
    return undefined;
  }

  const match = CELL_MARKER_PATTERN.exec(trimmed);

  if (!match) {
    issues.push(
      createIssue(
        "invalidCellMarkerJson",
        "The cell marker is malformed.",
        createLineRange(line.lineIndex, line.text),
        true,
        buildLineReplacementFix(
          "Replace with canonical SQL cell marker",
          line.lineIndex,
          line.text,
          buildCellMarkerLine("sql", {})
        )
      )
    );

    return {
      kind: "code",
      language: "sql",
      metadata: {}
    };
  }

  const rawLanguage = (match[1] ?? "sql").trim() || "sql";
  const trailingPayload = (match[2] ?? "").trim();
  let metadata: Record<string, unknown> = {};
  let kind: "code" | "markup" = "code";
  const normalizedLanguage = rawLanguage.toLowerCase();

  if (trailingPayload.length > 0) {
    const parsedPayload = parseJsonObject(trailingPayload);

    if (!parsedPayload) {
      issues.push(
        createIssue(
          "invalidCellMarkerJson",
          "The cell marker metadata JSON is malformed.",
          createLineRange(line.lineIndex, line.text),
          true,
          buildLineReplacementFix(
            "Replace with canonical cell marker metadata",
            line.lineIndex,
            line.text,
            buildCellMarkerLine(
              normalizedLanguage === "markup" ? "markdown" : rawLanguage,
              {}
            )
          )
        )
      );
    } else if ("metadata" in parsedPayload && !isRecord(parsedPayload.metadata)) {
      issues.push(
        createIssue(
          "invalidCellMarkerMetadata",
          "Cell marker metadata must be a JSON object.",
          createLineRange(line.lineIndex, line.text),
          false,
          buildLineReplacementFix(
            "Normalize cell marker metadata",
            line.lineIndex,
            line.text,
            buildCellMarkerLine(
              normalizedLanguage === "markup" ? "markdown" : rawLanguage,
              {}
            )
          )
        )
      );
    } else {
      metadata = normalizeMetadata(parsedPayload.metadata);
    }
  }

  if (normalizedLanguage === "markdown") {
    kind = "markup";
  } else if (normalizedLanguage === "markup") {
    kind = "markup";
    issues.push(
      createIssue(
        "nonCanonicalMarkupLanguage",
        "Use '[markdown]' instead of '[markup]' for canonical notebook SQL format.",
        createLineRange(line.lineIndex, line.text),
        false,
        buildLineReplacementFix(
          "Normalize marker to [markdown]",
          line.lineIndex,
          line.text,
          buildCellMarkerLine("markdown", metadata)
        )
      )
    );
  } else if (normalizedLanguage !== "sql") {
    issues.push(
      createIssue(
        "unsupportedCellLanguage",
        `Cell marker language '${rawLanguage}' is not part of the supported round-trip format.`,
        createLineRange(line.lineIndex, line.text),
        false
      )
    );
  }

  return {
    kind,
    language: kind === "markup" ? "markdown" : rawLanguage,
    metadata
  };
}

function deserializeMarkdownCell(
  lines: LineEntry[],
  issues: SqlNotebookValidationIssue[]
): string {
  return lines
    .map((line) => {
      if (line.text === "--") {
        return "";
      }

      if (line.text.startsWith("-- ")) {
        return line.text.slice(3);
      }

      if (line.text.startsWith("--")) {
        return line.text.slice(2);
      }

      if (line.text.trim().length > 0) {
        issues.push(
          createIssue(
            "markdownLineMissingCommentPrefix",
            "Markdown lines in notebook SQL should be written as SQL comments with '-- '.",
            createLineRange(line.lineIndex, line.text),
            false,
            buildCommentPrefixFix(line.lineIndex)
          )
        );
      }

      return line.text;
    })
    .join("\n");
}

function removeTrailingSerializerSeparator(lines: LineEntry[]): LineEntry[] {
  if (lines.length === 0 || lines[lines.length - 1]?.text !== "") {
    return lines;
  }

  return lines.slice(0, -1);
}

function buildCell(
  marker: ParsedCellMarker,
  lines: LineEntry[],
  issues: SqlNotebookValidationIssue[]
): RawNotebookCellV1 {
  const valueLines = removeTrailingSerializerSeparator(lines);

  return {
    kind: marker.kind,
    language: marker.language,
    value:
      marker.kind === "markup"
        ? deserializeMarkdownCell(valueLines, issues)
        : valueLines.map((line) => line.text).join("\n"),
    metadata: marker.metadata
  };
}

function buildPlainSqlNotebook(normalizedText: string): RawNotebookV1 {
  return {
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    metadata: {},
    cells: [
      {
        kind: "code",
        language: "sql",
        value: normalizedText.endsWith("\n")
          ? normalizedText.slice(0, -1)
          : normalizedText,
        metadata: {}
      }
    ]
  };
}

function buildFallbackCellFromLines(lines: LineEntry[]): RawNotebookCellV1 {
  return {
    kind: "code",
    language: "sql",
    value: lines.map((line) => line.text).join("\n").trimEnd(),
    metadata: {}
  };
}

function hasPairedSqlSignature(lines: readonly LineEntry[]): boolean {
  return lines.some((line) => {
    const trimmed = line.text.trim();
    return trimmed.startsWith(SQL_NOTEBOOK_HEADER_PREFIX) || trimmed.startsWith(CELL_MARKER_PREFIX);
  });
}

function getLineStartOffsets(text: string): number[] {
  const offsets = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function rangeToOffsets(
  text: string,
  range: SqlNotebookTextRange
): { start: number; end: number } {
  const offsets = getLineStartOffsets(text);
  const start = (offsets[range.startLine] ?? text.length) + range.startCharacter;
  const end = (offsets[range.endLine] ?? text.length) + range.endCharacter;

  return {
    start,
    end
  };
}

export function applySqlNotebookQuickFix(
  sqlText: string,
  quickFix: SqlNotebookQuickFix
): string {
  const normalized = normalizeLineEndings(sqlText);
  const { start, end } = rangeToOffsets(normalized, quickFix.range);
  return `${normalized.slice(0, start)}${quickFix.replacementText}${normalized.slice(end)}`;
}

export function hasBlockingSqlNotebookIssues(
  issues: readonly SqlNotebookValidationIssue[]
): boolean {
  return issues.some((issue) => issue.isBlocking);
}

export function analyzeSqlNotebookText(sqlText: string): SqlNotebookAnalysisResult {
  const normalizedText = normalizeLineEndings(sqlText);
  const lines = normalizedText.split("\n").map((text, lineIndex) => ({
    lineIndex,
    text
  }));

  if (!hasPairedSqlSignature(lines)) {
    return {
      isPairedFormat: false,
      notebook: buildPlainSqlNotebook(normalizedText),
      issues: []
    };
  }

  const issues: SqlNotebookValidationIssue[] = [];
  const metadata: Record<string, unknown> = {};
  const cells: RawNotebookCellV1[] = [];
  const plainLines: LineEntry[] = [];

  let currentMarker: ParsedCellMarker | undefined;
  let currentCellLines: LineEntry[] = [];
  let sawCellMarker = false;
  let firstContentLineIndex: number | undefined;
  let headerSeen = false;

  const flushCell = (): void => {
    if (!currentMarker) {
      return;
    }

    cells.push(buildCell(currentMarker, currentCellLines, issues));
    currentMarker = undefined;
    currentCellLines = [];
  };

  for (const line of lines) {
    if (firstContentLineIndex === undefined && line.text.trim().length > 0) {
      firstContentLineIndex = line.lineIndex;
    }

    if (!headerSeen && firstContentLineIndex === line.lineIndex) {
      const parsedHeader = parseHeaderLine(line, issues);

      if (parsedHeader) {
        headerSeen = true;
        Object.assign(metadata, normalizeMetadata(parsedHeader.metadata));
        continue;
      }

      headerSeen = true;
    }

    const marker = parseCellMarkerLine(line, issues);

    if (marker) {
      flushCell();
      currentMarker = marker;
      sawCellMarker = true;
      currentCellLines = [];
      continue;
    }

    if (currentMarker) {
      currentCellLines.push(line);
    } else {
      plainLines.push(line);
    }
  }

  flushCell();

  if (sawCellMarker && firstContentLineIndex !== undefined && !lines[firstContentLineIndex]?.text.trim().startsWith(SQL_NOTEBOOK_HEADER_PREFIX)) {
    issues.push(
      createIssue(
        "missingHeader",
        "Notebook-style SQL should start with an oracle-sql-notebook header comment.",
        createLineRange(firstContentLineIndex, lines[firstContentLineIndex]?.text ?? ""),
        false,
        buildHeaderInsertionFix()
      )
    );
  }

  for (const line of plainLines) {
    if (line.text.trim().length === 0) {
      continue;
    }

    issues.push(
      createIssue(
        "strayTextOutsideCells",
        "Text outside '-- %%' cell markers will not round-trip cleanly.",
        createLineRange(line.lineIndex, line.text),
        false
      )
    );
  }

  let notebook: RawNotebookV1;

  if (!sawCellMarker) {
    if (plainLines.some((line) => line.text.trim().length > 0)) {
      const firstPlainTextLine = plainLines.find((line) => line.text.trim().length > 0);
      issues.push(
        createIssue(
          "missingCellMarkers",
          "Paired notebook SQL should use '-- %%' cell markers. Remaining SQL will be treated as a single code cell.",
          firstPlainTextLine
            ? createLineRange(firstPlainTextLine.lineIndex, firstPlainTextLine.text)
            : createInsertionRange(0, 0),
          false
        )
      );
    }

    notebook = {
      schemaVersion: NOTEBOOK_SCHEMA_VERSION,
      metadata,
      cells: [buildFallbackCellFromLines(plainLines)]
    };
  } else {
    notebook = {
      schemaVersion: NOTEBOOK_SCHEMA_VERSION,
      metadata,
      cells: cells.length > 0 ? cells : createDefaultRawNotebook().cells
    };
  }

  return {
    isPairedFormat: true,
    notebook,
    issues
  };
}

export function serializeNotebookToSql(rawNotebook: RawNotebookV1): string {
  const lines: string[] = [buildHeaderLine(normalizeMetadata(rawNotebook.metadata))];

  for (const cell of rawNotebook.cells) {
    const language = cell.kind === "markup" ? "markdown" : cell.language || "sql";
    lines.push("", buildCellMarkerLine(language, normalizeMetadata(cell.metadata)));

    if (cell.kind === "markup") {
      lines.push(
        ...(
          cell.value.length === 0
            ? ["--"]
            : cell.value.split("\n").map((line) => (line.length > 0 ? `-- ${line}` : "--"))
        )
      );
      continue;
    }

    if (cell.value.length > 0) {
      lines.push(...cell.value.split("\n"));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function parseSqlToNotebook(sqlText: string): RawNotebookV1 {
  const analysis = analyzeSqlNotebookText(sqlText);
  const blockingIssue = analysis.issues.find((issue) => issue.isBlocking);

  if (blockingIssue) {
    throw new Error(blockingIssue.message);
  }

  return analysis.notebook;
}
