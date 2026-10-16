/** Exact public package metadata, never credentials or inference endpoints. */
export function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
export async function stablePackageVersion(
  packageName: string,
  tag = "latest",
  request: typeof fetch = fetch,
): Promise<string> {
  if (
    ![
      "@openai/codex",
      "@anthropic-ai/claude-code",
      "@anthropic-ai/claude-agent-sdk",
    ].includes(packageName)
  )
    throw new Error("Unknown agent package");
  const response = await request(
    `https://registry.npmjs.org/${packageName}/${tag}`,
    { signal: AbortSignal.timeout(20000), credentials: "omit" },
  );
  if (!response.ok)
    throw new Error(`Official release metadata returned ${response.status}`);
  const body = (await response.json()) as { version?: string };
  if (!isStableVersion(body.version))
    throw new Error(
      "Official release channel did not return a stable version.",
    );
  return body.version;
}
