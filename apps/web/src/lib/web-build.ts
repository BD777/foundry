// Which build of the web app a page runs, and which one is deployed. The
// build (vite.config.ts) names itself after its output, puts the name in a
// meta tag of index.html and writes it to version.json beside index.html.

/** The meta tag of index.html that names the page's build. */
export const buildMetaName = "foundry-build";

/** The file, beside index.html, that names the deployed build. */
export const buildVersionFile = "version.json";

/**
 * The build this page runs; undefined where it was not built (the Vite dev
 * server), so there is nothing to compare.
 */
export function runningBuild(
  document: Pick<Document, "querySelector"> | undefined = globalThis.document,
): string | undefined {
  const content = document
    ?.querySelector<HTMLMetaElement>(`meta[name="${buildMetaName}"]`)
    ?.getAttribute("content");
  return content || undefined;
}

/** The build version.json names; undefined for anything else. */
export function parseBuildVersion(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as { build?: unknown } | null;
    return typeof value?.build === "string" && value.build
      ? value.build
      : undefined;
  } catch {
    // Not JSON: a server that answers unknown paths with index.html.
    return undefined;
  }
}

/**
 * Reads which build is deployed, past every cache: undefined when the
 * server does not say (an older deployment, the network failed).
 */
export async function fetchDeployedBuild(
  url = `${import.meta.env?.BASE_URL ?? "/"}${buildVersionFile}`,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return undefined;
    return parseBuildVersion(await response.text());
  } catch {
    return undefined;
  }
}
