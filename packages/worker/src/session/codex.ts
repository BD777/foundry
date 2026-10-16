import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCodexCommand } from "../native-cli.js";
import { codexProfileConfig } from "../runner/codex-options.js";
import { codexTransportPlan } from "../runner/codex-transport.js";
import type { HarnessAdapter } from "./harness.js";
import {
  sandboxCredentialCopies,
  writeSandboxCredentials,
} from "./provider-credentials.js";
import { codexDisabledFeatures } from "./policy.js";
import { CodexAppServerThread } from "../runner/codex-app-server.js";

/**
 * The private Codex configuration of a stage session. Codex discovers skills
 * in its working directory, which for a verifier is the candidate: a
 * candidate could plant a skill telling the judge what to decide. Native
 * skill discovery is therefore off, as are MCP servers and the features no
 * read-only session may use.
 */
export function codexStageConfig(
  projectInstructions: boolean,
  hasDirectory: boolean,
): { toml: string; overrides: Record<string, unknown> } {
  const features = codexDisabledFeatures(hasDirectory);
  const projectDocBytes = projectInstructions ? 32768 : 0;
  return {
    toml:
      `project_doc_max_bytes = ${projectDocBytes}\n[features]\n` +
      Object.keys(features)
        .map((key) => `${key} = false`)
        .join("\n") +
      "\n[skills]\ninclude_instructions = false\n[skills.bundled]\nenabled = false\n",
    overrides: {
      project_doc_max_bytes: projectDocBytes,
      features,
      mcp_servers: {},
      skills: { include_instructions: false, bundled: { enabled: false } },
    },
  };
}

/**
 * Codex SDK session with a fresh private config. No skills or MCP
 * configuration is inherited; a session with a directory keeps Codex's
 * sandboxed read-only shell so it can actually look at the files.
 */
export const codexHarness: HarnessAdapter = {
  async run({
    spec,
    policy,
    profile,
    home,
    env,
    sandboxedExecutable,
    signal,
    note,
  }) {
    const workspace = spec.workspace;
    const config = resolve(home, "codex");
    mkdirSync(config, { mode: 0o700 });
    // The device's access token only (provider-credentials.ts).
    writeSandboxCredentials(sandboxCredentialCopies({ CODEX_HOME: config }));
    env.CODEX_HOME = config;
    // The read-only shell is how Codex looks at files: a directory, or the
    // PDFs it is given to read.
    const stage = codexStageConfig(
      policy.projectInstructions,
      Boolean(workspace) || Boolean(spec.prompt.documents?.length),
    );
    writeFileSync(
      resolve(config, "config.toml"),
      stage.toml +
        (workspace
          ? `\n[projects.${JSON.stringify(resolve(workspace.path))}]\ntrust_level = "untrusted"\n`
          : ""),
      { mode: 0o600 },
    );
    if (profile.connectionType !== "local_login" && env.OPENAI_API_KEY)
      env.CODEX_API_KEY = env.OPENAI_API_KEY;
    // A stage session learns nothing: it takes the WebSocket only where the
    // endpoint's transport is already known to allow it.
    const transport = codexTransportPlan(profile);
    const thread = new CodexAppServerThread(
      sandboxedExecutable(resolveCodexCommand()),
      env,
      {
        ...stage.overrides,
        developer_instructions: spec.systemPrompt,
        ...codexProfileConfig(
          {
            ...profile,
            codexTransport:
              transport.websockets && transport.learn !== "outcome"
                ? "websocket"
                : "https",
          },
          env,
        ),
      },
      {
        workingDirectory: workspace?.path ?? home,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        ephemeral: true,
        model: spec.model || profile.model,
      },
    );
    const images = spec.prompt.images.map((image, index) => {
      const path = resolve(home, `image-${index}.bin`);
      writeFileSync(path, image.bytes, { mode: 0o400 });
      return { type: "local_image", path };
    });
    // The SDK would write an output schema to this process's temporary
    // directory, which the sandboxed CLI cannot read; the schema travels in
    // the prompt instead and the caller parses the answer as text.
    // PDFs go as files Codex reads with its own tools, like any agent.
    const documents = (spec.prompt.documents ?? []).map((document, index) => {
      const path = resolve(home, `document-${index}.pdf`);
      writeFileSync(path, document.bytes, { mode: 0o400 });
      return `- ${document.name}: ${path}`;
    });
    const prompt = documents.length
      ? `${spec.prompt.text}\n\nPDF documents for this task (read them yourself):\n${documents.join("\n")}`
      : spec.prompt.text;
    const text = spec.responseSchema
      ? `${prompt}\n\nYour final message must be one JSON object matching this JSON Schema:\n${JSON.stringify(spec.responseSchema)}`
      : prompt;
    const { events } = await thread.runStreamed(
      [{ type: "text", text }, ...images],
      { signal },
    );
    let answer = "";
    let completed = false;
    for await (const value of events) {
      const event = value as {
        type: string;
        error?: { message?: string };
        item?: { type?: string; command?: string; text?: string };
      };
      if (event.type === "turn.failed")
        throw new Error(event.error?.message ?? "Codex verification failed.");
      if (event.type === "turn.completed") completed = true;
      if (event.type !== "item.completed") continue;
      if (event.item?.type === "command_execution" && event.item.command)
        note(`shell: ${event.item.command}`);
      if (event.item?.type === "agent_message") answer = event.item.text ?? "";
    }
    if (!completed)
      throw new Error("Codex verification ended without completing its turn.");
    return { text: answer, sessionId: thread.id ?? undefined };
  },
};
