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
    "Repository discovery must finish before initialization",
  )
    ? missingSubmodules
      ? `Workspace initialization was blocked by ${missingSubmodules} uninitialized submodule${missingSubmodules === 1 ? "" : "s"}. Inspect Environment for the affected repositories.`
      : "Workspace initialization was blocked by repository discovery problems. Inspect the Environment repository list for the affected paths."
    : `${text.split("\n")[0]!.slice(0, 240).trimEnd()}…`;
  return { summary, details: text };
}
