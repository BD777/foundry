import { spawn } from "node:child_process";
import { signalProcessGroup } from "./process-group.js";

const arguments_ = process.argv.slice(2);
const explicitParent = arguments_[0] === "--owner";
const parent = explicitParent ? Number(arguments_[1]) : process.ppid;
const [command, ...args] = arguments_.slice(explicitParent ? 2 : 0);
if (!command) throw new Error("Execution command is missing");
// The owner may die between spawning this guardian and its first instruction.
// Never mistake launchd/init (the new parent) for the execution owner.
if (process.ppid !== parent) process.exit(1);
const child = spawn(command, args, { stdio: "inherit" });
const watchdog = setInterval(() => {
  if (process.ppid === parent) return;
  if (!signalProcessGroup(process.pid, "SIGKILL")) process.exit(1);
}, 500);
watchdog.unref();
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
