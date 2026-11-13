#!/usr/bin/env node
// Fetch one file from a leased compute's scratch folder, many pieces at a time.
// Used by scripts/lib/remote-compute.sh (download); talks to the server's
// /api/mcp like the foundry CLI, with FOUNDRY_SERVER_URL and the lease's
// FOUNDRY_LEASE_TOKEN (or FOUNDRY_SESSION_TOKEN).
//
//   node remote-fetch.mjs <leaseId> <scratch> <path on the device> <local file>
//
// A server that cuts tool results to a model's text budget answers only small
// pieces whole; the first piece shows which kind this server is, and the rest
// are fetched in parallel at the size that fits.
import { closeSync, openSync, writeSync } from "node:fs";

const [lease, scratch, path, out] = process.argv.slice(2);
const server = process.env.FOUNDRY_SERVER_URL;
const token =
  process.env.FOUNDRY_LEASE_TOKEN || process.env.FOUNDRY_SESSION_TOKEN;
if (!lease || !scratch || !path || !out) {
  console.error(
    "usage: remote-fetch.mjs <leaseId> <scratch> <path> <local file>",
  );
  process.exit(2);
}
if (!server || !token) {
  console.error(
    "remote-fetch: needs FOUNDRY_SERVER_URL and FOUNDRY_LEASE_TOKEN",
  );
  process.exit(2);
}
const large = 4 * 1024 * 1024;
const small = 7000;
const probeSizes = [
  large,
  1024 * 1024,
  256 * 1024,
  64 * 1024,
  16 * 1024,
  small,
];
const parallel = Number(process.env.REMOTE_FETCH_PARALLEL || 12);
let calls = 0;

class Cut extends Error {}
class Retryable extends Error {}

function retryable(message) {
  return /device did not answer a ping|device_error|client_connection|unavailable|temporar|timed? out|ECONNRESET/i.test(
    String(message),
  );
}

async function piece(offset, length) {
  for (let attempt = 1; ; attempt++) {
    try {
      calls++;
      const response = await fetch(new URL("/api/mcp", server), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: calls,
          method: "tools/call",
          params: {
            name: "operate_resource",
            arguments: {
              leaseId: lease,
              op: "get_file",
              args: { scratch, path, offset, length },
            },
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const reply = await response.json();
      if (reply.error) throw new Error(reply.error.message);
      const text = reply.result?.content?.[0]?.text ?? "";
      let outer;
      try {
        outer = JSON.parse(text);
      } catch (error) {
        if (retryable(text) || retryable(error))
          throw new Retryable(text.slice(0, 300));
        throw new Cut("cut");
      }
      const result = outer.results?.[0];
      if (
        (result && !result.ok && retryable(JSON.stringify(result))) ||
        (!result && retryable(JSON.stringify(outer)))
      )
        throw new Retryable(JSON.stringify(result ?? outer).slice(0, 300));
      if (!result?.ok)
        throw new Error(
          `get_file failed: ${result?.errorCode}: ${result?.error}`,
        );
      let file;
      try {
        file = JSON.parse(result.text);
      } catch {
        throw new Cut("cut");
      }
      return { size: file.size, data: Buffer.from(file.data, "base64") };
    } catch (error) {
      const retries =
        error instanceof Cut || error instanceof Retryable
          ? Number(process.env.REMOTE_FETCH_RETRIES || 6)
          : 4;
      if (
        error instanceof Cut ||
        /get_file failed|stale_lease/.test(String(error)) ||
        attempt >= retries
      )
        throw error;
      await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
}

const started = Date.now();
let size;
let first;
let step = large;
try {
  for (const size of probeSizes) {
    try {
      first = await piece(0, size);
      step = size;
      break;
    } catch (error) {
      if (!(error instanceof Cut) || size === small) throw error;
    }
  }
} catch (error) {
  throw error;
}
size = first.size;
const fd = openSync(out, "w");
writeSync(fd, first.data, 0, first.data.length, 0);
const offsets = [];
for (let offset = first.data.length; offset < size; offset += step)
  offsets.push(offset);
let next = 0;
let done = first.data.length;
async function worker() {
  while (next < offsets.length) {
    const offset = offsets[next++];
    const { data } = await piece(offset, Math.min(step, size - offset));
    writeSync(fd, data, 0, data.length, offset);
    done += data.length;
  }
}
await Promise.all(
  Array.from({ length: step === large ? 2 : parallel }, worker),
);
closeSync(fd);
if (done !== size) {
  console.error(`remote-fetch: got ${done} of ${size} bytes`);
  process.exit(1);
}
const seconds = (Date.now() - started) / 1000;
console.error(
  `remote-fetch: ${size} bytes in ${seconds.toFixed(1)}s, ${calls} calls of ${step === large ? "4 MB" : `${small} bytes (the server cuts tool results; whole results need a server with command-token results)`}`,
);
