import { serveExecutionHost } from "./server.js";
const serverURL = process.argv[2];
if (!serverURL)
  throw new Error("Execution host requires its paired server URL");
await serveExecutionHost(serverURL);
