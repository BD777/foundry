# Lease manager research: sharing vs exclusively locking execution resources

Context: AI agent sessions lease a device's `compute` (shell commands on a machine) or
`computer_use` (a Mac screen). All links below were fetched on 2026-11-13. Quotes are
from the linked page; "(paraphrase)" marks a summary.

---

## 1. Shared / exclusive lock modes

### Databases: compatibility matrices

- PostgreSQL table locks: `ACCESS SHARE` "Conflicts with the ACCESS EXCLUSIVE lock mode only";
  `ACCESS EXCLUSIVE` "Conflicts with locks of all modes ... guarantees that the holder is the only
  transaction accessing the table in any way." "A transaction never conflicts with itself."
  https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL has 8 table modes, not 2: e.g. `SHARE` conflicts with `ROW EXCLUSIVE` (protects
  against concurrent data changes) while `ROW EXCLUSIVE` holders coexist. A matrix generalizes
  binary S/X. Same page.
- PostgreSQL waits are unbounded by default: a lock seeker "will wait indefinitely for conflicting
  locks to be released" (unless deadlock detected / lock_timeout). Same page.
- SQL Server: "no lock modes are compatible with exclusive locks"; S is compatible with S and U.
  The `U` (update) lock exists because two S holders both upgrading to X deadlock; only one
  transaction may hold U at a time, so it serialises would-be upgraders.
  https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide
  -> Lesson: do not let a shared holder "upgrade in place" to exclusive; either release-and-
  reacquire or have a single "intent to upgrade" slot.

### flock(2)

- `LOCK_SH`: "More than one process may hold a shared lock for a given file at a given time."
  `LOCK_EX`: "Only one process may hold an exclusive lock". `LOCK_NB` -> fail with EWOULDBLOCK
  instead of waiting. https://man7.org/linux/man-pages/man2/flock.2.html
- "Converting a lock (shared to exclusive, or vice versa) is not guaranteed to be atomic" — the old
  lock is dropped first and a pending request may win in between. Same page.
- Locks are released on explicit `LOCK_UN` or when all duplicate fds are closed (holder death =
  automatic release). Same page.

### POSIX rwlock and Go sync.RWMutex

- POSIX `pthread_rwlock_rdlock`: when writers are blocked (and no writer holds the lock), "it is
  implementation-defined whether the calling thread acquires the lock" (without the Thread
  Execution Scheduling option). Writer preference is therefore NOT guaranteed by POSIX.
  https://man7.org/linux/man-pages/man3/pthread_rwlock_rdlock.3p.html
- Go makes writer preference explicit: RLock "should not be used for recursive read locking; a
  blocked Lock call excludes new readers from acquiring the lock." https://pkg.go.dev/sync#RWMutex
  -> A queued exclusive request closes the door to new shared holders; existing readers drain.

---

## 2. Counting semaphores / concurrency slots

- GitHub Actions concurrency groups: "at most one running job or workflow in a concurrency group at
  any time"; by default "any existing pending job or workflow in the same concurrency group will be
  canceled" when a new one is queued; `cancel-in-progress: true` also kills the running one;
  `queue: max` keeps up to 100 pending; ordering FIFO but "ordering is not guaranteed".
  https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs
  -> Capacity 1 with a "latest wins" pending slot — right for deploys, wrong for agent work.
- GitLab Runner: global `concurrent` "Limits how many jobs can run concurrently, across all
  registered runners"; per-runner `limit` "how many jobs can be handled concurrently by this
  registered runner" (0 = unlimited). Two-level slot cap (host, then executor).
  https://docs.gitlab.com/runner/configuration/advanced-configuration/
- Buildkite agent: `--spawn` "The number of agents to spawn in parallel" (default 1); with
  `--disconnect-after-job` "each worker booted will run exactly one job".
  https://buildkite.com/docs/agent/v3/cli-start
- Buildkite concurrency groups/limits: a group is a shared label across pipelines, the limit caps
  simultaneous jobs; default `ordered` method runs oldest-first and "If a job's state is `limited`,
  it is waiting for another job ahead of it in the same concurrency group to finish"; `eager`
  lets ready jobs jump ahead. (paraphrase + quote)
  https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency
- Jenkins: an executor is "a slot for the execution of tasks"; "The number of executors on a node
  defines the number of concurrent tasks that can run"; one executor per node is "the safest
  configuration". https://www.jenkins.io/doc/book/managing/nodes/
- Jenkins Lockable Resources: `lock(resource:)`, `lock(label:, quantity:)` (N of a labelled pool;
  waits if not enough), `skipIfLocked`, and queue ordering knobs `inversePrecedence` / `priority`.
  https://plugins.jenkins.io/lockable-resources/
  -> Closest analogue to "lease N slots of a labelled resource pool".
- Kubernetes: scheduler places Pods by the sum of _requests_ vs node allocatable, not actual usage;
  limits are enforced at runtime (CPU throttled, memory OOM-killed).
  https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
  -> Admission by declared reservation; enforcement is a separate layer.
- Nomad: `cpu` (MHz, shared CPU time) vs `cores` (reserved cores — task does not share them with
  other Nomad tasks; cannot combine with `cpu`); `memory` hard limit unless `memory_max`
  oversubscription is enabled. https://developer.hashicorp.com/nomad/docs/job-specification/resources
  -> Same resource offered in a shared mode and an exclusive mode.
- Bazel: tag `exclusive` "ensuring that no other tests are running at the same time";
  `exclusive-if-local` only when local; `exec_properties` passes platform keys to remote executors.
  https://bazel.build/reference/be/common-definitions
- Remote execution: Buildfarm has no exclusive concept; `exclusive` tag disables remote execution;
  proposal to use `exec_properties = {"exclusive": "true"}` so a worker runs nothing else alongside.
  https://github.com/buildfarm/buildfarm/issues/730
  (I found no BuildBuddy/Buildbarn doc for an exclusive property — treat as unsupported/unknown.)

---

## 3. Fairness and queue ordering

- PostgreSQL lock manager: a request is granted immediately only if it does not conflict with "any
  existing or waiting lock request"; otherwise "Normally it will be added to the end of the queue";
  "conflicting requests are granted in order of arrival". The deadlock detector may reorder only
  processes involved in a cycle ("soft edges").
  https://raw.githubusercontent.com/postgres/postgres/master/src/backend/storage/lmgr/README
- Practical consequence: a queued `ACCESS EXCLUSIVE` (e.g. ALTER TABLE) blocks every later plain
  SELECT (ACCESS SHARE conflicts with the waiting request), so migrations use `lock_timeout` to
  give up and drain the queue. (follows from the README rule above + the conflict table in
  https://www.postgresql.org/docs/current/explicit-locking.html)
- Linux rwsem: "To prevent a constant stream of readers from starving a sleeping writer, don't
  attempt optimistic lock stealing"; a waiter that has waited too long (`RWSEM_WAIT_TIMEOUT`, ~4ms)
  or is RT sets `RWSEM_FLAG_HANDOFF` so the lock is handed to it rather than stolen; readers "will
  block as they will notice the queued writer".
  https://raw.githubusercontent.com/torvalds/linux/master/kernel/locking/rwsem.c
- Go RWMutex: queued writer excludes new readers (see §1). https://pkg.go.dev/sync#RWMutex
- POSIX: reader-vs-waiting-writer is implementation-defined, i.e. starvation possible.
  https://man7.org/linux/man-pages/man3/pthread_rwlock_rdlock.3p.html
- Buildkite `ordered` = strict oldest-first per group; `eager` trades fairness for throughput.
  https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency
- GitHub: FIFO intent, "ordering is not guaranteed"; default keeps only the newest pending.
  https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs
- Jenkins Lockable Resources exposes explicit `priority` (higher first) — i.e. priority beats FIFO
  when configured. https://plugins.jenkins.io/lockable-resources/

Pattern: FIFO queue + compatibility check against _waiters_ (not only holders) = no writer
starvation. Allow bounded queue-jumping only via explicit priority or handoff after a timeout.

---

## 4. Lease TTL and heartbeats

- Chubby (Burrows, OSDI'06): each file is a reader-writer lock — "either one client handle may hold
  the lock in exclusive (writer) mode, or any number of client handles may hold the lock in shared
  (reader) mode"; locks are advisory. Sessions have a lease the master "may not move ... backwards
  in time"; extended via KeepAlive, "The default extension is 12s"; on local lease expiry the
  client is "in jeopardy" and waits a "grace period, 45s by default". If a holder fails, the lock
  is withheld for a "lock-delay" (bounded, ≤1 min); `sequencer` tokens let servers reject stale
  holders. https://storage.googleapis.com/gweb-research2023-media/pubtools/4444.pdf
  (abstract: https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/)
- etcd: leases are "a mechanism for detecting client liveness"; requested TTL is advisory, server
  returns the granted TTL; refreshed via `LeaseKeepAlive` stream; on expiry or revoke, attached keys
  are deleted (emitting delete events). https://etcd.io/docs/v3.5/learning/api/
- Kubernetes Lease (`coordination.k8s.io`): used for node heartbeats (kubelet updates
  `spec.renewTime`) and leader election; fields `holderIdentity`, `renewTime`,
  `leaseDurationSeconds` ("how long ... valid after the last renewal before other candidates may
  take it over"). An alpha feature releases the lock on exit instead of waiting for TTL to lapse.
  https://kubernetes.io/docs/concepts/architecture/leases/
- Consul sessions: "If the TTL interval expires without being renewed, the session has expired and
  an invalidation is triggered"; TTL is a lower bound; invalidation behavior `release` (default) or
  `delete`; `lock-delay` 0–60s (default 15s) blocks re-acquisition after invalidation; health-check
  failure also invalidates. https://developer.hashicorp.com/consul/docs/automate/session

Pattern: lease = holder id + expiry; holder renews well before expiry; explicit release frees
immediately; expiry frees after a short fencing delay; fencing token (sequencer / monotonically
increasing lease id) lets the device reject commands from a stale holder.

---

## 5. GUI / screen automation is exclusive

- Selenium Grid node: `--max-sessions` default = number of processors, "1 browser session per
  processor"; overriding risks stability. Concurrency here is per _browser process_, not per
  desktop — each session owns its own browser window.
  https://www.selenium.dev/documentation/grid/configuration/cli_options/
- Appium: "it is not possible to have more than one session running on the same device"; parallel
  runs need distinct devices and unique ports per session.
  https://appium.github.io/appium.io/docs/en/advanced-concepts/parallel-tests/
- Anthropic computer-use reference demo: run in "a dedicated virtual machine or container with
  minimal privileges"; the agent loop "can only be used by one session at a time, and must be
  restarted or reset between sessions". One desktop, exposed over VNC/noVNC.
  https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo
- UiPath: "There can only be one active console session at a time on a machine" -> one Robot at
  a time; Windows workstation allows only one active RDP session; Windows Server allows a session
  per user but robots sharing a user across sessions "must not rely on Hardware events".
  https://docs.uipath.com/robot/standalone/2023.10/admin-guide/windows-sessions
- UiPath attended licence: "you can concurrently execute only one foreground automation" (UI) but
  multiple background (non-UI) automations.
  https://docs.uipath.com/robot/standalone/2025.10/admin-guide/background-process-automation
- Windows: of the WinSta0 desktops "only one of these desktops at a time is active" — the input
  desktop that is visible and receives user input.
  https://learn.microsoft.com/en-us/windows/win32/winstation/desktops

Takeaway: every system treats "the interactive screen + keyboard/mouse" as capacity 1 (exclusive).
Concurrency is only possible by multiplying screens (more devices / VMs / server sessions) or by
moving work to non-UI background mode — exactly UiPath's "1 foreground + N background" split,
which maps to `computer_use` (exclusive) vs `compute` (shared).

---

## 6. Recommendation for the Foundry lease manager

1. **Modes.** Two modes per device resource: `shared` and `exclusive`, with a compatibility
   matrix (Postgres/flock style): shared+shared OK, exclusive conflicts with everything.
   - `compute` leases default to `shared` (many sessions run shell commands concurrently, like
     Jenkins executors / GitLab `limit`). Offer `exclusive` for "nothing else may run here"
     (Bazel `exclusive`, Nomad `cores`).
   - `computer_use` is always `exclusive` (capacity 1): one screen, one input focus (Appium,
     UiPath console session, WinSta0 input desktop, Anthropic demo "one session at a time").
   - No in-place shared->exclusive upgrade (SQL Server U-lock deadlock, flock non-atomic
     conversion). Upgrade = release + enqueue as exclusive.
2. **Capacity slots.** Shared mode is a counting semaphore: `capacity` slots per device (default
   from cores, à la Selenium/Jenkins/GitLab), optional per-session weight (`quantity`, k8s
   requests). Admit on declared slots, not observed load; enforce separately.
3. **Writer-preference FIFO queue.** Single FIFO queue per resource; a request is granted only if
   compatible with holders AND with every earlier waiter (Postgres lmgr rule, Go RWMutex). A queued
   exclusive therefore stops new shared grants until it runs — no exclusive starvation. Optional
   explicit `priority` (Jenkins) or aging/handoff (Linux rwsem) — never silent queue-jumping.
   Provide `try`/non-blocking acquire (`LOCK_NB`, `skipIfLocked`) and a wait timeout
   (`lock_timeout`) so a blocked exclusive cannot stall shared users indefinitely.
4. **Parked leases.** A waiting request is a first-class "parked" lease with a queue position the
   session can see and cancel, not a busy loop. Don't adopt GitHub's "newest pending cancels older"
   default; keep all waiters (like `queue: max`/Buildkite `ordered`).
5. **TTL + heartbeat.** Every granted lease has `holder`, `lease_id` (monotonic fencing token),
   `expires_at`; holder renews at ~1/3 TTL (Chubby 12s extension, k8s `renewTime`, etcd
   KeepAlive). Explicit release frees immediately; expiry frees after a short lock-delay (Chubby,
   Consul) so a stale holder's in-flight command can't collide; the Worker rejects commands whose
   `lease_id` is not current (Chubby sequencer). Parked requests also need a TTL so dead sessions
   drop out of the queue. Device disconnect = release via expiry (flock-on-close semantics).
