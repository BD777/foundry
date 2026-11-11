// Installing a connector extension from the git folder it is published in
// (docs/connector-extensions.md, "来源"): fetched with the device's own git,
// recorded with its source and commit, told of a newer commit, updated from
// it, and refused when the source is not a plain git folder. The remote is a
// local repository git reaches through an https URL rewrite, so nothing
// leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleExtensionRequest,
  extensionConnectorDescriptors,
} from "../dist/connectors/index.js";
import {
  installExtensionFromRepository,
  refreshLatestCommits,
  updateExtension,
} from "../dist/connectors/extensions/sources.js";
import {
  extensionDir,
  listExtensions,
  removeExtension,
  setExtensionAutoUpdate,
} from "../dist/connectors/extensions/registry.js";
import { parseExtensionManifest } from "../dist/connectors/extensions/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-extension");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();
}

/** A repository with the fixture extension in tools/foundry-extension. */
function publishedRepository() {
  const repo = mkdtempSync(join(tmpdir(), "fdy-ext-repo-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  cpSync(fixture, join(repo, "tools", "foundry-extension"), {
    recursive: true,
  });
  writeFileSync(join(repo, "README.md"), "not part of the extension\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "extension 1.0");
  return repo;
}

test("an extension installs from its git folder, sees a newer commit and updates", async (t) => {
  const repo = publishedRepository();
  // git fetches https://git.example.test/acme/<repo> from the folder.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${dirname(repo)}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://git.example.test/acme/";
  const name = repo.split("/").at(-1);
  const source = {
    git: `https://git.example.test/acme/${name}`,
    path: "tools/foundry-extension",
    ref: "main",
  };
  t.after(() => {
    try {
      removeExtension("corp");
    } catch {}
  });
  const first = await installExtensionFromRepository(source);
  assert.equal(first.action, "created");
  setExtensionAutoUpdate("corp", false);
  const commit = git(repo, "rev-parse", "HEAD");
  assert.deepEqual(first.extension.source, source);
  assert.equal(first.extension.commit, commit);
  // Only the folder, never .git or the rest of the repository.
  assert.ok(existsSync(join(extensionDir("corp"), "foundry-extension.json")));
  assert.ok(!existsSync(join(extensionDir("corp"), ".git")));
  assert.ok(!existsSync(join(extensionDir("corp"), "README.md")));
  const reported = extensionConnectorDescriptors().find(
    (connector) => connector.kind === "corpcli",
  );
  assert.deepEqual(reported.extension.source, source);
  assert.equal(reported.extension.commit, commit);

  // The same commit again changes nothing.
  assert.equal(
    (await installExtensionFromRepository(source)).action,
    "unchanged",
  );

  // A new commit upstream: the device notices, then updates to it.
  const manifestPath = join(
    repo,
    "tools",
    "foundry-extension",
    "foundry-extension.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, version: "1.1.0" }),
  );
  git(repo, "commit", "--quiet", "-am", "extension 1.1");
  const newer = git(repo, "rev-parse", "HEAD");
  assert.equal(await refreshLatestCommits(0), true);
  const noticed = listExtensions().find((item) => item.id === "corp");
  assert.equal(noticed.commit, commit);
  assert.equal(noticed.latestCommit, newer);
  assert.equal(
    extensionConnectorDescriptors().find((c) => c.kind === "corpcli").extension
      .latestCommit,
    newer,
  );
  const updated = await updateExtension("corp");
  assert.equal(updated.action, "updated");
  assert.equal(updated.extension.version, "1.1.0");
  assert.equal(updated.extension.commit, newer);

  // Through the server's request: remove, then install again.
  assert.deepEqual(
    await handleExtensionRequest({ action: "remove", extensionId: "corp" }),
    { action: "removed" },
  );
  const again = await handleExtensionRequest({ action: "install", source });
  assert.equal(again.action, "created");
  assert.equal(again.extension.commit, newer);
});

test("a source git cannot fetch, or that is not a plain git folder, is refused", async () => {
  for (const source of [
    { git: "file:///etc" },
    { git: "https://user:secret@github.com/acme/tools.git" },
    { git: "https://github.com/acme/tools.git", path: "../up" },
    { git: "https://github.com/acme/tools.git", ref: "--upload-pack=x" },
    { git: "" },
  ]) {
    const reply = await handleExtensionRequest({ action: "install", source });
    assert.match(reply.error ?? "", /source/, JSON.stringify(source));
  }
  const missing = await handleExtensionRequest({
    action: "install",
    source: { git: "https://git.example.test/acme/no-such-repository.git" },
  });
  assert.ok(
    missing.error,
    "a repository git cannot fetch fails in git's words",
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...JSON.parse(
          readFileSync(join(fixture, "foundry-extension.json"), "utf8"),
        ),
        source: { git: "ftp://example.test/x" },
      }),
    /source\.git/,
  );
});
