import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

async function runAbruptWalWriter(
  storagePath: string,
  workspacePath: string,
): Promise<never> {
  const service = await PersistenceService.open(
    uri(storagePath),
    uri(workspacePath),
  );
  service.database.exec("PRAGMA wal_autocheckpoint = 0");
  service.sessions.create({
    id: "wal-committed",
    threadId: "wal-committed-thread",
  });
  service.database.exec("BEGIN IMMEDIATE");
  service.database
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
        'wal-partial',
        'wal-partial-thread',
        '',
        'Uncommitted session',
        'default',
        'active',
        'now',
        'now',
        'now'
      )
    `)
    .run();
  process.exit(0);
}

function insertUpgradeSentinel(
  database: DatabaseSync,
  schemaVersion: number,
): void {
  database
    .prepare(`
      INSERT INTO workspace_metadata (
        id, workspace_uri, workspace_root, created_at, updated_at
      ) VALUES (1, ?, ?, 'created', 'updated')
    `)
    .run(`file://workspace-v${schemaVersion}`, `/workspace-v${schemaVersion}`);
  database
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
      ) VALUES (?, ?, '', ?, 'default', 'active', 'created', 'updated', 'event')
    `)
    .run(
      `upgrade-session-v${schemaVersion}`,
      `upgrade-thread-v${schemaVersion}`,
      `Upgrade fixture v${schemaVersion}`,
    );
  database
    .prepare(`
      INSERT INTO conversation_events (
        id,
        session_id,
        sequence,
        event_type,
        payload_json,
        created_at
      ) VALUES (?, ?, 1, 'user_message', ?, 'event')
    `)
    .run(
      `upgrade-event-v${schemaVersion}`,
      `upgrade-session-v${schemaVersion}`,
      JSON.stringify({
        schemaVersion: 1,
        content: `before upgrade from v${schemaVersion}`,
      }),
    );
}

async function main(): Promise<void> {
  if (process.argv[2] === "abrupt-wal-writer") {
    await runAbruptWalWriter(process.argv[3], process.argv[4]);
  }

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

    for (const sourceMigration of APP_MIGRATIONS) {
      const upgradePath = join(
        root,
        `upgrade-from-v${sourceMigration.version}.sqlite`,
      );
      const upgradeDatabase = new DatabaseSync(upgradePath);
      configureDatabase(upgradeDatabase);
      applyMigrations(
        upgradeDatabase,
        APP_MIGRATIONS.filter(
          ({ version }) => version <= sourceMigration.version,
        ),
      );
      insertUpgradeSentinel(upgradeDatabase, sourceMigration.version);

      applyMigrations(upgradeDatabase);
      assert.equal(
        (
          upgradeDatabase
            .prepare("SELECT COUNT(*) AS count FROM app_migrations")
            .get() as { count: number }
        ).count,
        APP_MIGRATIONS.length,
      );
      assert.equal(
        (
          upgradeDatabase
            .prepare(`
              SELECT COUNT(*) AS count
              FROM conversation_events
              WHERE id = ?
            `)
            .get(`upgrade-event-v${sourceMigration.version}`) as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          upgradeDatabase
            .prepare(`
              SELECT workspace_root
              FROM workspace_metadata
              WHERE id = 1
            `)
            .get() as { workspace_root: string }
        ).workspace_root,
        `/workspace-v${sourceMigration.version}`,
      );
      upgradeDatabase.close();
    }

    const corruptStoragePath = join(root, "corrupt-storage");
    await mkdir(corruptStoragePath);
    const corruptDatabasePath = join(
      corruptStoragePath,
      "deep-agents.sqlite",
    );
    const corruptContents = Buffer.from(
      "This is intentionally not a SQLite database.",
      "utf8",
    );
    await writeFile(corruptDatabasePath, corruptContents);
    await assert.rejects(
      PersistenceService.open(
        uri(corruptStoragePath),
        uri(join(root, "corrupt-workspace")),
      ),
      (error: unknown) =>
        error instanceof PersistenceInitializationError &&
        /quick_check could not read the database/i.test(error.message) &&
        /original database was preserved/i.test(error.message),
    );
    assert.deepEqual(await readFile(corruptDatabasePath), corruptContents);
    assert.deepEqual(await readdir(corruptStoragePath), [
      "deep-agents.sqlite",
    ]);

    const walStoragePath = join(root, "wal-storage");
    const walWorkspacePath = join(root, "wal-workspace");
    const abruptWriter = spawnSync(
      process.execPath,
      [
        __filename,
        "abrupt-wal-writer",
        walStoragePath,
        walWorkspacePath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      abruptWriter.status,
      0,
      `Abrupt WAL writer failed:\n${
        abruptWriter.stderr || abruptWriter.stdout
      }`,
    );
    const reopenedWal = await PersistenceService.open(
      uri(walStoragePath),
      uri(walWorkspacePath),
    );
    assert.ok(reopenedWal.sessions.get("wal-committed"));
    assert.equal(reopenedWal.sessions.get("wal-partial"), undefined);
    assert.deepEqual(
      reopenedWal.database
        .prepare("PRAGMA quick_check")
        .all()
        .map((row) => ({ ...(row as object) })),
      [{ quick_check: "ok" }],
    );
    reopenedWal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Persistence service integration test passed: every schema upgrades without data loss, corruption is preserved and reported, and WAL recovers committed state after abrupt termination",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
