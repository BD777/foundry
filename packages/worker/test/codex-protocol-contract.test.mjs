// Checks the installed Codex's app-server protocol against every method and
// notification Foundry uses. Offline and model-free: the schema comes from
// `codex app-server generate-json-schema`, which only writes files. Skipped
// when the device has no Codex (FOUNDRY_CODEX_BIN, or the runtime Foundry
// installed: ~/.foundry-tools/agent-runtimes/codex/current.json).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Client requests Foundry sends (worker src: request("…")). */
const clientRequests = [
  "initialize",
  "account/read",
  "account/login/start",
  "account/rateLimits/read",
  "model/list",
  "skills/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "thread/archive",
  "thread/unarchive",
  "thread/inject_items",
  "thread/compact/start",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/queue/list",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];
/** Of those, the ones Codex serves only to clients opting into experimentalApi. */
const experimentalRequests = [
  "thread/queue/list",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
];
/** Notifications Foundry reads. */
const serverNotifications = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/queue/changed",
  "serverRequest/resolved",
];
/** Requests Codex sends that Foundry answers (codex-questions.ts). */
const serverRequests = [
  "account/chatgptAuthTokens/refresh",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
];
/** The values of the responses Foundry sends them, by response schema. */
const responseValues = {
  CommandExecutionRequestApprovalResponse: [
    "CommandExecutionApprovalDecision",
    ["accept", "decline"],
  ],
  FileChangeRequestApprovalResponse: [
    "FileChangeApprovalDecision",
    ["accept", "decline"],
  ],
  McpServerElicitationRequestResponse: [
    "McpServerElicitationAction",
    ["accept", "decline"],
  ],
  PermissionsRequestApprovalResponse: ["PermissionGrantScope", ["turn"]],
};
const contract = JSON.parse(
  readFileSync(
    new URL("../../protocol/src/contract-schema.json", import.meta.url),
    "utf8",
  ),
);
const contractEnum = (name) =>
  (contract.$defs ?? contract.definitions ?? contract.components?.schemas)?.[
    name
  ]?.enum ?? [];
/** The approval policies Foundry offers (contracts: CodexApprovalPolicy). */
const offeredApprovalPolicies = contractEnum("CodexApprovalPolicy");
/** The goal statuses a session goal carries (AgentSessionGoalStatus). */
const sessionGoalStatuses = contractEnum("AgentSessionGoalStatus");
/** Goal states that keep a thread's app-server (codexNativeActivityBusy). */
const goalStatuses = ["active"];

function installedCodex() {
  const configured = process.env.FOUNDRY_CODEX_BIN?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  // The test launcher points FOUNDRY_TOOLS_ROOT at scratch; the device's
  // runtime stays where the worker installed it, read-only here.
  const descriptor = join(
    homedir(),
    ".foundry-tools",
    "agent-runtimes",
    "codex",
    "current.json",
  );
  try {
    const { executable } = JSON.parse(readFileSync(descriptor, "utf8"));
    return typeof executable === "string" && existsSync(executable)
      ? executable
      : undefined;
  } catch {
    return undefined;
  }
}

function methods(dir, file) {
  const schema = JSON.parse(readFileSync(join(dir, `${file}.json`), "utf8"));
  return new Set(
    (schema.oneOf ?? schema.anyOf ?? [])
      .map(
        (variant) =>
          variant.properties?.method?.enum?.[0] ??
          variant.properties?.method?.const,
      )
      .filter(Boolean),
  );
}

function generate(codex, dir, experimental) {
  const result = spawnSync(
    codex,
    [
      "app-server",
      "generate-json-schema",
      ...(experimental ? ["--experimental"] : []),
      "--out",
      dir,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

const codex = installedCodex();

test("the contract names the approval policies and goal statuses checked below", () => {
  assert.deepEqual(offeredApprovalPolicies, [
    "untrusted",
    "on-request",
    "never",
  ]);
  assert.ok(sessionGoalStatuses.includes("paused"));
});

test(
  "the installed Codex app-server protocol has every method Foundry uses",
  { skip: codex ? false : "no Codex installed on this device" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "codex-schema-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stable = join(root, "stable");
    const experimental = join(root, "experimental");
    generate(codex, stable, false);
    generate(codex, experimental, true);
    const version = spawnSync(codex, ["--version"], {
      encoding: "utf8",
    }).stdout?.trim();
    const missing = (have, want) => want.filter((name) => !have.has(name));

    const requests = methods(experimental, "ClientRequest");
    assert.deepEqual(
      missing(requests, clientRequests),
      [],
      `${version}: client requests`,
    );
    assert.deepEqual(
      missing(methods(experimental, "ServerNotification"), serverNotifications),
      [],
      `${version}: notifications`,
    );
    assert.deepEqual(
      missing(methods(experimental, "ServerRequest"), serverRequests),
      [],
      `${version}: server requests`,
    );
    assert.ok(
      methods(experimental, "ClientNotification").has("initialized"),
      `${version}: initialized`,
    );
    for (const [file, [definition, values]] of Object.entries(responseValues)) {
      const schema = JSON.parse(
        readFileSync(join(experimental, `${file}.json`), "utf8"),
      ).definitions?.[definition];
      const known = [
        ...(schema?.enum ?? []),
        ...(schema?.oneOf ?? []).flatMap((variant) => variant.enum ?? []),
      ];
      assert.deepEqual(
        values.filter((value) => !known.includes(value)),
        [],
        `${version}: ${definition}`,
      );
    }
    const userInput = JSON.parse(
      readFileSync(
        join(experimental, "ToolRequestUserInputResponse.json"),
        "utf8",
      ),
    );
    assert.deepEqual(userInput.required, ["answers"]);
    assert.deepEqual(
      userInput.definitions?.ToolRequestUserInputAnswer?.required,
      ["answers"],
      `${version}: requestUserInput answers`,
    );

    // Foundry's initialize opts into experimentalApi (codex-client.ts);
    // these are served only then, and the rest must not depend on it.
    const stableRequests = methods(stable, "ClientRequest");
    const needExperimental = clientRequests.filter(
      (name) => !stableRequests.has(name),
    );
    assert.deepEqual(
      needExperimental.filter((name) => !experimentalRequests.includes(name)),
      [],
      `${version}: requests newly experimental-only`,
    );
    const client = readFileSync(
      new URL("../src/harness/agent-runtime/codex-client.ts", import.meta.url),
      "utf8",
    );
    assert.match(client, /capabilities:\s*\{\s*experimentalApi:\s*true\s*\}/);

    const definitions = JSON.parse(
      readFileSync(
        join(experimental, "codex_app_server_protocol.v2.schemas.json"),
        "utf8",
      ),
    ).definitions;
    for (const status of goalStatuses)
      assert.ok(
        definitions.ThreadGoalStatus?.enum?.includes(status),
        `${version}: goal status ${status}`,
      );
    // Every goal status Codex reports is one the session goal carries.
    assert.deepEqual(
      (definitions.ThreadGoalStatus?.enum ?? []).filter(
        (status) => !sessionGoalStatuses.includes(status),
      ),
      [],
      `${version}: goal statuses Foundry does not show`,
    );
    // Every approval policy Foundry offers is one Codex accepts.
    const approvals = (definitions.AskForApproval?.oneOf ?? []).flatMap(
      (variant) => variant.enum ?? [],
    );
    assert.deepEqual(
      offeredApprovalPolicies.filter((policy) => !approvals.includes(policy)),
      [],
      `${version}: approval policies`,
    );
    assert.deepEqual(
      definitions.ThreadBackgroundTerminal?.required?.slice().sort(),
      ["command", "cwd", "itemId", "processId"],
      `${version}: background terminal identity`,
    );
  },
);
