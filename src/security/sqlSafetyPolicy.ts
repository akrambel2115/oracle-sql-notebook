import { SecuritySettings } from "../config/settings";
import { classifySql } from "../db/sqlClassifier";

function stripComments(sql: string): string {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlockComments.replace(/--.*$/gm, " ");
}

function normalizeStatementPrefix(sql: string): string {
  return stripComments(sql).trimStart().replace(/\s+/g, " ").toUpperCase();
}

export function enforceSqlSafety(
  sql: string,
  securitySettings: SecuritySettings
): void {
  const normalizedPrefix = normalizeStatementPrefix(sql);

  for (const blockedPrefix of securitySettings.blockedStatementPrefixes) {
    if (normalizedPrefix.startsWith(blockedPrefix)) {
      throw new Error(`Statement blocked by policy: ${blockedPrefix}`);
    }
  }

  if (!securitySettings.readOnlyMode) {
    return;
  }

  const statementType = classifySql(sql);

  if (statementType !== "SELECT") {
    throw new Error(
      "Read-only mode is enabled. Only SELECT and WITH statements are allowed."
    );
  }
}
