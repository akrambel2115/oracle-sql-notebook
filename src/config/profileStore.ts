import * as vscode from "vscode";

import {
  ConnectionProfile,
  EXTENSION_ID,
  getConnectionProfiles
} from "./settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function findConnectionProfile(
  alias: string,
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
    EXTENSION_ID
  )
): ConnectionProfile | undefined {
  const normalizedAlias = alias.trim().toLowerCase();

  return getConnectionProfiles(config).find(
    (profile) => profile.alias.toLowerCase() === normalizedAlias
  );
}

export function resolveConnectionAlias(
  notebook: vscode.NotebookDocument,
  fallbackAlias: string | undefined
): string | undefined {
  const metadata = isRecord(notebook.metadata) ? notebook.metadata : undefined;
  const metadataAlias =
    metadata && typeof metadata.connectionAlias === "string"
      ? metadata.connectionAlias.trim()
      : "";

  if (metadataAlias.length > 0) {
    return metadataAlias;
  }

  return fallbackAlias;
}
