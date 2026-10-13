/**
 * A page's own query parameters (a filter): read once when the page opens,
 * then written from its state into the current history entry. The URL never
 * drives the state back, and other parameters (the workspace) are kept.
 */
export function readPageQuery(name: string): string {
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? "";
}

/** Sets the page's parameters on the current entry; "" removes one. */
export function replacePageQuery(values: Record<string, string>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  if (
    url !==
    `${window.location.pathname}${window.location.search}${window.location.hash}`
  )
    window.history.replaceState(window.history.state, "", url);
}
