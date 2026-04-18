import * as vscode from "vscode";

export const EXTENSION_ID = "oracleSqlNotebook";
export const NOTEBOOK_TYPE = "oracle-sql-notebook";

export interface ConnectionProfile {
  alias: string;
  user: string;
  connectString: string;
  poolMin?: number;
  poolMax?: number;
  poolIncrement?: number;
}

export interface ExecutionSettings {
  maxRows: number;
  callTimeoutMs: number;
  fetchArraySize: number;
  prefetchRows: number;
}

export interface PoolSettings {
  queueTimeoutMs: number;
  poolTimeoutSeconds: number;
  stmtCacheSize: number;
}

export interface SecuritySettings {
  readOnlyMode: boolean;
  blockedStatementPrefixes: string[];
}

export type LoggingLevel = "error" | "warn" | "info" | "debug";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function normalizeProfile(raw: unknown): ConnectionProfile | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
  const user = typeof raw.user === "string" ? raw.user.trim() : "";
  const connectString =
    typeof raw.connectString === "string" ? raw.connectString.trim() : "";

  if (!alias || !user || !connectString) {
    return undefined;
  }

  const poolMin = parseFiniteNumber(raw.poolMin);
  const poolMax = parseFiniteNumber(raw.poolMax);
  const poolIncrement = parseFiniteNumber(raw.poolIncrement);

  const profile: ConnectionProfile = {
    alias,
    user,
    connectString
  };

  if (poolMin !== undefined && poolMin >= 0) {
    profile.poolMin = poolMin;
  }

  if (poolMax !== undefined && poolMax >= 1) {
    profile.poolMax = poolMax;
  }

  if (poolIncrement !== undefined && poolIncrement >= 1) {
    profile.poolIncrement = poolIncrement;
  }

  return profile;
}

function getIntegerSetting(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number
): number {
  const raw = config.get<number>(key, fallback);

  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(raw));
}

export function getConnectionProfiles(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): ConnectionProfile[] {
  const rawProfiles = config.get<unknown[]>("connections", []);

  return rawProfiles
    .map((raw) => normalizeProfile(raw))
    .filter((profile): profile is ConnectionProfile => profile !== undefined);
}

export function getDefaultConnectionAlias(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): string | undefined {
  const alias = config.get<string>("defaultConnectionAlias", "").trim();
  return alias.length > 0 ? alias : undefined;
}

export function getExecutionSettings(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): ExecutionSettings {
  return {
    maxRows: getIntegerSetting(config, "execution.maxRows", 1000, 1),
    callTimeoutMs: getIntegerSetting(
      config,
      "execution.callTimeoutMs",
      30000,
      1000
    ),
    fetchArraySize: getIntegerSetting(config, "execution.fetchArraySize", 100, 1),
    prefetchRows: getIntegerSetting(config, "execution.prefetchRows", 100, 0)
  };
}

export function getPoolSettings(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): PoolSettings {
  return {
    queueTimeoutMs: getIntegerSetting(config, "pool.queueTimeoutMs", 60000, 0),
    poolTimeoutSeconds: getIntegerSetting(
      config,
      "pool.poolTimeoutSeconds",
      300,
      0
    ),
    stmtCacheSize: getIntegerSetting(config, "pool.stmtCacheSize", 30, 0)
  };
}

export function getSecuritySettings(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): SecuritySettings {
  const blockedValues = config.get<unknown[]>("security.blockedStatementPrefixes", [
    "ALTER SYSTEM",
    "DROP USER"
  ]);

  const blockedStatementPrefixes = [
    ...new Set(
      blockedValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0)
    )
  ];

  return {
    readOnlyMode: config.get<boolean>("security.readOnlyMode", false),
    blockedStatementPrefixes
  };
}

export function getLoggingLevel(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): LoggingLevel {
  const level = config.get<string>("logging.level", "info");

  switch (level) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      return level;
    default:
      return "info";
  }
}
