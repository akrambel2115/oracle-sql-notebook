export enum NotebookCellKind {
  Markup = 1,
  Code = 2
}

export class NotebookCellData {
  public metadata: Record<string, unknown> = {};

  public constructor(
    public readonly kind: NotebookCellKind,
    public readonly value: string,
    public readonly languageId: string
  ) {}
}

export class NotebookData {
  public metadata: Record<string, unknown> = {};

  public constructor(public readonly cells: NotebookCellData[]) {}
}

export class CancellationError extends Error {
  public constructor() {
    super("Operation cancelled.");
    this.name = "CancellationError";
  }
}
