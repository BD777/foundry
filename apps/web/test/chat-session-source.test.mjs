import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { chatStartedByLabel, chatThreadsFromSessions, isChatSession } =
  await import("../src/features/chat/chat-session-model.ts");
const { i18n } = await import("../src/i18n/index.ts");

function session(id, extra = {}) {
  return {
    id,
    threadId: id,
    workspaceId: "ws_1",
    status: "completed",
    title: id,
    ...extra,
  };
}

const parent = session("sess_parent", { source: "chat" });

test("the person's own chats are listed, older rows without a source too", () => {
  assert.equal(isChatSession(session("sess_old")), true);
  assert.equal(isChatSession(parent), true);
});

test("a fork the person makes is its own listed chat", () => {
  assert.equal(
    isChatSession(
      session("sess_fork", { source: "chat", forkNativeSessionId: "n_1" }),
    ),
    true,
  );
});

test("a timer's wake continues the same listed chat, not another one", () => {
  const woken = session("sess_parent", {
    source: "chat",
    input: { id: "in_2", prompt: "wake", timerFire: { timerId: "t_1" } },
  });
  assert.equal(isChatSession(woken), true);
  assert.deepEqual(
    chatThreadsFromSessions([woken].filter(isChatSession)).map((t) => t.id),
    ["sess_parent"],
  );
});

test("a session an agent started is listed", () => {
  assert.equal(
    isChatSession(
      session("sess_child", {
        source: "agent",
        parentSessionId: "sess_parent",
      }),
    ),
    true,
  );
});

test("a verifier an agent started is listed", () => {
  assert.equal(
    isChatSession(
      session("sess_verifier", {
        source: "verification",
        parentSessionId: "sess_parent",
      }),
    ),
    true,
  );
});

test("what an agent starts inside an Issue is listed on the Issue", () => {
  for (const source of ["agent", "verification"])
    assert.equal(
      isChatSession(
        session("sess_in_issue", {
          source,
          issueId: "iss_1",
          parentSessionId: "sess_exec",
        }),
      ),
      false,
      source,
    );
});

test("an Issue's execution and clarification are listed on the Issue", () => {
  for (const role of ["issue_execution", "issue_clarification"])
    assert.equal(
      isChatSession(
        session("sess_issue", { source: "issue", issueId: "iss_1", role }),
      ),
      false,
      role,
    );
});

test("Foundry's own naming and diagnostic jobs are not listed", () => {
  assert.equal(isChatSession(session("sess_n", { source: "naming" })), false);
  assert.equal(
    isChatSession(session("sess_d", { source: "diagnostic" })),
    false,
  );
});

test("a started chat names the chat that started it as the list shows it", () => {
  const child = session("sess_child", {
    source: "agent",
    parentSessionId: "sess_parent",
  });
  const verifier = session("sess_verifier", {
    source: "verification",
    parentSessionId: "sess_parent",
  });
  const threads = chatThreadsFromSessions([parent, child, verifier]);
  const titleOf = (thread) =>
    thread.id === "sess_parent" ? "FoundryDev" : thread.title;
  assert.equal(
    chatStartedByLabel(child, threads, titleOf),
    i18n.t("chat:listRow.startedBy", { title: "FoundryDev" }),
  );
  assert.equal(
    chatStartedByLabel(verifier, threads, titleOf),
    i18n.t("chat:listRow.verifierStartedBy", { title: "FoundryDev" }),
  );
  assert.equal(chatStartedByLabel(parent, threads, titleOf), undefined);
});

test("a chat whose starter the list does not hold names another session", () => {
  const orphan = session("sess_orphan", {
    source: "agent",
    parentSessionId: "sess_gone",
  });
  assert.equal(
    chatStartedByLabel(orphan, [], (thread) => thread.title),
    i18n.t("chat:listRow.startedBy", {
      title: i18n.t("chat:listRow.anotherSession"),
    }),
  );
});
