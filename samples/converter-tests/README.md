# Converter Validation Test Cases

Open these files in the Extension Development Host (`F5`). The validation layer only activates for `.sql` files that *already look like paired notebook SQL* (header and/or `-- %%` markers).

For each test file below:

- Open `View -> Problems` to see the warnings.
- Put the cursor on the underlined line and use `Ctrl+.` (Quick Fix) when noted.
- Try `Oracle SQL Notebook: Convert SQL to Notebook` and observe whether it converts, warns, or blocks.

## Test Files

### 1) Valid Paired SQL (no Problems, converts cleanly)
- File: `01_valid_paired.sql`
- Expected:
  - No Problems from `oracle-sql-notebook`
  - Conversion succeeds without warning prompt (other than overwrite)

### 2) Missing Header (warning + quick fix, conversion allowed with warning prompt)
- File: `02_missing_header.sql`
- Expected:
  - Problem code: `missingHeader`
  - Quick fix: "Add notebook header"
  - Conversion: allowed, but prompts due to warnings

### 3) Malformed Header JSON (blocking, quick fix offered, conversion blocked)
- File: `03_bad_header_json_blocking.sql`
- Expected:
  - Problem code: `invalidHeaderJson` (blocking)
  - Quick fix: "Replace with canonical notebook header"
  - Conversion: blocked with an error modal until fixed

### 4) Unsupported Header Schema Version (blocking, conversion blocked)
- File: `04_unsupported_schema_version_blocking.sql`
- Expected:
  - Problem code: `unsupportedSchemaVersion` (blocking)
  - Conversion: blocked with an error modal

### 5) Malformed Cell Marker JSON (blocking, quick fix offered, conversion blocked)
- File: `05_bad_marker_json_blocking.sql`
- Expected:
  - Problem code: `invalidCellMarkerJson` (blocking)
  - Quick fix: "Replace with canonical cell marker metadata"
  - Conversion: blocked with an error modal until fixed

### 6) Stray Text Outside Cells (warning, conversion allowed with warning prompt)
- File: `06_stray_text_outside_cells.sql`
- Expected:
  - Problem code: `strayTextOutsideCells`
  - Conversion: allowed, but prompts due to warnings

### 7) Markdown Cell Has Non-Comment Line (warning + quick fix, conversion allowed with warning prompt)
- File: `07_markdown_line_needs_comment_prefix.sql`
- Expected:
  - Problem code: `markdownLineMissingCommentPrefix`
  - Quick fix: "Prefix markdown line with '-- '"
  - Conversion: allowed, but prompts due to warnings

### 8) Non-Canonical Markup Marker (warning + quick fix, conversion allowed with warning prompt)
- File: `08_non_canonical_markup_marker.sql`
- Expected:
  - Problem code: `nonCanonicalMarkupLanguage`
  - Quick fix: "Normalize marker to [markdown]"
  - Conversion: allowed, but prompts due to warnings

### 9) Unsupported Cell Language Marker (warning, conversion allowed with warning prompt)
- File: `09_unsupported_cell_language.sql`
- Expected:
  - Problem code: `unsupportedCellLanguage`
  - Conversion: allowed, but prompts due to warnings

### 10) Looks Paired But Missing Cell Markers (warning, conversion allowed with warning prompt)
- File: `10_missing_cell_markers.sql`
- Expected:
  - Problem code: `missingCellMarkers`
  - Conversion: allowed, but prompts due to warnings

