# DeepSeek harness A/B: Codex vs Claude Code vs dsh on our own tasks

Status: done 2026-11-13. 90 runs plus reruns on CanWendeMac-mini. **Recommendation: move DeepSeek executions to the Claude runtime. Do not adopt dsh as a runtime now.** Doc only; no product code changed.

## Question

Foundry runs DeepSeek V4.1-Flash through the Codex runtime today. DeepSeek's own V4.1-Flash report
(arXiv 2609.19969, Table 4) has, for the same checkpoint, Claude Code 69.8 / 88.0 and Codex 65.6 / 84.1
(DeepSWE / Terminal-Bench 2.1), with DSH Standard at 70.5 / 85.8. Does that hold on our own repository,
and is it worth (a) moving DeepSeek executions to the Claude runtime, (b) adopting dsh as a third runtime,
or (c) neither?

## Arms

| arm        | harness                                                                   | how it is launched                                                                                                                                                                                                                                                                                   | model / provider                                                                     | effort                                        |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| A `codex`  | Codex CLI `0.167.0-alpha.3.2` (the binary Foundry's Mac mini worker runs) | `codex exec --json`, the same provider block Foundry passes to `codex app-server` (custom `model_providers.*`, Responses wire API, websockets on), Foundry's generated model catalog for this model, fresh `CODEX_HOME`, `--ignore-user-config`, no sandbox                                          | `deepseek-v4.1-flash-1017`, TokenHub `https://tokenhub.tencentmaas.com/v1`           | `xhigh` (the deepseek worker group's setting) |
| B `claude` | Claude Code `2.1.311` (Foundry's managed runtime on the Mac mini)         | `claude -p --output-format stream-json`, the env Foundry sets for an Anthropic-compatible provider (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and the Opus/Sonnet/Haiku/subagent pins, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`), fresh `CLAUDE_CONFIG_DIR`, `bypassPermissions` | same model, TokenHub Anthropic Messages `https://tokenhub.tencentmaas.com` (DEV-209) | `xhigh`                                       |
| C `dsh`    | `@deepseek-ai/dsh@0.2.2-rc.1`                                             | `dsh --profile headless --json` with a patch: native `llm-deepseek` adapter pointed at TokenHub, `danger-full-access`, approvals never, session-log upload and telemetry off, fresh `DSH_HOME`                                                                                                       | same model, TokenHub Anthropic Messages                                              | `max` (dsh's top level; it has no `xhigh`)    |

All three arms run the same prompt text, in the same kind of checkout, on the same machine
(CanWendeMac-mini, 10 CPUs), with the same key, a 30-minute wall cap per run and no sandbox.

Deliberate differences from "Foundry as it runs today", applied to A and B alike:

- The CLIs are launched directly, not through a Foundry session: no Foundry MCP tools, skills or
  workspace instructions are added. Ninety Foundry sessions would need ninety isolated workspaces and
  would put ninety chats in the person's list; the runtime-specific part (binary, provider wiring, model
  catalog, effort) is reproduced from the worker code (`codex-options.ts`, `codex-model-catalog.ts`,
  `harness/profiles.ts`) and from a live Foundry Codex process's argv.
- dsh runs the `headless` profile. It mounts the same shared base (tools, loop, compaction, subagents,
  AGENTS.md loading) as the `sdk` profile DeepSeek benchmarked as "Standard"; `sdk` adds only
  `present`, `ask_user_question`, `schedule_*`, `plugin_manager` and a time-context row, none of which a
  one-shot coding task uses. `sdk` needs a JSON-RPC client, `headless` is one command.

The TokenHub key is sealed on the Server. The runs are started from a Foundry Codex session on the
TokenHub provider, whose environment carries the key; the driver passes it to each CLI through its
environment only (never written to disk or logs).

## Task kit

Ten tasks from this repository's recent history (2026-09-27 … 2026-10-30). Each task is the tree at the
fix commit's parent plus the fix commit's test files, committed as the only commit of a fresh repository
(so `git log` cannot reveal the fix), with dependencies installed. The prompt describes the bug or
feature as an issue, names the reproducing test, and gives the check command; it does not describe the
fix.

| id  | fix commit                                                                | area                                | check                                      |
| --- | ------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| T01 | `4184d2e6` reconnect delay stays below 1.5x backoff                       | worker TS, tiny                     | `daemon-reconnect-delay.test.mjs`          |
| T02 | `ce89c5bd` SOCKS fetch uses the scheme's default port                     | worker TS, networking               | `server-proxy.test.mjs`                    |
| T03 | `ef682f4c` an executor's login is the device's login on every launch      | worker TS                           | `executor-login-copy.test.mjs`             |
| T04 | `5f4805b7` skill-isolation receipts written once and atomically           | worker TS, durability               | `skill-isolation.test.mjs`                 |
| T05 | `c22ef310` only the latest process row shimmers                           | web UI logic                        | `chat-process-display.test.mjs`            |
| T06 | `63671d20` arrow keys move through the slash menu                         | web React hooks                     | `composer-slash-keys.test.mjs` (happy-dom) |
| T07 | `49b9fd6d` explain unserved or missing workspace folders on send          | web small feature + i18n            | `chat-send-error.test.mjs`                 |
| T08 | `90f03b8d` a started Issue run carries an empty events list               | Go server, JSON contract            | `TestDaemonWebSocketRoundTrip`             |
| T09 | `02270057` a requested profile decides the session's agent                | Go server, selection logic refactor | `session_orchestration_test.go`            |
| T10 | `b187b378` agents may archive native chats on devices their person paired | Go server, authorization feature    | `chat_archive_test.go`                     |

The check copies the reference test files back over the result (so editing a test cannot pass it),
then runs the task's command: worker tasks build `protocol` and `worker` with `tsc` and run the file
under the repo's sandboxed test launcher; web tasks build `protocol` and run the file with node's test
runner; Go tasks run `go vet` on the package and the test file's tests. Validation: every base fails its
check and base + the reference fix passes it. (`87c640fc` was dropped: its parent does not build.)

T02 is excluded from the comparison: its reference fix does not pass the check on the Mac mini either.
The machine's default Node 26 bundles undici 8, which is incompatible with the repo's undici 6 custom
dispatcher, so `server-proxy.test.mjs` hangs whatever the fix (several agents noticed and validated under
Node 22/24). The runs that "passed" it rewrote the dispatcher (41–78 added lines) instead of making the
3-line fix. The other nine tasks validated cleanly.

Kit location: `CanWendeMac-mini:~/.foundry/compute/dsh-ab/kit` (canonical; run evidence in
`../runs`, blind packets and key in `../blind-gen1`, scores in `../scores.json`): `tasks/` (prompts, `tasks.json`), `bin/prepare.py` (bases and
references), `bin/check.sh`, `bin/validate.sh`, `bin/run-one.sh` (one run of one arm),
`bin/dsh-run.sh`, `bin/driver.py` (interleaved schedule, restartable, spend guard), `bin/parse.py`,
`bin/dsh-usage.py`, `bin/report.py`, `bin/blind.py`, `bin/arms.env`.

## Method

- 10 tasks × 3 arms × 3 repetitions = 90 runs, each repetition block shuffled over (task, arm) so time of
  day and provider load spread evenly. Started 5 in parallel, lowered to 3 after TokenHub 429s (below).
- Infrastructure failures are rerun, not scored: a run that a provider 429 aborted (dsh only, see below),
  and 8 runs that my own restarts of the driver killed mid-run.
- Per run: check pass/fail, wall time, model requests, tool calls, input / cached input / output
  tokens, cost estimate, whether a test file was touched, the diff.
- Cost: Foundry's price table entry `deepseek/deepseek-flash` (DeepSeek list price): $0.30 / M uncached
  input, $0.006 / M cached input, $1.20 / M output. TokenHub's own billing may differ; the ratios between
  arms do not depend on it.
- Token accounting is normalized to "input = all prompt tokens, cached ⊆ input": Codex reports it so;
  Claude Code's totals come from the result event's `modelUsage` (the `usage` field there is only the
  last request's: one 24-minute run reported 98 output tokens); dsh is summed over
  every session log (root, subagents, compaction) with cache reads and writes added.
- Spend guard: after the first 15 runs the driver fixes a projection (mean cost × 90) and stops
  launching if spent + remaining × current mean would exceed twice that.
- Quality: every diff is put in a per-task packet under a random code next to the reference fix; I
  score each 1–5 (correctness beyond the test, scope discipline, fit with the surrounding code) before
  opening the key.

## Results (T02 excluded; 9 tasks × 3 arms × 3 runs = 81 scored runs)

| arm           | runs | passed | pass rate (95% Wilson) | median wall | mean wall | p90 wall | mean input tokens | cache hit | mean output tokens | cost (all runs) | cost / solved task | quality (1–5) |
| ------------- | ---- | ------ | ---------------------- | ----------- | --------- | -------- | ----------------- | --------- | ------------------ | --------------- | ------------------ | ------------- |
| A Codex       | 27   | 27     | 100% (88–100%)         | 90 s        | 129 s     | 248 s    | 567 k             | 92.0%     | 11.2 k             | $0.81           | $0.030             | 4.37          |
| B Claude Code | 27   | 27     | 100% (88–100%)         | 57 s        | 102 s     | 251 s    | 487 k             | 93.3%     | 5.5 k              | $0.51           | $0.019             | 4.59          |
| C dsh         | 27   | 27     | 100% (88–100%)         | 74 s        | 109 s     | 284 s    | 450 k             | 91.1%     | 6.7 k              | $0.61           | $0.023             | 4.63          |

Paired by task (geometric mean of per-task means against Codex):

|             | cost vs Codex | tasks cheaper | wall time vs Codex | tasks faster |
| ----------- | ------------- | ------------- | ------------------ | ------------ |
| Claude Code | 0.61×         | 9 / 9         | 0.68×              | 8 / 9        |
| dsh         | 0.67×         | 8 / 9         | 0.74×              | 6 / 9        |

Per task (✓ pass, minutes rounded down):

| task | Codex    | Claude Code | dsh      |
| ---- | -------- | ----------- | -------- |
| T01  | ✓0 ✓1 ✓1 | ✓0 ✓0 ✓0    | ✓0 ✓0 ✓0 |
| T03  | ✓0 ✓1 ✓1 | ✓0 ✓0 ✓0    | ✓0 ✓1 ✓0 |
| T04  | ✓2 ✓1 ✓1 | ✓1 ✓0 ✓0    | ✓0 ✓1 ✓1 |
| T05  | ✓4 ✓2 ✓1 | ✓1 ✓0 ✓1    | ✓1 ✓1 ✓1 |
| T06  | ✓4 ✓1 ✓1 | ✓2 ✓1 ✓4    | ✓1 ✓1 ✓1 |
| T07  | ✓1 ✓1 ✓1 | ✓0 ✓0 ✓0    | ✓1 ✓1 ✓1 |
| T08  | ✓1 ✓0 ✓1 | ✓0 ✓0 ✓0    | ✓0 ✓0 ✓1 |
| T09  | ✓2 ✓2 ✓2 | ✓3 ✓3 ✓4    | ✓2 ✓4 ✓2 |
| T10  | ✓3 ✓3 ✓8 | ✓2 ✓7 ✓2    | ✓5 ✓4 ✓7 |

T02 for the record (not scored): Codex 1/3, Claude Code 2/3 (one 30-minute timeout), dsh 0/3. All
passes came from rewriting the proxy dispatcher around the Node 26 incompatibility.

Spend: $2.50 at list price over the 85 runs kept at 20:31 CST, plus about $0.2–0.3 for aborted runs
and reruns, so roughly $2.7–2.8 in total. The guard's first-15 projection was $1.43, which makes its 2×
stop $2.86. That projection was too low: it was taken while Claude Code's output tokens were still
undercounted (fixed later from `modelUsage`). The spend came close to the stop line but never crossed it.

### What the numbers say

- **Pass rate does not separate the arms.** Every arm solved every valid task every time. These are
  real but small fixes from our history, and V4.1-Flash solves them under any of the three harnesses.
  The 95% interval for each arm is 88–100%, so a gap of a few points (DeepSeek's 69.8 vs 65.6 on
  DeepSWE) would be invisible here. The differences are in cost, time and diff quality.
- **Claude Code is the cheapest and fastest.** Against Codex it costs 0.61× per task (cheaper on 9 of 9)
  and takes 0.68× the wall time (faster on 8 of 9). Codex emits about twice the output tokens per task
  (11.2 k vs 5.5 k) and reads more context.
- **dsh sits between them**: 0.67× Codex cost and 0.74× wall time, about 20% more cost than Claude Code
  for the same results.
- **Quality**: dsh 4.63 ≈ Claude Code 4.59 > Codex 4.37. The difference between dsh and Claude Code is
  one or two diffs and within noise. Codex's lower mean comes from four 3s:
  - T08: fixed one call site instead of the store.
  - T09, twice: changed the not-found / fallback rule beyond the task.
  - T01: rewrote an unrelated devlog line.

  dsh had two 3s (T09 the same not-found change, T04 an over-built receipt validator). Claude Code had
  none, but more 4s.

- **Cache hit rate is 91–93% on all three**, matching the separate cache experiment. It is not a
  differentiator.

### Failure modes and findings beyond the scores

- **TokenHub rate limits are shared and tight.** Every arm saw HTTP 429 with "model RPM limit 60" and
  "model TPM limit 6000000" and a 60 s Retry-After. Tencent documents RPM/TPM as model-level limits
  that every inference service and API key of the account shares, with optional lower per-service or
  per-key caps ([glossary](https://cloud.tencent.com/document/product/1823/130120),
  [limits](https://cloud.tencent.com/developer/article/2675468)). All of our DeepSeek sessions on this
  model therefore share 60 requests per minute. Codex and Claude Code retried silently.
- **dsh 0.2.2-rc.1 gave up on those 429s.** It aborted 13 runs, some at the very first request. Its
  default policy caps any accepted retry delay at 10 s and so refuses the provider's 60 s Retry-After. No
  dsh run aborted after I set
  `retryPolicy: {mode: normal, maxRetries: 10, backoff: {initialDelayMs: 1000, maxDelayMs: 65000}}` on
  its `llm-deepseek` provider. Anyone running dsh against TokenHub needs that setting.
- **Codex tries a WebSocket that TokenHub refuses.** Foundry declares the TokenHub provider with
  `supports_websockets = true`, as in the live worker's argv. TokenHub answers
  `405 Method Not Allowed` on `wss://…/v1/responses`, so every Codex session spends a few seconds
  retrying the socket before falling back to HTTPS. That is part of arm A's time, and the same happens
  in Foundry today: `codexTransportPlan` should mark TokenHub as no-websocket.
- **Claude Code does not recognize the model.** It logs `[claude-code:unrecognized_model]` and runs it
  with a 200 k context window and 32 k max output. Nothing failed here, but a Foundry provider for it
  should set the context window so compaction triggers at the model's real limit.
- **Agents follow the repo's devlog rule.** Two of the 81 runs (Codex T01, Codex T10) edited
  `docs/devlog/` because AGENTS.md says to. The other arms did not, and I scored those edits as scope
  creep.
- **No arm reused the existing `writeTextAtomic` helper in T04.** All 27 runs hand-rolled
  temp-file-plus-rename, so this is a model trait, not a harness one.
- **The benchmark broke the Mac mini for 3 h 20 min.** This was my kit's fault. In T02, agents ran
  ad-hoc proxy repros outside the test launcher's sandbox. With no `FOUNDRY_STATE_ROOT`, Worker code
  used the device's real `~/.foundry` and wrote a dead local proxy into `~/.foundry/worker-proxy.json`.
  The Mac's Worker then could not reconnect from 08:57Z to 12:18Z (found and fixed in DEV-217).
  - Fix in the kit: every agent now runs with `FOUNDRY_STATE_ROOT=<run>/state`, and the driver checks
    for and removes `~/.foundry/worker-proxy.json` after each run.
  - **Any benchmark that lets agents run Worker code on a live device needs that isolation.**

### Limits

- Nine small tasks, 27 runs per arm: enough to see cost and time differences that are consistent on
  nearly every task, not to rank pass rates. A harder task set (multi-file features, longer
  investigations) is needed to test DeepSeek's claimed pass-rate gap.
- A and B run the same CLIs and provider wiring as Foundry, but outside Foundry: no Foundry MCP
  tools, skills or workspace instructions. C runs dsh's `headless` profile, not the `sdk` profile
  DeepSeek benchmarked.
- One reviewer, me. The diffs were blind, but I had seen the per-arm pass and time tables before
  scoring. Three rerun diffs (Claude T10 r1, dsh T04 r1, Codex T01 r1) were scored after the key was
  open.
- Effort: Codex's model catalog for this model lists no reasoning levels, so `xhigh` may not reach the
  provider. Claude Code was given `--effort xhigh` and dsh `max`. Effort parity is approximate.

## Recommendation

1. **Switch DeepSeek executions to the Claude runtime** once DEV-209's provider is deployed. On our
   own tasks it matched Codex on success, cost 39% less per solved task, ran about 30% faster, and
   produced slightly cleaner diffs. This agrees with DeepSeek's own ordering (Claude Code > Codex).
   - Keep Codex as an alternative in the worker group until a week of real sessions confirms it.
   - Set the model's context window on the provider.
2. **Do not adopt dsh as a runtime now.** On our tasks it was no better than Claude Code: same pass
   rate, same quality within noise, about 20% more cost, somewhat slower. A dedicated runtime is a
   2–3-week integration of a developer-preview harness that breaks compatibility every week. Its
   default retry policy aborted on our provider's normal rate limiting. Revisit if a harder task set
   shows a real pass-rate gap.
3. Independent of the runtime choice:
   - Turn off Responses WebSockets for the TokenHub Codex provider.
   - Plan DeepSeek concurrency around TokenHub's account-wide 60 RPM / 6 M TPM per model (or ask
     Tencent for a higher limit). Several parallel DeepSeek sessions already hit it.
