import { DatabaseSync } from "node:sqlite";

export class DatabaseIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseIntegrityError";
  }
}

export function assertDatabaseHealthy(database: DatabaseSync): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = database
      .prepare("PRAGMA quick_check")
      .all() as unknown as Array<Record<string, unknown>>;
  } catch (error) {
    throw new DatabaseIntegrityError(
      `SQLite quick_check could not read the database. The original database was preserved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const results = rows.flatMap((row) => Object.values(row).map(String));
  if (results.length !== 1 || results[0] !== "ok") {
    throw new DatabaseIntegrityError(
      `SQLite quick_check reported corruption. The original database was preserved: ${
        results.join("; ") || "no diagnostic details"
      }`,
    );
  }
}

export function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = FULL");
}

export function inTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
