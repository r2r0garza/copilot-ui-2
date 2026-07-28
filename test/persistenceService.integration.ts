import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PersistenceInitializationError,
  PersistenceService,
} from "../src/persistence/PersistenceService";
import { configureDatabase } from "../src/persistence/database";
import {
  applyMigrations,
  type Migration,
} from "../src/persistence/migrations";

function uri(fsPath: string) {
  return {
    fsPath,
    toString: () => `file://${fsPath}`,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-persistence-"));
  const storage = uri(join(root, "storage"));
  const workspace = uri(join(root, "workspace"));

  try {
    const first = await PersistenceService.open(storage, workspace);
    assert.deepEqual(
      first.database
        .prepare("SELECT version, name FROM app_migrations")
        .all()
        .map((row) => ({ ...(row as object) })),
      [
        {
          version: 1,
          name: "persistence_foundation",
        },
      ],
    );
    assert.throws(() => {
      first.database
        .prepare(`
          INSERT INTO conversation_events (
            id,
            session_id,
            sequence,
            event_type,
            payload_json,
            created_at
          ) VALUES ('event', 'missing', 1, 'user_message', '{}', 'now')
        `)
        .run();
    }, /FOREIGN KEY/);
    first.close();

    const second = await PersistenceService.open(storage, workspace);
    assert.equal(
      (
        second.database
          .prepare("SELECT COUNT(*) AS count FROM app_migrations")
          .get() as { count: number }
      ).count,
      1,
    );
    second.database
      .prepare(`
        INSERT INTO app_migrations (version, name, applied_at)
        VALUES (999, 'future', 'now')
      `)
      .run();
    second.close();

    await assert.rejects(
      PersistenceService.open(storage, workspace),
      (error: unknown) =>
        error instanceof PersistenceInitializationError &&
        /newer than supported/.test(error.message),
    );

    const rollbackPath = join(root, "rollback.sqlite");
    const rollbackDatabase = new DatabaseSync(rollbackPath);
    configureDatabase(rollbackDatabase);
    const migrations: Migration[] = [
      {
        version: 1,
        name: "base",
        sql: "CREATE TABLE durable (id INTEGER PRIMARY KEY);",
      },
      {
        version: 2,
        name: "broken",
        sql: `
          INSERT INTO durable (id) VALUES (1);
          INSERT INTO table_that_does_not_exist (id) VALUES (1);
        `,
      },
    ];
    assert.throws(() => applyMigrations(rollbackDatabase, migrations));
    assert.equal(
      (
        rollbackDatabase
          .prepare("SELECT COUNT(*) AS count FROM durable")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        rollbackDatabase
          .prepare("SELECT COUNT(*) AS count FROM app_migrations")
          .get() as { count: number }
      ).count,
      1,
    );
    rollbackDatabase.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Persistence service integration test passed: migrations are idempotent, foreign keys enforced, future schemas rejected, and failed migrations rolled back",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
