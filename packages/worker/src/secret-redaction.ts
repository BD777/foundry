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

/**
 * Secrets whose exact values this worker knows (session tokens it was
 * handed, the device credential): redacted wherever they appear, whatever
 * their shape. Short values are never registered; they would match ordinary
 * text. The oldest are forgotten past a bound.
 */
const knownSecrets = new Set<string>();
const knownSecretLimit = 2000;
const knownSecretMinLength = 16;

export function registerKnownSecret(value: string | undefined): void {
  const secret = value?.trim();
  if (!secret || secret.length < knownSecretMinLength) return;
  knownSecrets.delete(secret);
  knownSecrets.add(secret);
  if (knownSecrets.size > knownSecretLimit)
    knownSecrets.delete(knownSecrets.values().next().value as string);
}

const redacted = "[REDACTED]";

/**
 * Shapes in agent transcripts that are secrets, not prose or code: distinct
 * provider prefixes, JWTs, private keys, bearer values, values assigned to
 * secret-named environment variables and credential-file JSON fields. Each
 * needs a long, token-like value, so names, references ($VAR) and
 * placeholders stay readable.
 */
const transcriptSecretPatterns: Array<[RegExp, string]> = [
  [
    /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    `-----BEGIN $1PRIVATE KEY-----\n${redacted}\n-----END $1PRIVATE KEY-----`,
  ],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    redacted,
  ],
  [/\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, redacted],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, redacted],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, redacted],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, redacted],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, redacted],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, redacted],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, redacted],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, redacted],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, `$1${redacted}`],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)S?=)(["']?)(?=[^\s"'$]*[A-Za-z])[^\s"'$][^\s"']{11,}/g,
    `$1$2${redacted}`,
  ],
  [
    /("(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken|api_key|apiKey|client_secret|clientSecret|deviceCredential|sessionToken|password)"\s*:\s*")[^"]{8,}"/g,
    `$1${redacted}"`,
  ],
];

/**
 * Removes secrets from what an agent said or a tool printed, before it
 * reaches a transcript: the values this worker knows, then the shapes above.
 * Returns the input itself when nothing matched.
 */
export function redactTranscriptText(text: string): string {
  if (!text) return text;
  let result = text;
  for (const secret of knownSecrets)
    if (result.includes(secret)) result = result.split(secret).join(redacted);
  for (const [pattern, replacement] of transcriptSecretPatterns)
    result = result.replace(pattern, replacement);
  return result === text ? text : result;
}

/** A transcript message with secrets removed from what it shows. */
export function redactTranscriptMessage<
  T extends { text: string; title?: string },
>(message: T): T {
  const text = redactTranscriptText(message.text);
  const title =
    message.title === undefined
      ? undefined
      : redactTranscriptText(message.title);
  return text === message.text && title === message.title
    ? message
    : { ...message, text, ...(title === undefined ? {} : { title }) };
}
