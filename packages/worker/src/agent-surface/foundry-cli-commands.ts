/**
 * The `foundry` CLI's commands. Every command but `mcp` and `skill` calls one
 * Foundry tool on the server's MCP endpoint, the same tools sessions call:
 * `tool` names it, `positional` the argument the word after the verb fills,
 * `fixed` arguments it always sends and `flags` the arguments its flags set
 * (a flag with a `field` sets that field of an object argument).
 * The CLI dispatches by this table alone, and test/foundry-skill.test.mjs
 * checks every tool and argument it names against the tool catalog.
 */

export type FlagKind =
  /** The next word. */
  | "string"
  /** The next word, a positive whole number. */
  | "number"
  /** Present or not; takes no word. */
  | "boolean"
  /** The next word, split at commas; the flag may repeat. */
  | "list"
  /** The contents of the file the next word names. */
  | "file"
  /** The next word, parsed as JSON. */
  | "json"
  /** The contents of the file the next word names, parsed as JSON. */
  | "jsonFile";

export interface FlagSpec {
  argument: string;
  kind: FlagKind;
  /** A boolean flag that adds these values to a list argument instead. */
  adds?: string[];
  /** Sets this field of the object argument instead of the argument itself. */
  field?: string;
}

export interface ToolCommand {
  tool: string;
  positional?: string;
  fixed?: Record<string, unknown>;
  flags: Record<string, FlagSpec>;
}

/** A command the CLI runs itself, without a server. */
export interface LocalCommand {
  local: true;
  flags: Record<string, FlagSpec>;
}

const flag = (argument: string, kind: FlagKind = "string"): FlagSpec => ({
  argument,
  kind,
});
const ALIAS_FLAGS: Record<string, FlagSpec> = {
  "--kind": flag("providerKind"),
  "--provider": flag("providerId"),
  "--runtime": flag("runtime"),
  "--model": flag("model"),
};
const field = (
  argument: string,
  name: string,
  kind: FlagKind = "string",
): FlagSpec => ({ argument, field: name, kind });

/**
 * Flags every tool command accepts: the workspace a tool acts in (tools that
 * act on a named session or Issue ignore it).
 */
export const foundryCommonFlags: Record<string, FlagSpec> = {
  "--workspace": flag("workspaceId"),
};

/** Flags that choose where the CLI connects, not what a tool does. */
export const foundryConnectionFlags = ["--server"];

const maxBytes = { "--max-bytes": flag("maxBytes", "number") };
const prompt = {
  "--prompt": flag("prompt"),
  "--message": flag("prompt"),
  "--prompt-file": flag("prompt", "file"),
};

/** What creating or updating a model provider sets. */
const providerFields = {
  "--runtime": flag("runtime"),
  "--label": flag("label"),
  "--base-url": flag("baseUrl"),
  "--api-key-file": flag("apiKey", "file"),
  "--clear-api-key": flag("clearApiKey", "boolean"),
  "--model": flag("model"),
  "--models": flag("models", "list"),
  "--effort": flag("effort"),
  "--devices": flag("deviceIds", "list"),
};

/** A verb of "" is the command alone; "<name>" stands for a skill's name. */
export const foundryCommands: Record<
  string,
  Record<string, ToolCommand | LocalCommand>
> = {
  mcp: { "": { local: true, flags: {} } },
  service: {
    register: {
      tool: "register_service",
      flags: {
        "--workspace": flag("workspaceId"),
        "--target-workspace": flag("targetWorkspaceId"),
        "--name": flag("name"),
        "--port": flag("port", "number"),
        "--protocol": flag("protocol"),
        "--work-id": flag("workId"),
        "--registration-key": flag("registrationKey"),
      },
    },
  },
  work: {
    list: {
      tool: "list_session_work",
      flags: {
        "--session": flag("sessionId"),
        "--workspace": flag("workspaceId"),
        "--item-session": flag("itemSessionId"),
        "--status": flag("status", "list"),
        "--detail": flag("detail", "boolean"),
        "--offset": flag("offset", "number"),
        "--limit": flag("limit", "number"),
        "--cursor": flag("cursor"),
      },
    },
    show: {
      tool: "list_session_work",
      flags: {
        "--session": flag("sessionId"),
        "--workspace": flag("workspaceId"),
        "--id": flag("id"),
      },
    },
    control: {
      tool: "control_session_work",
      flags: {
        "--session": flag("sessionId"),
        "--id": flag("id"),
        "--action": flag("action"),
        "--revision": flag("expectedRevision", "number"),
        "--reference-revision": flag("expectedReferenceRevision", "number"),
        "--related-session": flag("relatedSessionId"),
        "--key": flag("idempotencyKey"),
      },
    },
    schedule: {
      tool: "create_scheduled_work",
      flags: {
        "--session": flag("sessionId"),
        "--title": flag("title"),
        "--spec": flag("spec", "json"),
        "--key": flag("idempotencyKey"),
        "--kind": flag("kind"),
      },
    },
  },
  session: {
    list: {
      tool: "list_sessions",
      flags: {
        "--parent-only": flag("parentOnly", "boolean"),
        "--parent": flag("parentSessionId"),
        "--limit": flag("limit", "number"),
        "--cursor": flag("cursor"),
      },
    },
    children: {
      tool: "list_sessions",
      positional: "parentSessionId",
      flags: { "--limit": flag("limit", "number"), "--cursor": flag("cursor") },
    },
    get: { tool: "get_session", positional: "sessionId", flags: {} },
    events: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "events" },
      flags: {
        "--errors": {
          argument: "levels",
          kind: "boolean",
          adds: ["error", "warning"],
        },
        "--level": flag("levels", "list"),
        "--label": flag("labels", "list"),
        "--query": flag("query"),
        "--tail": flag("tail", "number"),
        "--limit": flag("limit", "number"),
        "--context": flag("context", "number"),
        "--after": flag("after"),
        "--before": flag("before"),
        ...maxBytes,
      },
    },
    thread: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "thread" },
      flags: maxBytes,
    },
    chat: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "transcript" },
      flags: maxBytes,
    },
    subagents: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "subagents" },
      flags: { "--task": flag("taskId"), ...maxBytes },
    },
    changes: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "changes" },
      flags: {
        "--path": flag("path"),
        "--input": flag("inputId"),
        ...maxBytes,
      },
    },
    file: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "file" },
      flags: { "--path": flag("path"), ...maxBytes },
    },
    background: {
      tool: "read_context",
      positional: "sessionId",
      fixed: { scope: "background" },
      flags: { "--task": flag("taskId"), ...maxBytes },
    },
    create: {
      tool: "create_session",
      flags: {
        ...prompt,
        "--profile": flag("profileId"),
        "--provider": flag("provider"),
        "--model": flag("model"),
        "--worker-group": flag("workerGroupId"),
        "--context": flag("importedContext"),
        "--issue": flag("issueId"),
        "--fork": flag("forkSessionId"),
        "--verification": flag("verification", "boolean"),
        "--claude-effort": flag("claudeEffort"),
        "--claude-permission-mode": flag("claudePermissionMode"),
        "--codex-reasoning-effort": flag("codexReasoningEffort"),
        "--codex-sandbox-mode": flag("codexSandboxMode"),
        "--codex-approval-policy": flag("codexApprovalPolicy"),
        "--codex-speed": flag("codexSpeed"),
      },
    },
    send: {
      tool: "send_message",
      positional: "sessionId",
      flags: {
        ...prompt,
        "--delivery": flag("delivery"),
        "--input-id": flag("inputId"),
        "--profile": flag("profileId"),
        "--provider": flag("provider"),
        "--model": flag("model"),
      },
    },
    cancel: { tool: "cancel_session", positional: "sessionId", flags: {} },
    rename: {
      tool: "rename_session",
      positional: "sessionId",
      flags: { "--title": flag("title") },
    },
    archive: {
      tool: "archive_session",
      positional: "sessionId",
      flags: {
        "--workspace": flag("workspaceId"),
        "--sessions": flag("sessionIds", "list"),
        "--group": flag("groupId"),
        "--restore": flag("restore", "boolean"),
      },
    },
    group: { tool: "list_group_sessions", positional: "groupId", flags: {} },
  },
  issue: {
    list: {
      tool: "list_issues",
      flags: { "--status": flag("status", "list") },
    },
    get: { tool: "get_issue", positional: "issueId", flags: {} },
  },
  feishu: {
    subscribe: {
      tool: "feishu_events",
      flags: {
        "--app": flag("appId"),
        "--type": flag("eventTypes", "list"),
        "--chat": flag("chatId"),
        "--timeout-ms": flag("timeoutMs", "number"),
      },
    },
    events: {
      tool: "feishu_events",
      positional: "subscriptionId",
      flags: {
        "--cursor": flag("cursor", "number"),
        "--max": flag("maxEvents", "number"),
        "--timeout-ms": flag("timeoutMs", "number"),
        "--unsubscribe": flag("unsubscribe", "boolean"),
      },
    },
  },
  workspace: {
    "refresh-skills": { tool: "refresh_workspace_skills", flags: {} },
    list: { tool: "list_workspaces", flags: {} },
    find: {
      tool: "find_workspace",
      positional: "query",
      flags: { "--limit": flag("limit", "number") },
    },
    get: {
      tool: "get_workspace",
      positional: "workspaceId",
      flags: { "--include": flag("include", "list") },
    },
    create: {
      tool: "create_workspace",
      flags: {
        "--name": flag("name"),
        "--purpose": flag("purpose"),
        "--source": field("source", "kind"),
        "--url": field("source", "url"),
        "--path": field("source", "path"),
        "--skill": flag("skills", "list"),
        "--device": flag("deviceId"),
      },
    },
    update: {
      tool: "update_workspace",
      positional: "workspaceId",
      flags: {
        "--name": flag("name"),
        "--purpose": flag("purpose"),
        "--add-skill": field("skills", "add", "list"),
        "--remove-skill": field("skills", "remove", "list"),
        "--add-connector": field("connectors", "add", "list"),
        "--remove-connector": field("connectors", "remove", "list"),
      },
    },
    archive: {
      tool: "archive_workspace",
      positional: "workspaceId",
      flags: { "--restore": flag("restore", "boolean") },
    },
  },
  assistant: {
    "remove-device": {
      tool: "remove_device",
      positional: "deviceId",
      flags: { "--note": flag("note") },
    },
    knowledge: {
      tool: "read_knowledge",
      positional: "publicationId",
      flags: {
        "--entry": flag("entryId"),
        "--after-entry": flag("afterEntryId"),
        "--query": flag("query"),
        "--sources": flag("listSources", "boolean"),
      },
    },
    dispatch: {
      tool: "dispatch_item",
      positional: "itemId",
      flags: {
        "--intent-revision": flag("intentRevision", "number"),
        "--step": flag("stepKey"),
        "--workspace": flag("workspaceId"),
        "--session": flag("sessionId"),
        "--replace-owner": flag("replaceOwner", "boolean"),
        ...prompt,
      },
    },
    "cancel-dispatch": {
      tool: "cancel_item_dispatch",
      positional: "operationId",
      flags: { "--revision": flag("revision", "number") },
    },
    remember: {
      tool: "remember",
      positional: "op",
      flags: {
        "--id": field("item", "id"),
        "--content": field("item", "content"),
        "--quote": field("item", "quote"),
        "--inferred": field("item", "inferred", "boolean"),
        "--intent-key": field("item", "intentKey"),
        "--title": field("item", "title"),
        "--vault": field("item", "vaultId"),
        "--revision": field("item", "expectedRevision", "number"),
        "--hash": field("item", "expectedHash"),
        "--expires": field("item", "expiresAt"),
      },
    },
    rule: {
      tool: "update_rules",
      flags: {
        "--action": field("change", "action"),
        "--decision": field("change", "decision"),
      },
    },
    "needs-you": {
      tool: "needs_you",
      positional: "op",
      flags: {
        "--item": flag("itemId"),
        "--session": flag("sessionId"),
        "--note": flag("note"),
      },
    },
    tasks: {
      tool: "list_tasks",
      flags: { "--status": flag("status", "list") },
    },
    item: {
      tool: "update_list",
      positional: "op",
      flags: {
        "--id": field("item", "id"),
        "--revision": field("item", "revision", "number"),
        "--intent-key": field("item", "intentKey"),
        "--plan": field("item", "plan", "json"),
        "--plan-file": field("item", "plan", "jsonFile"),
        "--text": field("item", "text"),
        "--when": field("item", "when"),
        "--at": field("item", "at"),
        "--remind": field("item", "remind", "boolean"),
        "--status": field("item", "status"),
        "--task": field("item", "taskId"),
        "--quote": field("item", "quote"),
      },
    },
    list: {
      tool: "read_list",
      flags: { "--closed-since": flag("closedSince") },
    },
    memory: {
      tool: "read_memory",
      flags: {
        "--query": flag("query"),
        "--offset": flag("offset", "number"),
        "--limit": flag("limit", "number"),
      },
    },
    computers: { tool: "list_computers", flags: {} },
  },
  device: {
    list: {
      tool: "list_resources",
      flags: {
        "--type": flag("type"),
        "--device": flag("deviceId"),
      },
    },
    "update-worker": {
      tool: "update_worker",
      positional: "deviceId",
      flags: { "--action": flag("action") },
    },
  },
  resource: {
    acquire: {
      tool: "acquire_resource",
      flags: {
        "--resource": flag("resourceIds", "list"),
        "--type": flag("type"),
        "--device": flag("deviceId"),
        "--reason": flag("reason"),
        "--wait-ms": flag("waitMs", "number"),
        "--hold-for": flag("holdFor", "number"),
      },
    },
    operate: {
      tool: "operate_resource",
      positional: "leaseId",
      flags: {
        "--op": flag("op"),
        "--args": flag("args", "json"),
        "--args-file": flag("args", "jsonFile"),
        "--actions": flag("actions", "json"),
        "--screenshot-after": flag("screenshotAfter", "boolean"),
      },
    },
    release: { tool: "release_resource", positional: "leaseId", flags: {} },
    status: {
      tool: "resource_status",
      flags: { "--resource": flag("resourceId"), "--lease": flag("leaseId") },
    },
  },
  profile: {
    list: {
      tool: "list_profiles",
      flags: { "--runtime": flag("runtime"), "--device": flag("deviceId") },
    },
  },
  // Model providers. A key is read from a file, never taken on the command
  // line, where other processes could see it.
  provider: {
    list: {
      tool: "list_model_providers",
      flags: {
        "--kind": flag("kind"),
        "--runtime": flag("runtime"),
        "--device": flag("deviceId"),
        "--provider": flag("providerId"),
        "--offset": flag("offset", "number"),
        "--limit": flag("limit", "number"),
      },
    },
    create: { tool: "save_model_provider", flags: providerFields },
    update: {
      tool: "save_model_provider",
      positional: "providerId",
      flags: providerFields,
    },
    delete: {
      tool: "delete_model_provider",
      positional: "providerId",
      flags: {},
    },
    check: {
      tool: "check_model_provider",
      positional: "providerId",
      flags: { "--device": flag("deviceId") },
    },
    defaults: {
      tool: "set_model_defaults",
      positional: "providerId",
      flags: {
        "--device": flag("deviceId"),
        "--model": flag("model"),
        "--effort": flag("effort"),
      },
    },
    "sign-in": {
      tool: "sign_in_subscription",
      positional: "action",
      flags: {
        "--device": flag("deviceId"),
        "--runtime": flag("runtime"),
        "--operation": flag("operationId"),
        "--code": flag("code"),
      },
    },
    "execution-default": {
      tool: "get_execution_default",
      flags: { "--workspace": flag("workspaceId") },
    },
  },
  model: {
    list: {
      tool: "list_models",
      flags: {
        "--profile": flag("profileId"),
        "--device": flag("deviceId"),
        "--query": flag("query"),
        "--offset": flag("offset", "number"),
        "--limit": flag("limit", "number"),
      },
    },
  },
  connector: {
    instances: {
      tool: "connector_instances",
      positional: "action",
      flags: {
        "--kind": flag("kind"),
        "--instance": flag("instanceId"),
        "--workspace": flag("workspaceId"),
        "--label": flag("label"),
        "--network": flag("network"),
        "--probe-device": flag("probeDeviceId"),
        "--fields": flag("fields", "json"),
        "--secret-files": flag("secretFiles", "json"),
      },
    },
    packages: {
      tool: "connector_packages",
      positional: "action",
      flags: {
        "--kind": flag("kind"),
        "--devices": flag("deviceIds", "list"),
        "--add-devices": flag("addDevices", "list"),
        "--remove-devices": flag("removeDevices", "list"),
      },
    },
  },
  // Model guides: what to know before handing work to a model.
  "model-guides": {
    list: { tool: "model_guides", fixed: { action: "list" }, flags: {} },
    get: {
      tool: "model_guides",
      positional: "id",
      fixed: { action: "get" },
      flags: {
        "--revision": flag("revision", "number"),
        "--offset": flag("offset", "number"),
        "--limit": flag("limit", "number"),
      },
    },
    resolve: {
      tool: "model_guides",
      fixed: { action: "resolve" },
      flags: ALIAS_FLAGS,
    },
    upsert: {
      tool: "model_guides",
      positional: "id",
      fixed: { action: "upsert" },
      flags: {
        "--change": flag("changeSummary"),
        "--name": flag("displayName"),
        "--owner": flag("owner"),
        "--family": flag("family"),
        "--aliases": flag("aliases", "json"),
        "--sections": flag("sections", "json"),
        "--sections-file": flag("sections", "jsonFile"),
        "--summary": field("sections", "summary"),
        "--strengths": field("sections", "strengths"),
        "--weaknesses": field("sections", "weaknesses"),
        "--briefing": field("sections", "briefing"),
        "--avoid": field("sections", "avoid"),
        "--pitfalls": field("sections", "pitfalls"),
        "--settings": field("sections", "settings"),
      },
    },
    "add-alias": {
      tool: "model_guides",
      positional: "id",
      fixed: { action: "add_alias" },
      flags: { ...ALIAS_FLAGS, "--change": flag("changeSummary") },
    },
    "remove-alias": {
      tool: "model_guides",
      positional: "id",
      fixed: { action: "remove_alias" },
      flags: { ...ALIAS_FLAGS, "--change": flag("changeSummary") },
    },
    observe: {
      tool: "model_guides",
      positional: "id",
      fixed: { action: "observe" },
      flags: {
        "--body": flag("body"),
        "--body-file": flag("body", "file"),
        "--sessions": flag("sessionIds", "list"),
      },
    },
  },
  "edge-access": {
    list: { tool: "edge_access", fixed: { action: "list" }, flags: {} },
    create: {
      tool: "edge_access",
      fixed: { action: "create" },
      flags: {
        "--label": flag("label"),
        "--provider": flag("provider"),
        "--team": flag("team"),
        "--audience": flag("audience"),
        "--host": field("match", "host"),
        "--path-prefix": field("match", "pathPrefix"),
        "--secret-files": flag("secretFiles", "json"),
      },
    },
    replace: {
      tool: "edge_access",
      positional: "id",
      fixed: { action: "replace" },
      flags: {
        "--label": flag("label"),
        "--provider": flag("provider"),
        "--team": flag("team"),
        "--audience": flag("audience"),
        "--host": field("match", "host"),
        "--path-prefix": field("match", "pathPrefix"),
        "--secret-files": flag("secretFiles", "json"),
      },
    },
    delete: {
      tool: "edge_access",
      positional: "id",
      fixed: { action: "delete" },
      flags: {},
    },
    provision: {
      tool: "edge_access",
      fixed: { action: "provision" },
      flags: { "--required": flag("edgeAccessRequired", "json") },
    },
  },
  library: {
    source: {
      tool: "set_skill_repository_source",
      positional: "repositoryId",
      flags: {
        "--device": flag("deviceId"),
        "--registry": flag("registry"),
      },
    },
  },
  skill: {
    "": { local: true, flags: {} },
    list: { local: true, flags: {} },
    install: { local: true, flags: { "--dir": flag("dir") } },
    "<name>": { local: true, flags: {} },
  },
};

export function isToolCommand(
  command: ToolCommand | LocalCommand,
): command is ToolCommand {
  return "tool" in command;
}
