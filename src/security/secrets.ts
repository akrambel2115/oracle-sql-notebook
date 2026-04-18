import * as vscode from "vscode";

const PASSWORD_KEY_PREFIX = "oracleSqlNotebook.connection.password";

export class SecretStore {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public async getConnectionPassword(alias: string): Promise<string | undefined> {
    return this.secrets.get(this.toPasswordKey(alias));
  }

  public async setConnectionPassword(
    alias: string,
    password: string
  ): Promise<void> {
    await this.secrets.store(this.toPasswordKey(alias), password);
  }

  public async clearConnectionPassword(alias: string): Promise<void> {
    await this.secrets.delete(this.toPasswordKey(alias));
  }

  private toPasswordKey(alias: string): string {
    return `${PASSWORD_KEY_PREFIX}:${alias.trim().toLowerCase()}`;
  }
}
