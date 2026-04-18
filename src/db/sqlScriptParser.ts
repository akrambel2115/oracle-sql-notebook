export type ParsedStatementMode = "sql" | "plsql";

export interface ParsedSqlStatement {
  sql: string;
  mode: ParsedStatementMode;
}

const PLSQL_CREATE_OBJECTS = new Set([
  "FUNCTION",
  "PROCEDURE",
  "PACKAGE",
  "PACKAGE_BODY",
  "TRIGGER",
  "TYPE",
  "TYPE_BODY"
]);

function stripLeadingIgnorable(text: string): string {
  let offset = 0;

  while (offset < text.length) {
    // Skip whitespace first.
    while (offset < text.length && /\s/u.test(text[offset] ?? "")) {
      offset += 1;
    }

    const remaining = text.slice(offset);

    if (remaining.startsWith("--")) {
      const lineBreak = remaining.indexOf("\n");
      offset += lineBreak === -1 ? remaining.length : lineBreak + 1;
      continue;
    }

    if (remaining.startsWith("/*")) {
      const blockEnd = remaining.indexOf("*/");

      if (blockEnd === -1) {
        return "";
      }

      offset += blockEnd + 2;
      continue;
    }

    break;
  }

  return text.slice(offset);
}

function extractLeadingTokens(text: string, maxTokens: number): string[] {
  const cleaned = stripLeadingIgnorable(text);
  const tokens: string[] = [];
  const matcher = /[A-Za-z_][A-Za-z0-9_$#]*/gu;

  for (const match of cleaned.matchAll(matcher)) {
    const token = match[0];

    if (!token) {
      continue;
    }

    tokens.push(token.toUpperCase());

    if (tokens.length >= maxTokens) {
      break;
    }
  }

  return tokens;
}

function detectStatementMode(sql: string): ParsedStatementMode {
  const tokens = extractLeadingTokens(sql, 6);

  if (tokens.length === 0) {
    return "sql";
  }

  const first = tokens[0];

  if (first === "BEGIN" || first === "DECLARE") {
    return "plsql";
  }

  if (first !== "CREATE") {
    return "sql";
  }

  let objectTokenIndex = 1;

  if (tokens[1] === "OR" && tokens[2] === "REPLACE") {
    objectTokenIndex = 3;
  }

  const objectToken = tokens[objectTokenIndex];

  if (!objectToken) {
    return "sql";
  }

  if (objectToken === "PACKAGE" && tokens[objectTokenIndex + 1] === "BODY") {
    return "plsql";
  }

  if (objectToken === "TYPE" && tokens[objectTokenIndex + 1] === "BODY") {
    return "plsql";
  }

  return PLSQL_CREATE_OBJECTS.has(objectToken) ? "plsql" : "sql";
}

function normalizeStatement(sql: string): string {
  return sql.trim();
}

export function splitSqlScript(script: string): ParsedSqlStatement[] {
  const statements: ParsedSqlStatement[] = [];

  let buffer = "";
  let mode: ParsedStatementMode | undefined;
  let lineStartIndex = 0;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  const pushStatement = (rawStatement: string): void => {
    const normalized = normalizeStatement(rawStatement);

    if (!normalized) {
      return;
    }

    statements.push({
      sql: normalized,
      mode: mode ?? detectStatementMode(normalized)
    });
  };

  const refreshMode = (): void => {
    const trimmed = normalizeStatement(buffer);

    if (!trimmed) {
      return;
    }

    const detectedMode = detectStatementMode(trimmed);

    if (mode === undefined || (mode === "sql" && detectedMode === "plsql")) {
      mode = detectedMode;
    }
  };

  const finalizeSqlStatement = (): void => {
    const withoutTerminator = buffer.slice(0, -1);
    pushStatement(withoutTerminator);
    buffer = "";
    mode = undefined;
    lineStartIndex = 0;
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? "";
    const nextChar = script[index + 1] ?? "";

    buffer += char;

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        lineStartIndex = buffer.length;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        buffer += nextChar;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && nextChar === "'") {
        buffer += nextChar;
        index += 1;
      } else if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && nextChar === '"') {
        buffer += nextChar;
        index += 1;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      buffer += nextChar;
      index += 1;
      inLineComment = true;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      buffer += nextChar;
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    refreshMode();

    if (mode === "sql" && char === ";") {
      finalizeSqlStatement();
      continue;
    }

    const lineBoundaryReached = char === "\n" || index === script.length - 1;

    if (!lineBoundaryReached) {
      continue;
    }

    const lineEndIndex = char === "\n" ? buffer.length - 1 : buffer.length;
    const currentLine = buffer.slice(lineStartIndex, lineEndIndex);

    if (currentLine.trim() === "/") {
      if (mode === "plsql") {
        const statementText = buffer.slice(0, lineStartIndex).trimEnd();
        pushStatement(statementText);
        buffer = "";
        mode = undefined;
        lineStartIndex = 0;
        continue;
      }

      // Ignore standalone slash in SQL mode for compatibility with copied SQL*Plus scripts.
      if (mode === undefined || mode === "sql") {
        buffer = buffer.slice(0, lineStartIndex);
      }
    }

    if (char === "\n") {
      lineStartIndex = buffer.length;
    }
  }

  const remaining = normalizeStatement(buffer);

  if (remaining) {
    mode = mode ?? detectStatementMode(remaining);
    pushStatement(remaining);
  }

  return statements;
}
