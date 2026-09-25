#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { ExecutionStore } from "../packages/worker/dist/execution-storage.js";
import { git, gitCommit } from "../packages/worker/dist/execution-git.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
  cleanupEnvironment,
} from "../packages/worker/dist/issue-environments.js";
import { runIssueExecutor } from "../packages/worker/dist/issue-executor.js";
import {
  prepareAcceptance,
  applyAcceptance,
} from "../packages/worker/dist/workspace-acceptance.js";

const runtime = process.argv[2];
if (!["claude", "codex"].includes(runtime))
  throw new Error("Usage: node scripts/verify-issue-live.mjs <claude|codex>");
const root = mkdtempSync(resolve(tmpdir(), `foundry-live-${runtime}-`));
console.log(
  JSON.stringify({ runtime, stage: "fixture", evidenceDirectory: root }),
);
const source = resolve(root, "source");
const library = resolve(source, "repos/library");
mkdirSync(library, { recursive: true });
await git(library, ["init", "-b", "main"]);
writeFileSync(resolve(library, "base.txt"), "original library\n");
await git(library, ["add", "."]);
await gitCommit(library, "Fixture baseline");
mkdirSync(resolve(source, "Docs"));
writeFileSync(
  resolve(source, "Docs/guide.md"),
  "Verification workspace. Work only on the files explicitly requested.\n",
);
const workspaceId = `ws_${randomUUID()}`;
const issueId = `iss_${randomUUID()}`;
const store = new ExecutionStore(resolve(root, "state"));
let environment = await prepareIssueEnvironment(
  source,
  workspaceId,
  issueId,
  store,
);
const token = randomUUID();
// Execution follows the human-confirmed contract; later instructions arrive as
// conversation feedback after confirmation, as they do in the product.
const confirmedAt = new Date().toISOString();
const contract = (goal) => ({
  goal: { text: goal, media: [] },
  inScope: [],
  outOfScope: [],
  constraints: ["Never write to the original workspace."],
  criteria: [],
  status: "confirmed",
  confirmation: {
    actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
    at: confirmedAt,
    contentDigest: `sha256:${"0".repeat(64)}`,
  },
});
const feedback = (issue, text) => ({
  ...issue,
  messages: [
    ...(issue.messages ?? []),
    {
      id: `msg_${randomUUID()}`,
      role: "user",
      text,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    },
  ],
});
const issue = {
  id: issueId,
  workspaceId,
  shortId: "LIVE",
  title: "Verify multi-repository execution",
  runtime,
  acceptanceCriteria: [],
  checks: [],
  skills: [],
  sourceInput: "Live execution verification",
  messages: [],
  executionContract: contract(
    `This is a small execution verification. Read Docs/guide.md. Remember this token in the conversation: ${token}. Do not write the token to files yet. Create initial.txt containing 'initial' in the candidate root. Use the provided repository-tool to prepare repos/library, then create repos/library/result.txt containing 'library candidate'. Never write to the original workspace. Finish with a concise result.`,
  ),
};
const record = async (label, detail) => {
  appendFileSync(
    resolve(root, "events.private.jsonl"),
    JSON.stringify({ label, detail }) + "\n",
    { mode: 0o600 },
  );
  if (!["Response stream", "正在思考", "正在请求模型"].includes(label))
    console.log(JSON.stringify({ runtime, stage: "event", label }));
};
try {
  let result = await runIssueExecutor(
    environment,
    issue,
    `run_${randomUUID()}`,
    record,
    store,
  );
  environment = await snapshotEnvironment(result.environment, store);
  assert.ok(environment.nativeSessionId, "native session ID must be retained");
  assert.ok(existsSync(resolve(environment.cwd, "repos/library/result.txt")));
  assert.equal(existsSync(resolve(source, "initial.txt")), false);
  assert.equal(existsSync(resolve(library, "result.txt")), false);
  const nativeSessionId = environment.nativeSessionId;
  console.log(
    JSON.stringify({
      runtime,
      stage: "first-turn-passed",
      repositories: environment.repositories.length,
    }),
  );
  if (process.argv.includes("--interrupt")) {
    const control = new AbortController();
    const interrupted = runIssueExecutor(
      environment,
      feedback(
        issue,
        "For an interruption test: create started.txt containing 'started' in the candidate root, then run a shell command that sleeps for 60 seconds. Do not change any other files. This turn will be interrupted by the host.",
      ),
      `run_${randomUUID()}`,
      record,
      store,
      undefined,
      control.signal,
    ).then(
      () => ({ completed: true }),
      (error) => ({ error: String(error) }),
    );
    const deadline = Date.now() + 180000;
    while (
      !existsSync(resolve(environment.cwd, "started.txt")) &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 100));
    control.abort(
      new Error("Verification intentionally interrupts the executor"),
    );
    const outcome = await interrupted;
    assert.ok(
      existsSync(resolve(environment.cwd, "started.txt")),
      "Agent must start the interruption turn",
    );
    assert.ok(
      outcome.error,
      "Executor must be interrupted before normal completion",
    );
    environment = store.environment(workspaceId, issueId);
    assert.equal(environment.nativeSessionId, nativeSessionId);
    console.log(JSON.stringify({ runtime, stage: "interruption-passed" }));
  }
  result = await runIssueExecutor(
    environment,
    feedback(
      issue,
      "Continue the same verification. Write the verification token you remember from our previous conversation into resume.txt at the candidate root, with no other content. Keep initial.txt and repos/library/result.txt. Do not search logs or session files for the token. Finish after writing it.",
    ),
    `run_${randomUUID()}`,
    record,
    store,
  );
  environment = await snapshotEnvironment(result.environment, store);
  assert.equal(environment.nativeSessionId, nativeSessionId);
  assert.equal(
    readFileSync(resolve(environment.cwd, "resume.txt"), "utf8").trim(),
    token,
  );
  const acceptance = await prepareAcceptance(
    workspaceId,
    issueId,
    environment.revision,
    store,
  );
  assert.equal(acceptance.status, "prepared", acceptance.error);
  await applyAcceptance(
    workspaceId,
    issueId,
    acceptance.id,
    environment.revision,
    store,
  );
  assert.equal(
    readFileSync(resolve(source, "resume.txt"), "utf8").trim(),
    token,
  );
  assert.ok(existsSync(resolve(library, "result.txt")));
  await cleanupEnvironment(store.environment(workspaceId, issueId), store);
  const resultSummary = {
    runtime,
    status: "passed",
    checks: [
      "ordinary workspace assets",
      "lazy multi-repo preparation",
      "source unchanged before Accept",
      ...(process.argv.includes("--interrupt")
        ? ["in-flight executor termination and recovery"]
        : []),
      "native session resume and remembered token",
      "multi-repo Accept",
      "leaf-first cleanup",
    ],
  };
  writeFileSync(
    resolve(root, "result.json"),
    JSON.stringify(resultSummary, null, 2),
  );
  console.log(JSON.stringify(resultSummary));
} catch (error) {
  writeFileSync(resolve(root, "failure.log"), String(error), { mode: 0o600 });
  console.error(
    JSON.stringify({
      runtime,
      status: "failed",
      evidenceDirectory: root,
      message: "See private failure.log; no credentials are printed",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const name of [
    "codex/auth.json",
    "codex/config.toml",
    "claude/.credentials.json",
  ])
    rmSync(resolve(environment.scratch, name), { force: true });
}
