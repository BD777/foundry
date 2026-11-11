// cua-driver's `permissions status --json` answer: the daemon's grants, or
// an explicit "unknown" while its permission check has not confirmed them.

export interface CuaDriverGrants {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface CuaDriverPermissions {
  /** A CuaDriver daemon answered (or is listening). */
  running: boolean;
  /** Its grants, when known. */
  grants?: CuaDriverGrants;
  /** status "unknown": cua-driver cannot read its real grants yet. */
  unknown?: boolean;
}

/**
 * `cua-driver permissions status --json`, as cua-driver 0.34 prints it
 * (run_permissions_status in libs/cua-driver/rust/crates/cua-driver/src/cli.rs,
 * github.com/trycua/cua at 7a1dcd0):
 * - no trustworthy answer: {"daemon_running": bool, "status": "unknown",
 *   "reason": "..."} with no grant booleans;
 * - verified by the daemon itself: its check_permissions result, with
 *   top-level booleans "accessibility" and "screen_recording" (plus
 *   "screen_recording_capturable", "direct_capture_verification" and
 *   "source": {"attribution": "driver-daemon"}).
 * Any other shape is read loosely for grant keys.
 */
export function parseCuaDriverPermissions(
  output: string,
): CuaDriverPermissions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { running: false };
  }
  if (!parsed || typeof parsed !== "object") return { running: false };
  const record = parsed as Record<string, unknown>;
  if (record.status === "unknown")
    return { running: record.daemon_running === true, unknown: true };
  if (
    typeof record.accessibility === "boolean" &&
    typeof record.screen_recording === "boolean"
  )
    return {
      running: true,
      grants: {
        accessibility: record.accessibility,
        screenRecording: record.screen_recording,
      },
    };
  return parseLoosely(record);
}

function parseLoosely(record: Record<string, unknown>): CuaDriverPermissions {
  const found: Partial<Record<keyof CuaDriverGrants, boolean>> = {};
  const granted = (value: unknown): boolean | undefined =>
    typeof value === "boolean"
      ? value
      : typeof value === "string"
        ? /^(granted|true|yes|authorized)$/i.test(value.trim())
        : undefined;
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 3) return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^accessibility(_granted)?$/i.test(key) &&
        found.accessibility === undefined
      )
        found.accessibility = granted(entry);
      else if (
        /^screen_?recording(_granted)?$/i.test(key) &&
        found.screenRecording === undefined
      )
        found.screenRecording = granted(entry);
      else walk(entry, depth + 1);
    }
  };
  walk(record, 0);
  if (found.accessibility === undefined && found.screenRecording === undefined)
    return { running: record.daemon_running === true };
  return {
    running: record.daemon_running !== false,
    grants: {
      accessibility: found.accessibility === true,
      screenRecording: found.screenRecording === true,
    },
  };
}
