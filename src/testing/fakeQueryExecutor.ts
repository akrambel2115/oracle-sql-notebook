import * as vscode from "vscode";

import { QueryExecutionRequest, QueryExecutor } from "../db/queryExecutor";
import { QueryExecutionResult } from "../db/resultMapper";
import { classifySql } from "../db/sqlClassifier";
import { splitSqlScript } from "../db/sqlScriptParser";

export class FakeQueryExecutor implements QueryExecutor {
  public async execute(request: QueryExecutionRequest): Promise<QueryExecutionResult> {
    const results = await this.executeScript(request);
    const lastResult = results.at(-1);

    if (!lastResult) {
      throw new Error("No SQL statements were executed.");
    }

    return lastResult;
  }

  public executeScript(
    request: QueryExecutionRequest
  ): Promise<QueryExecutionResult[]> {
    if (request.cancellationToken.isCancellationRequested) {
      return Promise.reject(new vscode.CancellationError());
    }

    const statements = splitSqlScript(request.sql);

    if (statements.length === 0) {
      return Promise.reject(new Error("The SQL cell is empty."));
    }

    const results: QueryExecutionResult[] = statements.map((statement) => {
      const statementType = classifySql(statement.sql);
      const startedAt = Date.now();

      if (statementType === "SELECT") {
        const rows = [
          {
            RESULT: "ok",
            SQL_PREVIEW: statement.sql.slice(0, 100)
          }
        ];

        return {
          statementType,
          rows,
          columns: ["RESULT", "SQL_PREVIEW"],
          view: "table",
          rowsAffected: 0,
          truncated: false,
          executionMs: Date.now() - startedAt
        };
      }

      return {
        statementType,
        rows: [],
        columns: [],
        view: "table",
        rowsAffected: statementType === "DML" ? 1 : 0,
        truncated: false,
        executionMs: Date.now() - startedAt
      };
    });

    return Promise.resolve(results);
  }
}
