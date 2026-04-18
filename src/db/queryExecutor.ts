import * as vscode from "vscode";
import * as oracledb from "oracledb";

import {
  ConnectionProfile,
  ExecutionSettings,
  PoolSettings,
  SecuritySettings
} from "../config/settings";
import { Logger } from "../logging/logger";
import { enforceSqlSafety } from "../security/sqlSafetyPolicy";
import { OraclePoolManager } from "./poolManager";
import { detectResultView, QueryExecutionResult } from "./resultMapper";
import { classifySql, SqlStatementType } from "./sqlClassifier";
import { normalizeSqlForExecution } from "./sqlNormalizer";
import { ParsedSqlStatement, splitSqlScript } from "./sqlScriptParser";

export interface QueryExecutionRequest {
  profile: ConnectionProfile;
  password: string;
  sql: string;
  binds?: oracledb.BindParameters;
  sessionKey?: string;
  executionSettings: ExecutionSettings;
  poolSettings: PoolSettings;
  securitySettings: SecuritySettings;
  cancellationToken: vscode.CancellationToken;
}

export interface QueryExecutor {
  execute(request: QueryExecutionRequest): Promise<QueryExecutionResult>;
  executeScript(request: QueryExecutionRequest): Promise<QueryExecutionResult[]>;
  closeSession?(sessionKey: string): Promise<void>;
  closeAllSessions?(): Promise<void>;
}

export class OracleQueryExecutor implements QueryExecutor {
  private readonly sessionConnections = new Map<string, Promise<oracledb.Connection>>();

  public constructor(
    private readonly poolManager: OraclePoolManager,
    private readonly logger: Logger
  ) {}

  public async execute(request: QueryExecutionRequest): Promise<QueryExecutionResult> {
    const results = await this.executeScript(request);
    const lastResult = results.at(-1);

    if (!lastResult) {
      throw new Error("No SQL statements were executed.");
    }

    return lastResult;
  }

  public async executeScript(
    request: QueryExecutionRequest
  ): Promise<QueryExecutionResult[]> {
    if (request.cancellationToken.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const script = request.sql.trim();

    if (!script) {
      throw new Error("The SQL cell is empty.");
    }

    const parsedStatements = splitSqlScript(script);

    if (parsedStatements.length === 0) {
      throw new Error("The SQL cell is empty.");
    }

    if (parsedStatements.length > 1 && request.binds !== undefined) {
      throw new Error(
        "Bind parameters are not supported when executing multiple statements in one cell."
      );
    }

    const pool = await this.poolManager.getPool(
      request.profile,
      request.password,
      request.poolSettings
    );

    const { connection, managedBySession } = await this.getConnection(
      request,
      pool
    );

    const results: QueryExecutionResult[] = [];

    const cancellationSubscription = request.cancellationToken.onCancellationRequested(
      () => {
        void connection.break().catch((error: unknown) => {
          this.logger.debug("Failed to interrupt Oracle statement.", {
            error: String(error)
          });
        });
      }
    );

    try {
      connection.callTimeout = request.executionSettings.callTimeoutMs;

      for (const parsedStatement of parsedStatements) {
        if (request.cancellationToken.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const result = await this.executeParsedStatement(
          connection,
          parsedStatement,
          request
        );

        results.push(result);
      }

      return results;
    } catch (error) {
      if (
        request.cancellationToken.isCancellationRequested ||
        this.isOracleCancellationError(error)
      ) {
        throw new vscode.CancellationError();
      }

      throw error;
    } finally {
      cancellationSubscription.dispose();

      if (!managedBySession) {
        await connection.close();
      }
    }
  }

  private async executeParsedStatement(
    connection: oracledb.Connection,
    parsedStatement: ParsedSqlStatement,
    request: QueryExecutionRequest
  ): Promise<QueryExecutionResult> {
    const statementType = classifySql(parsedStatement.sql);
    const normalizerType: SqlStatementType =
      parsedStatement.mode === "plsql" ? "PLSQL" : statementType;

    const sql = normalizeSqlForExecution(parsedStatement.sql, normalizerType);

    if (!sql) {
      throw new Error("Encountered an empty SQL statement in the cell.");
    }

    enforceSqlSafety(sql, request.securitySettings);

    const startedAt = Date.now();

    if (statementType === "SELECT") {
      return this.executeSelect(connection, sql, request, statementType, startedAt);
    }

    return this.executeNonSelect(connection, sql, request, statementType, startedAt);
  }

  public async closeSession(sessionKey: string): Promise<void> {
    const connectionPromise = this.sessionConnections.get(sessionKey);

    if (!connectionPromise) {
      return;
    }

    this.sessionConnections.delete(sessionKey);

    try {
      const connection = await connectionPromise;
      await connection.close();
    } catch (error) {
      this.logger.warn(`Failed to close Oracle session '${sessionKey}'.`, {
        error: String(error)
      });
    }
  }

  public async closeAllSessions(): Promise<void> {
    const sessionKeys = Array.from(this.sessionConnections.keys());
    await Promise.allSettled(
      sessionKeys.map((sessionKey) => this.closeSession(sessionKey))
    );
  }

  private async executeSelect(
    connection: oracledb.Connection,
    sql: string,
    request: QueryExecutionRequest,
    statementType: SqlStatementType,
    startedAt: number
  ): Promise<QueryExecutionResult> {
    const executeResult = await connection.execute<Record<string, unknown>>(
      sql,
      request.binds ?? [],
      {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchArraySize: request.executionSettings.fetchArraySize,
        prefetchRows: request.executionSettings.prefetchRows
      }
    );

    const resultSet = executeResult.resultSet;

    if (!resultSet) {
      throw new Error("Oracle query did not return a result set.");
    }

    const rows: Record<string, unknown>[] = [];
    const rowLimit = request.executionSettings.maxRows + 1;
    const chunkSize = Math.max(
      1,
      Math.min(request.executionSettings.fetchArraySize, rowLimit)
    );

    try {
      while (rows.length < rowLimit) {
        if (request.cancellationToken.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const remaining = rowLimit - rows.length;
        const fetched = await resultSet.getRows(Math.min(chunkSize, remaining));

        if (fetched.length === 0) {
          break;
        }

        rows.push(...fetched);
      }
    } finally {
      await resultSet.close();
    }

    const truncated = rows.length > request.executionSettings.maxRows;
    const boundedRows = truncated
      ? rows.slice(0, request.executionSettings.maxRows)
      : rows;

    const firstRow = boundedRows[0];
    const columns = firstRow ? Object.keys(firstRow) : [];
    const view = detectResultView(columns, boundedRows);

    return {
      statementType,
      rows: boundedRows,
      columns,
      view,
      rowsAffected: 0,
      truncated,
      executionMs: Date.now() - startedAt
    };
  }

  private async executeNonSelect(
    connection: oracledb.Connection,
    sql: string,
    request: QueryExecutionRequest,
    statementType: SqlStatementType,
    startedAt: number
  ): Promise<QueryExecutionResult> {
    const executeResult = await connection.execute(
      sql,
      request.binds ?? [],
      {
        autoCommit: false,
        fetchArraySize: request.executionSettings.fetchArraySize,
        prefetchRows: request.executionSettings.prefetchRows
      }
    );

    return {
      statementType,
      rows: [],
      columns: [],
      view: "table",
      rowsAffected: executeResult.rowsAffected ?? 0,
      truncated: false,
      executionMs: Date.now() - startedAt
    };
  }

  private isOracleCancellationError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toUpperCase();
    return message.includes("ORA-01013") || message.includes("NJS-040");
  }

  private async getConnection(
    request: QueryExecutionRequest,
    pool: oracledb.Pool
  ): Promise<{ connection: oracledb.Connection; managedBySession: boolean }> {
    const sessionKey = request.sessionKey?.trim();

    if (!sessionKey) {
      return {
        connection: await pool.getConnection(),
        managedBySession: false
      };
    }

    const existingConnection = this.sessionConnections.get(sessionKey);

    if (existingConnection) {
      return {
        connection: await existingConnection,
        managedBySession: true
      };
    }

    const createdConnection = pool.getConnection();
    this.sessionConnections.set(sessionKey, createdConnection);

    try {
      return {
        connection: await createdConnection,
        managedBySession: true
      };
    } catch (error) {
      this.sessionConnections.delete(sessionKey);
      throw error;
    }
  }
}
