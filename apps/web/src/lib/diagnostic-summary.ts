import { i18n } from "../i18n";

/** Keep failure context available without turning the conversation into a log dump. */
export function diagnosticSummary(text: string): {
  summary: string;
  details?: string;
} {
  if (text.length <= 500 && text.split("\n").length <= 6)
    return { summary: text };
  const missingSubmodules =
    text.match(/Submodule is not initialized/g)?.length ?? 0;
  const summary = text.includes(
    // i18n-ignore: matches the worker's error text, not interface copy
    "Repository discovery must finish before initialization",
  )
    ? missingSubmodules
      ? i18n.t("agents:diagnostics.submodulesBlocked", {
          count: missingSubmodules,
        })
      : i18n.t("agents:diagnostics.discoveryBlocked")
    : `${text.split("\n")[0]!.slice(0, 240).trimEnd()}…`;
  return { summary, details: text };
}
