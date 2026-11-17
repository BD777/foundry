/** The first sentence of agent prose, for a one-line review title. */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  let end = 0;
  for (let index = 0; index < clean.length; index++) {
    const char = clean.charAt(index);
    if ("。！？!?".includes(char)) {
      end = index + 1;
      break;
    }
    // A Latin sentence ends at a period followed by space or the end, so
    // versions and paths (`AGENTS.md`, `2.9 KB`) stay in their sentence.
    if (
      char === "." &&
      (index === clean.length - 1 || clean[index + 1] === " ")
    ) {
      end = index + 1;
      break;
    }
  }
  return end ? clean.slice(0, end) : clean;
}

/**
 * What an expanded review adds under its title: the summary without the
 * sentence the row already shows. A one-sentence summary adds nothing.
 */
export function summaryBody(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const title = firstSentence(clean);
  if (!clean || clean === title) return "";
  return clean.startsWith(title) ? clean.slice(title.length).trim() : clean;
}

/**
 * `AGENTS.md#intro@6960ab19` reads as file plus section: the hash names the
 * file version, which the person never needs.
 */
export function sourceRef(ref: string): { file: string; section?: string } {
  const hash = ref.indexOf("#");
  if (hash < 0) return { file: ref };
  const tail = ref.slice(hash + 1);
  const version = tail.indexOf("@");
  const section = (version < 0 ? tail : tail.slice(0, version)).trim();
  return {
    file: ref.slice(0, hash),
    ...(section ? { section } : {}),
  };
}
