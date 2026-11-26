import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentQuestionReplyText } from "@bd777/foundry-protocol";
import {
  bindAntigravityProfile,
  antigravityBinDir,
} from "../dist/harness/native/antigravity.js";
import { registerSessionAmbientEnv } from "../dist/session/session-ambient.js";
import { runWorkspaceSession } from "../dist/session/workspace.js";
import {
  steerActiveSession,
  cancelActiveSession,
} from "../dist/session/session-control.js";

test(
  "ACP Chat streams and approves native options, then resumes the same session and cancels",
  { timeout: 60000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "agy-chat-"));
    process.env.FOUNDRY_TOOLS_ROOT = join(cwd, "tools");
    const bin = join(antigravityBinDir(), "agy");
    await mkdir(antigravityBinDir(), { recursive: true });
    await copyFile(new URL("./fake-antigravity-acp.mjs", import.meta.url), bin);
    await chmod(bin, 0o700);
    const profile = {
      id: "test_agy",
      runtime: "antigravity",
      connectionType: "local_login",
    };
    bindAntigravityProfile(profile.id);
    const session = {
      id: "chat-agy",
      provider: "antigravity",
      model: "chosen-model",
      source: "chat",
      input: {
        id: "first",
        prompt: "hello",
        importedContext: "must stay outside this session",
        attachments: [
          {
            kind: "image",
            path: join(cwd, "image"),
            mimeType: "image/png",
            name: "image",
          },
          {
            kind: "file",
            path: join(cwd, "document"),
            mimeType: "text/plain",
            name: "document",
          },
        ],
      },
    };
    await writeFile(join(cwd, "image"), "png");
    await writeFile(join(cwd, "document"), "document");
    t.after(
      registerSessionAmbientEnv(session.id, {
        serverURL: "http://localhost",
        sessionToken: "synthetic-token",
        workspaceID: "test-workspace",
      }),
    );
    const chunks = [];
    let reported;
    const run = () =>
      runWorkspaceSession({
        cwd,
        profile,
        session,
        emitSetup: async () => {},
        reportNativeSessionId: (id) => {
          reported = id;
        },
        async emit(_label, _detail, _level, _metadata, message) {
          if (message?.questions)
            await steerActiveSession(
              session.id,
              agentQuestionReplyText(message.id, message.questions, ["Once"]),
            );
          else if (message?.kind === "assistant") {
            chunks.push(message.text);
            if (message.text === "waiting")
              await cancelActiveSession(session.id, "second");
          }
        },
      });
    await assert.rejects(run(), /native conversation history/);
    delete session.input.importedContext;
    session.input.inputSource = { kind: "scheduled" };
    await assert.rejects(run(), /inputs from the person/);
    delete session.input.inputSource;
    const first = await run();
    assert.equal(first.response, "first second");
    assert.equal(reported, "acp-native-1");
    assert.deepEqual(chunks, ["first", "first second"]);
    session.nativeSessionId = first.nativeSessionId;
    session.input = { id: "second", prompt: "wait" };
    await assert.rejects(run(), /canceled/i);
    assert.deepEqual(
      (await readFile(join(cwd, "acp-methods"), "utf8")).trim().split("\n"),
      [
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/prompt",
        "initialize",
        "session/resume",
        "session/set_config_option",
        "session/prompt",
        "session/cancel",
      ],
    );
    session.input = { id: "cases", prompt: "same input" };
    const auth = "⚠ UNAUTHENTICATED (code 401)";
    const busy = "⚠ UNAVAILABLE (code 503)";
    for (const [attempts, expected] of [
      [[[auth], ["ok"]], "ok"],
      [[[auth], [auth]], /auth.*401/],
      [[[busy], [busy], [busy]], /transient.*503/],
      [[["⚠ network error"], ["ok"]], "ok"],
      [[["partial", busy]], /transient.*503/],
      [[["User location is not supported"]], /region/],
      [
        [["⚠ FAILED_PRECONDITION (code 400): User location is not supported"]],
        /region/,
      ],
      [
        [["⚠ RESOURCE_EXHAUSTED (code 429): insufficient allowance"]],
        /quota exhausted/,
      ],
      [
        [["⚠ RESOURCE_EXHAUSTED (code 429)"]],
        /^Error: Antigravity Claude\/GPT quota exhausted for profile test_agy, model chosen-model$/,
      ],
      [
        [["⚠ RESOURCE_EXHAUSTED (code 429) resets at 12:00 UTC"]],
        /resets at 12:00 UTC/,
      ],
    ]) {
      await writeFile(join(cwd, "scenario"), JSON.stringify(attempts));
      await writeFile(join(cwd, "attempts"), "");
      if (typeof expected === "string")
        assert.equal((await run()).response, expected);
      else await assert.rejects(run(), expected);
      assert.equal(
        (await readFile(join(cwd, "attempts"), "utf8")).length,
        attempts.length,
      );
    }
    session.model = "gemini-3.5-flash";
    await writeFile(join(cwd, "expected-model"), session.model);
    await writeFile(join(cwd, "attempts"), "");
    await writeFile(
      join(cwd, "scenario"),
      JSON.stringify([["⚠ RESOURCE_EXHAUSTED (code 429)"]]),
    );
    await assert.rejects(
      run(),
      /^Error: Antigravity Gemini quota exhausted for profile test_agy, model gemini-3\.5-flash$/,
    );
    session.model = "chosen-model";
    await rm(join(cwd, "expected-model"));
    await writeFile(join(cwd, "load-only"), "");
    await writeFile(join(cwd, "scenario"), JSON.stringify([["new output"]]));
    await writeFile(join(cwd, "attempts"), "");
    chunks.length = 0;
    assert.equal((await run()).response, "new output");
    assert.deepEqual(chunks, ["new output"]);
  },
);
