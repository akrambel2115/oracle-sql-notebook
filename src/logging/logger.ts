import * as vscode from "vscode";
import { inspect } from "node:util";

import { LoggingLevel } from "../config/settings";
import { redactSensitive } from "../security/redaction";

const LEVEL_ORDER: Record<LoggingLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Oracle SQL Notebook");

  public constructor(private level: LoggingLevel) {}

  public setLevel(level: LoggingLevel): void {
    this.level = level;
  }

  public error(message: string, details?: unknown): void {
    this.log("error", message, details);
  }

  public warn(message: string, details?: unknown): void {
    this.log("warn", message, details);
  }

  public info(message: string, details?: unknown): void {
    this.log("info", message, details);
  }

  public debug(message: string, details?: unknown): void {
    this.log("debug", message, details);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private log(level: LoggingLevel, message: string, details?: unknown): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) {
      return;
    }

    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const safeMessage = redactSensitive(message);

    if (details === undefined) {
      this.channel.appendLine(`${prefix} ${safeMessage}`);
      return;
    }

    const serializedDetails =
      typeof details === "string"
        ? details
        : inspect(details, {
            depth: 6,
            maxArrayLength: 50,
            breakLength: 120
          });

    this.channel.appendLine(
      `${prefix} ${safeMessage} ${redactSensitive(serializedDetails)}`
    );
  }
}
