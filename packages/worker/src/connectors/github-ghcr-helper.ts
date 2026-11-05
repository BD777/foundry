// Docker's native credential-helper protocol. stdout is exclusively the reply
// to Docker; secrets are never command arguments, logs, or Foundry RPC payloads.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);

export async function ghcrCredential(
  gh: string,
  action: string,
  input: string,
): Promise<string> {
  if (
    action !== "get" ||
    !["ghcr.io", "https://ghcr.io"].includes(input.trim())
  )
    throw new Error("Only reading GHCR credentials is supported.");
  const options = {
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  };
  const { stdout: identity } = await execute(
    gh,
    ["api", "--hostname", "github.com", "user", "--jq", ".login"],
    options,
  );
  if (!/^[a-zA-Z0-9-]+$/.test(identity.trim()))
    throw new Error("GitHub identity unavailable.");
  const { stdout: token } = await execute(
    gh,
    ["auth", "token", "--hostname", "github.com"],
    options,
  );
  if (!token.trim()) throw new Error("GitHub credential unavailable.");
  return JSON.stringify({ Username: identity.trim(), Secret: token.trim() });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) process.exit(1);
  }
  try {
    process.stdout.write(
      await ghcrCredential(process.argv[2] ?? "", process.argv[3] ?? "", input),
    );
  } catch {
    process.stderr.write(
      "GHCR credential unavailable; check the GitHub connector in Foundry.\n",
    );
    process.exitCode = 1;
  }
}
