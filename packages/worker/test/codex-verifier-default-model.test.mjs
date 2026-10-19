import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexHarness } from "../dist/session/codex.js";

test("a verifier omits empty model ids so the native default can be selected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "verifier-default-"));
  const command = join(root, "codex-cli");
  const receipt = join(root, "receipt.json");
  writeFileSync(
    command,
    `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('0.0.0-test');process.exit(0);}
const config=fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 const send=x=>console.log(JSON.stringify(x));
 if(r.method==='initialize')return send({id:r.id,result:{}});
 if(r.method==='thread/start'){
  if(r.params.model==='')return send({id:r.id,error:{message:'No models are available'}});
  fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({model:r.params.model,config}));
  return send({id:r.id,result:{thread:{id:'fresh-verifier'}}});
 }
 if(r.method==='turn/start'){
  send({id:r.id,result:{turn:{id:'t'}}});
  send({method:'item/completed',params:{threadId:'fresh-verifier',item:{id:'answer',type:'agentMessage',text:'checked'}}});
  send({method:'turn/completed',params:{threadId:'fresh-verifier',turn:{id:'t',status:'completed'}}});
 }
});\n`,
    { mode: 0o700 },
  );
  const previous = process.env.FOUNDRY_CODEX_BIN;
  process.env.FOUNDRY_CODEX_BIN = command;
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_CODEX_BIN;
    else process.env.FOUNDRY_CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const response = await codexHarness.run({
    spec: {
      model: "",
      role: "verification",
      harness: "codex",
      profileId: "fixture",
      directory: root,
      prompt: { text: "Read the evidence", images: [] },
      title: "Synthetic verifier",
    },
    policy: { projectInstructions: false },
    profile: {
      model: "",
      id: "fixture",
      runtime: "codex",
      connectionType: "openai_compatible",
      baseUrl: "https://fixture.invalid",
    },
    home: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      FOUNDRY_EXECUTION_SESSION_ROOT: join(root, "sessions"),
    },
    sandboxedExecutable: (path) => path,
    signal: new AbortController().signal,
    note: () => {},
  });
  assert.equal(response.text, "checked");
  assert.equal(response.sessionId, "fresh-verifier");
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(
    observed.model,
    undefined,
    "selection stays with the native default",
  );
  assert.match(observed.config, /project_doc_max_bytes = 0/);
  assert.match(observed.config, /include_instructions = false/);
});
