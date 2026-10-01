/** The Feishu Bot: credentials and pairing. */
export const feishu = {
  readOnlyTitle: "Read-only access",
  notices: {
    loadFailed: "Could not load the Feishu Bot settings: {{error}}",
    appIdRequired: "Enter the Feishu app's App ID.",
    saved: "Feishu app credentials saved. Opening the long connection…",
    saveFailed: "Could not save: {{error}}",
    codeIssued: "Pairing code {{code}} is ready. Send it in the Feishu group.",
    codeFailed: "Could not generate a pairing code: {{error}}",
    unbindConfirm: "Unbind the current Feishu group from this workspace?",
    unbound: "The Feishu group is no longer linked.",
    unbindFailed: "Could not unbind: {{error}}",
    commandCopied: "Pairing command copied to the clipboard.",
    commandText: "The command: {{command}}",
  },
  credentials: {
    title: "Feishu Bot app",
    intro:
      "Set up a Feishu custom app for this workspace. Foundry receives group topics and messages over a WebSocket long connection.",
    status: {
      connected: "Connected",
      connecting: "Connecting",
      error: "Connection error",
      notConfigured: "Not set up",
    },
    appId: "App ID (the app's unique identifier)",
    appIdPlaceholder: "For example: cli_a1b2c3d4e5f6g7h8",
    appSecret: "App Secret (the app's credential key)",
    appSecretSaved: "•••••••••••••••• (saved; enter a new secret to change it)",
    appSecretPlaceholder: "Enter the App Secret",
    showGuide: "Feishu Open Platform setup guide",
    hideGuide: "Hide the custom app guide",
    saving: "Connecting…",
    save: "Save and connect",
    guideTitle: "Setting up a Feishu Bot",
    openPlatform: "Feishu Open Platform",
    guide: {
      step1:
        "Create a custom app on the Open Platform and turn on <b>Bot</b> under Add app capabilities.",
      step2:
        "Under Events & callbacks, choose <b>Long connection (WebSocket)</b> as the subscription mode.",
      step3:
        "Add the <code>im.message.receive_v1</code> (receive messages) event to the event list.",
      step4:
        "Under Permissions, request <code>im:message</code> (read and send direct and group messages) and <code>im:chat</code>. <b>To let people follow up inside a topic without @-mentioning the bot again</b>, also request <code>im:message.group_msg</code> (read all messages in groups).",
      step5:
        "Create and publish an app version, then enter its credentials above to connect.",
    },
  },
  pairing: {
    title: "Feishu group pairing",
    intro:
      "Link a Feishu group to the workspace <b>{{workspace}}</b>. Each topic in the group becomes its own Foundry agent session.",
    bound: "Group linked",
    unbound: "No group linked",
    defaultChatName: "Feishu group",
    chatId: "Group ID: <code>{{id}}</code>",
    unbind: "Unbind",
    mentionCommand: "@bot <your request>",
    pairCommand: "@bot /pair <pairing code>",
    readyHint:
      "💡 <b>Ready</b>: send <code>{{command}}</code> in the group to start a session. The bot streams reply cards in that topic (thread), and follow-up posts in the topic continue the work as further instructions.",
    stepsIntro: "Two steps link a group:",
    step1: "Add your Feishu Bot to the target Feishu group.",
    step2:
      "In the group, @-mention the bot with the pairing command: <code>{{command}}</code>.",
    identityHint:
      "Requests from the group run as <b>the account that generated the pairing code</b> and are limited by that account's permissions in this workspace (Member or higher).",
    commandLabel: "Pairing command (valid for 10 minutes)",
    copyCommand: "Copy command",
    regenerate: "Generate a new pairing code",
    generating: "Generating…",
    generate: "Generate a pairing code",
  },
};
