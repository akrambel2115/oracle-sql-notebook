const DEFAULT_PAGE_SIZE = 50;
const PLAN_MIME = "application/vnd.oracle-sql-notebook.plan+json";

function asObject(value) {
  return typeof value === "object" && value !== null ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toDisplayValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable object]";
    }
  }

  return String(value);
}

function compareValues(left, right, ascending) {
  const leftText = toDisplayValue(left);
  const rightText = toDisplayValue(right);
  const compared = leftText.localeCompare(rightText, undefined, {
    numeric: true,
    sensitivity: "base"
  });

  return ascending ? compared : -compared;
}

function buildButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createTableRendererPayload(outputItem) {
  const payload = asObject(outputItem.json());
  const columns = asArray(payload.columns).filter((item) => typeof item === "string");
  const rows = asArray(payload.rows)
    .map((item) => asObject(item))
    .filter((item) => Object.keys(item).length > 0 || columns.length === 0);

  return {
    columns,
    rows,
    rowCount: typeof payload.rowCount === "number" ? payload.rowCount : rows.length,
    truncated: payload.truncated === true,
    executionMs: typeof payload.executionMs === "number" ? payload.executionMs : 0
  };
}

function createPlanRendererPayload(outputItem) {
  const payload = asObject(outputItem.json());
  const lines = asArray(payload.lines).filter((item) => typeof item === "string");

  return {
    lines,
    rowCount: typeof payload.rowCount === "number" ? payload.rowCount : lines.length,
    truncated: payload.truncated === true,
    executionMs: typeof payload.executionMs === "number" ? payload.executionMs : 0
  };
}

function renderCell(row, columnName) {
  const td = document.createElement("td");
  td.textContent = toDisplayValue(row[columnName]);
  return td;
}

function applyStyles(root) {
  root.style.fontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  root.style.fontSize = "12px";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";

  const style = document.createElement("style");
  style.textContent = `
    .oracle-sql-meta {
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }

    .oracle-sql-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .oracle-sql-table-wrap {
      overflow: auto;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      max-height: 480px;
    }

    .oracle-sql-table {
      border-collapse: collapse;
      width: 100%;
      min-width: 500px;
      background: var(--vscode-editor-background);
    }

    .oracle-sql-table th,
    .oracle-sql-table td {
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      border-right: 1px solid var(--vscode-editorWidget-border);
      padding: 6px 8px;
      white-space: nowrap;
      text-align: left;
      vertical-align: top;
    }

    .oracle-sql-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editorStickyScroll-background);
      cursor: pointer;
      user-select: none;
    }

    .oracle-sql-warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .oracle-sql-page {
      color: var(--vscode-descriptionForeground);
    }

    .oracle-sql-plan-wrap {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      overflow: auto;
      max-height: 480px;
      background: var(--vscode-editor-background);
    }

    .oracle-sql-plan {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.35;
      white-space: pre;
    }
  `;

  root.appendChild(style);
}

export function activate() {
  function renderPlanOutput(outputItem, element) {
    const payload = createPlanRendererPayload(outputItem);

    const root = document.createElement("div");
    applyStyles(root);

    const meta = document.createElement("div");
    meta.className = "oracle-sql-meta";

    const lineSummary = document.createElement("span");
    lineSummary.textContent = `${payload.rowCount} plan line(s) fetched`;

    const duration = document.createElement("span");
    duration.textContent = `Execution: ${payload.executionMs} ms`;

    meta.appendChild(lineSummary);
    meta.appendChild(duration);

    if (payload.truncated) {
      const warning = document.createElement("span");
      warning.className = "oracle-sql-warning";
      warning.textContent =
        "Preview is truncated by maxRows. Increase maxRows to see the full plan.";
      meta.appendChild(warning);
    }

    const wrap = document.createElement("div");
    wrap.className = "oracle-sql-plan-wrap";

    const pre = document.createElement("pre");
    pre.className = "oracle-sql-plan";
    pre.textContent = payload.lines.length > 0 ? payload.lines.join("\n") : "No plan lines";

    wrap.appendChild(pre);
    root.appendChild(meta);
    root.appendChild(wrap);

    element.appendChild(root);
  }

  return {
    renderOutputItem(outputItem, element) {
      element.textContent = "";

      if (outputItem.mime === PLAN_MIME) {
        renderPlanOutput(outputItem, element);
        return;
      }

      const payload = createTableRendererPayload(outputItem);
      let page = 0;
      let sortColumn = null;
      let sortAscending = true;

      const root = document.createElement("div");
      applyStyles(root);

      const meta = document.createElement("div");
      meta.className = "oracle-sql-meta";

      const rowSummary = document.createElement("span");
      rowSummary.textContent = `${payload.rowCount} row(s) fetched`;

      const duration = document.createElement("span");
      duration.textContent = `Execution: ${payload.executionMs} ms`;

      meta.appendChild(rowSummary);
      meta.appendChild(duration);

      if (payload.truncated) {
        const warning = document.createElement("span");
        warning.className = "oracle-sql-warning";
        warning.textContent =
          "Preview is truncated by maxRows. Increase maxRows to see more rows.";
        meta.appendChild(warning);
      }

      const toolbar = document.createElement("div");
      toolbar.className = "oracle-sql-toolbar";

      const previousButton = buildButton("Previous", () => {
        if (page > 0) {
          page -= 1;
          renderTableBody();
        }
      });

      const nextButton = buildButton("Next", () => {
        const maxPage = Math.max(0, Math.ceil(sortedRows().length / DEFAULT_PAGE_SIZE) - 1);
        if (page < maxPage) {
          page += 1;
          renderTableBody();
        }
      });

      const pageLabel = document.createElement("span");
      pageLabel.className = "oracle-sql-page";

      toolbar.appendChild(previousButton);
      toolbar.appendChild(nextButton);
      toolbar.appendChild(pageLabel);

      const tableWrap = document.createElement("div");
      tableWrap.className = "oracle-sql-table-wrap";

      const table = document.createElement("table");
      table.className = "oracle-sql-table";
      table.setAttribute("aria-label", "Oracle SQL query result table");

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");

      const tbody = document.createElement("tbody");

      const discoveredColumns =
        payload.columns.length > 0
          ? payload.columns
          : Array.from(
              new Set(payload.rows.flatMap((row) => Object.keys(asObject(row))))
            );

      function sortedRows() {
        if (!sortColumn) {
          return payload.rows;
        }

        const copied = [...payload.rows];
        copied.sort((left, right) =>
          compareValues(left[sortColumn], right[sortColumn], sortAscending)
        );
        return copied;
      }

      function renderTableBody() {
        const rows = sortedRows();
        const maxPage = Math.max(0, Math.ceil(rows.length / DEFAULT_PAGE_SIZE) - 1);
        if (page > maxPage) {
          page = maxPage;
        }

        const from = page * DEFAULT_PAGE_SIZE;
        const to = Math.min(rows.length, from + DEFAULT_PAGE_SIZE);
        const pageRows = rows.slice(from, to);

        tbody.textContent = "";

        for (const row of pageRows) {
          const tr = document.createElement("tr");
          for (const columnName of discoveredColumns) {
            tr.appendChild(renderCell(row, columnName));
          }
          tbody.appendChild(tr);
        }

        if (pageRows.length === 0) {
          const emptyRow = document.createElement("tr");
          const emptyCell = document.createElement("td");
          emptyCell.colSpan = Math.max(1, discoveredColumns.length);
          emptyCell.textContent = "No rows";
          emptyRow.appendChild(emptyCell);
          tbody.appendChild(emptyRow);
        }

        previousButton.disabled = page <= 0;
        nextButton.disabled = page >= maxPage;
        pageLabel.textContent = `Page ${maxPage === 0 ? 1 : page + 1} / ${maxPage + 1}`;
      }

      for (const columnName of discoveredColumns) {
        const th = document.createElement("th");
        th.textContent = columnName;
        th.setAttribute("role", "columnheader");

        th.addEventListener("click", () => {
          if (sortColumn === columnName) {
            sortAscending = !sortAscending;
          } else {
            sortColumn = columnName;
            sortAscending = true;
          }
          page = 0;
          renderTableBody();
        });

        headRow.appendChild(th);
      }

      thead.appendChild(headRow);
      table.appendChild(thead);
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      root.appendChild(meta);
      root.appendChild(toolbar);
      root.appendChild(tableWrap);

      element.appendChild(root);
      renderTableBody();
    }
  };
}
