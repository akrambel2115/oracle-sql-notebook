const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const originalExtensionPath = path.resolve(__dirname, "../..");
  const testRootLink = path.join(os.tmpdir(), "oracle-sql-notebook-e2e-link");
  const symlinkType = process.platform === "win32" ? "junction" : "dir";

  try {
    await fs.rm(testRootLink, { recursive: true, force: true });
    await fs.symlink(originalExtensionPath, testRootLink, symlinkType);

    const extensionDevelopmentPath = testRootLink;
    const extensionTestsPath = path.join(
      extensionDevelopmentPath,
      "test",
      "e2e",
      "suite",
      "index.js"
    );
    const userDataDir = path.join(os.tmpdir(), "oracle-sql-notebook-e2e-user-data");

    await runTests({
      version: "1.90.0",
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        extensionDevelopmentPath,
        "--disable-updates",
        "--disable-workspace-trust",
        `--user-data-dir=${userDataDir}`
      ],
      extensionTestsEnv: {
        ORACLE_SQL_NOTEBOOK_TEST_MODE: "1"
      }
    });
  } catch (error) {
    console.error("Failed to run extension e2e tests.");
    console.error(error);
    process.exit(1);
  } finally {
    await fs.rm(testRootLink, { recursive: true, force: true });
  }
}

void main();
