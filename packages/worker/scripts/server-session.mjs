// Verification harnesses start a real foundry-server, which always requires
// an account. This creates a throwaway owner through the server's own CLI and
// returns the headers that authenticate browser-API calls as that owner.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export async function loginTestOwner({ executable, env, base, origin }) {
  const username = "verify-owner";
  const password = randomBytes(18).toString("base64url");
  execFileSync(
    executable,
    [
      "users",
      "create",
      "--username",
      username,
      "--role",
      "admin",
      "--password-stdin",
    ],
    { env, input: `${password}\n`, stdio: ["pipe", "pipe", "pipe"] },
  );
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok)
    throw new Error(
      `test owner login failed: ${response.status} ${await response.text()}`,
    );
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { Cookie: cookie, Origin: origin };
}

// Pairs a synthetic worker device owned by the test owner and returns the
// header that authenticates daemon routes and the daemon WebSocket.
export async function pairTestDevice({ executable, env, base, deviceId }) {
  const token = execFileSync(
    executable,
    ["devices", "pairing-token", "--username", "verify-owner"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const response = await fetch(`${base}/api/daemon/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      machineFingerprint: `verify-${deviceId}`,
      deviceId,
    }),
  });
  if (!response.ok)
    throw new Error(
      `test device pairing failed: ${response.status} ${await response.text()}`,
    );
  const paired = await response.json();
  if (paired.deviceId !== deviceId)
    throw new Error(
      `test device paired as ${paired.deviceId}, not ${deviceId}`,
    );
  return { "X-Foundry-Device-Credential": paired.credential };
}
