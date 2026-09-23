#!/usr/bin/env node

const baseUrl = (
  process.env.FOUNDRY_API_BASE_URL ?? "http://127.0.0.1:31982"
).replace(/\/$/, "");
const webOrigin = process.env.FOUNDRY_WEB_ORIGIN ?? "http://127.0.0.1:31983";
let sessionHeaders;

// Every browser API needs an account: log in once with FOUNDRY_USERNAME and
// FOUNDRY_PASSWORD (create one with `foundry-server users create`).
async function login() {
  const username = process.env.FOUNDRY_USERNAME?.trim();
  const password = process.env.FOUNDRY_PASSWORD;
  if (!username || !password)
    throw new Error(
      "set FOUNDRY_USERNAME and FOUNDRY_PASSWORD for an account on this server",
    );
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: webOrigin },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `login returned ${response.status}: ${await response.text()}`,
    );
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { Cookie: cookie, Origin: webOrigin };
}

async function getJSON(path) {
  if (path.startsWith("/api/") && !sessionHeaders)
    sessionHeaders = await login();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: path.startsWith("/api/") ? sessionHeaders : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${path} returned non-JSON body with status ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return body;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
}

const health = await getJSON("/healthz");
if (health.status !== "ok" || typeof health.startedAt !== "string") {
  throw new Error(
    "/healthz did not return the expected status/startedAt contract",
  );
}

const projection = await getJSON("/api/foundry-data");
if (!projection.workspace || typeof projection.workspace !== "object") {
  throw new Error("/api/foundry-data must contain a workspace projection");
}
for (const field of [
  "workspaces",
  "devices",
  "providerHealth",
  "agentProfiles",
  "agents",
  "workspaceFiles",
  "agentSessions",
  "skills",
  "issues",
]) {
  requireArray(projection[field], `/api/foundry-data.${field}`);
}

const workspaces = await getJSON("/api/workspaces");
requireArray(workspaces, "/api/workspaces");

console.log(
  `API smoke passed at ${baseUrl}: health=ok, workspaces=${workspaces.length}, issues=${projection.issues.length}.`,
);
