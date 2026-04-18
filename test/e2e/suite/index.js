const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "akrambel.oracle-sql-notebook";
const TABLE_MIME = "application/vnd.oracle-sql-notebook.table+json";

async function waitFor(predicate, timeoutMs = 10000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }

  throw new Error("Timed out while waiting for notebook output.");
}

async function runNotebookExecutionE2E() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected extension '${EXTENSION_ID}' to be installed.`);

  const api = await extension.activate();
  assert.ok(
    api && typeof api.runNotebookCellsForTesting === "function",
    "Extension did not expose runNotebookCellsForTesting API in test mode."
  );

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "oracle-sql-notebook-e2e-")
  );

  const notebookUri = vscode.Uri.file(path.join(tempDir, "query.isqlnb"));
  const notebookPayload = {
    schemaVersion: 1,
    metadata: {},
    cells: [
      {
        kind: "code",
        language: "sql",
        value: "select 1 as answer from dual",
        metadata: {}
      }
    ]
  };

  try {
    await fs.writeFile(
      notebookUri.fsPath,
      JSON.stringify(notebookPayload, null, 2),
      "utf8"
    );

    const notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    await vscode.window.showNotebookDocument(notebook);

    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "oracle-sql-notebook-controller",
      extension: EXTENSION_ID
    });

    await api.runNotebookCellsForTesting(notebook, 0, 1);

    await waitFor(() => notebook.cellAt(0).outputs.length > 0);

    const outputItems = notebook
      .cellAt(0)
      .outputs.flatMap((output) => output.items);
    const tableOutput = outputItems.find((item) => item.mime === TABLE_MIME);

    assert.ok(tableOutput, "Expected custom table MIME output from executed cell.");

    const payload = JSON.parse(Buffer.from(tableOutput.data).toString("utf8"));

    assert.equal(Array.isArray(payload.columns), true);
    assert.equal(Array.isArray(payload.rows), true);
    assert.equal(payload.columns.includes("RESULT"), true);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].RESULT, "ok");
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await runNotebookExecutionE2E();
}

module.exports = {
  run
};
