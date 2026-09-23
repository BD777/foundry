import type { Material } from "@foundry/protocol";

/** Conservative baseline policy; configured secret bindings are never materialized. */
export function redactEvidence(bytes: Buffer): {
  bytes: Buffer;
  redaction: Material["redaction"];
} {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    return { bytes, redaction: { status: "none" } };
  const redacted = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:token|key|signature|password|secret)=)[^&\s"']*/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  return redacted === text
    ? { bytes, redaction: { status: "none" } }
    : {
        bytes: Buffer.from(redacted),
        redaction: {
          status: "applied",
          policyVersion: "foundry-secrets/v1",
          note: "Credentials and authentication tokens were removed before persistence and display. Redacted fields cannot support assertions.",
        },
      };
}
export function assertNonsecretDeclarations(
  values: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (
      /authorization|cookie|password|secret|api[_-]?key|(?:^|_)token(?:$|_)/i.test(
        name,
      ) ||
      redactEvidence(Buffer.from(value)).redaction.status === "applied"
    )
      throw new Error(
        "secret_binding_required: do not place credentials in public checker configuration",
      );
  }
}
