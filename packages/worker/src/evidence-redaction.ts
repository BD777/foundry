import type { Material } from "@foundry/protocol";
import { redactSecrets } from "./secret-redaction.js";

/** Conservative baseline policy; configured secret bindings are never materialized. */
export function redactEvidence(bytes: Buffer): {
  bytes: Buffer;
  redaction: Material["redaction"];
} {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    return { bytes, redaction: { status: "none" } };
  const redacted = redactSecrets(text);
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
