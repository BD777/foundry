/**
 * Setting an external connection up on a device from the chat picker
 * (DEV-086, docs/external-connections.md "Setup on another device").
 */
export const connectionSetup = {
  picker: {
    setUp: "Set up…",
    viewProgress: "View progress…",
    finishSignIn: "Finish sign-in…",
    check: "Check…",
    retry: "Retry…",
    detail: {
      not_set_up: "Not set up on this device",
      in_progress: "Being set up on this device",
      waiting_sign_in: "Waiting for sign-in",
      unchecked: "Registered, not checked yet",
      check_failed: "Check failed: {{reason}}",
      check_failed_plain: "Check failed",
      setup_failed: "Setup failed: {{reason}}",
      setup_failed_plain: "Setup failed",
    },
  },
  dialog: {
    title: "Set up {{label}} on {{device}}",
    description:
      "One command installs and registers it on that device. Its progress shows here.",
    runAs:
      "Run this command on {{device}} as {{user}}, in a terminal signed in as that account.",
    runAsUnknown:
      "Run this command on {{device}}, in a terminal signed in as the account its Foundry worker runs as.",
    provenance: "Registered on {{source}} at {{time}} by connection {{id}}.",
    provenanceNoTime: "Registered on {{source}} by connection {{id}}.",
    commandLabel: "Setup command",
    copy: "Copy command",
    copied: "Copied",
    gatewayLink: "Gateway instructions",
    otherSetups: "Other devices registered a different setup command.",
    showOtherSetups: "Show the other commands",
    otherSetupFrom: "{{device}} · {{time}}",
    noCommand:
      "No setup command is registered for this connection. Run its gateway's installer on {{device}} again.",
    loadFailed: "The setup state could not be read: {{error}}",
    close: "Close",
    done: "Done",
    success: "Ready, selected for this chat.",
    successNotSelected: "Ready. Choose it in the picker to use it.",
  },
  remote: {
    run: "Set it up for me",
    hint: "Foundry runs exactly the command above on {{device}}. Only the sign-in step needs you.",
    starting: "Starting…",
    running: "Running on {{device}}",
    stop: "Stop",
    unavailable: {
      offline: "{{device}} is offline, so Foundry cannot run it there.",
      old_worker:
        "Update {{device}}'s Foundry worker to set connections up from here.",
      remote_commands_off:
        "Remote commands are off on {{device}}. Its owner can turn them on in Resources.",
    },
  },
  steps: {
    runDone: "Command started",
    check: "Check",
    checkFailed: "Check failed",
    title: "Progress",
    run: "Waiting for the command to run",
    installed: "Installed",
    signIn: "Waiting for sign-in",
    signedIn: "Signed in",
    registered: "Registered with Foundry",
    checked: "Check passed",
    checking: "Checking with one short conversation…",
  },
  signIn: {
    open: "Open sign-in page",
    code: "Code: {{code}}",
    hint: "Confirm the sign-in in your browser. This panel moves on by itself.",
  },
  check: {
    note: "Once it is registered, Foundry checks it with one short conversation (uses model quota).",
    retry: "Retry check",
  },
  failure: {
    setup: "Setup failed",
    check: "Check failed",
    exit: "The command exited with code {{code}}.",
    timedOut: "The command ran for 20 minutes and was stopped.",
    cancelled: "The command was stopped.",
    retry: "Retry",
  },
  stalled: {
    title: "No progress reported — check the terminal",
    body: "Nothing changed on {{device}} for 20 minutes. Look at the terminal where the command runs, then retry.",
  },
  log: {
    show: "Show log",
    truncated: "Earlier output was dropped.",
    empty: "No output yet.",
  },
};
