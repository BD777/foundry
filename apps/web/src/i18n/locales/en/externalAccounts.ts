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
  },
  list: {
    emptyTitle: "No Feishu accounts yet",
    emptyBody:
      "Connect a Feishu account so feishu-cli in your sessions works as you.",
    notBound: "Not bound to a workspace",
    workspaces_one: "Bound to {{count}} workspace",
    workspaces_other: "Bound to {{count}} workspaces",
  },
  providers: {
    feishu: "Feishu",
  },
  feishu: {
    intro:
      "Your connected Feishu accounts, each with its organisation and the Feishu app it signed in through. feishu-cli in your sessions uses them to work in Feishu as you.",
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
    revokeTitle: "Stop using {{name}} now?",
    revokeBody:
      "Revokes the login at Feishu and cuts off running sessions at once. The account stays listed until you remove it; reconnect to use it again.",
    remove: "Remove",
    removeTitle: "Remove {{name}}?",
    removeBody:
      "Revokes the login at Feishu and deletes the account and its workspace bindings. Connect it again to use it.",
    more: "More actions for {{name}}",
    reconnect: "Reconnect",
    reauthorize: "Re-authorize",
    working: "Working…",
  },
  notices: {
    connected: "Connected {{name}}.",
    reauthorized: "Re-authorized {{name}}.",
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
    instance: "Organization app",
    personal: "Your app",
    defaultName: "Feishu app {{id}}",
    authorize: "Sign in through it",
    noAccounts: "No account connected through this app.",
    remove: "Remove app",
    removeTitle: "Remove {{name}}?",
    removeBody:
      "Foundry forgets the app and its secret. The app itself stays in Feishu's developer console.",
    replaceSecret: "Replace app secret",
    rotateHint:
      "Devices held the secret of {{name}} before sessions went through Foundry. Reset it in the Feishu developer console, then replace it here at once: until then Foundry cannot use the app.",
    rotateOpenConsole: "Open the app's credentials",
    showTenantName:
      "Show the full company name (needs an app permission in Feishu)",
    newSecretLabel: "New app secret for {{name}}",
    newSecretHint:
      "Needed only after you reset the secret in Feishu's developer console. Sealed on the server and checked with Feishu first; accounts connected through the app keep working.",
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
      openBot: "Open the channels of {{name}}",
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
    switchToLark:
      "Using Lark (international)? Open the Lark sign-in page instead",
    switchToFeishu:
      "Using Feishu (China)? Open the Feishu sign-in page instead",
    brandHint: "Your account's region is detected after you scan.",
    teamApp: "Use your team's app {{name}}",
    teamAppMeta: "Shared by an administrator · one scan, no new app",
    newAppInstead: "Create a new app instead",
    restart: "Restart with these settings",
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
    cancel: "Cancel",
  },
  authorize: {
    reauthorizeTitle: "Re-authorize {{name}}",
    reauthorizeBody:
      "Sign in again as the same Feishu user through {{app}}. The account keeps its workspaces and settings.",
    anotherTitle: "Sign in through {{app}}",
    anotherBody:
      "One scan: the Feishu user who scans authorizes this app and is connected as an account here.",
  },
  workspace: {
    rule: "Only sessions you start, on devices you own, use your accounts. Other members see that an account is bound, not whose it is.",
    binding: {
      feishu:
        "A bound account lets feishu-cli in your sessions here work in Feishu as you.",
    },
    others: "Bound by other members",
    use: "Use {{name}} in this workspace",
    empty: "You have no {{provider}} account yet.",
    connect: "Connect {{provider}} account",
    manage: "Manage connectors",
    loading: "Loading accounts…",
    loadFailed: "Could not load this workspace's accounts: {{error}}",
    saveFailed: "Could not change the binding: {{error}}",
    bound: "{{name}} is used in this workspace.",
    unbound: "{{name}} is no longer used in this workspace.",
    notUsable: "{{status}}: sessions cannot use it until you reconnect it.",
  },
  linkQr: {
    body: "Best done on a computer: open the link and sign in to Feishu there. The QR code opens the page on your phone, but Feishu's developer console may not work well on mobile.",
    tenantTitle: "Show the full company name",
    tenantDescription:
      "Enable the app permission tenant:tenant:readonly in Feishu, then choose Refresh now on the account.",
  },
};
