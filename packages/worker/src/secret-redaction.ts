/**
 * Conservative baseline removal of credentials and authentication tokens
 * from text. Returns the input unchanged when nothing matched.
 */
export function redactSecrets(text: string): string {
  return text
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
}

/**
 * Whether redactSecrets can match across this whole line: it holds only
 * whitespace and what may stand between a secret's name and its value. A
 * secret named on an earlier line can reach past such lines, so text
 * redacted in pieces starts each piece at the last line before it that is
 * not one.
 */
export function secretSeparatorLine(line: string): boolean {
  return /^[\s"':=]*$/.test(line);
}
