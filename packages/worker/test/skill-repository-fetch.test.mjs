import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(join(tmpdir(), "tools-root-"));
process.env.npm_config_cache = mkdtempSync(join(tmpdir(), "npm-cache-"));
const { fetchSkillRepository, readRepositoryRefs } =
  await import("../dist/skill-repository-fetch.js");
const { installTool, managedToolVersions, npmRegistryArgs } =
  await import("../dist/managed-tools.js");
const { unpackZip } = await import("../dist/skill-zip.js");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (dir, ...args) =>
  execFileSync("git", args, { cwd: dir, env: gitEnv }).toString().trim();

function commit(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "change");
}

/**
 * A repository only this device can reach: its https address is rewritten
 * to a local bare repository by the device's own git config (insteadOf),
 * the way an intranet host or ssh setup is found through it.
 */
function deviceOnlyRepository() {
  const work = mkdtempSync(join(tmpdir(), "repo-work-"));
  git(work, "init", "--quiet", "--initial-branch=main");
  commit(work, {
    "skills/review/SKILL.md": "---\nname: review\n---\nv1\n",
    "skills/review/scripts/run.sh": "echo v1\n",
    "skills/notes/SKILL.md": "---\nname: notes\n---\n",
    "skills/manifest.yaml": "skills: [review, notes]\n",
    "src/big.js": "not a skill\n",
    LICENSE: "MIT\n",
  });
  git(work, "tag", "v1.0.0");
  commit(work, { "skills/review/SKILL.md": "---\nname: review\n---\nv2\n" });
  git(work, "tag", "-a", "v1.1.0", "-m", "release");
  const bare = mkdtempSync(join(tmpdir(), "repo-bare-"));
  execFileSync("git", ["clone", "--quiet", "--bare", work, bare], {
    env: gitEnv,
  });
  const config = join(mkdtempSync(join(tmpdir(), "gitconfig-")), "config");
  writeFileSync(
    config,
    `[url "${bare}"]\n\tinsteadOf = https://git.devfetch.invalid/team/skills\n` +
      `[protocol "file"]\n\tallow = always\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return { work, remote: "https://git.devfetch.invalid/team/skills" };
}

test("a git repository is read with the device's own git settings and only its skills are uploaded", async () => {
  const { work, remote } = deviceOnlyRepository();
  const tags = await readRepositoryRefs({ remote, tags: true });
  assert.match(tags.refs, /refs\/tags\/v1\.1\.0\^\{\}/);
  const head = await readRepositoryRefs({ remote, patterns: ["HEAD"] });
  assert.equal(head.refs.split(/\s+/)[0], git(work, "rev-parse", "HEAD"));

  let uploaded;
  const fetched = await fetchSkillRepository(
    { remote, ref: "v1.0.0", subpath: "skills", uploadPath: "/x" },
    async (body, type) => {
      uploaded = { body, type };
    },
  );
  assert.equal(fetched.commit, git(work, "rev-parse", "v1.0.0^{commit}"));
  assert.equal(uploaded.type, "application/zip");
  const files = Object.fromEntries(
    unpackZip(uploaded.body, { maxBytes: 1 << 24, maxFiles: 100 }).map(
      (entry) => [entry.path, entry.data.toString()],
    ),
  );
  assert.deepEqual(Object.keys(files).sort(), [
    "LICENSE",
    "skills/manifest.yaml",
    "skills/notes/SKILL.md",
    "skills/review/SKILL.md",
    "skills/review/scripts/run.sh",
  ]);
  assert.match(files["skills/review/SKILL.md"], /v1/);

  // An annotated tag and a branch, from the same cache.
  const tagged = await fetchSkillRepository(
    { remote, ref: "v1.1.0", subpath: "skills", uploadPath: "/x" },
    async (body) => {
      uploaded = { body };
    },
  );
  assert.equal(tagged.commit, git(work, "rev-parse", "v1.1.0^{commit}"));
  const main = await fetchSkillRepository(
    { remote, ref: "main", subpath: "skills", uploadPath: "/x" },
    async () => {},
  );
  assert.equal(main.commit, git(work, "rev-parse", "main"));
  assert.ok(
    existsSync(join(process.env.FOUNDRY_STATE_ROOT, "skill-repositories")),
    "the cache lives under the worker's state root",
  );

  await assert.rejects(
    fetchSkillRepository(
      { remote, ref: "no-such-ref", uploadPath: "/x" },
      async () => {},
    ),
    /no-such-ref|couldn't find remote ref/i,
  );
  for (const bad of ["file:///etc", "ext::sh -c id", "--upload-pack=id"])
    await assert.rejects(
      readRepositoryRefs({ remote: bad, tags: true }),
      /only https and ssh/,
    );
  await assert.rejects(
    fetchSkillRepository(
      { remote, ref: "--help", uploadPath: "/x" },
      async () => {},
    ),
    /invalid branch or tag/,
  );
  await assert.rejects(
    readRepositoryRefs({ remote, patterns: ["--upload-pack=id"] }),
    /invalid ref/,
  );
});

function npmTarball(name, version, files) {
  const dir = mkdtempSync(join(tmpdir(), "npm-src-"));
  const root = join(dir, "package");
  mkdirSync(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version, bin: { [name]: "cli.js" } }),
  );
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), body, { mode: 0o644 });
  }
  const out = join(mkdtempSync(join(tmpdir(), "npm-tar-")), "p.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, "package"]);
  return readFileSync(out);
}

async function fakeRegistry(name, versions) {
  const tarballs = {};
  let origin = "";
  const server = createServer((request, response) => {
    if (request.url === `/${name}`) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: Object.keys(versions).at(-1) },
          versions: Object.fromEntries(
            Object.keys(versions).map((version) => [
              version,
              {
                name,
                version,
                bin: { [name]: "cli.js" },
                dist: {
                  tarball: `${origin}/${name}/-/${name}-${version}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(tarballs[version]).digest("base64")}`,
                },
              },
            ]),
          ),
        }),
      );
      return;
    }
    const match = request.url.match(/-(\d+\.\d+\.\d+)\.tgz$/);
    if (match && tarballs[match[1]]) {
      response.end(tarballs[match[1]]);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  for (const [version, files] of Object.entries(versions))
    tarballs[version] = npmTarball(name, version, files);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, registry: `${origin}/` };
}

test("an npm package is read and its tool installed with the device's own npm settings", async () => {
  const cli = (label) => `#!/usr/bin/env node\nconsole.log("${label}");\n`;
  const { server, registry } = await fakeRegistry("devcli", {
    "1.0.0": {
      "cli.js": cli("v1"),
      "skills/devcli/SKILL.md": "---\nname: devcli\n---\n",
    },
    "1.1.0": {
      "cli.js": cli("v1.1"),
      "skills/devcli/SKILL.md": "---\nname: devcli\n---\nv2\n",
    },
  });
  // The device's npm settings name its registry; Foundry passes none.
  process.env.npm_config_registry = registry;
  try {
    const refs = await readRepositoryRefs({ remote: "npm:devcli" });
    assert.equal(refs.distTags.latest, "1.1.0");
    assert.deepEqual(refs.versions.sort(), ["1.0.0", "1.1.0"]);

    let uploaded;
    const fetched = await fetchSkillRepository(
      { remote: "npm:devcli", ref: "1.0.0", uploadPath: "/x" },
      async (body, type) => {
        uploaded = { body, type };
      },
    );
    assert.equal(fetched.commit, "1.0.0");
    assert.equal(uploaded.type, "application/gzip");
    const listing = execFileSync("tar", ["-tz"], {
      input: uploaded.body,
    }).toString();
    assert.match(listing, /package\/skills\/devcli\/SKILL\.md/);
    const latest = await fetchSkillRepository(
      { remote: "npm:devcli", uploadPath: "/x" },
      async () => {},
    );
    assert.equal(latest.commit, "1.1.0");

    await installTool({
      name: "devcli",
      version: "1.1.0",
      source: "npm",
      package: "devcli",
      registry: "device",
    });
    assert.equal(managedToolVersions().devcli, "1.1.0");
    await assert.rejects(
      installTool({
        name: "devcli",
        version: "1.0.0",
        source: "npm",
        package: "devcli",
        registry: "http://insecure.example",
      }),
      /must be an https address/,
    );
  } finally {
    delete process.env.npm_config_registry;
    server.close();
  }
});

test("a named registry also wins over the device's scoped registry", () => {
  assert.deepEqual(npmRegistryArgs("devcli", "device"), []);
  assert.deepEqual(
    npmRegistryArgs("@bytedance-dev/bytedcli", "https://bnpm.byted.org"),
    [
      "--registry",
      "https://bnpm.byted.org",
      "--@bytedance-dev:registry=https://bnpm.byted.org",
    ],
  );
  assert.throws(() => npmRegistryArgs("x", "https://u:p@r.example"), /https/);
});
