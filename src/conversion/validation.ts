import * as vscode from "vscode";

import {
  analyzeSqlNotebookText,
  SqlNotebookAnalysisResult,
  SqlNotebookTextRange,
  SqlNotebookValidationIssue
} from "./sqlNotebookText";

const DIAGNOSTIC_SOURCE = "oracle-sql-notebook";

function isSqlDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLowerCase().endsWith(".sql");
}

function toVsCodeRange(range: SqlNotebookTextRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.startLine, range.startCharacter),
    new vscode.Position(range.endLine, range.endCharacter)
  );
}

function rangesOverlap(left: SqlNotebookTextRange, right: vscode.Range): boolean {
  const leftStartsBeforeRightEnds =
    left.startLine < right.end.line ||
    (left.startLine === right.end.line && left.startCharacter <= right.end.character);
  const rightStartsBeforeLeftEnds =
    right.start.line < left.endLine ||
    (right.start.line === left.endLine && right.start.character <= left.endCharacter);

  return leftStartsBeforeRightEnds && rightStartsBeforeLeftEnds;
}

function createDiagnostic(issue: SqlNotebookValidationIssue): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    toVsCodeRange(issue.range),
    issue.message,
    vscode.DiagnosticSeverity.Warning
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = issue.code;
  return diagnostic;
}

export class SqlNotebookValidationProvider implements vscode.CodeActionProvider, vscode.Disposable {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly diagnostics = vscode.languages.createDiagnosticCollection(
    "oracleSqlNotebook.sqlConversion"
  );

  private readonly analyses = new Map<string, SqlNotebookAnalysisResult>();

  public constructor() {
    for (const document of vscode.workspace.textDocuments) {
      this.validateDocument(document);
    }
  }

  public dispose(): void {
    this.diagnostics.dispose();
    this.analyses.clear();
  }

  public validateDocument(document: vscode.TextDocument): void {
    if (!isSqlDocument(document)) {
      this.clearDocument(document.uri);
      return;
    }

    const analysis = analyzeSqlNotebookText(document.getText());
    const key = document.uri.toString();

    if (!analysis.isPairedFormat) {
      this.clearDocument(document.uri);
      return;
    }

    this.analyses.set(key, analysis);
    this.diagnostics.set(document.uri, analysis.issues.map((issue) => createDiagnostic(issue)));
  }

  public clearDocument(uri: vscode.Uri): void {
    this.analyses.delete(uri.toString());
    this.diagnostics.delete(uri);
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!isSqlDocument(document)) {
      return [];
    }

    const analysis = this.analyses.get(document.uri.toString());

    if (!analysis) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];

    for (const issue of analysis.issues) {
      if (!issue.quickFix) {
        continue;
      }

      if (!rangesOverlap(issue.range, range)) {
        continue;
      }

      if (
        context.diagnostics.length > 0 &&
        !context.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === issue.code &&
            diagnostic.range.start.line === issue.range.startLine &&
            diagnostic.range.start.character === issue.range.startCharacter &&
            diagnostic.range.end.line === issue.range.endLine &&
            diagnostic.range.end.character === issue.range.endCharacter
        )
      ) {
        continue;
      }

      const action = new vscode.CodeAction(
        issue.quickFix.title,
        vscode.CodeActionKind.QuickFix
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, toVsCodeRange(issue.quickFix.range), issue.quickFix.replacementText);
      action.edit = edit;
      action.diagnostics = context.diagnostics.filter(
        (diagnostic) => diagnostic.code === issue.code
      );
      actions.push(action);
    }

    return actions;
  }
}
