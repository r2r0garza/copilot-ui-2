import type { DatabaseSync } from "node:sqlite";
import { inTransaction, isoNow } from "./database";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const APP_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "persistence_foundation",
    sql: `
      CREATE TABLE workspace_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        workspace_uri TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT UNIQUE NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        title_source TEXT NOT NULL CHECK (
          title_source IN ('default', 'generated', 'manual')
        ),
        selected_model_key TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'archived', 'deleting')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL
      );
      CREATE INDEX chat_sessions_status_last_event_idx
        ON chat_sessions(status, last_event_at DESC);

      CREATE TABLE conversation_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'user_message',
            'assistant_message',
            'tool_call',
            'tool_result',
            'approval_requested',
            'approval_resolved',
            'run_error',
            'run_cancelled',
            'model_changed',
            'title_changed'
          )
        ),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence)
      );
      CREATE INDEX conversation_events_session_sequence_idx
        ON conversation_events(session_id, sequence);

      CREATE TABLE checkpoint_cleanup_queue (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL CHECK (
          reason IN ('session_deleted', 'session_cleared', 'migration_cleanup')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns)
      );

      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'draft',
            'queued',
            'running',
            'paused',
            'completed',
            'failed',
            'cancelled'
          )
        ),
        priority INTEGER NOT NULL DEFAULT 0,
        active_run_id TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
        goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        last_checkpoint_id TEXT,
        model_key TEXT,
        compatibility_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued',
            'running',
            'waiting_approval',
            'paused',
            'interrupted',
            'completed',
            'failed',
            'cancelled'
          )
        ),
        recovery_class TEXT CHECK (
          recovery_class IS NULL OR recovery_class IN (
            'safe_to_resume',
            'waiting_for_approval',
            'needs_review',
            'not_resumable'
          )
        ),
        resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (session_id IS NOT NULL OR goal_id IS NOT NULL)
      );
      CREATE INDEX agent_runs_session_status_idx
        ON agent_runs(session_id, status);
      CREATE INDEX agent_runs_goal_status_idx
        ON agent_runs(goal_id, status);

      CREATE TABLE run_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        process_instance_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('starting', 'running', 'interrupted', 'completed', 'failed')
        ),
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        interruption_reason TEXT
      );
      CREATE INDEX run_attempts_run_status_idx
        ON run_attempts(run_id, status);
      CREATE UNIQUE INDEX run_attempts_active_process_idx
        ON run_attempts(run_id)
        WHERE status IN ('starting', 'running');

      CREATE TABLE todo_snapshots (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'in_progress', 'completed')
        ),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, checkpoint_id, ordinal)
      );

      CREATE TABLE tool_executions (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        effect_class TEXT NOT NULL CHECK (
          effect_class IN ('read_only', 'idempotent_write', 'non_idempotent')
        ),
        status TEXT NOT NULL CHECK (
          status IN (
            'requested',
            'waiting_approval',
            'approved',
            'running',
            'succeeded',
            'failed',
            'denied',
            'uncertain'
          )
        ),
        output_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, tool_call_id)
      );

      CREATE TABLE approval_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (
          decision IN ('once', 'session', 'deny')
        ),
        process_instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX approval_decisions_session_created_idx
        ON approval_decisions(session_id, created_at);

      CREATE TRIGGER goals_active_run_reference
      BEFORE UPDATE OF active_run_id ON goals
      WHEN NEW.active_run_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM agent_runs
            WHERE id = NEW.active_run_id AND goal_id = NEW.id
          )
          THEN RAISE(ABORT, 'active_run_id must reference a run for this goal')
        END;
      END;
    `,
  },
  {
    version: 2,
    name: "recovery_reconciliation",
    sql: `
      CREATE TABLE recovery_reconciliations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (
          decision IN ('mark_completed', 'retry', 'abandon')
        ),
        warning_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (
          warning_acknowledged IN (0, 1)
        ),
        process_instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, tool_call_id),
        FOREIGN KEY (run_id, tool_call_id)
          REFERENCES tool_executions(run_id, tool_call_id) ON DELETE CASCADE
      );
      CREATE INDEX recovery_reconciliations_run_created_idx
        ON recovery_reconciliations(run_id, created_at);
    `,
  },
];

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = APP_MIGRATIONS,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const latestKnown = migrations.at(-1)?.version ?? 0;
  const appliedRows = database
    .prepare("SELECT version, name FROM app_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string }>;
  const future = appliedRows.find(({ version }) => version > latestKnown);
  if (future) {
    throw new Error(
      `Database schema version ${future.version} is newer than supported version ${latestKnown}.`,
    );
  }

  const applied = new Map(
    appliedRows.map(({ version, name }) => [version, name]),
  );
  for (const migration of migrations) {
    const appliedName = applied.get(migration.version);
    if (appliedName === migration.name) {
      continue;
    }
    if (appliedName) {
      throw new Error(
        `Migration ${migration.version} is recorded as "${appliedName}", expected "${migration.name}".`,
      );
    }

    inTransaction(database, () => {
      database.exec(migration.sql);
      database
        .prepare(`
          INSERT INTO app_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `)
        .run(migration.version, migration.name, isoNow());
    });
  }
}
