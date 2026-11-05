import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  enableGhcr,
  ghcrDirectory,
  ghcrSessionTools,
  ghcrEnabled,
  ghcrHelperName,
} from "../dist/connectors/github-ghcr.js";
import { ghcrCredential } from "../dist/connectors/github-ghcr-helper.js";
import { githubAdapter } from "../dist/connectors/github.js";
const exec = promisify(execFile);

test("Docker gets a current GitHub credential only for GHCR; no token is persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghcr-test-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    '#!/bin/sh\nif [ "$1" = api ]; then echo synthetic-user; else echo SYNTHETIC_TOKEN; fi\n',
    { mode: 0o700 },
  );
  await assert.rejects(ghcrCredential(gh, "get", "docker.io"), /Only/);
  await assert.rejects(ghcrCredential(gh, "store", "{}"), /Only/);
  enableGhcr();
  assert.equal(ghcrEnabled(), true);
  const tools = ghcrSessionTools(gh);
  const helper = tools[ghcrHelperName];
  const output = await new Promise((resolve, reject) => {
    const child = execFile(helper, ["get"], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    child.stdin.end("ghcr.io\n");
  });
  assert.deepEqual(JSON.parse(output), {
    Username: "synthetic-user",
    Secret: "SYNTHETIC_TOKEN",
  });
  for (const path of [helper, join(ghcrDirectory(), "config.json")])
    assert.ok(!readFileSync(path, "utf8").includes("SYNTHETIC_TOKEN"));
  const env = githubAdapter.sessionEnvironment({ path: gh, source: "device" });
  assert.equal(env.DOCKER_CONFIG, ghcrDirectory());
  assert.notEqual(
    githubAdapter.isolationEnvironment().DOCKER_CONFIG,
    env.DOCKER_CONFIG,
  );
  // The helper follows the live CLI identity instead of keeping a copied token.
  writeFileSync(gh, "#!/bin/sh\necho unavailable >&2\nexit 1\n", {
    mode: 0o700,
  });
  await assert.rejects(ghcrCredential(gh, "get", "ghcr.io"));
});

test("GHCR setup requires read permission and selected package scopes are allowlisted", async () => {
  const run = async () => ({
    code: 0,
    stdout:
      "Logged in to github.com account synthetic-user (keyring)\nToken scopes: 'repo'",
    stderr: "",
  });
  assert.equal(
    (
      await githubAdapter.beginAuthorization(run, "", {
        id: "ghcr-docker",
        revision: 1,
      })
    ).step.status,
    "failed",
  );
  await assert.rejects(
    githubAdapter.beginAuthorization(
      run,
      "",
      { id: "packages-read", revision: 1 },
      { scopes: "read:packages,admin:org" },
    ),
    /Unsupported/,
  );
  await assert.rejects(
    githubAdapter.beginAuthorization(
      run,
      "",
      { id: "packages-read", revision: 1 },
      { scopes: "delete:packages" },
    ),
    /Unsupported/,
  );
  const ready = async () => ({
    code: 0,
    stdout:
      "Logged in to github.com account synthetic-user (keyring)\nToken scopes: 'write:packages', 'delete:packages'",
    stderr: "",
  });
  assert.equal(
    (
      await githubAdapter.beginAuthorization(
        ready,
        "",
        { id: "packages-read", revision: 1 },
        { scopes: "read:packages,write:packages,delete:packages" },
      )
    ).step.status,
    "complete",
  );
  assert.equal(
    (
      await githubAdapter.beginAuthorization(ready, "", {
        id: "ghcr-docker",
        revision: 1,
      })
    ).step.status,
    "complete",
  );
});
