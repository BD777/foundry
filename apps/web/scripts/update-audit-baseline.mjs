import { spawnSync } from "node:child_process";

const scripts = [
  "audit:buttons",
  "audit:native-controls",
  "audit:app-boundary",
  "audit:css",
  "audit:v3-layout",
];

for (const script of scripts) {
  const result = spawnSync("pnpm", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FOUNDRY_AUDIT_UPDATE: "1",
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
