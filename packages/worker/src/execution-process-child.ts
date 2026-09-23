import { spawn } from "node:child_process";

const parent = process.ppid;
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Execution command is missing");
const child = spawn(command, args, { stdio: "inherit" });
const watchdog = setInterval(() => {
  if (process.ppid === parent) return;
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}, 500);
watchdog.unref();
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
