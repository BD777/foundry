/** Connectors: external services sessions use as the person (Feishu first). */
export const externalAccounts = {
  cloudflare: {
    requestedPermissions: "Requested permissions",
    revokePending:
      "Foundry access is stopped. Cloudflare revocation is pending; retry disconnect.",
    unverifiedZone:
      "This saved zone is not in the loaded list. Load more, check permissions, or remove it.",
    verificationPending:
      "Approval received. Identity verification or saving is still pending; this operation retries without another authorization.",

    unknownOperation:
      "This authorization is no longer known. Refresh connections before starting again; any saved login is preserved.",
    intro:
      "Cloudflare identities stay on the server. Select the zones each workspace may read.",
    connect: "Connect Cloudflare",
    refresh: "Refresh",
    empty: "No Cloudflare identity connected.",
    noSecretStore:
      "The server secret store must be configured before connecting.",
    identityConfirmed:
      "Identity verified at sign-in · resource access depends on granted permissions",
    needsAuth: "Authorization required",
    permissions: "Granted permissions",
    reauthorize: "Re-authorize",
    revoke: "Disconnect authorization",
    revokeDetail:
      "Stop this authorization and all workspace access through it. This does not change DNS records.",
    workspace: "Workspace",
    chooseWorkspace: "Choose a workspace you manage",
    connected:
      "Cloudflare identity connected. Review the zones enabled for each workspace.",
    authorizeDetail:
      "Open the official Cloudflare page in this browser and approve read access. Return here to select workspace zones. Closing this dialog does not revoke an approval already being verified.",
    preparing: "Preparing official authorization…",
    waiting: "Waiting for your approval on Cloudflare…",
    verifying: "Verifying your Cloudflare identity…",
    openAuthorization: "Open Cloudflare authorization",
    workspaceAccess: "Workspace access",
    bindingDetail:
      "Only your sessions on your own devices can read the selected zones, DNS and certificate metadata.",
    identity: "Cloudflare identity",
    chooseIdentity: "Choose an identity",
    discovering: "Checking accessible zones…",
    discoveryFailed:
      "Cloudflare could not list zones. Check the granted permissions.",
    more: "Load more zones",
    save: "Save selected zones",
    refreshZones: "Check zones again",
    removeBinding: "Remove workspace binding",
    bound: "Cloudflare resource binding saved.",
    unbound:
      "Workspace access removed; the Cloudflare login remains connected.",
    consumption:
      "Bound sessions can use the Cloudflare MCP tool. The cf CLI also needs an updated execution worker and the installed official CLI. Credentials are never copied to the device.",
  },
  page: {
    title: "Connectors",
    intro:
      "External services your sessions use as you. Each tab explains where credentials are kept and how to connect. Workspace bindings control which connections are provided to sessions.",
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
    aws: "AWS CLI",
    cloudflare: "Cloudflare",
    feishu: "Feishu",
    bytedcli: "bytedcli",
  },
  feishu: {
    intro:
      "Your connected Feishu accounts, each with its organisation and the Feishu app it signed in through. Foundry keeps each login and app secret on the server; feishu-cli in your sessions reaches Feishu through Foundry as you and holds no credential on the device.",
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
  deviceStatus: {
    ready: "Base login ready",
    expiring: "Expires soon",
    expired: "Expired",
    signed_out: "Signed out",
    not_installed: "Not installed",
    unavailable: "Not available here",
    error: "Could not read",
  },
  deviceHeld: {
    setup: {
      aws: "Install AWS CLI using AWS’s official installer on the device. Configure credentials in its terminal (for SSO: aws configure sso, then aws sso login), then select Check again. Named profiles must be selected in the worker’s AWS_PROFILE environment. Authentication and sign-out are managed in the terminal. Your sessions on that device can use its ready login automatically.",
    },
    offlineUnknown: "Device offline",
    intro: {
      aws: "AWS CLI uses this device’s native credential chain (AWS_PROFILE or default, environment credentials, SSO or device roles). Foundry checks the current identity with STS; credentials stay on the device. This does not verify permissions for other AWS services.",
      bytedcli:
        "bytedcli keeps its ByteDance sign-in on each device, and Foundry never copies it anywhere. Your sessions on that device can use its ready login automatically. Share it with other workspace members from Workspace → Connectors.",
      default:
        "{{name}} keeps its sign-in on each device, and Foundry never copies it anywhere.",
    },
    loading: "Reading your devices…",
    loadFailed: "Could not read your devices: {{error}}",
    unknown: "This server does not know the connector {{kind}}.",
    checkAll: "Check again",
    checking: "Checking…",
    checkAgain: "Check again",
    emptyTitle: "No device can use {{name}} yet",
    emptyBody:
      "Pair a device that can reach where {{name}} works; it shows up here.",
    notOffered:
      "Not offered on {{devices}}: {{name}} needs access to the {{requirement}}, which they do not have.",
    notRead: "Not checked yet",
    notInstalled: "{{name}} is not installed",
    notSignedIn: "Not signed in",
    readFailed: "Could not read the sign-in: {{detail}}",
    signedIn: "Signed in",
    signedInAs: "Signed in as {{name}}",
    sites: "site {{sites}}",
    expires: "expires {{when}}",
    expired: "expired {{when}}",
    versionFoundry: "{{name}} {{version}}, installed by Foundry",
    versionDevice: "{{name}} {{version}}, the device's own",
    checked: "checked {{when}}",
    offline: "Offline · last read {{when}}",
    workerTooOld:
      "This device's worker is too old for {{name}}; update it from Devices.",
    install: "Install",
    installing: "Installing {{name}}; this can take a few minutes…",
    upgrade: "Upgrade to {{version}}",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    signOut: "Sign out",
    signOutTitle: "Sign {{name}} out on {{device}}?",
    signOutBody:
      "Runs {{name}}'s own sign-out on the device. Sessions there lose the sign-in until you sign in again.",
    reminderExpiring: "{{name}} on {{device}} expires {{when}}.",
    reminderExpired: "{{name}} on {{device}} expired {{when}}.",
    checkedNotice: "Read {{name}} on {{device}} again.",
    installed: "{{name}} is installed on {{device}}.",
    signedOut: "{{name}} on {{device}} is signed out.",
    signedInNotice: "{{name}} is signed in on {{device}}.",
  },
  authorization: {
    separate:
      "Additional capabilities use their own authorization. They do not share the Feishu account connected above.",
    localOnly:
      "Local credential status; business permissions have not been tested.",
    workerUpgrade:
      "Update this device’s worker to check and authorize this capability.",
    checked: "Checked {{when}}",
    authorize: "Authorize capability",
    prepare: "Prepare existing login",
    nativeQr: "Native authorization QR code",
    scanNative:
      "Scan this original QR code with the provider’s mobile app. Keep this page open while it finishes.",
    imageExpired:
      "This authorization image is no longer available. Restart authorization.",
    status: {
      ready: "Local credential ready",
      needs_auth: "Needs authorization",
      expired: "Expired",
      unknown: "Not verified",
      unavailable: "Unavailable",
    },
    reason: {
      bootstrap_available:
        "A saved native session may be reusable; preparing it does not repeat the base login.",
      cli_upgrade: "Update the installed CLI to support this authorization.",
      check_failed: "Could not check this capability. Base login is unchanged.",
    },
  },
  deviceSignIn: {
    connectionUncertain:
      "Connection interrupted: {{error}}. Retry to check the same authorization.",
    reconnecting:
      "Waiting for the device to confirm this step. This authorization will resume automatically; no new sign-in is started.",
    phase: {
      checking: "Checking the existing login on {{device}}…",
      starting: "Preparing authorization on {{device}}…",
      awaiting_user: "Waiting for you to approve…",
      verifying: "Verifying the device login…",
    },

    unverified: "The device has not confirmed a usable login.",
    title: "Sign in to {{name}}",
    description:
      "{{device}} starts {{name}}'s own sign-in; the sign-in stays on that device.",
    starting: "Asking {{device}} to start the sign-in…",
    approveTitle: "Approve on the sign-in page",
    approveBody:
      "Open the page here, or scan the code with your phone, and approve the request. {{name}} on the device finishes the sign-in.",
    waiting: "Waiting for you to approve…",
    expired: "The sign-in request expired.",
    denied: "The sign-in request was denied.",
    failed: "The sign-in did not finish: {{error}}",
  },
  workspace: {
    ownerAvailable: "Available to your sessions on {{device}}",
    localAuthentication:
      "Configure or renew {{name}} credentials in the device terminal, then check again. Manage connectors has setup instructions.",
    appUnavailable:
      "This account’s app is unavailable. Manage it in Connectors.",
    executionDevice: "Execution device",
    executionHint:
      "This setting applies only to sessions running on the selected device.",
    deviceScope: "Login on {{device}}",
    deviceOwnerOnly: "Only the execution device’s owner can manage its login.",
    lastRead:
      "Local login read {{when}}; service access has not been verified.",
    useExisting: "Use existing login",
    authorize: "Authorize and use here",
    signInDevice: "Sign in on device",
    enabled: "Enabled here",
    removeBinding: "Remove binding",
    retryBinding: "Retry saving binding",
    retrySharing: "Retry sharing change",
    nativeBoundary:
      "Your own sessions use this device’s ready login automatically. Sharing applies only to this workspace and device; turning it off keeps your own access. Manage device logins in Connectors.",

    rule: "Feishu accounts follow their workspace grants. Device logins apply only on their execution device.",
    binding: {
      feishu:
        "A bound account lets feishu-cli in your sessions here work in Feishu as you.",
      bytedcli:
        "Your sessions use bytedcli with their execution device’s ready login automatically; it never leaves the device.",
    },
    useDevice: "Sessions on {{device}} use its {{name}} sign-in",
    members: "Share with sessions other members start on {{device}}",
    membersHint:
      "They use your identity and permissions in this service. Leave off unless you mean to lend your sign-in.",
    noDevices:
      "None of your devices has {{name}} yet. Set it up from Manage connectors.",
    devicesLoadFailed: "Could not load the devices' sign-ins: {{error}}",
    deviceBound: "Sessions here on {{device}} use its {{name}} sign-in.",
    deviceUnbound: "The {{name}} binding on {{device}} was removed.",
    membersOn:
      "Other members' sessions on {{device}} may use its {{name}} sign-in here.",
    membersOff:
      "Only your own sessions on {{device}} use its {{name}} sign-in here.",
    othersOwner: "For its owner's sessions",
    othersMembers: "For every member's sessions on that device",
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
