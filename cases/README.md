# Foundry Regression Cases

This directory is the product-level regression catalogue. Executable tests stay
next to the code that owns them; each `*.case.json` records why the behavior
matters, how it is exercised, which evidence is required, and where its
automation lives.

The catalogue prevents two common failures:

- a test exists but nobody knows which product promise it protects;
- a feature ships with unit coverage but no API, interaction, or visual
  acceptance definition.

## Case contract

Every case follows [`case.schema.json`](case.schema.json) and should describe
one externally observable risk. Use stable behavior, not implementation detail:

- API cases assert status, schema, authorization, idempotency, and durable
  effects at the HTTP boundary.
- Daemon cases assert connection lifecycle, message ordering, reconnect, and
  filesystem/credential ownership boundaries.
- Storage cases assert transaction atomicity, identity, concurrency, and
  projection rebuild behavior at the durable-store boundary.
- Browser interaction cases use roles, accessible names, labels, and visible
  text. Do not couple them to `fdy-*` classes or DOM nesting.
- Browser visual cases pin route, fixture, viewport, color scheme, masks, and a
  screenshot checkpoint. Dynamic clocks, cursors, and streamed output should be
  masked or replaced by deterministic fixtures.
- Contract cases guard compatibility between independently compiled layers.
- Security cases must include both an allowed and rejected path.

Write steps as Given/When and assertions as Then. A bug fix should add or point
to a case that would have caught the bug. A new feature should add at least one
happy-path case and one case for its highest-risk failure or trust boundary.

## Automation levels

| Cadence        | Intended coverage                          | Requirement                              |
| -------------- | ------------------------------------------ | ---------------------------------------- |
| `commit`       | unit, reducer, contract, security boundary | deterministic, no external service       |
| `pull-request` | API integration and critical browser flows | isolated database and fixed fixtures     |
| `release`      | daemon lifecycle, responsive/visual matrix | retained screenshots/logs on failure     |
| `manual`       | exploratory checks not yet automated       | owner must record evidence and follow-up |

`automation.status` is explicit:

- `automated`: the referenced command is runnable now;
- `manual`: intentionally human/browser-driven for now;
- `planned`: accepted coverage gap with a concrete future target.

Do not mark a case automated merely because a nearby test exists. The referenced
test or command must exercise the assertions described by the case.

## Commands

```bash
pnpm cases:validate
pnpm verify

# With an isolated server already running:
FOUNDRY_API_BASE_URL=http://127.0.0.1:31982 pnpm test:smoke:api
```

`pnpm verify` validates this catalogue in addition to running the repository's
normal automated gates. Browser cases are currently executed against the local
app and retained as manual evidence; they are intentionally shaped so a future
Playwright runner can consume the same semantic steps.

## Review checklist for a new case

1. Is the case about observable product behavior and one primary risk?
2. Are fixture, viewport, credentials, time, and cleanup deterministic?
3. Are selectors semantic and stable?
4. Does the case identify the executable test instead of duplicating its logic?
5. Does failure retain enough response, log, console, network, or screenshot
   evidence to diagnose the problem?
6. Is its cadence proportional to cost and user impact?
