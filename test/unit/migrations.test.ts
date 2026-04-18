import { describe, expect, it } from "vitest";

import { migrateNotebookPayload } from "../../src/notebook/migrations";

describe("migrateNotebookPayload", () => {
  it("returns default notebook for invalid payload", () => {
    const migrated = migrateNotebookPayload(null);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.cells.length).toBeGreaterThan(0);
  });

  it("migrates legacy markdown and source arrays", () => {
    const migrated = migrateNotebookPayload({
      schemaVersion: 0,
      metadata: { connectionAlias: "dev" },
      cells: [
        {
          cell_type: "markdown",
          source: ["# Title", "\nBody"],
          metadata: { sample: true }
        }
      ]
    });

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.metadata.connectionAlias).toBe("dev");
    expect(migrated.cells[0]?.kind).toBe("markup");
    expect(migrated.cells[0]?.value).toContain("Title");
  });

  it("throws on unsupported schema versions", () => {
    expect(() =>
      migrateNotebookPayload({
        schemaVersion: 99,
        cells: []
      })
    ).toThrow(/Unsupported notebook schema version/);
  });
});
