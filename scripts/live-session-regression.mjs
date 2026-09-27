#!/usr/bin/env node
// Live regression for the session model and orchestration against a real
// stack with real agents. It acts as the owner of a paired device: select the
// device with FOUNDRY_STACK / FOUNDRY_STATE_ROOT like the worker itself.
//
//   FOUNDRY_STACK=dev node scripts/live-session-regression.mjs \
//     --profile cc_relay [--codex-profile codex_local] [--cases two-inputs,steer]
//
// Cases and the environments they are run in: docs/live-regression.md.
// Every model request goes through the worker's agent runtimes; this script
// only talks to the Foundry server.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  FoundryClient,
  resolveConfig,
} from "../packages/worker/dist/foundry-client.js";
import { foundryStatePath } from "../packages/worker/dist/state-root.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    "codex-profile": { type: "string" },
    cases: { type: "string" },
    workspace: { type: "string" },
    "kill-worker": { type: "boolean" },
    "restart-worker": { type: "string" },
    "other-workspace": { type: "string" },
    "other-state-root": { type: "string" },
  },
});
if (!values.profile) {
  console.error(
    "usage: live-session-regression.mjs --profile <claude profile id> [--codex-profile <id>] [--cases a,b] [--workspace <id>] [--other-workspace <id> --other-state-root <dir>] [--kill-worker [--restart-worker <shell command>]]",
  );
  process.exit(2);
}

const client = new FoundryClient(resolveConfig());

/** A client acting as the owner of the device paired in another state root. */
function clientFor(stateRoot) {
  const previous = process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STATE_ROOT = stateRoot;
  try {
    return new FoundryClient(resolveConfig());
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previous;
  }
}
const active = new Set(["queued", "running", "blocked"]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const get = (id) => client.request("GET", `/api/agent-sessions/${id}`);
const inputs = (session) =>
  (session.events ?? [])
    .filter((event) => event.label === "User message")
    .map((event) => event.message.text);

async function settle(id, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await get(id);
    if (!active.has(session.status)) return session;
    if (Date.now() > deadline)
      throw new Error(`${id} did not settle within ${timeoutMs}ms`);
    await sleep(3000);
  }
}

async function running(id) {
  for (let i = 0; i < 60; i++) {
    const session = await get(id);
    if (session.status === "running") return session;
    if (!active.has(session.status))
      throw new Error(`${id} settled before it ran: ${session.status}`);
    await sleep(2000);
  }
  throw new Error(`${id} never started running`);
}

/** A square PNG of one RGB color, built without an image library. */
function solidPNG(side, rgb) {
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(side).fill(rgb).flat()),
  ]);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(side).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const workspaces = await client.request("GET", "/api/workspaces");
const workspace = values.workspace
  ? workspaces.find((item) => item.id === values.workspace)
  : workspaces[0];
check(workspace, "the device owner sees no workspace");
const agents = await client.request(
  "GET",
  `/api/agents?workspaceId=${workspace.id}`,
);
const agentFor = (profileId) => {
  const agent = agents.find((item) => item.profileId === profileId);
  check(agent, `profile ${profileId} has no agent in ${workspace.name}`);
  check(agent.status === "healthy", `profile ${profileId} is ${agent.status}`);
  return agent;
};
const claude = agentFor(values.profile);

async function start(prompt) {
  return client.request("POST", "/api/agent-sessions", {
    workspaceId: workspace.id,
    agentId: claude.id,
    provider: claude.provider,
    profileId: claude.profileId,
    prompt,
    source: "chat",
  });
}

const cases = {
  // A follow-up is a new input of the same session on the same native session.
  async "two-inputs"() {
    const session = await start(
      "Remember the codeword KIWI-9. Reply with exactly: NOTED",
    );
    const first = await settle(session.id);
    check(
      first.status === "completed" && first.response === "NOTED",
      `first input: ${first.status} ${first.response ?? first.error}`,
    );
    await client.send(
      session.id,
      "Which codeword did I give you? Reply with just the codeword.",
    );
    const second = await settle(session.id);
    check(second.id === session.id, "the follow-up created another session");
    check(
      second.nativeSessionId &&
        second.nativeSessionId === first.nativeSessionId,
      "the native session changed",
    );
    check(
      second.response === "KIWI-9",
      `context lost: ${second.response ?? second.error}`,
    );
    const transcript = await get(session.id);
    check(
      inputs(transcript).length === 2,
      "the transcript does not hold both inputs",
    );
    return `one session ${session.id}, answers NOTED then KIWI-9`;
  },

  // A message to a running session steers the active input.
  async steer() {
    const session = await start(
      "Use Bash to run: sleep 25; then reply DONE followed by any extra instruction I send meanwhile.",
    );
    await running(session.id);
    await sleep(6000);
    await client.send(session.id, "Extra instruction: append STEERED.");
    const done = await settle(session.id);
    check(
      /STEERED/.test(done.response ?? ""),
      `steer lost: ${done.response ?? done.error}`,
    );
    check(inputs(done).length === 1, "a steer became a new input");
    return `answer ${JSON.stringify(done.response)}`;
  },

  // Cancelling an input leaves the session usable with its context.
  async "cancel-continue"() {
    const session = await start(
      "Remember the codeword FIG-3. Reply with exactly: NOTED",
    );
    await settle(session.id);
    await client.send(
      session.id,
      "Use Bash to run: sleep 60; then reply TOO-LATE.",
    );
    await running(session.id);
    await sleep(5000);
    const canceled = await client.cancel(session.id);
    check(canceled.status === "canceled", `cancel: ${canceled.status}`);
    await client.send(
      session.id,
      "Ignore the stopped task. Which codeword did I give you? Reply with just it.",
    );
    const resumed = await settle(session.id);
    check(
      resumed.response === "FIG-3",
      `continue after cancel: ${resumed.response ?? resumed.error}`,
    );
    return "canceled, then answered FIG-3";
  },

  // A later input of a chat controls children an earlier input created, and a
  // child runs on its parent's profile.
  async orchestration() {
    const parent = await start(
      "Use the foundry MCP tools only. Call create_session (do not wait) with prompt: 'Use Bash to run sleep 120, then reply CHILD-FINISHED.' Then reply with exactly: CHILD=<the new session id>",
    );
    const created = await settle(parent.id);
    const childId = (created.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(childId, `no child: ${created.response ?? created.error}`);
    const child = await get(childId);
    check(
      child.parentSessionId === parent.id,
      "the child does not record its parent",
    );
    check(
      child.profileId === claude.profileId,
      `the child runs on ${child.profileId}, not its parent's ${claude.profileId}`,
    );
    await running(childId);
    await client.send(
      parent.id,
      `Using the foundry MCP tools, cancel session ${childId} with cancel_session. Reply with exactly: CANCEL=<ok or the error>`,
    );
    const canceled = await settle(parent.id);
    check(
      /CANCEL=ok/i.test(canceled.response ?? ""),
      `second input could not cancel: ${canceled.response ?? canceled.error}`,
    );
    check(
      (await get(childId)).status === "canceled",
      "the child is not canceled",
    );
    await client.send(
      parent.id,
      `Using the foundry MCP send_message tool with wait=true, tell session ${childId}: 'Forget the sleep. Reply with exactly: CHILD-CONTINUED'. Then reply with exactly: CHILD-SAID=<its response>`,
    );
    const continued = await settle(parent.id);
    check(
      /CHILD-SAID=CHILD-CONTINUED/.test(continued.response ?? ""),
      `third input: ${continued.response ?? continued.error}`,
    );
    const finalChild = await get(childId);
    check(
      inputs(finalChild).length === 2,
      "the continued child is not one session with two inputs",
    );
    return `child ${childId} canceled by input 2, continued by input 3`;
  },

  // A handoff successor controls a child it did not create.
  async handoff() {
    const parent = await start(
      "Use the foundry MCP tools only. Call create_session with wait=true and prompt: 'Reply with exactly: CHILD-READY'. Then reply with exactly: CHILD=<the new session id>",
    );
    const created = await settle(parent.id);
    const childId = (created.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(childId, `no child: ${created.response ?? created.error}`);
    await client.send(
      parent.id,
      `Use the foundry handoff_session tool with prompt: 'You now own session ${childId}. Use send_message with wait=true to tell it: Reply with exactly: SUCCESSOR-OK. Then reply with exactly: SUCCESSOR-GOT=<its response>'. Reply with exactly: HANDOFF=<new session id>`,
    );
    const handed = await settle(parent.id);
    const successorId = (handed.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(successorId, `no successor: ${handed.response ?? handed.error}`);
    const successor = await settle(successorId);
    check(
      /SUCCESSOR-GOT=SUCCESSOR-OK/.test(successor.response ?? ""),
      `successor: ${successor.response ?? successor.error}`,
    );
    return `successor ${successorId} controlled ${childId}`;
  },

  // An orchestrator steers a running child through send_message.
  async "steer-child"() {
    const parent = await start(
      "Use the foundry MCP tools only. Call create_session (do not wait) with prompt: 'Use Bash to run sleep 30, then reply CHILD-DONE followed by any extra instruction you received meanwhile.' Then reply with exactly: CHILD=<the new session id>",
    );
    const created = await settle(parent.id);
    const childId = (created.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(childId, `no child: ${created.response ?? created.error}`);
    await running(childId);
    await sleep(6000);
    await client.send(
      parent.id,
      `Using the foundry MCP send_message tool, tell running session ${childId}: 'Extra instruction: append CHILD-STEERED.' Then call wait_session on it and reply with exactly: CHILD-SAID=<its response>`,
    );
    const reported = await settle(parent.id);
    const child = await get(childId);
    check(
      /CHILD-STEERED/.test(child.response ?? ""),
      `the child was not steered: ${child.response ?? child.error}`,
    );
    check(
      inputs(child).length === 1,
      "a steer became a new input of the child",
    );
    check(
      /CHILD-SAID=.*CHILD-STEERED/s.test(reported.response ?? ""),
      `the orchestrator did not observe it: ${reported.response ?? reported.error}`,
    );
    return `child answered ${JSON.stringify(child.response)}`;
  },

  // A read-only verifier cannot change the workspace.
  async verifier() {
    check(
      workspace.localPath && existsSync(workspace.localPath),
      "run this case on the workspace's own device",
    );
    const probe = `verifier-probe-${Date.now()}.txt`;
    const parent = await start(
      `Use the foundry MCP tools only. Call create_session with verification=true, wait=true and prompt: 'Try to create the file ${probe} in the current directory with the text PROBE, using any tool you have. Reply with exactly WROTE if the file now exists, otherwise BLOCKED.' Then reply with exactly: VERIFIER=<its response> ID=<its session id>`,
    );
    const reported = await settle(parent.id);
    const verifierId = (reported.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(verifierId, `no verifier: ${reported.response ?? reported.error}`);
    const verifier = await get(verifierId);
    check(verifier.source === "verification", `source is ${verifier.source}`);
    check(
      !existsSync(join(workspace.localPath, probe)),
      "the verifier wrote into the workspace",
    );
    return `verifier ${verifierId} answered ${JSON.stringify(verifier.response)}; ${probe} absent`;
  },

  // An attachment is stored on the workspace's device and reaches the agent
  // with a follow-up input.
  async attachment() {
    const session = await start("Reply with exactly: READY");
    await settle(session.id);
    const attachment = await client.uploadAttachment(workspace.id, {
      name: "red.png",
      mimeType: "image/png",
      bytes: solidPNG(64, [0xff, 0, 0]),
    });
    check(
      attachment.kind === "image" &&
        attachment.path.startsWith(workspace.localPath),
      `stored at ${attachment.path}`,
    );
    await client.request("POST", `/api/agent-sessions/${session.id}/messages`, {
      prompt:
        "What single color fills the attached image? Reply with one lowercase word.",
      attachments: [attachment],
    });
    const answered = await settle(session.id);
    check(
      /red/i.test(answered.response ?? ""),
      `the agent did not see the image: ${answered.response ?? answered.error}`,
    );
    const carried = (answered.events ?? [])
      .filter((event) => event.label === "User message")
      .map((event) => event.message.attachments?.length ?? 0);
    check(carried.join(",") === "0,1", `attachments per input: ${carried}`);
    return `stored on the device at ${attachment.path}; the agent answered ${JSON.stringify(answered.response)}`;
  },

  // Switching runtime keeps the session and starts a new native session.
  // A worker killed mid-input: once it is back, the device reports the input
  // lost within seconds (not the 30-minute stale timeout), and the next
  // message resumes the same native context. Kills the worker of this state
  // root, so it only runs with --kill-worker; a supervisor (launchd, systemd,
  // pm2) or --restart-worker brings the worker back.
  async "worker-restart"() {
    check(
      values["kill-worker"],
      "needs --kill-worker: it kills this device's worker",
    );
    const session = await start(
      "Remember the codeword PEAR-4. Use Bash to run: sleep 90; then reply DONE.",
    );
    await running(session.id);
    await sleep(8000);
    const pid = Number(readFileSync(foundryStatePath("daemon.lock"), "utf8"));
    check(Number.isInteger(pid) && pid > 0, "no worker pid in daemon.lock");
    try {
      execFileSync("pkill", ["-9", "-P", String(pid)]);
    } catch {
      // No child processes left to kill.
    }
    process.kill(pid, "SIGKILL");
    if (values["restart-worker"])
      execFileSync("sh", ["-c", values["restart-worker"]], { stdio: "ignore" });
    const killedAt = Date.now();
    const lost = await settle(session.id, 120_000);
    const seconds = Math.round((Date.now() - killedAt) / 1000);
    check(
      lost.status === "failed" && /result was lost/.test(lost.error ?? ""),
      `after the restart: ${lost.status} ${lost.error ?? lost.response}`,
    );
    await client.send(
      session.id,
      "Ignore the interrupted task. Which codeword did I give you? Reply with just it.",
    );
    const resumed = await settle(session.id);
    check(
      resumed.response === "PEAR-4",
      `continue after the restart: ${resumed.response ?? resumed.error}`,
    );
    check(
      !(resumed.events ?? []).some((event) =>
        /Restarted runtime/.test(event.label),
      ),
      "the native context was dropped after the restart",
    );
    return `input lost ${seconds}s after the kill; the next message resumed with PEAR-4`;
  },

  // A native subagent an earlier input ran stays readable through
  // read_context after the session has moved on to another input.
  async subagents() {
    const session = await start(
      "Use the Task tool exactly once to launch a general-purpose subagent with the prompt: 'Reply with exactly MANGO-7 and nothing else.' When it returns, reply with exactly: DONE",
    );
    const first = await settle(session.id);
    check(
      first.status === "completed",
      `first input: ${first.status} ${first.error ?? first.response}`,
    );
    await client.send(session.id, "Reply with exactly: OK");
    const second = await settle(session.id);
    check(second.response === "OK", `second input: ${second.response}`);
    const readContext = async (args) => {
      const reply = await client.mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "read_context",
          arguments: { sessionId: session.id, maxBytes: 200000, ...args },
        },
      });
      const text = reply?.result?.content?.[0]?.text ?? "";
      check(
        !reply?.error && !reply?.result?.isError,
        `read_context ${JSON.stringify(args)}: ${reply?.error?.message ?? text}`,
      );
      return JSON.parse(text);
    };
    const subagents = await readContext({ scope: "subagents" });
    check(
      Array.isArray(subagents) && subagents.length > 0,
      "read_context lists no subagents after a later input",
    );
    const subagent =
      subagents.find((item) =>
        (item.responseTexts ?? []).some((text) => text.includes("MANGO-7")),
      ) ?? subagents[0];
    const transcript = await readContext({
      scope: "subagents",
      taskId: subagent.taskId,
    });
    check(
      (transcript.messages ?? []).some((message) =>
        message.content.includes("MANGO-7"),
      ),
      `subagent ${subagent.taskId} transcript lacks its answer`,
    );
    return `subagent ${subagent.taskId} of input 1 read after input 2: MANGO-7`;
  },

  // An agent starts and steers work in another workspace of the same person,
  // on that workspace's device (§5.6 option A). A device credential sees only
  // its own device, so the child is read with the other device's credential.
  async "cross-workspace"() {
    const other = values["other-workspace"];
    const otherRoot = values["other-state-root"];
    check(other && otherRoot, "needs --other-workspace and --other-state-root");
    const otherClient = clientFor(otherRoot);
    const getOther = (id) =>
      otherClient.request("GET", `/api/agent-sessions/${id}`);
    const parent = await start(
      `Use the foundry MCP tools only. Call list_workspaces, then create_session with workspaceId '${other}', wait=true and prompt: 'Compute 7 times 8. Reply with exactly ANSWER- followed by the product.' Then reply with exactly: CHILD=<the new session id> REACHABLE=<how many workspaces list_workspaces returned>`,
    );
    const created = await settle(parent.id);
    const childId = (created.response ?? "").match(/sess_[0-9]+/)?.[0];
    check(childId, `no child: ${created.response ?? created.error}`);
    check(
      /REACHABLE=([2-9]|\d{2,})/.test(created.response ?? ""),
      `list_workspaces did not show both workspaces: ${created.response}`,
    );
    const child = await getOther(childId);
    check(child.parentSessionId === parent.id, "the child lost its parent");
    check(
      child.workspaceId === other,
      `the child runs in ${child.workspaceId}`,
    );
    check(
      child.deviceId && child.deviceId !== claude.deviceId,
      `the child runs on ${child.deviceId}, not the other workspace's device`,
    );
    check(!child.createdGroupId, "the child joined a group across workspaces");
    check(
      child.response === "ANSWER-56",
      `child: ${child.status} ${child.response ?? child.error}`,
    );
    await client.send(
      parent.id,
      `Using the foundry MCP send_message tool with wait=true, tell session ${childId}: 'Add 10 to your previous answer. Reply with exactly ANSWER- followed by the result.' Then reply with exactly: CHILD-SAID=<its response>`,
    );
    const continued = await settle(parent.id);
    check(
      /CHILD-SAID=ANSWER-66/.test(continued.response ?? ""),
      `second input: ${continued.response ?? continued.error}`,
    );
    return `child ${childId} in ${other} on ${child.deviceId}: ANSWER-56, then ANSWER-66`;
  },

  async "runtime-switch"() {
    const codexProfile = values["codex-profile"];
    check(codexProfile, "needs --codex-profile");
    const codex = agentFor(codexProfile);
    const session = await start("Reply with exactly: ON-CLAUDE");
    const first = await settle(session.id);
    check(
      first.response === "ON-CLAUDE",
      `first input: ${first.response ?? first.error}`,
    );
    await client.request("POST", `/api/agent-sessions/${session.id}/messages`, {
      agentId: codex.id,
      provider: codex.provider,
      profileId: codex.profileId,
      importedContext:
        "User: Reply with exactly: ON-CLAUDE\nAssistant: ON-CLAUDE",
      profileTransitionNote: "Switched to Codex",
      prompt:
        "What did the assistant reply before the switch? Reply with just that text.",
    });
    const switched = await settle(session.id);
    check(
      switched.id === session.id && switched.provider === "codex",
      "the switch did not stay in the session",
    );
    check(
      switched.nativeSessionId !== first.nativeSessionId,
      "the native session did not change",
    );
    check(
      switched.response === "ON-CLAUDE",
      `imported context lost: ${switched.response ?? switched.error}`,
    );
    return "same session continued on Codex with imported context";
  },
};

const selected = values.cases
  ? values.cases.split(",").map((name) => name.trim())
  : Object.keys(cases).filter(
      (name) =>
        (name !== "runtime-switch" || values["codex-profile"]) &&
        (name !== "worker-restart" || values["kill-worker"]) &&
        (name !== "cross-workspace" || values["other-workspace"]),
    );
let failed = 0;
console.log(
  `workspace ${workspace.name} (${workspace.id}), profile ${claude.profileId}`,
);
for (const name of selected) {
  const run = cases[name];
  if (!run) {
    console.log(`✖ ${name}: unknown case`);
    failed++;
    continue;
  }
  const started = Date.now();
  try {
    const evidence = await run();
    console.log(
      `✔ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${evidence}`,
    );
  } catch (error) {
    failed++;
    console.log(
      `✖ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${error instanceof Error ? error.message : error}`,
    );
  }
}
process.exit(failed ? 1 : 0);
