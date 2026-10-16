import { serveExecutionHost } from "./server.js";
const serverURL = process.argv[2];
// The role selects the app's launcher, never the programs agents start.
for (const name of [
  "FOUNDRY_SERVICE_ROLE",
  "FOUNDRY_EXECUTION_NODE",
  "FOUNDRY_EXECUTION_ENTRY",
  "FOUNDRY_EXECUTION_SERVER",
])
  delete process.env[name];
if (!serverURL)
  throw new Error("Execution host requires its paired server URL");
await serveExecutionHost(serverURL);
