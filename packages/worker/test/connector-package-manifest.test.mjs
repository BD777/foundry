import assert from "node:assert/strict";
import test from "node:test";

const { parseExtensionManifest } =
  await import("../dist/connectors/extensions/manifest.js");

const packageSpec = {
  upstream: {
    via: "github",
    repository: "https://github.com/nwverse/open-lark",
    ref: "main",
  },
  skills: { path: "plugins/open-lark/skills" },
  tools: [
    {
      command: "olk",
      source: "repository",
      path: "plugins/open-lark",
      bins: { olk: "bin/olk", "olk-ctx": "bin/olk-ctx" },
    },
  ],
};

const manifest = (overrides = {}) => ({
  manifestVersion: 2,
  id: "open-lark",
  name: "OpenLark",
  version: "1.0.0",
  protocol: 1,
  connectors: [
    {
      kind: "openlark",
      label: "OpenLark",
      serverHeld: {
        instances: "one",
        fields: [
          { id: "baseUrl", type: "url", required: true, label: "Server" },
          { id: "token", type: "secret", required: true, label: "Token" },
        ],
        steps: [["baseUrl", "token"]],
        probe: [
          {
            id: "routes",
            method: "GET",
            path: "/",
            extract: {
              routes: {
                items: "/routes",
                method: "/method",
                path: "/path",
                access: "/access",
              },
            },
          },
        ],
        upstream: { baseField: "baseUrl", pathPrefix: "/", headers: {} },
        access: { from: "probe:routes", default: "deny", allow: ["read"] },
        session: { env: { OPEN_LARK_TOKEN: "{standIn}" } },
        network: { holdings: ["server", "device"], publicOnly: true },
      },
      tool: { command: "olk" },
      package: packageSpec,
    },
  ],
  ...overrides,
});

test("manifest v2 carries a package's upstream, Skills and repository tools", () => {
  const parsed = parseExtensionManifest(manifest());
  const connector = parsed.connectors[0];
  assert.equal(parsed.manifestVersion, 2);
  assert.equal(connector.tool.source, undefined);
  assert.equal(connector.package.upstream.via, "github");
  assert.equal(connector.package.skills.path, "plugins/open-lark/skills");
  assert.deepEqual(connector.package.tools[0].bins, {
    olk: "bin/olk",
    "olk-ctx": "bin/olk-ctx",
  });
});

test("manifest v1 remains readable, but package declarations require v2", () => {
  const v1 = manifest({ manifestVersion: 1 });
  delete v1.connectors[0].package;
  assert.equal(parseExtensionManifest(v1).manifestVersion, 1);
  assert.throws(
    () => parseExtensionManifest(manifest({ manifestVersion: 1 })),
    /package declarations require manifestVersion 2/,
  );
});

test("package paths, bins and the repository-reading connector are checked", () => {
  const mutate = (change) => {
    const value = structuredClone(manifest());
    change(value.connectors[0].package);
    return value;
  };
  assert.throws(
    () =>
      parseExtensionManifest(
        mutate((pkg) => {
          pkg.upstream.via = "git";
        }),
      ),
    /via must name a connector that can read repositories/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        mutate((pkg) => {
          pkg.skills.path = "../skills";
        }),
      ),
    /package.skills.path is a relative folder/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        mutate((pkg) => {
          pkg.tools[0].bins.olk = "../../bin/olk";
        }),
      ),
    /bin olk is a relative folder/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        mutate((pkg) => {
          delete pkg.tools[0].bins.olk;
        }),
      ),
    /bins includes the command/,
  );
});
