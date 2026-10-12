/** Connectors: external services sessions use as the person (Feishu first). */
export const externalAccounts = {
  page: {
    title: "Connectors",
    intro:
      "External services your sessions use as you. Foundry keeps each login and app secret on the server; sessions you start, on a device you own, in a workspace you bound the account to, reach Feishu through Foundry and hold no credential on the device.",
    tabs: "Connector types",
    loading: "Loading Feishu accounts…",
    loadFailed: "Could not load Feishu accounts: {{error}}",
    secretsMissing:
      "This server has no secret-store key, so it cannot keep logins. An administrator has to configure one before accounts can be connected.",
    actionsNote:
      "Stop using now revokes the login at the platform and cuts off running sessions at once. Remove also deletes the account and its workspace bindings.",
  },
  list: {
    title: "Accounts",
    count_one: "{{count}} account",
    count_other: "{{count}} accounts",
    emptyTitle: "No Feishu accounts yet",
    emptyBody:
      "Connect a Feishu account so feishu-cli in your sessions works as you.",
    usedBy: "{{provider}} · used by {{tools}}",
    identityUnknown: "Identity not read",
    tenant: "tenant {{tenant}}",
    app: "app {{app}}",
    notBound: "Not bound to a workspace",
    workspaces_one: "Bound to {{count}} workspace",
    workspaces_other: "Bound to {{count}} workspaces",
  },
  providers: {
    feishu: "Feishu",
  },
  feishu: {
    intro:
      "Your Feishu logins. feishu-cli in your sessions uses them to work in Feishu as you.",
    connect: "Connect Feishu account",
  },
  status: {
    ready: "Ready",
    expiring: "Expires soon",
    needs_reauth: "Needs re-authorization",
    revoked: "Revoked",
  },
  statusDetail: {
    refresh_token_expired:
      "The login lapsed after a week without use. Reconnect to use it again.",
    authorization_expired:
      "The authorization reached its one-year limit. Reconnect to use it again.",
    revoked: "Revoked at the platform. Reconnect to use it again.",
    other:
      "The platform refused the last refresh ({{detail}}). Reconnect to use it again.",
  },
  keepAlive: {
    label: "Keep alive",
    on: "Kept alive by Foundry · last refreshed {{when}}",
    onNever: "Kept alive by Foundry · not refreshed yet",
    off: "Not kept alive · lapses {{when}} unless a session uses it",
    offUnknown: "Not kept alive · lapses after a week without use",
    lastRefreshed: "Last refreshed {{when}}",
  },
  actions: {
    refresh: "Refresh now",
    revoke: "Stop using now",
    revokeConfirm: "Revoke now?",
    remove: "Remove",
    removeConfirm: "Remove for good?",
    reconnect: "Reconnect",
    working: "Working…",
  },
  notices: {
    connected: "Connected {{name}}.",
    refreshed: "{{name}} was refreshed.",
    revoked: "{{name}} is revoked. Sessions lost access to it.",
    removed: "{{name}} was removed.",
    keepAliveOn: "Foundry keeps {{name}} alive.",
    keepAliveOff: "{{name}} is no longer kept alive.",
    appRemoved: "{{name}} was removed.",
    secretReplaced: "{{name}} uses its new secret.",
    failed: "{{error}}",
  },
  apps: {
    title: "Feishu apps",
    intro:
      "A Feishu login belongs to one app. Connect through the organization app an administrator set up, or through your own app.",
    instance: "Organization app",
    personal: "Your app",
    empty: "No app yet. Connecting an account creates one for you.",
    remove: "Remove app",
    removeConfirm: "Remove app?",
    replaceSecret: "Replace secret",
    rotateHint:
      "Devices held this app's secret before sessions went through Foundry. Reset it in the Feishu developer console, then replace it here at once: until then Foundry cannot use the app.",
    rotateOpenConsole: "Open the app's credentials",
    newSecretLabel: "New app secret",
    newSecretHint:
      "Sealed on the server and checked with Feishu first; accounts connected through the app keep working.",
    saveSecret: "Save secret",
    uses: {
      label: "Used by",
      bots: "Workspace bot in",
      workspaceChats_one: "{{name}} ({{count}} chat)",
      workspaceChats_other: "{{name}} ({{count}} chats)",
      otherWorkspaces_one: "{{count}} workspace you cannot see",
      otherWorkspaces_other: "{{count}} workspaces you cannot see",
      subscriptions_one: "{{count}} agent event subscription",
      subscriptions_other: "{{count}} agent event subscriptions",
      unused: "No workspace bot or agent event subscription uses this app.",
      openBot: "Open the Feishu Bot of {{name}}",
      connected: "Connected",
      connecting: "Connecting",
      error: "Not connected",
      lastEvent: "last event {{when}}",
    },
  },
  connect: {
    title: "Connect a Feishu account",
    description:
      "Scan a QR code with Feishu (or open the link), confirm there, and this dialog finishes by itself. Foundry never sees your password.",
    appLabel: "Connect through",
    newFeishuApp: "A new Feishu app, created as you scan",
    newLarkApp: "A new Lark app (international), created as you scan",
    newAppMeta: "Nothing to paste · recommended",
    newAppHint:
      "Two confirmations in Feishu: create a personal app for Foundry, then authorize it. Foundry keeps the app's credentials sealed on the server.",
    existingAppHint: "One confirmation in Feishu: authorize this app.",
    scopesPreset_one: "Asks for {{count}} Feishu permission",
    scopesPreset_other:
      "Asks for {{count}} Feishu permissions, covering Foundry's Feishu skills",
    scopesNamed_one: "Asks for the {{count}} permission you listed",
    scopesNamed_other: "Asks for the {{count}} permissions you listed",
    scopesSource: "Source: {{source}}.",
    advanced: "Advanced",
    approvalLabel_one:
      "Also ask for {{count}} permission that may need admin approval",
    approvalLabel_other:
      "Also ask for {{count}} permissions that may need admin approval",
    approvalHint:
      "Named by the Feishu skills but outside feishu-cli's auto-approved set; your tenant admin may have to approve them: {{scopes}}.",
    ownApp: "Use my own app (App ID and secret)",
    ownAppMeta: "For an app you created in the Feishu developer console.",
    appIdLabel: "App ID",
    appIdPlaceholder: "cli_…",
    appSecretLabel: "App secret",
    appSecretHint:
      "Sealed on the server and never shown again. It never leaves the server: sessions reach Feishu through Foundry.",
    baseUrlLabel: "Open API base URL (optional)",
    baseUrlPlaceholder: "https://open.feishu.cn",
    baseUrlHint:
      "Empty means Feishu (open.feishu.cn). For Lark use https://open.larksuite.com.",
    shareLabel: "Offer this app to everyone on this server",
    shareHint: "Admins only. Each person still signs in as themselves.",
    nameLabel: "Name (optional)",
    namePlaceholder: "Work Feishu",
    scopesLabel: "Permissions (optional)",
    scopesHint:
      "Space-separated Feishu scopes that replace the list above. Foundry always adds offline_access and auth:user.id:read.",
    scopesPlaceholder: "docx:document:readonly search:docs:read",
    appIdRequired: "Enter the app ID.",
    appSecretRequired: "Enter the app secret.",
    start: "Show QR code",
    starting: "Starting…",
    qrTitle: "QR code to open in Feishu",
    stepOf: "Step {{step}} of 2",
    registerTitle: "Create Foundry's app",
    registerBody:
      "Scan with the Feishu app, or open the link and sign in. Confirm creating the app; Feishu returns its credentials to Foundry.",
    authorizeTitle: "Authorize Foundry",
    authorizeBody:
      "The app exists. Scan this new code and approve, so sessions can work in Feishu as you.",
    loginTitle: "Authorize Foundry",
    loginBody:
      "Scan with the Feishu app, or open the link and sign in, then approve.",
    userCode: "Code",
    openPage: "Open link",
    copyLink: "Copy link",
    waitingApp: "Waiting for you to confirm the app · expires in {{time}}",
    waiting: "Waiting for approval · expires in {{time}}",
    expired: "The code expired before it was approved.",
    failed: "Sign-in failed: {{error}}",
    tryAgain: "Try again",
    partialTitle:
      "Connected {{name}}, with {{granted}} of {{requested}} permissions",
    partialBody_one:
      "Feishu did not grant {{count}} permission. Apply for it on the app's permission page (an admin may have to approve), then reconnect.",
    partialBody_other:
      "Feishu did not grant {{count}} permissions. Apply for them on the app's permission page (an admin may have to approve), then reconnect.",
    missingList_one: "{{count}} permission not granted",
    missingList_other: "{{count}} permissions not granted",
    applyScopes: "Apply for the missing permissions",
    done: "Done",
    close: "Close",
    cancel: "Cancel",
  },
  workspace: {
    rule: "Only sessions you start, on devices you own, use your accounts. Other members see that an account is bound, not whose it is.",
    mine: "Your accounts",
    others: "Bound by other members",
    use: "Use {{name}} in this workspace",
    emptyMine: "You have no connected accounts yet.",
    connect: "Connect an account",
    manage: "Manage connectors",
    otherAccount: "{{provider}} account {{name}}",
    loading: "Loading accounts…",
    loadFailed: "Could not load this workspace's accounts: {{error}}",
    saveFailed: "Could not change the binding: {{error}}",
    bound: "{{name}} is used in this workspace.",
    unbound: "{{name}} is no longer used in this workspace.",
    notUsable: "{{status}}: sessions cannot use it until you reconnect it.",
  },
};
