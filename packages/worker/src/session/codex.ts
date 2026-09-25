import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveCodexCommand } from "../utils.js";
import type { HarnessAdapter } from "./harness.js";
import { codexDisabledFeatures } from "./policy.js";

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
    const auth = resolve(
      process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(auth)) copyFileSync(auth, resolve(config, "auth.json"));
    env.CODEX_HOME = config;
    const features = codexDisabledFeatures(Boolean(workspace));
    const projectDocBytes = policy.projectInstructions ? 32768 : 0;
    writeFileSync(
      resolve(config, "config.toml"),
      `project_doc_max_bytes = ${projectDocBytes}\n[features]\n` +
        Object.keys(features)
          .map((key) => `${key} = false`)
          .join("\n") +
        "\n",
      { mode: 0o600 },
    );
    const sdkName = "@openai/codex-sdk";
    const sdk = (await import(sdkName)) as {
      Codex: new (options: Record<string, unknown>) => {
        startThread: (options: Record<string, unknown>) => {
          id?: string | null;
          run: (
            input: unknown,
            options: Record<string, unknown>,
          ) => Promise<{
            finalResponse: string;
            items?: { type: string; command?: string; text?: string }[];
          }>;
        };
      };
    };
    const codex = new sdk.Codex({
      codexPathOverride: sandboxedExecutable(resolveCodexCommand()),
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      env,
      config: {
        project_doc_max_bytes: projectDocBytes,
        features,
        mcp_servers: {},
      },
    });
    const thread = codex.startThread({
      workingDirectory: workspace?.path ?? home,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      model: spec.model || profile.model,
    });
    const images = spec.prompt.images.map((image, index) => {
      const path = resolve(home, `image-${index}.bin`);
      writeFileSync(path, image.bytes, { mode: 0o400 });
      return { type: "local_image", path };
    });
    const result = await thread.run(
      [{ type: "text", text: spec.prompt.text }, ...images],
      {
        signal,
        ...(spec.responseSchema ? { outputSchema: spec.responseSchema } : {}),
      },
    );
    for (const item of result.items ?? [])
      if (item.type === "command_execution" && item.command)
        note(`shell: ${item.command}`);
    return { text: result.finalResponse, sessionId: thread.id ?? undefined };
  },
};
