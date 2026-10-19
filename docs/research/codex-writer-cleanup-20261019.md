# Codex writer cleanup — 2026-10-19

## Incident and review

Session `sess_1792166248960787330` on cottoncpp failed with model capacity at
2026-10-18 17:38 UTC, then failed to resume at 23:55 UTC with
`thread 01a1456e-dea3-7643-aaeb-19f88cc1f496 already has an active writer`.
Remote read-only inspection found PID 418957 (owned by this session) holding
an exclusive FLOCK on that exact thread's writer lock via fd 41. Its launcher
was PID 418936, a child of execution host 3303651. All claims for the failed
session were terminal. The installed and loaded worker was
`0.5.7-dev.32.g65295eb.local.1792256215`, without iterator-return cleanup.
No live processes or lock files were changed during diagnosis.

The existing iterator-return fix closes the generator after an externally
handled `turn.failed`. It addresses the original leak, but the client used to
send TERM and return immediately, releasing its handle and runtime lease
before native exit. The stronger invariant is that successful cleanup requires
an exit receipt, not merely a terminal model event or a sent signal.

## Implementation

- Keep the existing unconditional iterator return. Await Codex client shutdown
  in both stream and startup cleanup, and in the native authentication helper.
- Wait for the child's close event and absence of live members of its owned
  process group. Send TERM, allow five seconds, then KILL and allow another
  five seconds. Repeated close calls share one promise. Zombies own no locks
  and do not block confirmation. This affects Codex's awaited shutdown;
  existing fire-and-forget callers keep their contract.
- Release the native handle and runtime maintenance lease only on confirmed
  shutdown. A bounded shutdown failure retains them and is surfaced. A success
  cannot hide a producer-close error; an original failure is preserved with a
  cleanup warning. No lock files are deleted and no failed prompt is replayed.
- The old-host idle-upgrade bridge also recognizes the real
  Node launcher → Codex app-server → code-mode-host process tree. It continues
  rejecting arbitrary tools/Node/Claude processes. The caller must first have
  established no active claims, background work or own turns.
- Existing service replacement and startup cleanup handle old-host residue.
  No broad background process killer or new automatic restart path is added.

## Verification and publication

The integration fixture uses a real `fcntl.flock` and real subprocesses, with
no model requests. It covers delayed shutdown, upstream failure, success,
TERM refusal, inherited locks retained by children after parent exit, startup
failure and cancellation. Each retry uses the same native thread and probes
that the lock is available before starting again. This OS-level fixture runs
on Linux with Python/fcntl; macOS was not exercised on a real device here.

The first targeted run passed 28 tests before the inherited-child case was
added. The final `scripts/check-changed.sh --files …` passed formatting for
12 files, worker build, all 21 related worker test files (including the
inherited-child case), and the module boundary audit. Build took 23.3 seconds
and tests 55.9 seconds; the shared check lock accounted for 221.4 seconds of
waiting on the other worktree. `git diff --check` and source SHA-256 checks
also passed. The check summary is `/tmp/foundry-writer-check-20261019.log`.

Only worker code changes. Dev server/web require no binary or asset deployment.
Publish the worker tarballs and atomically switch the existing dev server's
release manifest, preserving older tarballs. Devices are updated manually by
the user; this session does not request device upgrades or replace execution
hosts. Source changes remain uncommitted on local main.

Another session is working in `foundry-session-isolation`; this change stays in
`foundry` on main. Do not overwrite or merge that worktree during publication.

## Published 2026-10-19 08:31 (UTC+8)

- Version: `0.5.7-dev.39.gc2e46c6.local.1792369800`.
- Endpoint: `https://dev.foundryapp.app/api/worker/release`.
- Protocol SHA-256: `e9397517f0ccd919704eae438f0752b600b0d1e29dc03b52409300209a087310`.
- Worker SHA-256: `0d3c15b0c49fd727e8524af3076447356e6dc5cc83888b48d13ce62353fb1b05`.
- All four public downloads (versioned + latest URLs for both packages) matched
  the staged artifacts. Packed JavaScript was checked for awaited client close,
  iterator return, confirmed group shutdown, and launcher recognition.
- Previous release and publication receipt:
  `/home/windeng/.foundry/server-backups/writer-cleanup-0.5.7-dev.39.gc2e46c6.local.1792369800/`.
- The manifest was compared with its expected previous bytes immediately before
  atomic replacement. No newer concurrent publication was overwritten. Older
  tarballs remain available to in-flight downloads.
- No device update was requested, no execution service was restarted, and no
  commit was created. HEAD remains `c2e46c6` on local main.

Manual rollout: in Devices, select cottoncpp and update its Worker. sg-chaos
also runs the older affected version and should be updated. Let active work
finish so the execution host can switch at idle; an installed daemon version
alone does not prove that a busy execution host has switched. After the host
loads this release, retry the original conversation. This publication verifies
the fix and distributed package, not post-update recovery on those devices.
