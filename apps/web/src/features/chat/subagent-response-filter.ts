export function shouldDisplayResponseEvent(
  eventId: string,
  text: string,
  terminalResponseEventId: string | undefined,
  suppressedResponseTexts: ReadonlySet<string>,
): boolean {
  const normalized = text.trim();
  return (
    normalized !== "" &&
    (eventId === terminalResponseEventId ||
      !suppressedResponseTexts.has(normalized))
  );
}
