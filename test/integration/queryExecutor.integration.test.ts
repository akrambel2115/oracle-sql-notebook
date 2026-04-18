import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { OracleQueryExecutor, QueryExecutionRequest } from "../../src/db/queryExecutor";
import type { Logger } from "../../src/logging/logger";
import type { OraclePoolManager } from "../../src/db/poolManager";

function createCancellationToken(): {
  token: vscode.CancellationToken;
  cancel: () => void;
} {
  let canceled = false;
  const listeners = new Set<(event: vscode.CancellationToken) => unknown>();

  const token: vscode.CancellationToken = {
    get isCancellationRequested() {
      return canceled;
    },
    onCancellationRequested: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        }
      };
    }
  };

  return {
    token,
    cancel: () => {
      canceled = true;
      for (const listener of listeners) {
        listener(token);
      }
    }
  };
}

function createBaseRequest(
  token: vscode.CancellationToken
): Omit<QueryExecutionRequest, "sql"> {
  return {
    profile: {
      alias: "dev",
      user: "hr",
      connectString: "localhost/XEPDB1"
    },
    password: "test",
    executionSettings: {
      maxRows: 3,
      callTimeoutMs: 12000,
      fetchArraySize: 2,
      prefetchRows: 2
    },
    poolSettings: {
      queueTimeoutMs: 60000,
      poolTimeoutSeconds: 300,
      stmtCacheSize: 30
    },
    securitySettings: {
      readOnlyMode: false,
      blockedStatementPrefixes: []
    },
    cancellationToken: token
  };
}

function createLoggerStub(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    dispose: vi.fn()
  } as unknown as Logger;
}

describe("OracleQueryExecutor integration", () => {
  it("fetches SELECT rows in chunks and truncates output to maxRows", async () => {
    const { token } = createCancellationToken();

    const rowSource: Record<string, unknown>[] = [
      { ID: 1, NAME: "A" },
      { ID: 2, NAME: "B" },
      { ID: 3, NAME: "C" },
      { ID: 4, NAME: "D" }
    ];

    let offset = 0;

    const resultSet = {
      getRows: vi.fn(async (count: number) => {
        const rows = rowSource.slice(offset, offset + count);
        offset += rows.length;
        return rows;
      }),
      close: vi.fn(async () => undefined)
    };

    const connection = {
      callTimeout: 0,
      execute: vi.fn(async () => ({ resultSet })),
      break: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };

    const pool = {
      getConnection: vi.fn(async () => connection)
    };

    const poolManager = {
      getPool: vi.fn(async () => pool)
    } as unknown as OraclePoolManager;

    const executor = new OracleQueryExecutor(poolManager, createLoggerStub());

    const result = await executor.execute({
      ...createBaseRequest(token),
      sql: "select id, name from employees order by id"
    });

    expect(result.statementType).toBe("SELECT");
    expect(result.view).toBe("table");
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.columns).toEqual(["ID", "NAME"]);
    expect(connection.callTimeout).toBe(12000);
    expect(resultSet.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("normalizes trailing SQL terminators before execution", async () => {
    const { token } = createCancellationToken();

    const resultSet = {
      getRows: vi.fn(async () => [{ PLAN_TABLE_OUTPUT: "line" }]),
      close: vi.fn(async () => undefined)
    };

    const connection = {
      callTimeout: 0,
      execute: vi.fn(async () => ({ resultSet })),
      break: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };

    const pool = {
      getConnection: vi.fn(async () => connection)
    };

    const poolManager = {
      getPool: vi.fn(async () => pool)
    } as unknown as OraclePoolManager;

    const executor = new OracleQueryExecutor(poolManager, createLoggerStub());

    const result = await executor.execute({
      ...createBaseRequest(token),
      sql: "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY());\n/"
    });

    expect(connection.execute).toHaveBeenCalledWith(
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())",
      [],
      expect.any(Object)
    );
    expect(result.view).toBe("plan");
  });

  it("maps Oracle cancellation errors to CancellationError", async () => {
    const { token, cancel } = createCancellationToken();

    const connection = {
      callTimeout: 0,
      execute: vi.fn(async () => {
        cancel();
        throw new Error("ORA-01013: user requested cancel of current operation");
      }),
      break: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };

    const pool = {
      getConnection: vi.fn(async () => connection)
    };

    const poolManager = {
      getPool: vi.fn(async () => pool)
    } as unknown as OraclePoolManager;

    const executor = new OracleQueryExecutor(poolManager, createLoggerStub());

    await expect(
      executor.execute({
        ...createBaseRequest(token),
        sql: "select * from dual"
      })
    ).rejects.toBeInstanceOf(vscode.CancellationError);

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("reuses one connection per session key and closes it on closeSession", async () => {
    const { token } = createCancellationToken();

    const resultSet = {
      getRows: vi.fn(async () => [{ ID: 1 }]),
      close: vi.fn(async () => undefined)
    };

    const connection = {
      callTimeout: 0,
      execute: vi.fn(async () => ({ resultSet })),
      break: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };

    const pool = {
      getConnection: vi.fn(async () => connection)
    };

    const poolManager = {
      getPool: vi.fn(async () => pool)
    } as unknown as OraclePoolManager;

    const executor = new OracleQueryExecutor(poolManager, createLoggerStub());
    const baseRequest = createBaseRequest(token);

    await executor.execute({
      ...baseRequest,
      sessionKey: "notebook-session-1",
      sql: "select * from dual"
    });

    await executor.execute({
      ...baseRequest,
      sessionKey: "notebook-session-1",
      sql: "select * from dual"
    });

    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(0);

    await executor.closeSession?.("notebook-session-1");

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("executes multiple semicolon-separated statements in one script", async () => {
    const { token } = createCancellationToken();

    const firstResultSet = {
      getRows: vi.fn(async () => [{ ONE: 1 }]),
      close: vi.fn(async () => undefined)
    };

    const secondResultSet = {
      getRows: vi.fn(async () => [{ TWO: 2 }]),
      close: vi.fn(async () => undefined)
    };

    const connection = {
      callTimeout: 0,
      execute: vi
        .fn()
        .mockResolvedValueOnce({ resultSet: firstResultSet })
        .mockResolvedValueOnce({ resultSet: secondResultSet }),
      break: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };

    const pool = {
      getConnection: vi.fn(async () => connection)
    };

    const poolManager = {
      getPool: vi.fn(async () => pool)
    } as unknown as OraclePoolManager;

    const executor = new OracleQueryExecutor(poolManager, createLoggerStub());

    const results = await executor.executeScript({
      ...createBaseRequest(token),
      sql: "select 1 as one from dual; select 2 as two from dual;"
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.columns).toEqual(["ONE"]);
    expect(results[1]?.columns).toEqual(["TWO"]);
    expect(connection.execute).toHaveBeenNthCalledWith(
      1,
      "select 1 as one from dual",
      [],
      expect.any(Object)
    );
    expect(connection.execute).toHaveBeenNthCalledWith(
      2,
      "select 2 as two from dual",
      [],
      expect.any(Object)
    );
  });
});
