// Every test resolves `src` the way the bundler does (see bundler-resolve.mjs),
// including modules a test imports directly.
import { register } from "node:module";

register("./bundler-resolve.mjs", import.meta.url);

// Node offers BroadcastChannel and navigator.locks, which the event stream
// uses to share one connection between a browser's tabs. A test file is
// one tab: it streams alone unless it builds tabs of its own.
delete globalThis.BroadcastChannel;
