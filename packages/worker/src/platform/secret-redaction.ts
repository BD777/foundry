const redacted = "[REDACTED]";

type Rule = [RegExp, string];

/** Credentials in a URL's userinfo; the host stays readable. */
const urlCredentials: Rule = [
  /((?:https?|socks5h?):\/\/)[^/\s@]*@/gi,
  `$1${redacted}@`,
];

/**
 * Shapes that are credentials wherever they appear: private keys, JWTs and
 * issuers' distinct token prefixes. Each needs a long, token-like value, so
 * prose and code stay readable.
 */
const credentialShapes: Rule[] = [
  [
    /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    `-----BEGIN $1PRIVATE KEY-----\n${redacted}\n-----END $1PRIVATE KEY-----`,
  ],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    redacted,
  ],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, redacted],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, redacted],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, redacted],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, redacted],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, redacted],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, redacted],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, redacted],
];

/**
 * The baseline for operational text: errors, logs, command lines, command
 * output and evidence. It errs toward removing: any value named like a
 * credential, short prefixed tokens and every JWT-shaped string go.
 */
const operationalRules: Rule[] = [
  urlCredentials,
  // Other schemes (databases, brokers) only when a password is present.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${redacted}@`],
  ...credentialShapes,
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, `$1 ${redacted}`],
  [
    /((?:api[_-]?key|token|password|secret|authorization|cookie|credential)\s*["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)/gi,
    `$1${redacted}`,
  ],
  // A command-line flag's separate value: --api-key <value>.
  [
    /(--(?:api[_-]?key|[a-z-]*token|password|secret|credential)\s+)(?![-$<])[^"'&\s,;}]+/gi,
    `$1${redacted}`,
  ],
  [
    /([?&](?:token|access_token|key|signature|sig|password|secret|code)=)[^&\s"']*/gi,
    `$1${redacted}`,
  ],
  [
    /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|fdy|glpat)[-_][A-Za-z0-9_-]{8,}/gi,
    redacted,
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, redacted],
];

function applyRules(text: string, rules: Rule[]): string {
  let result = withoutKnownSecrets(text);
  for (const [pattern, replacement] of rules)
    result = result.replace(pattern, replacement);
  return result;
}

/**
 * Removes credentials and authentication tokens from operational text,
 * including the values this worker knows. Returns the input unchanged when
 * nothing matched.
 */
export function redactSecrets(text: string): string {
  return applyRules(text, operationalRules);
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

function withoutKnownSecrets(text: string): string {
  let result = text;
  for (const secret of knownSecrets)
    if (result.includes(secret)) result = result.split(secret).join(redacted);
  return result;
}

/**
 * What agents say and tools print, kept readable: a transcript discusses
 * tokens, shows code that reads them and quotes placeholders, which the
 * operational rules would mangle (any `token: x`, short prefixes, any
 * Bearer word). Only long, token-like values go: the shared credential
 * shapes, provider keys, bearer values, values assigned to secret-named
 * environment variables, and credential-named fields: JSON (also escaped
 * inside a JSON string), YAML-style `apiKey: value` and `--api-key value`.
 * References ($VAR) and placeholders (<key>) stay.
 */
const secretFieldName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|device[_-]?credential|session[_-]?token|password)`;
// A token-like value: at least 8 characters with a letter and a digit, and
// not a call or index, so code such as `apiKey: readKey(2)` stays.
const tokenValue = String.raw`(?![$<])(?=[\w.~+/=-]*\d)(?=[\w.~+/=-]*[A-Za-z])[\w.~+/=-]{8,}(?![\w.~+/=(\[-])`;
const transcriptRules: Rule[] = [
  urlCredentials,
  ...credentialShapes,
  [/\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, redacted],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, `$1${redacted}`],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)S?=)(["']?)(?=[^\s"'$]*[A-Za-z])[^\s"'$][^\s"']{11,}/g,
    `$1$2${redacted}`,
  ],
  [
    new RegExp(
      String.raw`((\\?)"${secretFieldName}\2"\s*:\s*\2")(?![$<])(?=(?:[^"\\]|\\[^"]){8})(?:[^"\\]|\\[^"])+`,
      "gi",
    ),
    `$1${redacted}`,
  ],
  [
    new RegExp(
      String.raw`((?:--${secretFieldName}(?:=|\s+)|\b${secretFieldName}\s*[:=]\s*)["']?)${tokenValue}`,
      "gi",
    ),
    `$1${redacted}`,
  ],
];

/**
 * Removes secrets from what an agent said or a tool printed, before it
 * reaches a transcript: the values this worker knows, then the rules above.
 * Returns the input itself when nothing matched.
 */
export function redactTranscriptText(text: string): string {
  if (!text) return text;
  const result = applyRules(text, transcriptRules);
  return result === text ? text : result;
}

const secretField = new RegExp(`^${secretFieldName}$`, "i");

/**
 * A JSON-shaped value (a tool call's input, event metadata, a logged SDK
 * message) with secrets removed: a credential-named field's string loses
 * its value whatever its shape, and becomes a known secret, so the same
 * value is redacted where an agent repeats it; every other string goes
 * through redactTranscriptText. Returns the input itself when nothing
 * matched.
 */
export function redactTranscriptValue<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, field: string | undefined): unknown {
  if (typeof value === "string") {
    const shown = value.trim();
    if (field !== undefined && secretField.test(field) && shown) {
      if (/^(?:\$|<[^>]*>$)/.test(shown)) return value;
      registerKnownSecret(shown);
      return redacted;
    }
    return redactTranscriptText(value);
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item, index) => {
      const next = redactValue(item, undefined);
      if (next !== item) (copy ??= [...value])[index] = next;
    });
    return copy ?? value;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    let copy: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = redactValue(item, key);
      if (next !== item) (copy ??= { ...value })[key] = next;
    }
    return copy ?? value;
  }
  return value;
}

/**
 * A transcript message with secrets removed from everything it shows: its
 * text and title, and the questions and details it carries.
 */
export function redactTranscriptMessage<
  T extends { text: string; title?: string },
>(message: T): T {
  return redactTranscriptValue(message);
}

/**
 * A line of a session's own log of what its runtime streamed (Claude SDK
 * messages, Codex events): the record as JSON, secrets removed, so tool
 * inputs never rest on disk where transcripts are read back from.
 */
export function redactedJSONLine(value: unknown): string {
  return `${JSON.stringify(redactTranscriptValue(value ?? null))}\n`;
}
