export type CliOptionType = "bool" | "int" | "string" | "url";

export interface CliOptionContract {
  defaultValue?: string;
  description: string;
  name: string;
  shortName?: string;
  type: CliOptionType;
}

export interface CliArgumentContract {
  description: string;
  name: string;
  required: boolean;
}

export interface CliExample {
  command: string;
  description: string;
  label?: "PIPELINE" | "RECOMMENDED" | "TEMPLATE";
}

export interface CliErrorContract {
  code: string;
  description: string;
  fix: string;
  name: string;
}

export interface CliCommandContract {
  arguments?: CliArgumentContract[];
  brief: string;
  description: string;
  errors?: CliErrorContract[];
  examples: CliExample[];
  id: string;
  options?: CliOptionContract[];
  path: string[];
}

export interface ParsedCliInvocation {
  command: CliCommandContract;
  positionals: string[];
}

export class CliError extends Error {
  readonly code: string;
  readonly example: string;
  readonly exitCode: number;
  readonly fix: string;
  readonly trigger: string;
  readonly errorName: string;

  constructor(input: {
    code: string;
    description: string;
    errorName: string;
    example: string;
    exitCode: number;
    fix: string;
    trigger: string;
  }) {
    super(input.description);
    this.name = "CliError";
    this.code = input.code;
    this.errorName = input.errorName;
    this.example = input.example;
    this.exitCode = input.exitCode;
    this.fix = input.fix;
    this.trigger = input.trigger;
  }
}

const serverOption: CliOptionContract = {
  defaultValue: "configured server or http://127.0.0.1:31982",
  description: "Foundry server URL (http or https)",
  name: "--server",
  type: "url",
};

const workspaceOption: CliOptionContract = {
  defaultValue: "current or first registered workspace",
  description: "Local Foundry workspace path",
  name: "--workspace",
  type: "string",
};

const pairingTokenOption: CliOptionContract = {
  defaultValue: "FOUNDRY_PAIRING_TOKEN, else the saved device credential",
  description:
    "One-time pairing token from Devices → Add device; exchanged for this device's credential (stored owner-only)",
  name: "--token",
  type: "string",
};

const connectOptions: CliOptionContract[] = [
  serverOption,
  workspaceOption,
  {
    defaultValue: "false",
    description: "Use HTTP polling instead of WebSocket",
    name: "--polling",
    type: "bool",
  },
  {
    defaultValue: "false",
    description: "Exit after one issue or idle cycle",
    name: "--once",
    type: "bool",
  },
  {
    defaultValue: "2500 with --once; otherwise 0",
    description: "Idle exit timeout in milliseconds (>=0)",
    name: "--idle-timeout-ms",
    type: "int",
  },
];

export const cliCommands: CliCommandContract[] = [
  {
    id: "workspace-scan",
    path: ["workspace", "scan"],
    brief: "Discover Git repositories in a workspace.",
    description:
      "Register the root and independent nested Git repositories without creating Issue worktrees. Prints the local repository inventory as JSON.",
    arguments: [
      { name: "path", description: "Workspace directory", required: true },
    ],
    examples: [
      {
        command: "foundry-worker workspace scan .",
        description: "Refresh the repository inventory.",
      },
    ],
  },
  {
    id: "issue-environment",
    path: ["issue", "environment"],
    brief: "Inspect or clean an Issue candidate environment.",
    description:
      "Read the persistent environment manifest. Pass --cleanup only after integration or explicit abandonment; candidate refs are retained.",
    arguments: [{ name: "issue-id", description: "Issue ID", required: true }],
    options: [
      workspaceOption,
      {
        name: "--cleanup",
        description:
          "Remove integrated candidate worktrees in leaf-first order",
        type: "bool",
      },
    ],
    examples: [
      {
        command: "foundry-worker issue environment iss_1 --workspace .",
        description: "Inspect the candidate CWD and repository mapping.",
      },
    ],
  },
  {
    brief: "Initialize, pair, and install the local daemon.",
    description:
      "Creates or updates a Foundry workspace, saves pairing metadata, registers the daemon, and installs a user service. Use --no-service for a foreground-only setup.",
    errors: [
      {
        code: "E2001",
        description: "The Foundry server is unreachable.",
        fix: "Start the server or pass a reachable --server URL.",
        name: "SERVER_UNREACHABLE",
      },
      {
        code: "E2002",
        description:
          "The server rejected the pairing token (invalid, expired or already used).",
        fix: "Create a new token in Devices → Add device and pass it with --token.",
        name: "PAIRING_REJECTED",
      },
    ],
    examples: [
      {
        command: "foundry-worker setup --workspace . --token <pairing-token>",
        description: "Set up the current workspace.",
        label: "RECOMMENDED",
      },
      {
        command:
          "foundry-worker setup --server http://127.0.0.1:31982 --workspace ~/work/project --token <pairing-token>",
        description: "Set up an explicit workspace and server.",
      },
      {
        command:
          "foundry-worker setup --workspace . --token <pairing-token> --no-service",
        description: "Set up without installing a login service.",
        label: "TEMPLATE",
      },
    ],
    id: "setup",
    options: [
      serverOption,
      workspaceOption,
      pairingTokenOption,
      {
        defaultValue: "false",
        description: "Skip user service installation",
        name: "--no-service",
        type: "bool",
      },
      {
        defaultValue: "false",
        description: "Install the service without starting it",
        name: "--no-start",
        type: "bool",
      },
    ],
    path: ["setup"],
  },
  {
    arguments: [
      {
        description: "Workspace directory to initialize",
        name: "path",
        required: true,
      },
    ],
    brief: "Initialize a local Foundry workspace.",
    description:
      "Creates the workspace scaffolding and registers the workspace locally. Existing user-authored files are preserved.",
    examples: [
      {
        command: "foundry-worker init .",
        description: "Initialize the current directory.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker init ~/work/project",
        description: "Initialize a workspace by path.",
      },
      {
        command: "foundry-worker init <workspace-path>",
        description: "Reusable workspace initialization pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "init",
    path: ["init"],
  },
  {
    brief: "Connect this machine to the Foundry control plane.",
    description:
      "Runs the local daemon and reconnects after transient failures. WebSocket transport is the default; --polling enables compatibility mode.",
    examples: [
      {
        command: "foundry-worker connect --workspace .",
        description: "Connect the current workspace.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker connect --workspace . --once",
        description: "Connect for one idle or work cycle.",
      },
      {
        command:
          "foundry-worker connect --server <server-url> --workspace <workspace-path>",
        description: "Reusable authenticated connection pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "connect",
    options: connectOptions,
    path: ["connect"],
  },
  {
    brief: "Run the long-lived local daemon.",
    description:
      "Runs the same daemon loop as connect. This alias is intended for user service definitions and foreground debugging.",
    examples: [
      {
        command: "foundry-worker daemon --workspace .",
        description: "Run the daemon for the current workspace.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker daemon --workspace . --once",
        description: "Run one daemon cycle.",
      },
      {
        command:
          "foundry-worker daemon --server <server-url> --workspace <workspace-path>",
        description: "Reusable daemon invocation pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "daemon",
    options: connectOptions,
    path: ["daemon"],
  },
  {
    brief:
      "Pair this machine with a one-time token and save its device credential.",
    description:
      "Writes owner-only daemon configuration and registers the local workspace. Pairing does not install a login service.",
    examples: [
      {
        command:
          "foundry-worker pair --server http://127.0.0.1:31982 --workspace .",
        description: "Pair the current workspace.",
        label: "RECOMMENDED",
      },
      {
        command:
          "foundry-worker pair --server https://foundry.example --workspace . --token <pairing-token>",
        description: "Pair with an authenticated remote server.",
      },
      {
        command:
          "foundry-worker pair --server <server-url> --workspace <workspace-path> --token <pairing-token>",
        description: "Reusable pairing pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "pair",
    options: [serverOption, workspaceOption, pairingTokenOption],
    path: ["pair"],
  },
  {
    brief: "Install a launch-on-login service for this user.",
    description:
      "Installs a launchd service on macOS or a systemd user service on Linux. Existing pairing metadata supplies the server and workspace.",
    examples: [
      {
        command: "foundry-worker install-service",
        description: "Install and start the user service.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker install-service --no-start",
        description: "Install without starting.",
      },
      {
        command:
          "foundry-worker pair --server <url> --workspace <path> && foundry-worker install-service",
        description: "Pair, then install the service.",
        label: "TEMPLATE",
      },
    ],
    id: "install-service",
    options: [
      {
        defaultValue: "false",
        description: "Install the service without starting it",
        name: "--no-start",
        type: "bool",
      },
    ],
    path: ["install-service"],
  },
  {
    brief: "Show local daemon configuration and service state.",
    description:
      "Prints the saved server, workspace, service path, and platform service status. This command does not modify local state.",
    examples: [
      {
        command: "foundry-worker status",
        description: "Show daemon and service status.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker status | sed -n '1,4p'",
        description: "Read the summary in a pipeline.",
        label: "PIPELINE",
      },
      {
        command: "foundry-worker status",
        description: "Reusable status check.",
        label: "TEMPLATE",
      },
    ],
    id: "status",
    path: ["status"],
  },
  {
    brief: "Print local daemon logs.",
    description:
      "Prints recent stdout and stderr lines from the user service log files. Missing log files are reported without failing.",
    examples: [
      {
        command: "foundry-worker logs",
        description: "Print the latest 80 lines.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker logs --lines 200",
        description: "Print a larger log tail.",
      },
      {
        command: "foundry-worker logs --lines <count>",
        description: "Reusable log tail pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "logs",
    options: [
      {
        defaultValue: "80",
        description: "Number of lines per log file (>0)",
        name: "--lines",
        type: "int",
      },
    ],
    path: ["logs"],
  },
  {
    brief: "Remove the launch-on-login service.",
    description:
      "Stops and removes the current user's Foundry worker service. Workspace and pairing files are preserved.",
    examples: [
      {
        command: "foundry-worker uninstall-service",
        description: "Remove the current user service.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker status && foundry-worker uninstall-service",
        description: "Inspect status before removal.",
      },
      {
        command: "foundry-worker uninstall-service",
        description: "Reusable service removal pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "uninstall-service",
    path: ["uninstall-service"],
  },
  {
    brief: "Sync review decisions from the control plane.",
    description:
      "Downloads issue review state and applies accepted artifacts to the paired workspace. Existing local execution records remain authoritative.",
    examples: [
      {
        command: "foundry-worker sync",
        description: "Sync the paired workspace.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker sync --workspace ~/work/project",
        description: "Sync an explicit workspace.",
      },
      {
        command:
          "foundry-worker sync --server <server-url> --workspace <workspace-path>",
        description: "Reusable sync pattern.",
        label: "TEMPLATE",
      },
    ],
    id: "sync",
    options: [serverOption, workspaceOption],
    path: ["sync"],
  },
  {
    arguments: [
      {
        description: "Workspace path; defaults to current directory",
        name: "path",
        required: false,
      },
    ],
    brief: "Check local workspace and runtime readiness.",
    description:
      "Checks required workspace files and prints local readiness results. This command does not create or repair files.",
    examples: [
      {
        command: "foundry-worker doctor .",
        description: "Check the current workspace.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker doctor ~/work/project",
        description: "Check an explicit workspace.",
      },
      {
        command: "foundry-worker doctor <workspace-path>",
        description: "Reusable readiness check.",
        label: "TEMPLATE",
      },
    ],
    id: "doctor",
    path: ["doctor"],
  },
  {
    brief: "Show local Claude and Codex configuration metadata.",
    description:
      "Reports provider readiness without printing secrets. Use --workspace to include workspace-specific configuration context.",
    examples: [
      {
        command: "foundry-worker providers",
        description: "Show provider health.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker providers --workspace .",
        description: "Show health for the current workspace.",
      },
      {
        command: "foundry-worker providers --workspace <workspace-path>",
        description: "Reusable provider health query.",
        label: "TEMPLATE",
      },
    ],
    id: "providers",
    options: [workspaceOption],
    path: ["providers"],
  },
  {
    brief: "List locally registered workspaces.",
    description:
      "Prints registered workspace names, baselines, and local paths. Output is line-oriented for shell pipelines.",
    examples: [
      {
        command: "foundry-worker workspace list",
        description: "List registered workspaces.",
        label: "RECOMMENDED",
      },
      {
        command: "foundry-worker workspace list | awk '{print $NF}'",
        description: "Extract workspace paths.",
        label: "PIPELINE",
      },
      {
        command: "foundry-worker workspace list",
        description: "Reusable workspace list command.",
        label: "TEMPLATE",
      },
    ],
    id: "workspace-list",
    path: ["workspace", "list"],
  },
];

const documentationOptions: CliOptionContract[] = [
  {
    defaultValue: "false",
    description: "Show full command help",
    name: "--help",
    shortName: "-h",
    type: "bool",
  },
  {
    defaultValue: "false",
    description: "Print the command JSON Schema",
    name: "--schema",
    type: "bool",
  },
  {
    defaultValue: "false",
    description: "Show the complete command manual",
    name: "--man",
    type: "bool",
  },
];

const commonErrors: CliErrorContract[] = [
  {
    code: "E1001",
    description: "The command or subcommand is unknown.",
    fix: "Run foundry-worker --commands and choose a listed command.",
    name: "UNKNOWN_COMMAND",
  },
  {
    code: "E1002",
    description: "A required argument or option value is missing.",
    fix: "Run the command with --help and provide the required value.",
    name: "MISSING_VALUE",
  },
  {
    code: "E1003",
    description: "An option is not supported by the selected command.",
    fix: "Remove the option or choose one listed in OPTIONS.",
    name: "UNKNOWN_OPTION",
  },
  {
    code: "E1004",
    description: "An option value has an invalid type or range.",
    fix: "Use the type and constraint shown in OPTIONS.",
    name: "INVALID_VALUE",
  },
];

const rootExamples: CliExample[] = [
  {
    command: "foundry-worker setup --workspace .",
    description: "Set up a workspace and local daemon.",
    label: "RECOMMENDED",
  },
  {
    command: "foundry-worker connect --workspace .",
    description: "Run the local daemon.",
  },
  {
    command: "foundry-worker doctor .",
    description: "Check workspace readiness.",
  },
  {
    command: "foundry-worker workspace list | awk '{print $NF}'",
    description: "List workspace paths in a pipeline.",
    label: "PIPELINE",
  },
  {
    command: "foundry-worker <command> --help",
    description: "Load command-specific help.",
    label: "TEMPLATE",
  },
];

export function requestedDocumentation(
  args: string[],
  version: string,
): string | undefined {
  if (args.length === 0) {
    return renderRootUsage(version);
  }
  if (args[0] === "--commands") {
    return renderCommands();
  }
  if (args[0] === "--schema") {
    return JSON.stringify(rootSchema(version), null, 2);
  }
  if (args[0] === "--man") {
    return renderRootMan(version);
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return renderRootHelp(version);
  }
  if (args[0] === "workspace" && args.length === 1) {
    return renderWorkspaceUsage();
  }
  if (
    args[0] === "workspace" &&
    (args[1] === "--help" || args[1] === "-h" || args[1] === "--man")
  ) {
    return renderWorkspaceUsage();
  }
  if (args[0] === "workspace" && args[1] === "--commands") {
    return renderCommands(["workspace"]);
  }

  const command = commandForArgs(args);
  if (!command) {
    if (
      args.includes("--help") ||
      args.includes("-h") ||
      args.includes("--schema") ||
      args.includes("--man")
    ) {
      throw unknownCommandError(args);
    }
    return undefined;
  }
  if (args.includes("--schema")) {
    return JSON.stringify(commandSchema(command), null, 2);
  }
  if (args.includes("--man")) {
    return renderCommandMan(command);
  }
  if (args.includes("--help") || args.includes("-h")) {
    return renderCommandHelp(command);
  }
  if (
    args.length === command.path.length &&
    (command.arguments ?? []).some((argument) => argument.required)
  ) {
    return renderCommandUsage(command);
  }
  return undefined;
}

export function parseCliInvocation(args: string[]): ParsedCliInvocation {
  const command = commandForArgs(args);
  if (!command) {
    throw unknownCommandError(args);
  }
  const commandArgs = args.slice(command.path.length);
  const optionMap = new Map(
    [...(command.options ?? []), ...documentationOptions].flatMap((option) => {
      const entries: Array<[string, CliOptionContract]> = [
        [option.name, option],
      ];
      if (option.shortName) {
        entries.push([option.shortName, option]);
      }
      return entries;
    }),
  );
  const positionals: string[] = [];

  for (let index = 0; index < commandArgs.length; index += 1) {
    const token = commandArgs[index] ?? "";
    if (token === "--") {
      positionals.push(...commandArgs.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const [optionName, inlineValue] = splitOption(token);
    const option = optionMap.get(optionName);
    if (!option) {
      throw argumentError({
        code: "E1003",
        description: `Option ${optionName} is not valid for ${commandPath(command)}.`,
        errorName: "UNKNOWN_OPTION",
        example: `${commandPath(command)} --help`,
        fix: "Remove the option or choose one listed in OPTIONS.",
        trigger: token,
      });
    }
    if (option.type === "bool") {
      if (inlineValue !== undefined) {
        throw invalidOptionValue(command, option, inlineValue);
      }
      continue;
    }

    const value = inlineValue ?? commandArgs[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw argumentError({
        code: "E1002",
        description: `${option.name} requires a ${option.type} value.`,
        errorName: "MISSING_VALUE",
        example: `${commandPath(command)} ${option.name} <value>`,
        fix: `Provide a value after ${option.name}.`,
        trigger: token,
      });
    }
    validateOptionValue(command, option, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  validatePositionals(command, positionals);
  return { command, positionals };
}

export function formatCliError(error: CliError): string {
  return [
    `ERROR [${error.code}] ${error.errorName}: ${error.message}`,
    `  Trigger:  ${error.trigger}`,
    `  Fix:      ${error.fix}`,
    `  Example:  ${error.example}`,
  ].join("\n");
}

export function genericCliError(error: unknown, args: string[]): CliError {
  const description = error instanceof Error ? error.message : String(error);
  return new CliError({
    code: "E5001",
    description,
    errorName: "COMMAND_FAILED",
    example: "foundry-worker --help",
    exitCode: 1,
    fix: "Inspect the message, correct local state, then retry.",
    trigger: `foundry-worker ${args.join(" ")}`.trim(),
  });
}

function commandForArgs(args: string[]): CliCommandContract | undefined {
  return [...cliCommands]
    .sort((left, right) => right.path.length - left.path.length)
    .find((command) =>
      command.path.every((segment, index) => args[index] === segment),
    );
}

function commandPath(command: CliCommandContract): string {
  return ["foundry-worker", ...command.path].join(" ");
}

function splitOption(token: string): [string, string | undefined] {
  const index = token.indexOf("=");
  if (index < 0) {
    return [token, undefined];
  }
  return [token.slice(0, index), token.slice(index + 1)];
}

function validateOptionValue(
  command: CliCommandContract,
  option: CliOptionContract,
  value: string,
): void {
  if (option.type === "int") {
    const parsed = Number(value);
    const minimum = option.name === "--idle-timeout-ms" ? 0 : 1;
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw invalidOptionValue(command, option, value);
    }
  }
  if (option.type === "url") {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported scheme");
      }
    } catch {
      throw invalidOptionValue(command, option, value);
    }
  }
  if (option.type === "string" && value.trim() === "") {
    throw invalidOptionValue(command, option, value);
  }
}

function invalidOptionValue(
  command: CliCommandContract,
  option: CliOptionContract,
  value: string,
): CliError {
  return argumentError({
    code: "E1004",
    description: `${option.name} received invalid ${option.type} value ${JSON.stringify(value)}.`,
    errorName: "INVALID_VALUE",
    example: `${commandPath(command)} --help`,
    fix: `Use the ${option.type} constraint shown for ${option.name}.`,
    trigger: `${option.name}=${value}`,
  });
}

function validatePositionals(
  command: CliCommandContract,
  positionals: string[],
): void {
  const argumentsContract = command.arguments ?? [];
  const requiredCount = argumentsContract.filter(
    (argument) => argument.required,
  ).length;
  if (positionals.length < requiredCount) {
    const missing = argumentsContract[positionals.length];
    throw argumentError({
      code: "E1002",
      description: `${commandPath(command)} requires ${missing?.name ?? "an argument"}.`,
      errorName: "MISSING_ARGUMENT",
      example: command.examples[0]?.command ?? `${commandPath(command)} --help`,
      fix: `Provide ${missing?.name ?? "the required argument"} shown in SYNTAX.`,
      trigger: commandPath(command),
    });
  }
  if (positionals.length > argumentsContract.length) {
    throw argumentError({
      code: "E1005",
      description: `${commandPath(command)} received unexpected argument ${JSON.stringify(positionals[argumentsContract.length])}.`,
      errorName: "UNEXPECTED_ARGUMENT",
      example: `${commandPath(command)} --help`,
      fix: "Remove the extra positional argument.",
      trigger: positionals.join(" "),
    });
  }
}

function unknownCommandError(args: string[]): CliError {
  const attempted = args
    .filter((token) => !token.startsWith("-"))
    .slice(0, 2)
    .join(" ");
  return argumentError({
    code: "E1001",
    description: `Unknown command${attempted ? ` ${JSON.stringify(attempted)}` : ""}.`,
    errorName: "UNKNOWN_COMMAND",
    example: "foundry-worker --commands",
    fix: "Choose a command returned by foundry-worker --commands.",
    trigger: `foundry-worker ${args.join(" ")}`.trim(),
  });
}

function argumentError(
  input: Omit<ConstructorParameters<typeof CliError>[0], "exitCode">,
): CliError {
  return new CliError({ ...input, exitCode: 2 });
}

function renderRootUsage(version: string): string {
  return [
    "@USAGE foundry-worker",
    "",
    `BRIEF: Foundry local workspace and daemon CLI (${version}).`,
    "",
    "SYNTAX:",
    "  foundry-worker <command> [arguments] [options]",
    "",
    "EXAMPLES:",
    ...renderExamples(rootExamples.slice(0, 5)),
  ].join("\n");
}

function renderRootHelp(version: string): string {
  return [
    "@HELP foundry-worker",
    "",
    `BRIEF: Foundry local workspace and daemon CLI (${version}).`,
    "",
    "SYNTAX:",
    "  foundry-worker <command> [arguments] [options]",
    "",
    "DESCRIPTION:",
    "  Initializes Foundry workspaces, runs the local daemon, and manages the user service.",
    "  Local credentials and custom commands remain in owner-only daemon configuration.",
    "",
    "COMMANDS:",
    ...cliCommands.map(
      (command) => `  ${command.path.join(" ").padEnd(20)} ${command.brief}`,
    ),
    "",
    "OPTIONS:",
    ...renderOptions([
      ...documentationOptions,
      {
        defaultValue: "false",
        description: "Print command discovery JSON",
        name: "--commands",
        type: "bool",
      },
      {
        defaultValue: "false",
        description: "Print CLI version",
        name: "--version",
        shortName: "-v",
        type: "bool",
      },
    ]),
    "",
    "COMMON EXAMPLES:",
    ...renderExamples(rootExamples),
    "",
    "COMMON ERRORS:",
    ...renderErrors(commonErrors),
    "",
    "SEE ALSO:",
    "  foundry-worker --commands        Machine-readable command list",
    "  foundry-worker <command> --schema Machine-readable command schema",
    "  foundry-worker <command> --man    Complete command manual",
  ].join("\n");
}

function renderWorkspaceUsage(): string {
  return [
    "@USAGE foundry-worker workspace",
    "",
    "BRIEF: Inspect locally registered Foundry workspaces.",
    "",
    "SYNTAX:",
    "  foundry-worker workspace <action>",
    "",
    "EXAMPLES:",
    "  # List registered workspaces",
    "  foundry-worker workspace list",
    "  # Show workspace list help",
    "  foundry-worker workspace list --help",
    "  # Discover workspace commands",
    "  foundry-worker --commands",
  ].join("\n");
}

function renderCommandHelp(command: CliCommandContract): string {
  return [
    `@HELP ${commandPath(command)}`,
    "",
    `PARENT: ${command.path.length > 1 ? ["foundry-worker", ...command.path.slice(0, -1)].join(" ") : "foundry-worker"}`,
    "",
    `BRIEF: ${command.brief}`,
    "",
    "SYNTAX:",
    `  ${commandSyntax(command)}`,
    "",
    "DESCRIPTION:",
    `  ${command.description}`,
    "",
    "ARGUMENTS:",
    ...renderArguments(command.arguments ?? []),
    "",
    "OPTIONS:",
    ...renderOptions(command.options ?? []),
    "",
    "INHERITED OPTIONS:",
    "  --help, -h   Show help (see: foundry-worker --help)",
    "  --schema     Print JSON Schema",
    "  --man        Show complete manual",
    "",
    "COMMON EXAMPLES:",
    ...renderExamples(commandHelpExamples(command)),
    "",
    "COMMON ERRORS:",
    ...renderErrors([...(command.errors ?? []), ...commonErrors].slice(0, 5)),
    "",
    "SEE ALSO:",
    "  foundry-worker --commands",
    "  foundry-worker --help",
  ].join("\n");
}

function renderCommandUsage(command: CliCommandContract): string {
  return [
    `@USAGE ${commandPath(command)}`,
    "",
    `BRIEF: ${command.brief}`,
    "",
    "SYNTAX:",
    `  ${commandSyntax(command)}`,
    "",
    "EXAMPLES:",
    ...renderExamples(command.examples.slice(0, 5)),
  ].join("\n");
}

function renderRootMan(version: string): string {
  return [
    "@MAN foundry-worker",
    "",
    "NAME",
    `  foundry-worker ${version} - local Foundry workspace and daemon CLI`,
    "",
    "SYNOPSIS",
    "  foundry-worker <command> [arguments] [options]",
    "",
    "DESCRIPTION",
    "  Manages local workspaces, daemon pairing, runtime connectivity, and user services.",
    "",
    "SCHEMA",
    JSON.stringify(rootSchema(version), null, 2),
    "",
    ...renderManualTail(commonErrors),
  ].join("\n");
}

function renderCommandMan(command: CliCommandContract): string {
  return [
    `@MAN ${commandPath(command)}`,
    "",
    "NAME",
    `  ${commandPath(command)} - ${command.brief}`,
    "",
    "SYNOPSIS",
    `  ${commandSyntax(command)}`,
    "",
    "DESCRIPTION",
    `  ${command.description}`,
    "",
    "OPTIONS",
    ...renderOptions([...(command.options ?? []), ...documentationOptions]),
    "",
    "ARGUMENTS",
    ...renderArguments(command.arguments ?? []),
    "",
    "ENUMS",
    "  None.",
    "",
    "SCHEMA",
    JSON.stringify(commandSchema(command), null, 2),
    "",
    "EXAMPLES",
    ...renderExamples(command.examples),
    "",
    ...renderManualTail([...(command.errors ?? []), ...commonErrors]),
  ].join("\n");
}

function renderManualTail(errors: CliErrorContract[]): string[] {
  return [
    "EXIT CODES",
    "  0 Success",
    "  1 Generic command failure",
    "  2 Argument error",
    "  3 Authentication failure",
    "  4 Permission denied",
    "  5 Resource not found",
    "  6 Conflict",
    "  7 Rate limit",
    "  8 Server error",
    "",
    "ERRORS",
    ...renderErrors(errors),
    "",
    "CAVEATS",
    "  Remote servers require TLS. Workers pair once with a token and then use their own device credential.",
    "  Provider credentials, environment variables, and commands are local-only.",
    "",
    "COMPATIBILITY",
    "  Requires Node.js 20 or newer.",
    "",
    "SEE ALSO",
    "  foundry-worker --help",
    "  foundry-worker --commands",
  ];
}

function commandSyntax(command: CliCommandContract): string {
  const argumentSyntax = (command.arguments ?? [])
    .map((argument) =>
      argument.required ? `<${argument.name}>` : `[${argument.name}]`,
    )
    .join(" ");
  const optionSyntax = (command.options ?? []).length > 0 ? " [options]" : "";
  return `${commandPath(command)}${argumentSyntax ? ` ${argumentSyntax}` : ""}${optionSyntax}`;
}

function renderArguments(argumentsContract: CliArgumentContract[]): string[] {
  if (argumentsContract.length === 0) {
    return ["  None."];
  }
  return [
    "  Name              Type        Required  Description",
    "  --------------------------------------------------------------",
    ...argumentsContract.map(
      (argument) =>
        `  ${argument.name.padEnd(17)} ${"string".padEnd(11)} ${(argument.required ? "yes" : "no").padEnd(9)} ${argument.description}`,
    ),
  ];
}

function renderOptions(options: CliOptionContract[]): string[] {
  if (options.length === 0) {
    return ["  None."];
  }
  return [
    "  Name              Type        Required  Default    Description",
    "  -------------------------------------------------------------------------------",
    ...options.map((option) => {
      const name = option.shortName
        ? `${option.name}, ${option.shortName}`
        : option.name;
      return `  ${name.padEnd(17)} ${option.type.padEnd(11)} ${"no".padEnd(9)} ${(option.defaultValue ?? "-").padEnd(10)} ${option.description}`;
    }),
  ];
}

function renderExamples(examples: CliExample[]): string[] {
  return examples.flatMap((example) => [
    `  # ${example.label ? `[${example.label}] ` : ""}${example.description}`,
    `  ${example.command}`,
  ]);
}

function commandHelpExamples(command: CliCommandContract): CliExample[] {
  return [
    ...command.examples,
    {
      command: `${commandPath(command)} --schema | jq '.properties'`,
      description: "Inspect option fields as JSON.",
      label: "PIPELINE",
    },
    {
      command: `${commandPath(command)} --man`,
      description: "Open the complete command manual.",
    },
  ];
}

function renderErrors(errors: CliErrorContract[]): string[] {
  return [
    "  CODE   NAME                 DESCRIPTION                         FIX",
    "  --------------------------------------------------------------------------------",
    ...errors.map(
      (error) =>
        `  ${error.code.padEnd(6)} ${error.name.padEnd(20)} ${error.description.padEnd(35)} ${error.fix}`,
    ),
  ];
}

function renderCommands(prefix: string[] = []): string {
  return JSON.stringify(
    cliCommands
      .filter((command) =>
        prefix.every((segment, index) => command.path[index] === segment),
      )
      .map((command) => ({
        brief: command.brief,
        path: commandPath(command),
        schema: `${commandPath(command)} --schema`,
        syntax: commandSyntax(command),
      })),
    null,
    2,
  );
}

function rootSchema(version: string): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
    description: `foundry-worker ${version} command selection`,
    properties: {
      command: {
        description: "Command path",
        enum: cliCommands.map((command) => command.path.join(" ")),
        example: "setup",
        type: "string",
      },
    },
    required: ["command"],
    type: "object",
  };
}

function commandSchema(command: CliCommandContract): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const argument of command.arguments ?? []) {
    properties[argument.name] = {
      description: argument.description,
      example: argument.name === "path" ? "/Users/you/work/project" : "value",
      type: "string",
    };
    if (argument.required) {
      required.push(argument.name);
    }
  }
  for (const option of command.options ?? []) {
    const name = option.name
      .replace(/^--/, "")
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    properties[name] = {
      default: option.defaultValue,
      description: option.description,
      example: optionExample(option),
      type: schemaType(option.type),
    };
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
    description: command.brief,
    properties,
    required,
    title: commandPath(command),
    type: "object",
  };
}

function schemaType(type: CliOptionType): "boolean" | "integer" | "string" {
  if (type === "bool") {
    return "boolean";
  }
  if (type === "int") {
    return "integer";
  }
  return "string";
}

function optionExample(option: CliOptionContract): boolean | number | string {
  if (option.type === "bool") {
    return false;
  }
  if (option.type === "int") {
    return option.name === "--lines" ? 80 : 2500;
  }
  if (option.type === "url") {
    return "http://127.0.0.1:31982";
  }
  if (option.name === "--workspace") {
    return "/Users/you/work/project";
  }
  if (option.name === "--token") {
    return "pairing-token";
  }
  return "value";
}
