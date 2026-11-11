/** Connectors: external services sessions use as the person (Feishu first). */
export const externalAccounts = {
  connectorPackage: {
    title: "Where to enable",
    description:
      "Choose the devices where this package installs its tools and brings its Skills. A new device is never selected automatically.",
    enabled: "Enabled",
    notEnabled: "Not enabled",
    selected: "Enabled on this device.",
    available: "Online now. Select this device to enable the package here.",
    unavailable: "Cannot enable: {{reason}}",
    selectDevice: "Enable the package on {{device}}",
    reasons: {
      offline: "the device is offline.",
      platformUnknown: "the device has not reported a supported platform.",
      platformUnsupported: "Foundry tools run on Linux and macOS only.",
      nodeMissing: "the device has no Node.js runtime for repository tools.",
      unavailable: "the device is not ready for this package.",
      connectorUnavailable: "{{connector}} is not available on this device.",
      installConnector: "install the {{connector}} connector on this device.",
      signInConnector: "sign in to the {{connector}} connector on this device.",
    },
    tools: "Tools in this package",
    versionPending: "version available after a device is enabled",
    skills: "Skills in this bundle",
    skillsPending: "Skills appear here after the bundle is followed.",
    save: "Save devices",
    saving: "Saving devices…",
    saved: "Package devices saved.",
    saveFailed: "Could not save devices: {{error}}",
    loading: "Loading this package…",
    loadFailed: "Could not load this package: {{error}}",
    notListed:
      "This package is not listed for any of your devices. Install its extension on a device first.",
  },
  cloudflare: {
    authorizeSelected: "Continue to Cloudflare",
    usePreset: "Use Foundry's read-only set",
    loadingScopes: "Reading Cloudflare's scope list…",
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
      "Cloudflare identities stay on the server. Select the zones each workspace may use, and what its sessions may do there.",
    connect: "Connect Cloudflare",
    refresh: "Refresh",
    empty: "No Cloudflare identity connected.",
    noSecretStore:
      "The server secret store must be configured before connecting.",
    identityConfirmed:
      "Identity verified at sign-in · resource access depends on granted permissions",
    needsAuth: "Authorization required",
    identityVerified: "Identity verified at sign-in",
    copyUserId: "Copy Cloudflare user ID",
    copiedUserId: "Cloudflare user ID copied",
    scopeSummary: "Asked for {{asked}} · Granted {{granted}}",
    scopeSummaryGranted: "Granted {{granted}}",
    scopeSummaryWrite_one: "({{count}} write)",
    scopeSummaryWrite_other: "({{count}} write)",
    viewPermissions: "View permissions",
    filterPermissions: "Filter",
    filterPlaceholder: "Scope or product, e.g. dns",
    noPermissionMatch: "No permission matches “{{filter}}”.",
    foundryUses:
      "Foundry uses: your identity; the zones, DNS records and certificates of the zones each workspace selects; and DNS record changes in workspaces you set to DNS edit.",
    reauthorize: "Re-authorize",
    revoke: "Disconnect authorization",
    revokeDetail:
      "Stop this authorization and all workspace access through it. This does not change DNS records.",
    workspace: "Workspace",
    chooseWorkspace: "Choose a workspace you manage",
    connected:
      "Cloudflare identity connected. Review the zones enabled for each workspace.",
    authorizeDetail:
      "Open the official Cloudflare page in this browser and approve the permissions Foundry may use (DNS edit needs DNS write). Return here to select workspace zones. Closing this dialog does not revoke an approval already being verified.",
    preparing: "Preparing official authorization…",
    waiting: "Waiting for your approval on Cloudflare…",
    verifying: "Verifying your Cloudflare identity…",
    openAuthorization: "Open Cloudflare authorization",
    workspaceAccess: "Workspace access",
    bindingDetail:
      "Only your sessions on your own devices can use the selected zones, within the session access below.",
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
      "Bound sessions use the official cf CLI (or curl) through Foundry; the server decides every request, so a change of access applies to a running session at once. It needs the installed cf CLI and an updated Worker on the device. Credentials are never copied to the device.",
    accessTitle: "Session access",
    accessDetail:
      "What sessions in this workspace may do in the selected zones. A choice applies at once.",
    accessRead: "Read",
    accessReadDetail: "Zones, DNS records and certificate metadata.",
    accessDnsEdit: "Read + DNS edit",
    accessDnsEditDetail:
      "Also create, update and delete DNS records in the selected zones, such as A records or ACME TXT challenges. Each change is listed under Activity on the identity.",
    accessNeedsScopes:
      "Needs {{scopes}}, which this authorization does not include. Use Re-authorize on the identity and allow DNS write on Cloudflare's page.",
    accessGrantLost:
      "This workspace is set to {{level}}, but the authorization no longer includes {{scopes}}: changes are refused until you re-authorize.",
    accessSaved: "Session access set to {{level}}.",
    accessAfterSave:
      "Save the zones first, then choose what sessions may do in them.",
    activity: "Activity",
    activityCount_one: "Activity ({{count}})",
    activityCount_other: "Activity ({{count}})",
    activityRefresh: "Refresh activity",
    activityEmpty: "No changes through Foundry yet.",
    activitySession: "Session",
    activityAccessChanged: "Session access: {{from}} → {{to}}",
    activityResult: {
      succeeded: "Done",
      failed: "Failed",
      refused: "Refused",
    },
  },
  appstoreconnect: {
    addKey: "Add team key",
    refresh: "Refresh",
    intro:
      "App Store Connect team keys stay on the server. Sessions can manage only the apps this workspace binds, through Foundry's gateway.",
    teamKeyTitle: "Use a team key with the App Manager role",
    teamKeyBody:
      "Apple team keys can access every app the team owns. Foundry never passes the .p8 or a real JWT to a session; it checks each request and permits only bound apps. Price changes and review submission stay with the person in App Store Connect.",
    noSecretStore:
      "The server secret store must be configured before a team key can be sealed.",
    empty: "No App Store Connect team key has been added.",
    addTitle: "Add an App Store Connect team key",
    addDescription:
      "Download a .p8 team key in App Store Connect under Users and Access → Integrations. Upload it or paste its contents with the Issuer ID and Key ID.",
    replaceTitle: "Replace App Store Connect team key",
    replaceDescription:
      "Apple validates the new key before Foundry replaces the sealed one. The previous key stops working as soon as this succeeds.",
    replace: "Replace key",
    revoke: "Revoke key",
    revokeTitle: "Revoke {{name}}?",
    revokeDescription:
      "This immediately stops every session and removes App Store Connect access from its workspace bindings.",
    revokeBody:
      "The team key stays in Apple. Foundry deletes its sealed copy and refuses new requests. Adding the key again requires a fresh .p8.",
    revokeConfirm: "Revoke and stop access",
    revokedNotice: "Revoked {{name}}; App Store Connect sessions lost access.",
    savedNotice: "App Store Connect key {{name}} is validated and sealed.",
    issuer: "Issuer",
    keyId: "Key",
    issuerLabel: "Issuer ID",
    issuerPlaceholder: "00000000-0000-0000-0000-000000000000",
    issuerHelp:
      "Found above the team keys in App Store Connect. It is not secret.",
    keyIdLabel: "Key ID",
    keyIdPlaceholder: "ABCDE12345",
    keyIdHelp: "The short ID beside the downloaded .p8 file. It is not secret.",
    nameLabel: "Name (optional)",
    namePlaceholder: "Example: Our App Store team",
    teamKey:
      "Apple validates this key by reading the first app in your team. No app or product is changed.",
    privateKeyLabel: "Private key (.p8)",
    privateKeyPlaceholder: "-----BEGIN PRIVATE KEY-----",
    sourceLabel: "Private key input",
    uploadFile: "Upload file",
    pasteText: "Paste text",
    privateKeyHelp:
      "The .p8 is sent once to Foundry, validated, and sealed in the server secret store. It is never returned.",
    keyDiscarded:
      "The last .p8 was discarded from this form before submission finished. Re-select it before retrying.",
    validating: "Validating…",
    validate: "Validate and save",
    validationFailed: "Apple rejected this team key",
    editAndRetry: "Edit and retry",
    errors: {
      issuer: "Enter Apple's Issuer ID as a UUID.",
      keyId: "Enter Apple's 8–16 character Key ID.",
      privateKey: "Choose or paste Apple's .p8 private key.",
      fileTooLarge:
        "This file is larger than 16 KiB; choose the .p8 Apple downloaded.",
      fileRead: "This browser could not read the selected file.",
    },
    loadingApps: "Checking apps visible to this key…",
    appCount_one: "{{count}} app visible",
    appCount_other: "{{count}} apps visible",
    appsNotRead: "Apps have not been read yet.",
    refreshApps: "Check apps",
    noApps: "No apps are visible to this key.",
    unnamedApp: "App {{id}}",
    validatedTitle_one: "Key validated · {{count}} app visible",
    validatedTitle_other: "Key validated · {{count}} apps visible",
    validatedApps: "Visible apps: {{apps}}",
    validatedNoApps:
      "The key is valid but currently sees no apps. Check its App Manager role in App Store Connect.",
    loadFailed: "Could not load App Store Connect keys: {{error}}",
    workspaceAccess: "Workspace access",
    bindingDetail:
      "Choose the apps this workspace may manage. The team key can still access every app at Apple; Foundry refuses everything outside this selection.",
    workspace: "Workspace",
    chooseWorkspace: "Choose a workspace you manage",
    loadingBinding: "Loading this workspace's App Store Connect binding…",
    identity: "App Store Connect key",
    chooseIdentity: "Choose a team key",
    unverifiedApp:
      "This saved app is not in the current list. Check the key or deselect it.",
    accessTitle: "Session access",
    accessDetail:
      "Read allows GET requests. Commerce also allows creating and updating subscription groups, subscriptions, offers, localizations and review screenshots.",
    accessRead: "Read",
    accessReadDetail:
      "Apps, subscription groups, subscriptions, prices and localized metadata.",
    accessCommerce: "Read + commerce",
    accessCommerceDetail:
      "Also creates and updates subscription groups, subscriptions, introductory offers, localizations and review screenshots. Price changes and review submission stay in App Store Connect.",
    saveBinding: "Save apps and access",
    removeBinding: "Remove workspace binding",
    boundNotice: "Bound the selected apps for {{name}} in this workspace.",
    unboundNotice:
      "Removed App Store Connect apps for {{name}} from this workspace.",
    consumption:
      "Sessions receive ASC_API_BASE_URL and a revocable ASC_API_TOKEN. curl reaches only the apps and access this workspace binds; changing the level applies to a running session at its next request.",
  },
  page: {
    title: "Connectors",
    intro:
      "External services your sessions use as you. Pick a connector to see where its credentials are kept and how to connect. Workspace bindings control which connections are provided to sessions.",
    picker: {
      label: "Connector",
      search: "Search connectors",
      noMatch: "No connector matches.",
      public: "Public",
      publicSource: "Built into Foundry",
      private: "Private",
      privateSource:
        "From connector extensions on your devices, visible only to you",
      connected: "Connected",
      signedIn: "Signed in",
      lastSignedIn: "Last seen signed in",
      needsSignIn: "Needs sign-in",
      notSetUp: "Not set up",
    },
    restricted: {
      title_one: "Needs access ({{count}})",
      title_other: "Needs access ({{count}})",
      notChecked: "Not checked on this device yet.",
      requirementFailed:
        "Needs to reach {{label}} ({{host}}:{{port}}). This device cannot connect; use it on a device on that network.",
      requirementMet: "Can reach {{label}}.",
      accessMet: "{{via}} account {{account}} can read {{repository}}.",
      accessMetAnonymous: "{{via}} can read {{repository}}.",
      notSignedIn:
        "{{via}} is not signed in on this device, so it cannot read {{repository}}.",
      noAccess:
        "{{via}} account {{account}} cannot read {{repository}}. If you should have access, switch to an account that does.",
      noAccessAnonymous:
        "{{via}} cannot read {{repository}}. If you should have access, sign in with an account that does.",
      accessFailed:
        "Could not check {{repository}} through {{via}} on this device: {{detail}}",
      openConnector: "Connectors › {{via}}",
      recheck: "Check again",
      rechecking: "Checking…",
      allDevicesNeedAccess_one: "1 device does not meet the conditions",
      allDevicesNeedAccess_other:
        "{{count}} devices do not meet the conditions",
      someDevicesNeedAccess_one: "1 device needs attention",
      someDevicesNeedAccess_other: "{{count}} devices need attention",
      readyToRecheck: "All checks now pass; check again",
      noDevices: "No device check has reported yet",
      back: "Back to connectors",
      details: "{{connector}} access details",
    },
    catalogLoading: "Loading connectors…",
    catalogFailed: "Could not load connectors: {{error}}",
    loading: "Loading Feishu accounts…",
    loadFailed: "Could not load Feishu accounts: {{error}}",
    secretsMissing:
      "This server has no secret-store key, so it cannot keep logins. An administrator has to configure one before accounts can be connected.",
  },
  serverHeld: {
    add: "Add instance",
    noSecretStore:
      "The server secret store must be configured before {{connector}} can seal credentials.",
    loading: "Loading {{connector}} instances…",
    empty: "No {{connector}} instance has been added.",
    check: "Validate again",
    checking: "Validating…",
    checked: "Validated {{name}}.",
    checkedAt: "Checked {{when}}",
    accessRead: "Read-only",
    accessWrite: "Read/write",
    version: "version {{version}}",
    routeCount_one: "{{count}} allowed route",
    routeCount_other: "{{count}} allowed routes",
    resultDetail: "Result: {{detail}}",
    replaceToken: "Replace token",
    revoke: "Revoke",
    addTitle: "Add a {{connector}} instance",
    addDescription:
      "Fill the connection fields reported by the connector extension. Foundry validates them before sealing any secret.",
    replaceTitle: "Replace {{connector}} credentials",
    replaceDescription:
      "Foundry validates the connection again before replacing anything. Leave a sealed secret blank to keep it.",
    validate: "Validate",
    continue: "Continue",
    update: "Validate and save",
    save: "Validate and add",
    validating: "Validating…",
    saving: "Saving…",
    back: "Back",
    step: "Step {{current}} of {{total}}",
    probePassed: "Probe passed · {{routes}}",
    savedNotice: "{{name}} is validated and saved.",
    updatedNotice: "Updated {{name}} after validating it.",
    labelLabel: "Instance name",
    labelPlaceholder: "Example: Production",
    labelHelp:
      "Optional. This name appears in the instance list and workspace bindings.",
    whereTitle: "Where should Foundry connect?",
    networkServer: "Foundry server direct (public)",
    networkDevice: "Via a device (internal)",
    networkServerHelp:
      "The Foundry server connects directly. Use a public HTTPS address.",
    networkDeviceHelp:
      "One of your devices validates the address and forwards requests. HTTP, private addresses and path prefixes are allowed.",
    probeDevice: "Device used for validation",
    chooseDevice: "Choose one of your online devices",
    deviceOffline: "{{device}} is offline; bring it online to validate here.",
    availableOn: "Available on {{devices}}",
    noAvailableDevice:
      "No reachable device is recorded. Validate the instance on a device that can reach this address.",
    deviceNetworkScope:
      "Sessions on other devices do not receive this instance.",
    validateForOptions: "Validate the previous step to load choices",
    chooseOption: "Choose an option",
    secretKeep: "Leave blank to keep the sealed value",
    secretSealed:
      "This value is sealed on the server. Leave it blank to keep it, or enter a replacement.",
    fieldRequired: "{{field}} is required.",
    fieldUrl: "{{field}} must be a complete URL.",
    revokeTitle: "Revoke {{name}}?",
    revokeDescription:
      "This immediately stops every session using this instance and removes its workspace bindings.",
    revokeBody:
      "Foundry deletes the sealed credential and refuses new requests. The credential still exists at the service; rotate it there if it may have leaked. A revoked instance cannot be restored.",
    revokeConfirm: "Revoke and stop access",
    revokedNotice: "Revoked {{name}}; sessions lost access.",
    errors: {
      credential: {
        title: "Credential rejected",
        body: "The service refused the credential. Replace the token or secret, then validate again.",
      },
      input: {
        title: "Check the connection fields",
        body: "A required value is missing or does not match the connector's declared format.",
      },
      network: {
        title: "Service unreachable",
        body: "Foundry or the selected device could not reach the service. Check the address, device network, DNS, certificate, redirects and timeout.",
      },
      response: {
        title: "Unexpected service response",
        body: "The service answered, but not with the JSON and route catalogue this connector expects.",
      },
      service: {
        title: "Validation could not run",
        body: "Foundry or the connector service could not complete validation. Try again shortly.",
      },
    },
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
    appstoreconnect: "App Store Connect",
    aws: "AWS CLI",
    cloudflare: "Cloudflare",
    feishu: "Feishu",
  },
  feishu: {
    intro:
      "Your connected Feishu accounts, each with its organisation and the Feishu app it signed in through. Foundry keeps each login and app secret on the server; feishu-cli in your sessions reaches Feishu through Foundry as you and holds no credential on the device.",
    connect: "Connect Feishu account",
    versions: {
      label: "{{command}} versions on devices",
      title: "{{command}} on devices, with the skills sessions get",
      manage: "Manage in Skill Library",
      mismatch: "sessions get the latest skills, which may not match this CLI",
    },
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
    scopesNamed_one: "Asks for the {{count}} permission you chose",
    scopesNamed_other: "Asks for the {{count}} permissions you chose",
    scopesAppUnread:
      "Could not read this app's own scope list ({{error}}); choosing from the feishu-cli preset instead.",
    restartWithScopes: "Restart with these permissions",
    advanced: "Advanced",
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
    ready: "Ready",
    readyBase: "Base login ready",
    expiring: "Expires soon",
    expired: "Expired",
    signed_out: "Signed out",
    not_installed: "Not installed",
    unavailable: "Not available here",
    error: "Could not read",
  },
  holding: {
    about: "About {{label}}",
    terms: {
      where: "Where",
      who: "Who can use it",
      offline: "Offline",
      revoke: "Revoke",
    },
    device_held: {
      label: "Credentials on each device",
      where:
        "{{name}} keeps its own login on each device. Foundry never reads or copies it.",
      who: "Your own sessions on that device. Other members’ sessions there only if you share it in a workspace.",
      offline:
        "While the device is offline, nothing can use its login, and sessions elsewhere never had it.",
      revoke:
        "Sign out of {{name}} on that device here, or turn off workspace sharing.",
      revokeLocal:
        "Sign out of {{name}} in that device’s terminal, or turn off workspace sharing.",
    },
    server_held: {
      label: "Credentials on the server",
      where:
        "The Foundry server keeps the login sealed. Devices only get revocable stand-ins.",
      who: "Sessions in workspaces you bind the account to, on any device. The server checks every request.",
      offline:
        "Works from whichever device runs the session; one device going offline doesn’t affect it.",
      revoke:
        "Disconnect it here. The server revokes the login and stand-ins stop at their next request.",
    },
  },
  setupSteps: {
    offline: "{{device}} is offline; you can install once it’s back online.",
    progress: {
      label: "Installing {{name}} on {{device}}",
      starting: "Starting…",
      downloading: "Downloading {{received}}",
      downloadingOf: "Downloading {{received}} of {{total}} ({{percent}}%)",
      speed: "{{speed}}/s",
      verifying: "Checking the download’s signature…",
      installing: "Running the installer…",
      checking: "Checking the installed copy…",
    },
    install: {
      missing: "{{name}} is not installed yet",
      outdated: "{{name}} {{version}} is older than {{minimum}}",
      running: "Installing {{name}}…",
      elapsed: "On {{device}} · {{elapsed}}",
      failed: "Could not install {{name}} on {{device}}",
      done: "{{name}} {{version}} installed",
      doneDetail: {
        installer:
          "Installed for your user on {{device}}; its sessions use this copy.",
        npm: "Installed as a Foundry-managed tool on {{device}}; its sessions use this copy.",
      },
      how: {
        installer:
          "Runs {{name}}’s official installer for your user, without sudo.",
        npm: "Installs the newest {{package}} as a Foundry-managed tool.",
      },
      action: "Install {{name}}",
      actionLabel: "Install {{name}} on {{device}}",
      update: "Update {{name}}",
      updateLabel: "Update {{name}} on {{device}}",
      retry: "Retry",
      retryLabel: "Retry installing {{name}} on {{device}}",
    },
    signIn: {
      copy: "Copy {{command}}",
      copied: "Command copied",
    },
  },
  deviceHeld: {
    notInstalledTitle: "Devices without {{extension}}",
    notInstalledInstall:
      "{{extension}} is not on {{devices}}. Install it there from the repository it is published in:",
    offlineInstall: "Offline; install it once the device is back",
    installExtension: "Install {{extension}}",
    installBundled: "Install on this device",
    installBundledTitle: "Install {{extension}} on a device",
    unavailableInstall:
      "This device does not meet the connector's requirements",
    bundled: "Bundled with the Worker",
    bundledNotInstalled: "Install {{extension}} on:",
    extensionSourceGit:
      "{{extension}} extension {{version}}, published in {{repository}}.",
    extensionSourceBundled:
      "{{extension}} extension {{version}}, bundled with the Worker.",
    extensionSourceLocal:
      "{{extension}} extension {{version}}, installed from a local folder.",
    autoUpdate: "Auto-update",
    autoUpdateOn: "Updates automatically when the repository moves.",
    autoUpdateOff: "Manual updates; a newer commit is shown here.",
    updatesWithWorker: "Updates with the Worker.",
    localNewerThanBundled:
      "The version installed on this device is newer, so it was not switched to the version bundled with the Worker (local {{local}}, Worker {{bundled}}).",
    extensionInstalled: "{{extension}} is installed on {{device}}.",
    extensionUpdated: "{{extension}} on {{device}} is updated.",
    extensionUnchanged: "{{extension}} on {{device}} is already the newest.",
    extensionRemoved: "{{extension}} is removed from {{device}}.",
    extensionDescriptorInvalid:
      "Invalid {{extension}} descriptor on {{device}}",
    updateExtension: "Update {{extension}}",
    extensionUpdateAvailable:
      "{{extension}} has a newer commit in its repository ({{commit}})",
    removeExtension: "Remove {{extension}} from this device",
    removeExtensionTitle: "Remove {{extension}} from {{device}}?",
    removeExtensionBody:
      "Its connectors leave this device, with the extension’s own data and the model providers it gave. The tool’s own login stays on the device.",
    removeExtensionAction: "Remove",
    offlineUnknown: "Device offline",
    emptyExtensionBody: "No device has installed {{name}} yet.",
    emptyExtensionAddBody:
      "This extension is not bundled. Use Add a connector to install it from its source.",
    notInstalledOn:
      "Not on {{devices}}: install the {{extension}} extension there to use it.",
    givesModels:
      "Gives this device’s chats Claude through {{name}}: pick it in a chat’s model menu.",
    intro: {
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
    checkingNow: "Checking now…",
    checkingSince: "Checking now · last read {{when}}",
    notInstalled: "{{name}} is not installed",
    notSignedIn: "Not signed in",
    sessionUsable: "Sessions can use it",
    sessionNotUsable: "Not usable in sessions: {{reason}}",
    isolationLeaks:
      "A session without access still gets this login: {{reason}}",
    readFailed: "Could not read the sign-in: {{detail}}",
    signedIn: "Signed in",
    signedInAs: "Signed in as {{name}}",
    sites: "site {{sites}}",
    expires: "expires {{when}}",
    expired: "expired {{when}}",
    versionFoundry: "{{name}} {{version}}, installed by Foundry",
    versionDevice: "{{name}} {{version}}, the device's own",
    checked: "checked {{when}}",
    checkedAt: "Checked {{when}}",
    offline: "Offline · last read {{when}}",
    upgrade: "Upgrade to {{version}}",
    update: "Update {{name}}",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    signOut: "Sign out",
    signOutTitle: "Sign {{name}} out on {{device}}?",
    signOutBody:
      "Runs {{name}}'s own sign-out on the device. Sessions there lose the sign-in until you sign in again.",
    reminderExpiring: "{{name}} on {{device}} expires {{when}}.",
    reminderExpired: "{{name}} on {{device}} expired {{when}}.",
    checkedNotice: "Read {{name}} on {{device}} again.",
    signedOut: "{{name}} on {{device}} is signed out.",
    signedInNotice: "{{name}} is signed in on {{device}}.",
    configuration: {
      region: "Default Region: {{region}}",
      change: "Change",
      regionLabel: "Default AWS Region",
      regionHint:
        "Used only when an AWS command names no Region. It does not limit the identity's permissions.",
      regionInvalid: "Default AWS Region doesn’t look right.",
      regionPlaceholder: "us-east-1",
      save: "Save Region",
      cancel: "Cancel",
      regionSaved: "Default AWS Region updated on {{device}}.",
    },
  },
  authorization: {
    dialogTitle: "Authorize {{name}}",
    dialogDescription:
      "Set up this capability on {{device}}. Approve any additional permissions on the provider’s page.",
    permissions: "Permissions to request",
    recommended: "Recommended",
    custom: "Custom",
    all: "All",
    granted: "Granted",
    sourceComplete: "All is every scope in {{source}}.",
    sourcePartial:
      "From {{source}}, which is not a complete list, so there is no All.",
    sourceLink: "Open the list",
    filter: "Filter permissions",
    filterPlaceholder: "Search by name or scope",
    noMatch: "No permission matches.",
    requiredHint: "always requested",
    includedIn: "included in {{scope}}",
    approvalHint: "may need administrator approval",
    unavailableHint: "this app does not have it yet",
    manualTitle: "Paste a list",
    manualPlaceholder: "repo workflow read:packages",
    manualHint:
      "Scope names separated by spaces, commas or lines. The list replaces the selection.",
    manualApply: "Use this list",
    manualUnknown: "Not in the list, left out: {{scopes}}",
    requesting_one: "Asks for {{count}} scope:",
    requesting_other: "Asks for {{count}} scopes:",
    adds: "Adds {{scopes}}",
    removes: "Removes {{scopes}}",
    noChange: "No change to what is granted now.",
    additiveNote:
      "Authorizing only adds: a scope granted earlier stays granted even if it is unchecked here.",
    removesNote: "Unchecking a granted scope removes it from this login.",
    replacesNote:
      "A new authorization replaces the current one: scopes left out are no longer held. The provider's page may still change the final set; Connectors shows what it granted.",
    changedOutside: "Changed outside Foundry {{when}}: {{scopes}}",
    changedInFoundry: "Changed in Foundry {{when}}: {{scopes}}",
    authorizeSelected: "Authorize selected permissions",
    choosePermissions: "Choose permissions",
    changePermissions: "Change permissions",
    grantedCount: "{{count}} of {{total}} listed scopes granted",

    separate:
      "These capabilities need their own authorization on top of the {{name}} sign-in.",
    localOnly:
      "Local credential status; business permissions have not been tested.",
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
  permissions: {
    manage: "Manage them there",
  },
  deviceSignIn: {
    signInWithPermissions: "Sign in with these permissions",
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
    awsPermissions:
      "Permissions come from the AWS identity you sign in with; to limit scope, use a role in AWS with narrower permissions. Foundry controls which workspaces and sessions can use this login.",
    starting: "Asking {{device}} to start the sign-in…",
    approveTitle: "Approve on the sign-in page",
    approveBody:
      "Open the page here, or scan the code with your phone, and approve the request. {{name}} on the device finishes the sign-in.",
    waiting: "Waiting for you to approve…",
    expired: "The sign-in request expired.",
    denied: "The sign-in request was denied.",
    failed: "The sign-in did not finish: {{error}}",
    codeLabel: "Code from the sign-in page",
    codePlaceholder: "Paste the code",
    addressLabel:
      "Address the browser opened after you signed in (the page does not load; that is expected)",
    addressPlaceholder: "http://127.0.0.1:12345/cli/callback?code=…",
    finish: "Finish sign-in",
  },
  signInChooser: {
    how: "How do you want to sign in?",
    start: "Start sign-in",
    optional: "optional",
    required: "Enter {{field}}.",
    invalid: "{{field}} doesn’t look right.",
    https: "{{field}} must be an https:// address.",
    offline: "{{device}} is offline. You can sign in once it’s back.",
    terminalIntro:
      "Run one of these in a terminal on {{device}}, then check again here.",
    checkAgain: "I’ve signed in — check again",
    notYet:
      "{{device}} isn’t signed in yet. Finish in the terminal, then check again.",
    otherWay: "Choose another way",
    using: "Signing in with: {{method}}",
  },
  extensionInstall: {
    repositoryPlaceholder: "https://github.com/acme/tools.git",
    folderPlaceholder: "foundry-extension",
    refPlaceholder: "main",
    title: "Install a connector extension",
    titleNamed: "Install {{name}}",
    description:
      "The device fetches the extension’s folder with its own git login and installs what it holds.",
    repository: "Repository",
    repositoryHelp:
      "An https, ssh or host:path git remote. A private GitHub repository needs GitHub CLI signed in on the device.",
    repositoryMissing: "Enter the repository the extension is published in.",
    folder: "Folder",
    ref: "Branch or tag",
    defaultBranch: "The default branch",
    device: "Device",
    chooseDevice: "Choose a device",
    offline: "Offline",
    githubHint:
      "GitHub CLI is not signed in on {{device}}. A private GitHub repository needs it; a public one installs without.",
    githubOpen: "Open GitHub CLI",
    trust:
      "The extension runs as you on {{device}}. Install only what you trust.",
    install: "Install on {{device}}",
    installing: "Installing on {{device}}…",
    cancel: "Cancel",
  },
  addConnector: {
    open: "Add a connector",
    title: "Add a connector",
    description:
      "{{names}} are built in: open its tab and sign in. Anything else depends on whose tool it is.",
    own: {
      title: "Your company’s or your own tool",
      body: "It connects through a connector extension: a folder with a foundry-extension.json and a small program, usually published in a git repository by whoever maintains the tool.",
      install: "Install from a repository…",
      orTerminal: "Or, on the device, run:",
      after:
        "Its tab appears here within half a minute; sign in there like any other. An extension runs as you on that device, so install only ones you trust; remove one with foundry-worker extension remove <id>.",
    },
    installed: "Installed on your devices",
    installedRow: "{{name}} {{version}} — {{provides}}",
    public: {
      title: "A public service Foundry doesn’t have",
      body: "Public services are built into Foundry itself, since many keep their sign-in on the server and reach it through Foundry’s gateway. Ask for one in Foundry’s issues.",
      link: "Request a service",
    },
    author: {
      title: "Writing an extension",
      body: "What the manifest declares (names, sign-in methods and their fields, what it provides) and the protocol its program speaks with the device, with a minimal example.",
      link: "Read the extension spec",
    },
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
    deviceOwnerOnly:
      "Only the execution device’s owner can install the CLI or manage its login there; ask them.",
    useExisting: "Use existing login",
    authorize: "Authorize and use here",
    enabled: "Enabled here",
    removeBinding: "Remove binding",
    retryBinding: "Retry saving binding",
    retrySharing: "Retry sharing change",
    nativeBoundary:
      "Your own sessions use this device’s ready login automatically. Sharing applies only to this workspace and device; turning it off keeps your own access. Manage device logins in Connectors.",

    rule: "Server-held accounts follow their workspace grants. Device logins apply only on their execution device.",
    binding: {
      feishu:
        "A bound account lets feishu-cli in your sessions here work in Feishu as you.",
      serverHeld:
        "Choose which of your {{provider}} instances this workspace may use. A revoked instance is unavailable until you add a new one.",
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
