import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteSaver } from "./NodeSqliteSaver";
import { configureDatabase, isoNow } from "./database";
import { applyMigrations } from "./migrations";

export interface UriLike {
  fsPath: string;
  toString(): string;
}

export class PersistenceInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceInitializationError";
  }
}

export class PersistenceService {
  readonly database: DatabaseSync;
  readonly checkpointer: NodeSqliteSaver;
  readonly databasePath: string;
  private closed = false;

  private constructor(database: DatabaseSync, databasePath: string) {
    this.database = database;
    this.databasePath = databasePath;
    this.checkpointer = new NodeSqliteSaver(database);
  }

  static async open(
    storageUri: UriLike,
    workspaceUri: UriLike,
  ): Promise<PersistenceService> {
    await mkdir(storageUri.fsPath, { recursive: true });
    const databasePath = join(storageUri.fsPath, "deep-agents.sqlite");
    const database = new DatabaseSync(databasePath);

    try {
      configureDatabase(database);
      applyMigrations(database);
      const now = isoNow();
      database
        .prepare(`
          INSERT INTO workspace_metadata (
            id,
            workspace_uri,
            workspace_root,
            created_at,
            updated_at
          ) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            workspace_uri = excluded.workspace_uri,
            workspace_root = excluded.workspace_root,
            updated_at = excluded.updated_at
        `)
        .run(
          workspaceUri.toString(),
          workspaceUri.fsPath,
          now,
          now,
        );
      return new PersistenceService(database, databasePath);
    } catch (error) {
      database.close();
      throw new PersistenceInitializationError(
        `Could not initialize persistence at ${databasePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }
}
