/**
 * Registrations that leave out what the server already has. A worker
 * registers every workspace it serves on each connection, and all of them
 * again when its agents' health changes; on a slow uplink that was tens of
 * kilobytes per workspace after every reconnect, the same each time.
 *
 * A registration has two sections that rarely change: "device" (the agent
 * profiles and provider health, the same in every registration) and
 * "workspace" (the workspace's assets, agents, files, chats and skills).
 * Each is named by a digest of its content. A section this process already
 * sent in full is left out; the server fills it in from what it kept, or,
 * when it does not have it (it restarted), answers registration_needed and
 * the registration goes again in full.
 */
import { createHash } from "node:crypto";

/** The registration fields each section stands for. */
export const registrationSectionFields = {
  device: ["agentProfiles", "providerHealth"],
  workspace: ["assets", "agents", "workspaceFiles", "chats", "skills"],
} as const;

/** What a registration says of its sections. */
export interface RegistrationSectionFields {
  sections: Record<string, string>;
  omittedSections?: string[];
}

/** Sections this process sent in full, as "name:digest". */
const sentInFull = new Set<string>();
const maxRemembered = 1024;

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 32);
}

/** The digest of each of the registration's sections, by name. */
export function sectionDigests(registration: object): Record<string, string> {
  const fields = registration as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(registrationSectionFields).map(([name, names]) => [
      name,
      digest(names.map((field) => fields[field] ?? null)),
    ]),
  );
}

/**
 * The registration whole, with its sections' digests, and, when some of its
 * sections were sent in full before, the registration without them.
 */
export function sectionedRegistration<T extends object>(
  registration: T,
): {
  whole: T & RegistrationSectionFields;
  slim?: Partial<T> & RegistrationSectionFields;
} {
  const sections = sectionDigests(registration);
  const whole = { ...registration, sections };
  const omitted = Object.keys(sections).filter((name) =>
    sentInFull.has(`${name}:${sections[name]}`),
  );
  if (omitted.length === 0) return { whole };
  const slim: Record<string, unknown> = { ...whole, omittedSections: omitted };
  for (const name of omitted)
    for (const field of registrationSectionFields[
      name as keyof typeof registrationSectionFields
    ])
      delete slim[field];
  return { whole, slim: slim as Partial<T> & RegistrationSectionFields };
}

/** The registration's sections went in full. */
export function sentSectionsInFull(sections: Record<string, string>): void {
  if (sentInFull.size > maxRemembered) sentInFull.clear();
  for (const [name, value] of Object.entries(sections))
    sentInFull.add(`${name}:${value}`);
}

/** Forgets what was sent (tests). */
export function forgetSentSections(): void {
  sentInFull.clear();
}
