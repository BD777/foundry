// The per-case journal of scripts/pa-eval-run.mjs: one JSON line per finished
// case, appended as the case ends, so a run that dies keeps every case it
// completed. `--resume FILE` reads it back and skips the cases it holds.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export function journalKey(repeat, caseId) {
  return `${repeat}\u0000${caseId}`;
}

export function appendRow(file, repeat, row) {
  appendFileSync(file, `${JSON.stringify({ repeat, row })}\n`);
}

// The rows a journal holds, by (repetition, case). A last line cut short by a
// crash is left out; any other line that does not parse is an error, since a
// journal read with a gap would silently re-run or lose cases.
export function readJournal(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  const lines = readFileSync(file, "utf8").split("\n");
  const last = lines.findLastIndex((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (index === last) return;
      throw new Error(
        `${file}: line ${index + 1} is not a row: ${error.message}`,
      );
    }
    done.set(journalKey(entry.repeat, entry.row.id), entry.row);
  });
  return done;
}
