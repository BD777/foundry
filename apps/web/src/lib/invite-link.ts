/** The accept URL for a one-time invite token. */
export function inviteLink(
  token: string,
  origin = window.location.origin,
): string {
  return `${origin}/invite/${encodeURIComponent(token)}`;
}
