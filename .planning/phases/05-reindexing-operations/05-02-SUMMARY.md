---
phase: 05-reindexing-operations
plan: 02
subsystem: api
tags: [git-hooks, debounce, incremental-indexing, express, vitest, supertest]

# Dependency graph
requires:
  - phase: 05-01
    provides: "IndexPipeline incremental mode, pullRepo, readLastCommit/writeLastCommit"
provides:
  - "installPostCommitHook: writes executable .git/hooks/post-commit shell script with fire-and-forget curl POST"
  - "POST /repos/:id/index?incremental=true: returns 202 Accepted, debounced, per-repo locked"
  - "Debounce timer (5s) and inProgress Set scoped to indexRoutes factory closure"
affects:
  - phase-06-dashboard
  - any-consumer-of-index-route

# Tech tracking
tech-stack:
  added: [supertest (dev)]
  patterns:
    - "Fire-and-forget incremental index via debounced setTimeout inside route factory closure"
    - "Per-repo in-progress lock via Set<string> prevents concurrent duplicate runs"
    - "Hook install as idempotent post-success side effect (try/catch so hook failure never breaks index)"
    - "vi.mock factory with __state slot pattern for cross-test state access without hoisting violations"

key-files:
  created:
    - src/indexer/hook-installer.ts
    - src/indexer/__tests__/hook-installer.test.ts
    - src/http/__tests__/incremental-route.test.ts
  modified:
    - src/http/routes/index.ts

key-decisions:
  - "DEBOUNCE_MS=5000 stored as named constant; debounceTimers Map and inProgress Set live in indexRoutes closure (not module-level) so each router instance has independent state"
  - "Hook install failure is non-fatal: wrapped in try/catch with console.warn — index result is never affected"
  - "vi.mock() factory with __state object exposes mutable shared state to tests without hoisting violations (factories run before all imports)"
  - "supertest installed with --legacy-peer-deps due to tree-sitter-cpp peer conflict"
  - "installPostCommitHook called after both full and incremental successful runs (and in index-all loop)"

patterns-established:
  - "Test fake-timer pattern: vi.useFakeTimers() in beforeEach, vi.runAllTimersAsync() to fire debounce, vi.useRealTimers() in afterEach"
  - "Mock constructor with __state: factory creates mutable state bag attached to exported constructor for test access"

requirements-completed: [OPS-02]

# Metrics
duration: 20min
completed: 2026-03-11
---

# Phase 5 Plan 2: Git Hook Automation and Incremental Trigger Summary

**Git post-commit hook installer + HTTP 202 incremental trigger with 5s debounce and per-repo in-progress lock, wired to IndexPipeline.run({incremental:true})**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-03-11T09:04:00Z
- **Completed:** 2026-03-11T09:15:00Z
- **Tasks:** 2
- **Files modified:** 5 (2 created implementation, 3 created/modified tests + route)

## Accomplishments
- `installPostCommitHook(destPath, repoId)` writes an executable `#!/bin/sh` script to `.git/hooks/post-commit` that backgrounds a curl POST to `/repos/{repoId}/index?incremental=true` and exits 0
- POST `/repos/:id/index?incremental=true` returns 202 Accepted immediately; pipeline runs async after 5s debounce window with per-repo in-progress lock
- Hook is installed after every successful pipeline run (full, incremental, and index-all)
- 120 tests pass (0 regressions), 0 TypeScript errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Post-commit hook installer** - `8bc053a` (feat)
2. **Task 2: Route handler with incremental trigger, debounce, and per-repo lock** - `c2ad4c3` (feat)

**Plan metadata:** (docs commit follows)

_Note: TDD tasks have single commit (test + implementation together after GREEN)_

## Files Created/Modified
- `src/indexer/hook-installer.ts` - installPostCommitHook: writes executable shell script with backgrounded curl POST
- `src/indexer/__tests__/hook-installer.test.ts` - 10 tests using real filesystem in temp dir
- `src/http/routes/index.ts` - Extended with ?incremental=true, debounceTimers Map, inProgress Set, hook install in all index paths
- `src/http/__tests__/incremental-route.test.ts` - 11 tests: 202 response, debounce, lock, repo independence, hook install

## Decisions Made
- **DEBOUNCE_MS=5000 in route closure:** Debounce timers and in-progress lock live in the `indexRoutes` factory closure (not module-level) so each router instance has independent state — critical for test isolation
- **Hook failure is non-fatal:** `installPostCommitHook` is called in a `try/catch` with `console.warn`; a hook install failure never affects index result or response
- **vi.mock factory with `__state` pattern:** Since vi.mock() factories are hoisted before any imports, they can't reference outer variables. Sharing mock state across tests is done via a `__state` object attached to the exported mock constructor
- **supertest with --legacy-peer-deps:** tree-sitter-cpp peer conflict required `--legacy-peer-deps` flag for installation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing supertest dependency**
- **Found during:** Task 2 (route tests)
- **Issue:** `supertest` and `@types/supertest` not in package.json; test file couldn't import
- **Fix:** Ran `npm install --save-dev supertest @types/supertest --legacy-peer-deps`
- **Files modified:** package.json, package-lock.json
- **Verification:** Import succeeds, all tests pass
- **Committed in:** c2ad4c3 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix essential for test functionality. No scope creep.

## Issues Encountered
- Vitest mock hoisting: `vi.mock()` factories can't reference outer variables (`const mockInstallHook = vi.fn()` before factory causes "cannot access before initialization"). Resolved using `__state` pattern — factory creates a shared state bag attached to the mock constructor.
- `mockImplementation(() => ({...}))` with arrow function is not a valid constructor — resolved by using a real `function` declaration in the factory.
- Lock test required pre-configuring the next pipeline run via `__state.nextRunResult` before `new IndexPipeline()` is called — patching the instance after construction was too late.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 5 (Re-indexing Operations) is complete: incremental engine + git hook automation both implemented
- Ready for Phase 6 (Dashboard) — indexRoutes has `createProgressEmitter` factory already prepared for SSE/WebSocket integration; comment notes this at line 34
- OPS-02 requirement satisfied: git hooks trigger automatic incremental re-indexing on commit

## Self-Check: PASSED

- `src/indexer/hook-installer.ts` - FOUND
- `src/indexer/__tests__/hook-installer.test.ts` - FOUND
- `src/http/__tests__/incremental-route.test.ts` - FOUND
- `.planning/phases/05-reindexing-operations/05-02-SUMMARY.md` - FOUND
- Commit `8bc053a` (Task 1) - FOUND
- Commit `c2ad4c3` (Task 2) - FOUND

---
*Phase: 05-reindexing-operations*
*Completed: 2026-03-11*
