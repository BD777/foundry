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
 * environment variables and credential-file JSON fields. References ($VAR)
 * and placeholders stay.
 */
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
    /("(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken|api_key|apiKey|client_secret|clientSecret|deviceCredential|sessionToken|password)"\s*:\s*")[^"]{8,}"/g,
    `$1${redacted}"`,
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
