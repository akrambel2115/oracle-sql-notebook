import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";

export type NotebookExportFormat = "html" | "pdf";

const TABLE_MIME = "application/vnd.oracle-sql-notebook.table+json";
const PLAN_MIME = "application/vnd.oracle-sql-notebook.plan+json";
const JSON_MIME = "application/json";
const TEXT_MIME = "text/plain";
const MARKDOWN_MIME = "text/markdown";
const HTML_MIME = "text/html";
const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const STDERR_MIME = "application/vnd.code.notebook.stderr";
const ERROR_MIME = "application/vnd.code.notebook.error";

const OUTPUT_MIME_PRIORITY: readonly string[] = [
  TABLE_MIME,
  PLAN_MIME,
  STDERR_MIME,
  STDOUT_MIME,
  TEXT_MIME,
  MARKDOWN_MIME,
  HTML_MIME,
  JSON_MIME,
  ERROR_MIME
];

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const WINDOWS_BROWSER_CANDIDATES: readonly string[] = [
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
];

const MAC_BROWSER_CANDIDATES: readonly string[] = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

const LINUX_BROWSER_CANDIDATES: readonly string[] = [
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium"
];

const WINDOWS_PATH_BROWSER_CANDIDATES: readonly string[] = [
  "msedge.exe",
  "chrome.exe",
  "msedge",
  "chrome"
];

const POSIX_PATH_BROWSER_CANDIDATES: readonly string[] = [
  "microsoft-edge",
  "google-chrome",
  "chromium",
  "chromium-browser"
];

const SQL_KEYWORDS: readonly string[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "ON",
  "AS",
  "DISTINCT",
  "UNION",
  "ALL",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "MERGE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CASE",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "TABLE",
  "VIEW",
  "INDEX",
  "SEQUENCE",
  "PROCEDURE",
  "FUNCTION",
  "PACKAGE",
  "BEGIN",
  "DECLARE",
  "LOOP",
  "IF",
  "ELSIF",
  "RETURN",
  "COMMIT",
  "ROLLBACK",
  "EXPLAIN",
  "PLAN",
  "FOR",
  "WITH",
  "FETCH",
  "FIRST",
  "NEXT",
  "ONLY"
];

const SQL_KEYWORD_PATTERN = SQL_KEYWORDS.join("|");
const SQL_TOKEN_REGEX = new RegExp(
  `(--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|'(?:''|[^'])*'|\\b\\d+(?:\\.\\d+)?\\b|\\b(?:${SQL_KEYWORD_PATTERN})\\b|[()*+,\\-/%=<>!]+)`,
  "gi"
);

interface TablePayload {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
}

interface PlanPayload {
  lines: string[];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
}

interface BaseSnapshot {
  language: string;
  source: string;
}

interface CodeCellSnapshot extends BaseSnapshot {
  kind: "code";
  outputs: string[];
}

interface MarkupCellSnapshot extends BaseSnapshot {
  kind: "markup";
}

type ExportCellSnapshot = CodeCellSnapshot | MarkupCellSnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function decodeUtf8(data: Uint8Array): string {
  return textDecoder.decode(data);
}

function tryParseJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(data)) as unknown;
  } catch {
    return undefined;
  }
}

function toDisplayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (typeof value === "symbol") {
    const description = value.description;
    return description ? `Symbol(${description})` : "Symbol()";
  }

  if (typeof value === "function") {
    return "[function]";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable object]";
    }
  }

  return "[unsupported value]";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function discoverColumns(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): string[] {
  if (columns.length > 0) {
    return [...columns];
  }

  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

function normalizeTablePayload(raw: unknown): TablePayload | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter((item): item is string => typeof item === "string")
    : [];

  const rows = Array.isArray(raw.rows)
    ? raw.rows.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];

  const rowCount =
    typeof raw.rowCount === "number" && Number.isFinite(raw.rowCount)
      ? Math.max(0, Math.floor(raw.rowCount))
      : rows.length;

  const executionMs =
    typeof raw.executionMs === "number" && Number.isFinite(raw.executionMs)
      ? Math.max(0, Math.floor(raw.executionMs))
      : 0;

  return {
    columns,
    rows,
    rowCount,
    truncated: raw.truncated === true,
    executionMs
  };
}

function normalizePlanPayload(raw: unknown): PlanPayload | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const lines = Array.isArray(raw.lines)
    ? raw.lines.filter((item): item is string => typeof item === "string")
    : [];

  const rowCount =
    typeof raw.rowCount === "number" && Number.isFinite(raw.rowCount)
      ? Math.max(0, Math.floor(raw.rowCount))
      : lines.length;

  const executionMs =
    typeof raw.executionMs === "number" && Number.isFinite(raw.executionMs)
      ? Math.max(0, Math.floor(raw.executionMs))
      : 0;

  return {
    lines,
    rowCount,
    truncated: raw.truncated === true,
    executionMs
  };
}

function renderPreBlock(text: string): string {
  return `<pre class="nb-pre">${escapeHtml(text)}</pre>`;
}

function isSqlLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === "sql" || normalized === "plsql" || normalized.endsWith("sql");
}

function highlightSqlCode(source: string): string {
  let result = "";
  let offset = 0;

  SQL_TOKEN_REGEX.lastIndex = 0;

  for (const match of source.matchAll(SQL_TOKEN_REGEX)) {
    const matched = match[0];
    const index = match.index;

    if (matched === undefined || index === undefined) {
      continue;
    }

    if (index > offset) {
      result += escapeHtml(source.slice(offset, index));
    }

    if (matched.startsWith("--") || matched.startsWith("/*")) {
      result += `<span class="nb-sql-comment">${escapeHtml(matched)}</span>`;
    } else if (matched.startsWith("'")) {
      result += `<span class="nb-sql-string">${escapeHtml(matched)}</span>`;
    } else if (/^\d/.test(matched)) {
      result += `<span class="nb-sql-number">${escapeHtml(matched)}</span>`;
    } else if (/^[A-Za-z_]/.test(matched)) {
      result += `<span class="nb-sql-keyword">${escapeHtml(matched)}</span>`;
    } else {
      result += `<span class="nb-sql-operator">${escapeHtml(matched)}</span>`;
    }

    offset = index + matched.length;
  }

  if (offset < source.length) {
    result += escapeHtml(source.slice(offset));
  }

  return result;
}

function renderCodeSourceHtml(source: string, language: string): string {
  if (isSqlLanguage(language)) {
    return highlightSqlCode(source);
  }

  return escapeHtml(source);
}

function renderTableOutputHtml(table: TablePayload): string {
  const columns = discoverColumns(table.columns, table.rows);
  const summaryParts: string[] = [`${table.rowCount} row(s)`, `${table.executionMs} ms`];

  if (table.truncated) {
    summaryParts.push("truncated");
  }

  const headerHtml =
    columns.length === 0
      ? ""
      : `<tr>${columns
          .map((column) => `<th>${escapeHtml(column)}</th>`)
          .join("")}</tr>`;

  const rowsHtml =
    table.rows.length === 0
      ? `<tr><td colspan="${Math.max(1, columns.length)}">No rows</td></tr>`
      : table.rows
          .map(
            (row) =>
              `<tr>${columns
                .map((column) => `<td>${escapeHtml(toDisplayValue(row[column]))}</td>`)
                .join("")}</tr>`
          )
          .join("");

  return [
    `<div class="nb-output-meta">${escapeHtml(summaryParts.join(" | "))}</div>`,
    `<div class="nb-table-wrap">`,
    `<table class="nb-table">`,
    `<thead>${headerHtml}</thead>`,
    `<tbody>${rowsHtml}</tbody>`,
    `</table>`,
    `</div>`
  ].join("");
}

function renderPlanOutputHtml(plan: PlanPayload): string {
  const summaryParts: string[] = [`${plan.rowCount} plan line(s)`, `${plan.executionMs} ms`];

  if (plan.truncated) {
    summaryParts.push("truncated");
  }

  const content = plan.lines.length > 0 ? plan.lines.join("\n") : "No plan lines";

  return [
    `<div class="nb-output-meta">${escapeHtml(summaryParts.join(" | "))}</div>`,
    renderPreBlock(content)
  ].join("");
}

function renderErrorOutputHtml(data: Uint8Array): string {
  const parsed = tryParseJson(data);

  if (!isRecord(parsed)) {
    return renderPreBlock(normalizeLineEndings(decodeUtf8(data)).trimEnd());
  }

  const name = typeof parsed.name === "string" ? parsed.name : "Error";
  const message = typeof parsed.message === "string" ? parsed.message : "Unknown error";
  const stack = typeof parsed.stack === "string" ? parsed.stack : "";
  const lines = stack.length > 0 ? `${name}: ${message}\n${stack}` : `${name}: ${message}`;

  return renderPreBlock(lines);
}

function renderMarkdownOutputHtml(text: string): string {
  const markdownHtml = markdownRenderer.render(text);
  return `<div class="nb-markdown-output">${markdownHtml}</div>`;
}

function renderOutputItemHtml(item: vscode.NotebookCellOutputItem): string {
  switch (item.mime) {
    case TABLE_MIME: {
      const table = normalizeTablePayload(tryParseJson(item.data));
      return table ? renderTableOutputHtml(table) : renderPreBlock(decodeUtf8(item.data));
    }
    case PLAN_MIME: {
      const plan = normalizePlanPayload(tryParseJson(item.data));
      return plan ? renderPlanOutputHtml(plan) : renderPreBlock(decodeUtf8(item.data));
    }
    case JSON_MIME: {
      const parsed = tryParseJson(item.data);
      const table = normalizeTablePayload(parsed);
      if (table) {
        return renderTableOutputHtml(table);
      }

      const plan = normalizePlanPayload(parsed);
      if (plan) {
        return renderPlanOutputHtml(plan);
      }

      const jsonText =
        parsed === undefined ? decodeUtf8(item.data) : JSON.stringify(parsed, null, 2);

      return renderPreBlock(normalizeLineEndings(jsonText).trimEnd());
    }
    case MARKDOWN_MIME:
      return renderMarkdownOutputHtml(decodeUtf8(item.data));
    case ERROR_MIME:
      return renderErrorOutputHtml(item.data);
    case STDERR_MIME:
    case STDOUT_MIME:
    case TEXT_MIME:
    case HTML_MIME:
      return renderPreBlock(normalizeLineEndings(decodeUtf8(item.data)).trimEnd());
    default:
      return renderPreBlock(normalizeLineEndings(decodeUtf8(item.data)).trimEnd());
  }
}

function pickPrimaryOutputItem(
  items: readonly vscode.NotebookCellOutputItem[]
): vscode.NotebookCellOutputItem | undefined {
  for (const mime of OUTPUT_MIME_PRIORITY) {
    const preferred = items.find((item) => item.mime === mime);
    if (preferred) {
      return preferred;
    }
  }

  return items[0];
}

function buildCellSnapshots(notebook: vscode.NotebookDocument): ExportCellSnapshot[] {
  const snapshots: ExportCellSnapshot[] = [];

  for (const cell of notebook.getCells()) {
    const source = normalizeLineEndings(cell.document.getText());

    if (cell.kind === vscode.NotebookCellKind.Code) {
      const outputs = cell.outputs
        .map((output) => pickPrimaryOutputItem(output.items))
        .filter((item): item is vscode.NotebookCellOutputItem => item !== undefined)
        .map((item) => renderOutputItemHtml(item));

      snapshots.push({
        kind: "code",
        language: cell.document.languageId,
        source,
        outputs
      });

      continue;
    }

    snapshots.push({
      kind: "markup",
      language: cell.document.languageId,
      source
    });
  }

  return snapshots;
}

function getNotebookDisplayName(notebook: vscode.NotebookDocument): string {
  if (notebook.uri.scheme === "file") {
    return basename(notebook.uri.fsPath);
  }

  const path = notebook.uri.path;
  const segment = path.split("/").pop();
  return segment && segment.length > 0 ? segment : "oracle-sql-notebook";
}

function getExportBasename(notebook: vscode.NotebookDocument): string {
  const displayName = getNotebookDisplayName(notebook);

  if (displayName.toLowerCase().endsWith(".isqlnb")) {
    const withoutExt = displayName.slice(0, -".isqlnb".length).trim();
    if (withoutExt.length > 0) {
      return withoutExt;
    }
  }

  const fallback = displayName.replace(/\.[^.]+$/, "").trim();
  return fallback.length > 0 ? fallback : "oracle-sql-notebook";
}

function getDefaultExportUri(
  notebook: vscode.NotebookDocument,
  extension: "html" | "pdf"
): vscode.Uri | undefined {
  if (notebook.uri.scheme !== "file") {
    return undefined;
  }

  const parentFolder = vscode.Uri.file(dirname(notebook.uri.fsPath));
  return vscode.Uri.joinPath(parentFolder, `${getExportBasename(notebook)}.${extension}`);
}

async function promptExportTarget(
  notebook: vscode.NotebookDocument,
  format: NotebookExportFormat
): Promise<vscode.Uri | undefined> {
  const formatLabel = format === "html" ? "HTML" : "PDF";
  const saveDialogOptions: vscode.SaveDialogOptions = {
    title: `Export Oracle SQL Notebook as ${formatLabel}`,
    saveLabel: `Export ${formatLabel}`,
    filters: format === "html" ? { "HTML Files": ["html"] } : { "PDF Files": ["pdf"] }
  };

  const defaultUri = getDefaultExportUri(notebook, format);
  if (defaultUri) {
    saveDialogOptions.defaultUri = defaultUri;
  }

  const uri = await vscode.window.showSaveDialog(saveDialogOptions);
  return uri ?? undefined;
}

function renderMarkupCellHtml(cell: MarkupCellSnapshot): string {
  const body = cell.source.trim().length > 0 ? markdownRenderer.render(cell.source) : "<p></p>";

  return [
    `<section class="nb-cell nb-markup-cell">`,
    `<div class="nb-markdown-body">${body}</div>`,
    `</section>`
  ].join("");
}

function renderCodeCellHtml(cell: CodeCellSnapshot): string {
  const codeSource = renderCodeSourceHtml(cell.source, cell.language);

  const sections: string[] = [
    `<div class="nb-input-area">`,
    `<pre class="nb-pre nb-code">${codeSource}</pre>`,
    `</div>`
  ];

  if (cell.outputs.length > 0) {
    const groupedOutputs = cell.outputs
      .map((outputHtml) => `<div class="nb-output-item">${outputHtml}</div>`)
      .join("");

    sections.push(`<div class="nb-output-group">${groupedOutputs}</div>`);
  }

  return `<section class="nb-cell nb-code-cell">${sections.join("")}</section>`;
}

function renderCellHtml(cell: ExportCellSnapshot): string {
  if (cell.kind === "markup") {
    return renderMarkupCellHtml(cell);
  }

  return renderCodeCellHtml(cell);
}

function buildNotebookExportHtml(notebook: vscode.NotebookDocument): string {
  const notebookName = getNotebookDisplayName(notebook);
  const cells = buildCellSnapshots(notebook);
  const renderedCells = cells.map((cell) => renderCellHtml(cell)).join("\n");

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    `<title>${escapeHtml(notebookName)} - Export</title>`,
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<style>",
    "body {",
    "  margin: 14px;",
    "  color: #1f2328;",
    "  background: #ffffff;",
    "  font-family: 'Segoe UI', Tahoma, sans-serif;",
    "  font-size: 14px;",
    "}",
    ".nb-root {",
    "  max-width: 1100px;",
    "  margin: 0 auto;",
    "}",
    ".nb-cell {",
    "  margin-bottom: 12px;",
    "}",
    ".nb-input-area {",
    "  border: 1px solid #d0d7de;",
    "  border-radius: 4px;",
    "  background: #f6f8fa;",
    "  overflow: hidden;",
    "}",
    ".nb-output-group {",
    "  margin-top: 6px;",
    "  background: transparent;",
    "}",
    ".nb-output-item {",
    "  padding: 0;",
    "}",
    ".nb-output-item + .nb-output-item {",
    "  margin-top: 8px;",
    "}",
    ".nb-code-cell .nb-output-group .nb-pre {",
    "  background: transparent;",
    "}",
    ".nb-pre {",
    "  margin: 0;",
    "  padding: 10px 12px;",
    "  white-space: pre-wrap;",
    "  overflow-wrap: anywhere;",
    "  font-family: Menlo, Consolas, 'Courier New', monospace;",
    "  font-size: 12px;",
    "  line-height: 1.45;",
    "}",
    ".nb-code {",
    "  background: transparent;",
    "}",
    ".nb-sql-keyword { color: #0b7f3f; font-weight: 600; }",
    ".nb-sql-string { color: #b54708; }",
    ".nb-sql-number { color: #0550ae; }",
    ".nb-sql-comment { color: #6e7781; font-style: italic; }",
    ".nb-sql-operator { color: #8250df; }",
    ".nb-markup-cell {",
    "  padding: 4px 0;",
    "}",
    ".nb-markdown-body {",
    "  min-width: 0;",
    "}",
    ".nb-markdown-body > *:first-child {",
    "  margin-top: 0;",
    "}",
    ".nb-markdown-body > *:last-child {",
    "  margin-bottom: 0;",
    "}",
    ".nb-markdown-body pre {",
    "  background: #f6f8fa;",
    "  border: 1px solid #d0d7de;",
    "  border-radius: 4px;",
    "  padding: 10px 12px;",
    "  font-family: Menlo, Consolas, 'Courier New', monospace;",
    "  font-size: 12px;",
    "}",
    ".nb-output-meta {",
    "  padding: 10px 12px 0;",
    "  color: #656d76;",
    "  font-size: 12px;",
    "}",
    ".nb-table-wrap {",
    "  overflow: auto;",
    "  padding: 8px 12px 12px;",
    "}",
    ".nb-table {",
    "  width: 100%;",
    "  border-collapse: collapse;",
    "  font-family: Menlo, Consolas, 'Courier New', monospace;",
    "  font-size: 12px;",
    "  background: #ffffff;",
    "}",
    ".nb-table th, .nb-table td {",
    "  border: 1px solid #d0d7de;",
    "  padding: 4px 6px;",
    "  text-align: left;",
    "  vertical-align: top;",
    "  white-space: pre-wrap;",
    "}",
    ".nb-markdown-output > *:first-child {",
    "  margin-top: 0;",
    "}",
    ".nb-markdown-output > *:last-child {",
    "  margin-bottom: 0;",
    "}",
    "@media (max-width: 900px) {",
    "  body { margin: 8px; }",
    "}",
    "@media print {",
    "  body { margin: 0; }",
    "  @page { margin: 10mm; }",
    "  .nb-cell, .nb-input-area, .nb-output-group, .nb-output-item, .nb-table-wrap {",
    "    break-inside: auto;",
    "    page-break-inside: auto;",
    "  }",
    "  .nb-table tr {",
    "    break-inside: auto;",
    "    page-break-inside: auto;",
    "  }",
    "}",
    "</style>",
    "</head>",
    "<body>",
    "<main class=\"nb-root\">",
    renderedCells,
    "</main>",
    "</body>",
    "</html>"
  ].join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getAbsoluteBrowserCandidates(): readonly string[] {
  switch (process.platform) {
    case "win32":
      return WINDOWS_BROWSER_CANDIDATES;
    case "darwin":
      return MAC_BROWSER_CANDIDATES;
    default:
      return LINUX_BROWSER_CANDIDATES;
  }
}

function getPathBrowserCandidates(): readonly string[] {
  return process.platform === "win32"
    ? WINDOWS_PATH_BROWSER_CANDIDATES
    : POSIX_PATH_BROWSER_CANDIDATES;
}

async function resolveBrowserCandidates(): Promise<string[]> {
  const candidates = new Set<string>();

  const browserPathFromEnv = process.env.ORACLE_SQL_NOTEBOOK_BROWSER_PATH;
  if (browserPathFromEnv && browserPathFromEnv.trim().length > 0) {
    candidates.add(browserPathFromEnv.trim());
  }

  for (const candidate of getAbsoluteBrowserCandidates()) {
    if (await fileExists(candidate)) {
      candidates.add(candidate);
    }
  }

  for (const candidate of getPathBrowserCandidates()) {
    candidates.add(candidate);
  }

  return [...candidates];
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }

        const stderrText = typeof stderr === "string" ? stderr.trim() : "";
        const stdoutText = typeof stdout === "string" ? stdout.trim() : "";
        const commandOutput = stderrText || stdoutText;
        const reason = commandOutput.length > 0 ? commandOutput : getErrorMessage(error);

        reject(new Error(`${command} failed: ${reason}`));
      }
    );
  });
}

async function printHtmlToPdf(htmlFilePath: string, pdfFilePath: string): Promise<void> {
  const browserCandidates = await resolveBrowserCandidates();
  const htmlFileUrl = pathToFileURL(htmlFilePath).toString();
  let lastError: unknown;

  for (const browserCandidate of browserCandidates) {
    const args: string[] = [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--allow-file-access-from-files",
      "--no-pdf-header-footer",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfFilePath}`,
      htmlFileUrl
    ];

    if (process.platform === "linux") {
      args.splice(2, 0, "--no-sandbox");
    }

    try {
      await runCommand(browserCandidate, args);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const details = lastError ? ` Details: ${getErrorMessage(lastError)}` : "";
  throw new Error(
    "Unable to generate PDF from the exported HTML using a Chromium-based browser. " +
      "Install Microsoft Edge or Google Chrome, or set ORACLE_SQL_NOTEBOOK_BROWSER_PATH." +
      details
  );
}

async function buildNotebookExportPdf(html: string): Promise<Uint8Array> {
  const tempDir = await mkdtemp(join(tmpdir(), "oracle-sql-notebook-export-"));
  const htmlFilePath = join(tempDir, "notebook-export.html");
  const pdfFilePath = join(tempDir, "notebook-export.pdf");

  try {
    await writeFile(htmlFilePath, html, "utf8");
    await printHtmlToPdf(htmlFilePath, pdfFilePath);
    return await readFile(pdfFilePath);
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
}

export async function exportNotebook(
  notebook: vscode.NotebookDocument,
  format: NotebookExportFormat
): Promise<vscode.Uri | undefined> {
  const targetUri = await promptExportTarget(notebook, format);

  if (!targetUri) {
    return undefined;
  }

  const html = buildNotebookExportHtml(notebook);

  if (format === "html") {
    await vscode.workspace.fs.writeFile(targetUri, textEncoder.encode(html));
    return targetUri;
  }

  const pdf = await buildNotebookExportPdf(html);
  await vscode.workspace.fs.writeFile(targetUri, pdf);
  return targetUri;
}
