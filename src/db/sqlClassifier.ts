export type SqlStatementType = "SELECT" | "DML" | "DDL" | "PLSQL" | "UNKNOWN";

const DML_PREFIXES = ["INSERT", "UPDATE", "DELETE", "MERGE"];
const DDL_PREFIXES = [
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "GRANT",
  "REVOKE"
];

function stripComments(sql: string): string {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlockComments.replace(/--.*$/gm, " ");
}

function normalizedPrefix(sql: string): string {
  const normalized = stripComments(sql)
    .trimStart()
    .replace(/^;+/, "")
    .trimStart()
    .replace(/\s+/g, " ")
    .toUpperCase();

  return normalized;
}

export function classifySql(sql: string): SqlStatementType {
  const prefix = normalizedPrefix(sql);

  if (prefix.startsWith("SELECT") || prefix.startsWith("WITH")) {
    return "SELECT";
  }

  if (
    prefix.startsWith("BEGIN") ||
    prefix.startsWith("DECLARE") ||
    prefix.startsWith("CALL")
  ) {
    return "PLSQL";
  }

  if (DML_PREFIXES.some((keyword) => prefix.startsWith(keyword))) {
    return "DML";
  }

  if (DDL_PREFIXES.some((keyword) => prefix.startsWith(keyword))) {
    return "DDL";
  }

  return "UNKNOWN";
}
