---
phase: 001-persistence
plan: 06
subsystem: database
tags: [sqlite, langgraph, wal, migrations, recovery]
requires:
  - phase: 001-persistence-plan-05
    provides: recovery classification, run attempts, tool ledger, approvals
provides:
  - resumable future-goal integration fixture
  - startup SQLite quick health check
  - every-version migration, corruption, and abrupt-WAL coverage
  - manual backup and recovery runbook
affects: [durable-goals, recovery, operations]
tech-stack:
  added: []
  patterns:
    - checkpoint state is canonical; todo snapshots are projections
    - corrupt databases fail closed and remain untouched
key-files:
  created:
    - test/futureGoal.integration.ts
  modified:
    - src/persistence/database.ts
    - src/persistence/PersistenceService.ts
    - test/persistenceService.integration.ts
    - test/run.mjs
    - README.md
key-decisions:
  - "Run PRAGMA quick_check before migrations or application writes on every database open."
  - "Leave corrupt database recovery, replacement, and restoration as explicit user actions."
requirements-completed: []
duration: 13min
completed: 2026-07-29
---

# Persistence Plan 06: Future-goal Compatibility and Operational Hardening Summary

**Checkpoint-canonical goals now have a two-attempt recovery fixture, while startup integrity, migration, corruption, WAL recovery, and manual backup behavior are verified and documented.**

## Performance

- **Duration:** 13 min
- **Completed:** 2026-07-29T21:07:44Z
- **Tasks:** 2
- **Implementation files:** 6

## Accomplishments

- Proved one logical goal run and stable LangGraph thread can survive an interrupted attempt and complete in a second attempt.
- Verified todo snapshots capture pre- and post-resume projections without participating in graph reconstruction.
- Added a startup `PRAGMA quick_check` gate that reports corruption and preserves the original database.
- Upgraded fixtures from every committed schema version without losing workspace or conversation sentinel data.
- Proved abrupt WAL termination retains committed transactions and rejects the partial transaction on reopen.
- Documented workspace storage scope, backup/export, restart behavior, approval expiration, and deferred scheduling limits.

## Task Commits

1. **Task 6.1: Prove the schema can represent a resumable goal** — `2c1aa6d`
2. **Task 6.2: Add backup, corruption, and migration tests** — `b634ade`

## Decisions Made

- Use `PRAGMA quick_check` at startup for bounded-cost integrity verification.
- Reserve full `PRAGMA integrity_check` for manual diagnosis.
- Use SQLite's `.backup` command as the preferred manual backup path and require an offline copy to include WAL sidecars when present.
- Keep automatic goal scheduling and background continuation deferred.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The SQLite driver returns result rows with null prototypes, so the WAL assertion normalizes the row before deep comparison. No production behavior changed.

## Verification

- `npm test`
- Result: typecheck, bundle, and all unit/integration tests passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The persistence foundation is complete and ready to support later durable-goal scheduling without treating todo projections as execution state.

## Self-Check: PASSED
