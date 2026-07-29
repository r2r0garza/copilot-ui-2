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
  APP_MIGRATIONS,
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
        {
          version: 2,
          name: "recovery_reconciliation",
        },
        {
          version: 3,
          name: "session_agent_selection",
        },
        {
          version: 4,
          name: "steering_conversation_events",
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
      4,
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

    const upgradePath = join(root, "upgrade.sqlite");
    const upgradeDatabase = new DatabaseSync(upgradePath);
    configureDatabase(upgradeDatabase);
    applyMigrations(upgradeDatabase, APP_MIGRATIONS.slice(0, 3));
    upgradeDatabase
      .prepare(`
        INSERT INTO chat_sessions (
          id,
          thread_id,
          checkpoint_ns,
          title,
          title_source,
          status,
          created_at,
          updated_at,
          last_event_at
        ) VALUES (
          'upgrade-session',
          'upgrade-thread',
          '',
          'Upgrade fixture',
          'default',
          'active',
          'now',
          'now',
          'now'
        )
      `)
      .run();
    upgradeDatabase
      .prepare(`
        INSERT INTO conversation_events (
          id,
          session_id,
          sequence,
          event_type,
          payload_json,
          created_at
        ) VALUES (
          'old-event',
          'upgrade-session',
          1,
          'user_message',
          '{"schemaVersion":1,"content":"before upgrade"}',
          'now'
        )
      `)
      .run();

    applyMigrations(upgradeDatabase);
    assert.equal(
      (
        upgradeDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM conversation_events WHERE id = 'old-event'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    upgradeDatabase
      .prepare(`
        INSERT INTO conversation_events (
          id,
          session_id,
          sequence,
          event_type,
          payload_json,
          created_at
        ) VALUES (
          'steering-event',
          'upgrade-session',
          2,
          'steering_message',
          '{"schemaVersion":1,"steeringId":"steer-1","content":"after upgrade"}',
          'now'
        )
      `)
      .run();
    assert.equal(
      (
        upgradeDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM conversation_events WHERE session_id = 'upgrade-session'",
          )
          .get() as { count: number }
      ).count,
      2,
    );
    upgradeDatabase.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Persistence service integration test passed: migrations are idempotent and upgrade safely, foreign keys enforced, future schemas rejected, and failed migrations rolled back",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
