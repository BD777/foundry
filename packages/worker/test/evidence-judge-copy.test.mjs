import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Profiles are read from the state root when the modules load.
const home = realpathSync(mkdtempSync(join(tmpdir(), "foundry-judge-copy-")));
process.env.HOME = home;
process.env.FOUNDRY_STATE_ROOT = join(home, ".foundry");
mkdirSync(join(home, ".foundry"));
writeFileSync(
  join(home, ".foundry/agent-profiles.local.json"),
  JSON.stringify({
    profiles: [{ id: "claude_p", runtime: "claude", label: "C", model: "x" }],
  }),
);
const cli = join(home, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
test.after(() => rmSync(home, { recursive: true, force: true }));

register("./fixtures/fake-agent-sdk-hooks.mjs", import.meta.url);
const { calls } = await import("./fixtures/fake-agent-sdk.mjs");
const { git, gitCommit } = await import("../dist/execution-git.js");
const { prepareIssueEnvironment, snapshotEnvironment } =
  await import("../dist/issue-environments.js");
const { ExecutionStore } = await import("../dist/execution-storage.js");
const { EvidenceStore, digestObject } =
  await import("../dist/evidence-store.js");
const { writeCandidateChanges } = await import("../dist/evidence-snapshots.js");
const { evidenceWorkerAction } = await import("../dist/evidence-rpc.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");

/** A candidate with a tracked change and ignored node_modules / .env. */
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(home, "issue-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  mkdirSync(source);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(resolve(source, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(resolve(source, "greet.mjs"), "export const hi = 'hi';\n");
  await git(source, ["add", "."]);
  await gitCommit(source, "baseline");
  const execution = new ExecutionStore(resolve(root, "state"));
  let environment = await prepareIssueEnvironment(
    source,
    "ws_copy",
    "iss_copy",
    execution,
  );
  writeFileSync(
    resolve(environment.cwd, "greet.mjs"),
    "export const hi = 'hello';\n",
  );
  mkdirSync(resolve(environment.cwd, "node_modules/dep"), { recursive: true });
  writeFileSync(resolve(environment.cwd, "node_modules/dep/index.js"), "x\n");
  writeFileSync(resolve(environment.cwd, ".env"), "TOKEN=secret\n");
  environment = await snapshotEnvironment(environment, execution);
  environment.controlIsolationVersion = 1;
  environment.contractRevision = 1;
  execution.saveEnvironment(environment);
  const store = new EvidenceStore(
    "ws_copy",
    "iss_copy",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  const criterion = {
    id: "greets",
    title: "Greets",
    statement: "greet.mjs says hello",
    required: true,
    proofKind: "content_completeness",
    evaluationMode: "agent",
    rubric: { text: "Read greet.mjs", media: [] },
    evidenceRequirements: [
      {
        id: "source",
        description: "greet.mjs from the candidate",
        acceptedCarriers: ["document"],
        minimumCount: 1,
        bindingPolicy: "system_observed",
      },
    ],
  };
  const contract = {
    ...store.record("contract"),
    revision: 1,
    origin: "user",
    goal: { text: "Say hello", media: [] },
    inScope: [],
    outOfScope: [],
    constraints: [],
    criteria: [criterion],
    contentDigest: digestObject([criterion]),
    status: "confirmed",
  };
  contract.confirmation = {
    actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
    at: new Date().toISOString(),
    contentDigest: contract.contentDigest,
  };
  const scope = {
    workspaceId: "ws_copy",
    issueId: "iss_copy",
    deviceId: "dev",
  };
  return { root, environment, execution, store, criterion, contract, scope };
}

test("ignored files in the live candidate no longer leave the input unbound", async (t) => {
  const { execution, contract, scope } = await fixture(t);
  const sealed = await evidenceWorkerAction(
    { ...scope, action: "seal", taskId: "seal", contract },
    execution,
  );
  assert.equal(sealed.error, undefined, sealed.error);
  assert.equal(sealed.input.bindingStatus, "verified");
  assert.deepEqual(sealed.input.bindingNotes, []);
});

test("the change summary names what the sealed candidate changed", async (t) => {
  const { root, execution, contract, scope, environment } = await fixture(t);
  const sealed = await evidenceWorkerAction(
    { ...scope, action: "seal", taskId: "seal", contract },
    execution,
  );
  const changes = resolve(root, "changes");
  await writeCandidateChanges(sealed.candidate, environment, changes);
  const summary = readFileSync(resolve(changes, "summary.md"), "utf8");
  assert.match(summary, /M\tgreet\.mjs/);
  assert.doesNotMatch(summary, /node_modules|\.env/);
  const diff = summary.match(/Full diff: (\S+)/)[1];
  assert.match(
    readFileSync(resolve(changes, diff), "utf8"),
    /\+export const hi = 'hello';/,
  );
});

test(
  "a judge works in a clean copy of the sealed candidate, never the live worktree",
  { skip: !sandboxAvailable("readonly_agent") },
  async (t) => {
    const { execution, store, criterion, contract, scope, environment } =
      await fixture(t);
    const sealed = await evidenceWorkerAction(
      { ...scope, action: "seal", taskId: "seal", contract },
      execution,
    );
    const verification = {
      ...store.record("verify"),
      sequence: 1,
      criterionId: criterion.id,
      contractRevision: 1,
      verificationInputId: sealed.input.id,
      evidenceIds: [],
      mode: "agent",
      executor: {
        kind: "agent",
        harness: "claude",
        profileId: "claude_p",
        requestedModel: "x",
        sessionId: "pending",
        promptTemplateVersion: "foundry-verification/v1",
        promptDigest: digestObject("pending"),
        isolated: true,
      },
      status: "queued",
    };
    calls.length = 0;
    // The fake model's answer is not a judgment; only what it saw matters.
    await evidenceWorkerAction(
      {
        ...scope,
        action: "assess",
        taskId: verification.id,
        contract,
        input: sealed.input,
        verification,
        evidence: [],
      },
      execution,
    );
    const judge = calls.find((call) => call.sdk === "claude");
    assert.ok(judge, "the judge session ran");
    assert.notEqual(judge.options.cwd, environment.cwd);
    assert.ok(judge.cwdFiles.includes("greet.mjs"));
    assert.ok(!judge.cwdFiles.some((f) => /node_modules|\.env/.test(f)));
    assert.match(judge.promptText, /exactly the files Accept would integrate/);
    assert.match(judge.promptText, /summary\.md/);
    // The copy is gone once the judgment is over.
    assert.equal(existsSync(judge.options.cwd), false);
  },
);
