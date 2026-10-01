// Every test resolves `src` the way the bundler does (see bundler-resolve.mjs),
// including modules a test imports directly.
import { register } from "node:module";

register("./bundler-resolve.mjs", import.meta.url);
