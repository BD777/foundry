import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { parseExtensionManifest } =
  await import("../dist/connectors/extensions/manifest.js");

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "../../../extensions/examples");

test("the published extension examples parse with the manifest reader", () => {
  const names = readdirSync(examples)
    .filter((name) => name.startsWith("acme-"))
    .sort();
  assert.deepEqual(names, [
    "acme-api-server-held",
    "acme-cli-declarative",
    "acme-cli-program",
  ]);

  const parsed = new Map(
    names.map((name) => [
      name,
      parseExtensionManifest(
        JSON.parse(
          readFileSync(join(examples, name, "foundry-extension.json"), "utf8"),
        ),
      ),
    ]),
  );

  const program = parsed.get("acme-cli-program");
  assert.equal(program.entry?.command, "node");
  assert.equal(program.connectors[0].holding, "device_held");
  assert.equal(program.connectors[0].signIn?.methods[0].kind, "terminal");

  const declarative = parsed.get("acme-cli-declarative");
  assert.equal(declarative.entry, undefined);
  assert.equal(declarative.connectors[0].holding, "device_held");
  assert.deepEqual(declarative.cli?.["acme-declarative"]?.signIn?.token.args, [
    "login",
    "--token-stdin",
  ]);
  assert.deepEqual(declarative.cli?.["acme-declarative"]?.signOut?.args, [
    "logout",
  ]);

  const serverHeld = parsed.get("acme-api-server-held");
  assert.equal(serverHeld.entry, undefined);
  assert.equal(serverHeld.cli, undefined);
  assert.equal(serverHeld.connectors[0].holding, "server_held");
  assert.equal(serverHeld.connectors[0].serverHeld?.steps.length, 2);
  assert.deepEqual(serverHeld.connectors[0].serverHeld?.network.holdings, [
    "server",
    "device",
  ]);
});
