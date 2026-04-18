import { SqlStatementType } from "./sqlClassifier";

function stripSqlPlusSlashTerminator(sql: string): string {
  let normalized = sql;

  // SQL*Plus and SQLcl often use a trailing "/" line as a statement terminator.
  while (/(?:^|\n)\s*\/\s*$/u.test(normalized)) {
    normalized = normalized.replace(/(?:^|\n)\s*\/\s*$/u, "").trimEnd();
  }

  return normalized;
}

export function normalizeSqlForExecution(
  sql: string,
  statementType: SqlStatementType
): string {
  let normalized = stripSqlPlusSlashTerminator(sql.trim());

  // For plain SQL statements, strip trailing SQL*Plus semicolon terminators.
  if (statementType !== "PLSQL") {
    normalized = normalized.replace(/;+(?=\s*$)/u, "").trimEnd();
  }

  return normalized;
}
