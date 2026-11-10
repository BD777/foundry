import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import {
  codexCatalogWithWindow,
  codexModelCatalogArguments,
} from "../dist/harness/agent-runtime/codex-model-catalog.js";
import { foundryStatePath } from "../dist/platform/state-root.js";
import { CodexAppServerThread } from "../dist/session/runner/codex-app-server.js";

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

function executableCachePath(command) {
  const program = realpathSync.native(command);
  const stat = statSync(program, { bigint: true });
  const identity = createHash("sha256")
    .update([program, stat.size, stat.mtimeNs].join("\0"))
    .digest("hex");
  return foundryStatePath(
    "native-runtime",
    "codex-models",
    `bundled-${identity}.json`,
  );
}

function catalogPath(args) {
  assert.equal(args[0], "-c");
  assert.match(args[1], /^model_catalog_json=/);
  return JSON.parse(args[1].slice("model_catalog_json=".length));
}

async function captureConsoleError(promise) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  try {
    return { value: await promise, messages };
  } catch (error) {
    return { error, messages };
  } finally {
    console.error = original;
  }
}

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
  const started = Date.now();
  try {
    await assert.rejects(
      codexModelCatalogArguments(
        command,
        { PATH: process.env.PATH },
        root,
        window,
        controller.signal,
      ),
      /interrupted/,
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

test("a native catalog cache hit does not execute Codex again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-hit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls");
  writeFileSync(
    command,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
console.log(${JSON.stringify(JSON.stringify(bundled))});`,
    { mode: 0o700 },
  );
  const env = { PATH: process.env.PATH };
  const first = await codexModelCatalogArguments(command, env, root, window);
  const second = await codexModelCatalogArguments(command, env, root, window);
  assert.deepEqual(second, first);
  assert.equal(readFileSync(calls, "utf8"), "x");
  assert.deepEqual(
    JSON.parse(readFileSync(executableCachePath(command), "utf8")),
    bundled,
  );
});

test("a shared disk cache is read without executing Codex", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-disk-hit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls");
  writeFileSync(
    command,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
process.exit(9);`,
    { mode: 0o700 },
  );
  const cache = executableCachePath(command);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(bundled));
  const args = await codexModelCatalogArguments(
    command,
    { PATH: process.env.PATH },
    root,
    window,
  );
  assert.equal(
    JSON.parse(readFileSync(catalogPath(args), "utf8")).models[0]
      .max_context_window,
    window.tokens,
  );
  assert.equal(existsSync(calls), false);
});

test("an issue execution keeps its native catalog cache in memory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-issue-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls"),
    executionRoot = join(root, "sessions");
  writeFileSync(
    command,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
console.log(${JSON.stringify(JSON.stringify(bundled))});`,
    { mode: 0o700 },
  );
  const env = {
    PATH: process.env.PATH,
    FOUNDRY_EXECUTION_SESSION_ROOT: executionRoot,
  };
  const first = await codexModelCatalogArguments(command, env, root, window);
  const second = await codexModelCatalogArguments(command, env, root, window);
  assert.deepEqual(second, first);
  assert.equal(readFileSync(calls, "utf8"), "x");
  assert.ok(catalogPath(first).startsWith(join(executionRoot, "codex-models")));
  assert.equal(existsSync(executableCachePath(command)), false);
});

test("changing the Codex executable identity reads the catalog again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls");
  const writeCatalog = (catalog, suffix = "") =>
    writeFileSync(
      command,
      `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
console.log(${JSON.stringify(JSON.stringify(catalog))});${suffix}`,
      { mode: 0o700 },
    );
  writeCatalog(bundled);
  const env = { PATH: process.env.PATH };
  const first = catalogPath(
    await codexModelCatalogArguments(command, env, root, window),
  );
  const updated = structuredClone(bundled);
  updated.models[0].base_instructions = "changed native instructions";
  writeCatalog(updated, "\n// identity changed");
  const later = new Date(Date.now() + 2_000);
  utimesSync(command, later, later);
  const second = catalogPath(
    await codexModelCatalogArguments(command, env, root, window),
  );
  assert.notEqual(second, first);
  assert.equal(readFileSync(calls, "utf8"), "xx");
  assert.equal(
    JSON.parse(readFileSync(second, "utf8")).models[0].base_instructions,
    "changed native instructions",
  );
});

test("concurrent cache misses share one native catalog read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-concurrent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    calls = join(root, "calls");
  writeFileSync(
    command,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'x');
setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(bundled))}), 100);`,
    { mode: 0o700 },
  );
  const env = { PATH: process.env.PATH };
  const args = await Promise.all([
    codexModelCatalogArguments(command, env, root, window),
    codexModelCatalogArguments(command, env, root, {
      ...window,
      tokens: 400000,
    }),
  ]);
  assert.notEqual(catalogPath(args[0]), catalogPath(args[1]));
  assert.equal(readFileSync(calls, "utf8"), "x");
});

test("native catalog read failures retry once and expose safe classes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writeCommand = (body) => {
    const command = join(root, `codex-${Math.random().toString(36).slice(2)}`);
    writeFileSync(command, `#!${process.execPath}\n${body}`, { mode: 0o700 });
    return command;
  };
  const cases = [
    {
      command: writeCommand("setInterval(()=>{},1000);"),
      expected: /timeout/,
      env: {
        PATH: process.env.PATH,
        FOUNDRY_CODEX_MODEL_CATALOG_TIMEOUT_MS: "100",
      },
    },
    {
      command: writeCommand(
        "console.error('SECRET_CREDENTIAL');process.exit(7);",
      ),
      expected: /exit code 7/,
      env: { PATH: process.env.PATH },
    },
    {
      command: writeCommand("process.stdout.write('SECRET_CREDENTIAL');"),
      expected: /invalid JSON/,
      env: { PATH: process.env.PATH },
    },
  ];
  for (const item of cases) {
    const result = await captureConsoleError(
      codexModelCatalogArguments(item.command, item.env, root, window),
    );
    assert.match(result.error.message, item.expected);
    assert.doesNotMatch(result.error.message, /SECRET_CREDENTIAL/);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0], item.expected);
    assert.doesNotMatch(result.messages[0], /SECRET_CREDENTIAL/);
  }
});

test("a failed native catalog read succeeds on its one retry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-catalog-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "codex"),
    attempts = join(root, "attempts");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs=require('node:fs');
let count=0;
try{count=Number(fs.readFileSync(${JSON.stringify(attempts)}, 'utf8'));}catch{}
count++;
fs.writeFileSync(${JSON.stringify(attempts)}, String(count));
if(count===1)process.exit(9);
console.log(${JSON.stringify(JSON.stringify(bundled))});`,
    { mode: 0o700 },
  );
  const args = await codexModelCatalogArguments(
    command,
    { PATH: process.env.PATH },
    root,
    window,
  );
  assert.equal(readFileSync(attempts, "utf8"), "2");
  assert.equal(
    JSON.parse(readFileSync(catalogPath(args), "utf8")).models[0]
      .max_context_window,
    window.tokens,
  );
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
  const updatedAt = new Date(Date.now() + 2_000);
  utimesSync(command, updatedAt, updatedAt);
  assert.notEqual(path(await materialize(window)), firstPath);
  // A failed native metadata read must fail visibly, without exposing stderr
  // or continuing with Codex's small unknown-model default.
  writeFileSync(
    command,
    `#!${process.execPath}\nconsole.error('SECRET_CREDENTIAL');process.exit(1);\n`,
    { mode: 0o700 },
  );
  const failedAt = new Date(Date.now() + 4_000);
  utimesSync(command, failedAt, failedAt);
  const failure = await captureConsoleError(materialize(window));
  assert.match(failure.error.message, /Cannot read Codex.*exit code 1/);
  assert.doesNotMatch(failure.error.message, /SECRET_CREDENTIAL/);
  assert.equal(failure.messages.length, 1);
  assert.match(failure.messages[0], /exit code 1/);
  assert.doesNotMatch(failure.messages[0], /SECRET_CREDENTIAL/);
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
