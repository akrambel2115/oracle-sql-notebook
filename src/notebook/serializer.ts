import * as vscode from "vscode";

import { migrateNotebookPayload } from "./migrations";
import {
  createDefaultRawNotebook,
  fromNotebookData,
  toNotebookData
} from "./schema";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export class OracleSqlNotebookSerializer implements vscode.NotebookSerializer {
  public deserializeNotebook(
    content: Uint8Array,
    token: vscode.CancellationToken
  ): vscode.NotebookData {
    if (token.isCancellationRequested) {
      return toNotebookData(createDefaultRawNotebook());
    }

    const text = textDecoder.decode(content);

    if (!text.trim()) {
      return toNotebookData(createDefaultRawNotebook());
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        "The .isqlnb file is not valid JSON and could not be deserialized."
      );
    }

    const migrated = migrateNotebookPayload(parsed);
    return toNotebookData(migrated);
  }

  public serializeNotebook(
    data: vscode.NotebookData,
    token: vscode.CancellationToken
  ): Uint8Array {
    if (token.isCancellationRequested) {
      return new Uint8Array();
    }

    const rawNotebook = fromNotebookData(data);
    const formatted = JSON.stringify(rawNotebook, null, 2);

    return textEncoder.encode(formatted);
  }
}
