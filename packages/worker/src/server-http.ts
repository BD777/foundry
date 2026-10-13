// HTTP requests from the worker to the Foundry server, with the device
// credential header. Depends on config only for that credential.

import { readDaemonConfig } from "./config.js";
import { errorMessage } from "./utils.js";

export const deviceCredentialHeader = "X-Foundry-Device-Credential";

export function daemonRequestHeaders(
  includeContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  const credential = readDaemonConfig()?.deviceCredential?.trim();
  if (credential) {
    headers[deviceCredentialHeader] = credential;
  }
  return headers;
}

export async function postJSON<T>(
  serverURL: string,
  path: string,
  body: unknown,
): Promise<T | undefined> {
  const response = await fetch(`${serverURL}${path}`, {
    method: "POST",
    headers: daemonRequestHeaders(true),
    body: JSON.stringify(body),
  });
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

export async function getJSON<T>(serverURL: string, path: string): Promise<T> {
  const response = await fetch(`${serverURL}${path}`, {
    headers: daemonRequestHeaders(false),
  });
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

export async function ensureServerReachable(serverURL: string): Promise<void> {
  const healthURL = new URL("/healthz", serverURL).toString();
  try {
    const response = await fetch(healthURL);
    if (!response.ok) {
      throw new Error(`health check returned ${response.status}`);
    }
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(
      `Foundry server is not reachable at ${serverURL}. Start the server first, then rerun setup. (${detail})`,
    );
  }
}
