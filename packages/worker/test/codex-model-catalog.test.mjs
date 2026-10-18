import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  codexCatalogWithWindow,
  codexModelCatalogArguments,
} from "../dist/agent-runtime/codex-model-catalog.js";
import { CodexAppServerThread } from "../dist/runner/codex-app-server.js";

const window = {
  model: "flux/GPT-6.1-Sol",
  tokens: 921600,
  source: "endpoint",
};
const nativeModel = {
  slug: "gpt-6.1-sol",
  base_instructions: "native system instructions",
  model_messages: { instructions_template: "native template" },
  context_window: 272000,
  max_context_window: 872000,
  effective_context_window_percent: 95,
  auto_compact_token_limit: 240000,
  supported_reasoning_levels: [{ effort: "xhigh" }],
  shell_type: "unified_exec",
};
const bundled = { models: [nativeModel, { ...nativeModel, slug: "gpt-5.5" }] };

test("relay aliases retain native capabilities and get both window bounds", () => {
  const original = structuredClone(bundled);
  const { models } = codexCatalogWithWindow(bundled, window);
  assert.equal(models[0].slug, window.model);
  assert.equal(models[0].context_window, 921600);
  assert.equal(models[0].max_context_window, 921600);
  assert.equal(models[0].auto_compact_token_limit, null);
  assert.equal(models[0].base_instructions, nativeModel.base_instructions);
  assert.deepEqual(models[0].model_messages, nativeModel.model_messages);
  assert.deepEqual(
    models[0].supported_reasoning_levels,
    nativeModel.supported_reasoning_levels,
  );
  assert.equal(models[0].shell_type, "unified_exec");
  assert.deepEqual(models.slice(1), bundled.models);
  assert.deepEqual(bundled, original);
  const exact = codexCatalogWithWindow(
    { models },
    { ...window, tokens: 400000 },
  );
  assert.equal(
    exact.models.filter((row) => row.slug === window.model).length,
    1,
  );
  assert.equal(exact.models[0].max_context_window, 400000);
});

test("opaque model ids get a native prompt without optional provider capabilities", () => {
  const { models } = codexCatalogWithWindow(bundled, {
    ...window,
    model: "private/opaque",
  });
  assert.equal(models[0].slug, "private/opaque");
  assert.equal(models[0].base_instructions, nativeModel.base_instructions);
  assert.deepEqual(models[0].input_modalities, ["text"]);
  assert.deepEqual(models[0].supported_reasoning_levels, []);
  assert.equal(models[0].model_messages, null);
  assert.equal(models[0].supports_search_tool, false);
  assert.equal(
    codexCatalogWithWindow(
      { models: [nativeModel] },
      { ...window, model: "private/opaque" },
    ).models[0].max_context_window,
    921600,
  );
  assert.throws(
    () => codexCatalogWithWindow({ models: [] }, window),
    /invalid bundled/,
  );
  assert.throws(
    () => codexCatalogWithWindow(bundled, { ...window, tokens: -1 }),
    /Invalid/,
  );
});

test("cancellation stops the native catalog reader before an app-server starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex");
  writeFileSync(command, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, {
    mode: 0o700,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75);
  const thread = new CodexAppServerThread(
    command,
    { PATH: process.env.PATH },
    {},
    {
      workingDirectory: root,
      model: window.model,
      contextWindow: window,
    },
  );
  const started = Date.now();
  try {
    const pending = thread.runStreamed("unused", { signal: controller.signal });
    await assert.rejects(
      thread.runStreamed("duplicate", { signal: controller.signal }),
      /already running/,
    );
    await assert.rejects(pending, /interrupted/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

test("startup catalogs are immutable across concurrent windows and native metadata changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex");
  writeFileSync(
    command,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(bundled))});\n`,
    { mode: 0o700 },
  );
  const env = { PATH: process.env.PATH };
  const materialize = (w) => codexModelCatalogArguments(command, env, root, w);
  const [first, second] = await Promise.all([
    materialize(window),
    materialize({ ...window, tokens: 400000 }),
  ]);
  const path = (args) => {
    assert.equal(args[0], "-c");
    assert.match(args[1], /^model_catalog_json=/);
    return JSON.parse(args[1].slice("model_catalog_json=".length));
  };
  const firstPath = path(first),
    secondPath = path(second);
  assert.notEqual(firstPath, secondPath);
  assert.equal(
    JSON.parse(readFileSync(firstPath)).models[0].max_context_window,
    921600,
  );
  assert.equal(
    JSON.parse(readFileSync(secondPath)).models[0].max_context_window,
    400000,
  );
  assert.deepEqual(await materialize(window), first);
  const scratch = join(root, "sandbox-sessions");
  const sandboxed = await codexModelCatalogArguments(
    command,
    { ...env, FOUNDRY_EXECUTION_SESSION_ROOT: scratch },
    root,
    window,
  );
  assert.equal(
    path(sandboxed),
    join(scratch, "codex-models", firstPath.split("/").at(-1)),
  );
  assert.equal(
    readFileSync(path(sandboxed), "utf8"),
    readFileSync(firstPath, "utf8"),
  );
  const updated = structuredClone(bundled);
  updated.models[0].base_instructions = "new native instructions";
  writeFileSync(
    command,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(updated))});\n`,
    { mode: 0o700 },
  );
  assert.notEqual(path(await materialize(window)), firstPath);
  // A failed native metadata read must fail visibly, without exposing stderr
  // or continuing with Codex's small unknown-model default.
  writeFileSync(
    command,
    `#!${process.execPath}\nconsole.error('SECRET_CREDENTIAL');process.exit(1);\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    materialize(window),
    (error) =>
      /Cannot read Codex/.test(error.message) &&
      !error.message.includes("SECRET_CREDENTIAL"),
  );
  assert.deepEqual(await materialize(undefined), []);
});

test("the execution owner loads the catalog before initialize and retains it on resume", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls.jsonl");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--bundled')){console.log(${JSON.stringify(JSON.stringify(bundled))});process.exit(0);}
const arg=process.argv.find(x=>x.startsWith('model_catalog_json='));
const catalog=arg&&JSON.parse(fs.readFileSync(JSON.parse(arg.slice('model_catalog_json='.length))));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:m.method,catalog,params:m.params})+'\\n');
 const send=x=>console.log(JSON.stringify(x));
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:'same-native-thread'}}});
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'turn/completed',params:{threadId:'same-native-thread',turn:{id:'turn',status:'completed'}}});}
});`,
    { mode: 0o700 },
  );
  const run = async (id, tokens) => {
    const thread = new CodexAppServerThread(
      command,
      { PATH: process.env.PATH },
      { model_context_window: tokens },
      {
        workingDirectory: root,
        model: window.model,
        contextWindow: { ...window, tokens },
      },
      id,
    );
    const { events } = await thread.runStreamed("test");
    for await (const event of events) {
    }
    return thread.id;
  };
  const id = await run(undefined, 921600);
  assert.equal(await run(id, 400000), id);
  const seen = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    seen.map((x) => x.method),
    [
      "initialize",
      "thread/start",
      "turn/start",
      "initialize",
      "thread/resume",
      "turn/start",
    ],
  );
  assert.equal(seen[0].catalog.models[0].max_context_window, 921600);
  assert.equal(seen[3].catalog.models[0].max_context_window, 400000);
  assert.equal(seen[4].params.threadId, id);
});

test(
  "native Codex honors compatible model windows across resume and model switches",
  {
    skip: !process.env.TEST_CODEX_CONTEXT_BIN,
  },
  async (t) => {
    const command = process.env.TEST_CODEX_CONTEXT_BIN;
    const root = mkdtempSync(join(tmpdir(), "codex-context-native-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Local context test; no inference",
            type: "invalid_request_error",
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const env = {
      PATH: process.env.PATH,
      CODEX_HOME: join(root, "native"),
      TMPDIR: tmpdir(),
    };
    mkdirSync(env.CODEX_HOME);
    const history = () => {
      const walk = (path) =>
        readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(path, entry.name))
            : entry.name.endsWith(".jsonl")
              ? [join(path, entry.name)]
              : [],
        );
      return walk(join(env.CODEX_HOME, "sessions")).flatMap((path) =>
        readFileSync(path, "utf8").trim().split("\n").map(JSON.parse),
      );
    };
    let id;
    for (const [model, tokens] of [
      [window.model, 921600],
      [window.model, 400000],
      ["private/opaque-context-test", 700000],
    ]) {
      const thread = new CodexAppServerThread(
        command,
        env,
        {
          model_provider: "local_test",
          model_context_window: tokens,
          model_providers: {
            local_test: {
              name: "local test",
              base_url: `http://127.0.0.1:${server.address().port}/v1`,
              wire_api: "responses",
              supports_websockets: false,
              request_max_retries: 0,
              stream_max_retries: 0,
            },
          },
        },
        {
          workingDirectory: root,
          model,
          approvalPolicy: "never",
          sandboxMode: "read-only",
          contextWindow: { ...window, model, tokens },
        },
        id,
      );
      const { events } = await thread.runStreamed("local window test");
      for await (const event of events) {
      }
      assert.ok(thread.id);
      if (id) assert.equal(thread.id, id);
      id = thread.id;
      const started = history().filter(
        (row) =>
          row.type === "event_msg" && row.payload.type === "task_started",
      );
      assert.equal(
        started.at(-1).payload.model_context_window,
        Math.floor(tokens * 0.95),
      );
    }
  },
);
