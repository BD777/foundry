/** Opaque process-local versions for private configuration, never secret hashes. */
import { randomUUID } from "node:crypto";

const versions = new Map<string, string>();

export function privateConfigurationVersion(input: unknown): string {
  const privateInput = JSON.stringify(input);
  let version = versions.get(privateInput);
  if (!version) {
    version = randomUUID();
    if (versions.size >= 4096) versions.delete(versions.keys().next().value!);
    versions.set(privateInput, version);
  }
  return version;
}
