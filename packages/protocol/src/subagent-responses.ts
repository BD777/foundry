const utf8 = new TextEncoder();

/**
 * A subagent's answer as the chat compares it with the main transcript (to
 * keep it out): FNV-1a 64 of the UTF-8 of its text trimmed as
 * `String.prototype.trim` trims, as 16 hex digits. The subagent list a chat
 * reads carries these instead of the answers; the server computes the same
 * for workers that send the answers (store.SubagentResponseFingerprint),
 * both checked against test/subagent-response-fixtures.json.
 */
export function subagentResponseFingerprint(text: string): string {
  // The 64-bit state as four 16-bit limbs, low first: numbers multiply
  // exactly only below 2^53.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const bytes = utf8.encode(text.trim());
  for (let index = 0; index < bytes.length; index += 1) {
    h0 ^= bytes[index]!;
    // Times 0x100000001b3: times 0x1b3, plus the state shifted 40 bits (8
    // bits into limb 2); what passes 64 bits is dropped.
    const r0 = h0 * 0x1b3;
    const r1 = h1 * 0x1b3 + (r0 >>> 16);
    const r2 = h2 * 0x1b3 + (h0 << 8) + (r1 >>> 16);
    const r3 = h3 * 0x1b3 + (h1 << 8) + (r2 >>> 16);
    h0 = r0 & 0xffff;
    h1 = r1 & 0xffff;
    h2 = r2 & 0xffff;
    h3 = r3 & 0xffff;
  }
  return [h3, h2, h1, h0]
    .map((limb) => limb.toString(16).padStart(4, "0"))
    .join("");
}
