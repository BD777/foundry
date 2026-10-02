import { extractPdfText, pdfTextDocument } from "../pdf-text.js";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveCodexCommand } from "../utils.js";
import type { HarnessAdapter } from "./harness.js";
import { codexDisabledFeatures } from "./policy.js";

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
    const auth = resolve(
      process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(auth)) copyFileSync(auth, resolve(config, "auth.json"));
    env.CODEX_HOME = config;
    const stage = codexStageConfig(
      policy.projectInstructions,
      Boolean(workspace),
    );
    writeFileSync(resolve(config, "config.toml"), stage.toml, { mode: 0o600 });
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
      config: stage.overrides,
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
    // The SDK would write an output schema to this process's temporary
    // directory, which the sandboxed CLI cannot read; the schema travels in
    // the prompt instead and the caller parses the answer as text.
    const prompt = `${spec.prompt.text}${await documentTexts(spec.prompt.documents ?? [])}`;
    const text = spec.responseSchema
      ? `${prompt}\n\nYour final message must be one JSON object matching this JSON Schema:\n${JSON.stringify(spec.responseSchema)}`
      : prompt;
    const result = await thread.run([{ type: "text", text }, ...images], {
      signal,
    });
    for (const item of result.items ?? [])
      if (item.type === "command_execution" && item.command)
        note(`shell: ${item.command}`);
    return { text: result.finalResponse, sessionId: thread.id ?? undefined };
  },
};

/**
 * Codex cannot read PDFs, so it gets their text, saying that layout and
 * images are missing and what that means for a judgment.
 */
export async function documentTexts(
  documents: { name: string; bytes: Buffer }[],
): Promise<string> {
  const sections: string[] = [];
  for (const document of documents) {
    let text: string;
    try {
      text = pdfTextDocument(
        document.name,
        await extractPdfText(document.bytes),
      );
    } catch (error) {
      text = `No text could be extracted from ${document.name} (${error instanceof Error ? error.message : String(error)}).`;
    }
    sections.push(
      `\n\n# Document ${document.name} (PDF given to you as extracted text only)\nYou cannot see this PDF's layout or images. Anything that depends on them is inconclusive, and say so in limitations.\n\n${text}`,
    );
  }
  return sections.join("");
}
