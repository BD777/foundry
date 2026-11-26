#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = "acp-native-1";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
let prompt;
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params, result } = JSON.parse(line);
  if (method) appendFileSync("acp-methods", method + "\n");
  if (method === "initialize")
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true },
        loadSession: true,
        sessionCapabilities: existsSync("load-only") ? {} : { resume: {} },
      },
    });
  else if (["session/new", "session/resume", "session/load"].includes(method)) {
    assert.deepEqual(
      Object.keys(params).sort(),
      method === "session/new"
        ? ["cwd", "mcpServers"]
        : ["cwd", "mcpServers", "sessionId"],
    );
    assert.equal(params.mcpServers[0].name, "foundry");
    assert.equal(
      params.mcpServers[0].env.find((e) => e.name === "FOUNDRY_SESSION_TOKEN")
        .value,
      "synthetic-token",
    );
    assert.equal(process.env.FOUNDRY_SESSION_TOKEN, undefined);
    if (method !== "session/new") assert.equal(params.sessionId, sessionId);
    reply(id, {
      sessionId,
      configOptions: [
        { category: "model", id: "model-selection", currentValue: "old" },
      ],
    });
    if (method === "session/load") update("old transcript");
  } else if (method === "session/set_config_option") {
    assert.equal(
      params.value,
      existsSync("expected-model")
        ? readFileSync("expected-model", "utf8")
        : "chosen-model",
    );
    reply(id, {});
  } else if (method === "session/prompt") {
    assert.equal(params.sessionId, sessionId);
    prompt = id;
    if (params.prompt[0].text === "wait") update("waiting");
    else if (existsSync("scenario")) {
      const scenario = JSON.parse(readFileSync("scenario", "utf8"));
      assert.deepEqual(params.prompt, [{ type: "text", text: "same input" }]);
      const calls = existsSync("attempts")
        ? readFileSync("attempts", "utf8").length
        : 0;
      appendFileSync("attempts", "X");
      for (const chunk of scenario[calls]) update(chunk);
      reply(id, { stopReason: "end_turn" });
    } else {
      assert.deepEqual(
        params.prompt.map((p) => p.type),
        ["text", "image", "resource_link"],
      );
      assert.equal(params.prompt[0].text, "hello");
      assert.equal(params.prompt[1].data, "cG5n");
      update("first");
      send({
        id: 72,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { title: "Run test?" },
          options: [{ name: "Once", optionId: "yes", kind: "allow_once" }],
        },
      });
    }
  } else if (id === 72) {
    assert.deepEqual(result, {
      outcome: { outcome: "selected", optionId: "yes" },
    });
    update(" second");
    reply(prompt, { stopReason: "end_turn" });
  } else if (method === "session/cancel")
    reply(prompt, { stopReason: "cancelled" });
}
