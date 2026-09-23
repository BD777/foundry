import { connect } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function repositoryTool(args: string[]): Promise<unknown> {
  const endpoint = process.env.FOUNDRY_REPOSITORY_SOCKET;
  if (!endpoint)
    throw new Error("Repository tools are available inside an Issue executor");
  if (args[0] !== "list" && args[0] !== "prepare")
    throw new Error("Usage: repository-tool list | prepare <repository-id>");
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let response = "";
    socket.setTimeout(30_000, () =>
      socket.destroy(new Error("Repository broker timed out")),
    );
    socket.on("connect", () =>
      socket.end(
        JSON.stringify({
          action: args[0],
          repoId: args[1],
          token: process.env.FOUNDRY_REPOSITORY_TOKEN,
        }),
      ),
    );
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const value = JSON.parse(response);
        if (value.error) reject(new Error(value.error));
        else resolve(value);
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  repositoryTool(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(String(error));
      process.exitCode = 1;
    },
  );
}
