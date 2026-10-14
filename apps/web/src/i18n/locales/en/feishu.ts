/** The Feishu bot channel: a Connectors app, its connection and the paired
 * chats. */
export const feishu = {
  notices: {
    loadFailed: "Could not load the Feishu bot: {{error}}",
    saved: "The bot now runs on {{app}}.",
    saveFailed: "Could not change the bot's app: {{error}}",
    removed:
      "The bot is removed from this workspace. {{app}} stays in Connectors.",
    removeFailed: "Could not remove the bot: {{error}}",
    codeIssued: "Pairing code {{code}} is ready. Send it in the Feishu chat.",
    codeFailed: "Could not generate a pairing code: {{error}}",
    unbound: "{{chat}} no longer sends messages here.",
    unbindFailed: "Could not unbind: {{error}}",
    nameRefreshed: "The chat's name is now {{chat}}.",
    nameUnchanged: "{{chat}} is still the chat's name in Feishu.",
    nameRefreshFailed:
      "Could not read the chat's name from Feishu; it stays {{chat}}. {{error}}",
    commandCopied: "Pairing command copied to the clipboard.",
    commandText: "The command: {{command}}",
  },
  status: {
    connected: "Connected",
    connecting: "Connecting",
    error: "Not connected",
    unconfigured: "Not set up",
  },
  app: {
    title: "Feishu bot",
    intro:
      "People reach this workspace from Feishu through the bot. It runs on a Feishu app from Connectors; Foundry keeps the app's secret and its one connection.",
    pick: "Feishu app",
    pickPlaceholder: "Choose a Feishu app",
    noChoices:
      "You have no Feishu app in Connectors yet. Connect one there, then pick it here.",
    connect: "Connect an app in Connectors",
    use: "Run the bot on this app",
    switch: "Switch app",
    switchConfirm: "Unbind {{count}} chats and switch?",
    switchHint:
      "Another Feishu app is a different bot: the chats paired with this one are unbound when you switch.",
    working: "Working…",
    manage: "Open in Connectors",
    otherOwner: "Managed in Connectors by its owner",
    personal: "Personal app",
    instance: "Organisation app",
    optionMeta: "{{whose}} · ID …{{id}}",
    lastEvent: "Last event {{when}}",
    noEvent: "No event since the server started",
    remove: "Remove bot",
    removeConfirm: "Remove the bot from this workspace?",
    rotateHint:
      "This secret was stored on devices before. Rotate it in Feishu, then paste the new one in Connectors.",
    rotateAction: "Update the secret",
    noSecret: "Paste the app's secret in Connectors",
    secretMissing:
      "This server holds no secret for the app, so the bot cannot connect.",
    setupTitle: "What the Feishu app needs",
    openPlatform: "Feishu Open Platform",
    guide: {
      step1:
        "A custom app with the <b>Bot</b> capability (Connectors can create one for you).",
      step2:
        "Under Events & callbacks, <b>Long connection (WebSocket)</b> as the subscription mode, with the <code>im.message.receive_v1</code> event.",
      step3:
        "The permissions <code>im:message</code> and <code>im:chat</code>; <code>im:message.group_msg</code> lets people follow up in a topic without mentioning the bot again.",
      step4: "A published app version.",
    },
  },
  chats: {
    title: "Chats",
    intro:
      "Each paired chat sends its messages to <b>{{workspace}}</b>. Every topic becomes its own agent session.",
    count_one: "{{count}} chat",
    count_other: "{{count}} chats",
    empty: "No chat is paired yet.",
    needsApp: "Pick the bot's app first; then pair chats here.",
    group: "Group",
    direct: "Direct chat",
    defaultGroupName: "Feishu group",
    defaultDirectName: "Direct chat with the bot",
    unbind: "Unbind",
    unbindConfirm: "Unbind this chat?",
    refreshName: "Refresh name",
    shortId: "…{{id}}",
    readyHint:
      "In a group, mention the bot with your request: <code>{{command}}</code>. In a direct chat, just write. The bot replies in a topic, and posts in that topic continue the work.",
    mentionCommand: "@bot <your request>",
    assistantBadge: "Assistant",
    movedToYourAssistant:
      "Your assistant answers this chat now. Turn that off in its settings to send it here again.",
    movedToAssistant:
      "The assistant of the person who paired it answers this chat now.",
    movedHere:
      "Paired with “{{workspace}}”; your assistant answers it. Unbind or rename it there.",
    otherWorkspace: "another workspace",
    assistantSettings: "Assistant settings",
  },
  pairing: {
    title: "Pair a chat",
    step1: "Add the bot to a Feishu group, or open a direct chat with it.",
    step2:
      "Send the pairing command there (in a group, mention the bot): <code>{{command}}</code>.",
    pairCommand: "/pair <pairing code>",
    identityHint:
      "Requests from the chat run as <b>the account that generated the pairing code</b>, with that account's permissions in this workspace (Member or higher).",
    commandLabel: "Pairing command (valid until {{time}})",
    copyCommand: "Copy command",
    regenerate: "Generate a new pairing code",
    generating: "Generating…",
    generate: "Generate a pairing code",
    pending:
      "A pairing code is waiting until {{time}}; generate a new one to see it again.",
  },
};
