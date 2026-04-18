# Oracle SQL Notebook for VS Code

A native Visual Studio Code notebook extension that allows you to run Oracle SQL queries interactively within `.isqlnb` files.

## Features

- **Interactive Notebooks:** Execute Oracle SQL and PL/SQL queries as notebook cells safely.
- **Rich Data Output:** View query results in an interactive table renderer, allowing you to easily browse datasets natively in VS Code.
- **Execution Plans:** Built-in support for rendering runtime execution plans (DBMS_XPLAN style).
- **Session Continuity:** Multiple statements in the same notebook run in the same session by default, making it simple to define temporary tables or session variables.
- **Secure Credential Storage:** Connection passwords are securely stored in VS Code's native SecretStorage—never saved as plain text in your settings or notebooks.
- **Connection Pooling:** Powered by `node-oracledb` pools for high-performance and robust concurrent executions.

## Getting Started

1. **Install the Extension** from the VS Code Marketplace.
2. **Create a new file** with the `.isqlnb` extension (e.g., `query.isqlnb`).
3. **Configure your connection** globally in your `settings.json` (see Configuration below). 
4. **Set your password** by running the command `Oracle SQL Notebook: Set Connection Password` from the Command Palette (`Ctrl+Shift+P`).
5. **Write your SQL** and hit the Run button on the cell!

## Configuration

You can define multiple Oracle connections in your VS Code `settings.json` and set performance/safety preferences.

```json
{
  "oracleSqlNotebook.defaultConnectionAlias": "dev",
  "oracleSqlNotebook.connections": [
    {
      "alias": "dev",
      "user": "hr",
      "connectString": "localhost/XEPDB1",
      "poolMin": 0,
      "poolMax": 4,
      "poolIncrement": 1
    }
  ],
  "oracleSqlNotebook.execution.maxRows": 1000,
  "oracleSqlNotebook.execution.callTimeoutMs": 30000,
  "oracleSqlNotebook.execution.fetchArraySize": 100,
  "oracleSqlNotebook.execution.prefetchRows": 100,
  "oracleSqlNotebook.security.readOnlyMode": false
}
```

## Writing Queries

- **Single & Multiple Statements:** Statements separated by a semicolon (`;`) run sequentially.
- **PL/SQL Blocks & Scripts:** For `CREATE PROCEDURE` / `FUNCTION` / `PACKAGE` scripts or PL/SQL blocks, use `/` on its own line as the block terminator, mirroring SQL*Plus behavior.

```sql
-- Standard queries
SELECT * FROM employees;
```

```sql
-- PL/SQL block execution
BEGIN
  DBMS_OUTPUT.PUT_LINE('Hello from PL/SQL!');
END;
/
```

## Security & Trust

- **Workspace Trust:** Execution and privileged actions are gated behind VS Code's Workspace Trust requirements. Untrusted workspaces will block notebook execution.
- **Strict Read-Only Mode:** Use the optional `oracleSqlNotebook.security.readOnlyMode` setting to restrict execution to `SELECT` and `CTE` queries only.
- **Blocked Execution:** An optional `oracleSqlNotebook.security.blockedStatementPrefixes` configuration blocks unsafe SQL commands (e.g., `ALTER SYSTEM`, `DROP USER`).
- **No Credentials in Files:** Authentication parameters like passwords remain out of your project metadata.

## Development & Contributing

To build, test, and package:

```bash
npm install
npm run check
npm run test         # Unit Tests
npm run test:e2e     # End-to-End Tests
npm run build
npm run package      # Build a .vsix for local installation
```

To run smoke tests locally, press `F5` in VS Code to launch an Extension Development Host.
