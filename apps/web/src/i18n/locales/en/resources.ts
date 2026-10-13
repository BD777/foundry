/** Resources: the inventory of what devices offer sessions. */
export const resources = {
  page: {
    title: "Resources",
    intro:
      "What each device offers sessions, as its worker detects it: browsers, screen control, simulators, GPUs, toolchains, the machine itself for running commands, and more. Foundry lists resources and installs one only when you ask.",
  },
  filters: {
    label: "Filter resources",
    type: "Type",
    allTypes: "All types",
    device: "Device",
    allDevices: "All devices",
    showGone: "Show resources that are gone",
    clear: "Clear filters",
  },
  types: {
    computer_use: "Computer use",
    browser: "Browser",
    simulator: "Simulator",
    mobile_device: "Mobile device",
    gpu: "GPU",
    container_runtime: "Container runtime",
    toolchain: "Toolchain",
    account: "Account",
    disk: "Disk",
    compute: "Compute",
  },
  platforms: {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    ios: "iOS",
    android: "Android",
    any: "Any platform",
  },
  states: {
    available: "Available",
    busy: "In use",
    unready: "Not ready",
    offline: "Device offline",
    gone: "Gone",
  },
  levels: {
    installed: "installed",
    configured: "configured",
    permitted: "permitted",
    verified: "verified",
  },
  readiness: {
    ready: "Ready · {{level}}",
    notReady: "Not ready · {{level}}",
    withReason: "{{readiness}} — {{reason}}",
  },
  stale: "Stale",
  staleNote:
    "Its detector failed on the latest scan; this is the last known report.",
  backendLine: "Used through {{backend}} — {{readiness}}",
  backend: {
    named: "{{id}} {{version}}",
    withMode: "{{name}} ({{mode}})",
    listed: "detected",
    native_session: "sessions on the device only",
    remote_ops: "operated through Foundry",
  },
  missing: {
    cua_driver_not_installed: "cua-driver is not installed",
    cua_driver_not_running: "cua-driver is not running",
    cua_driver_awaiting_approval: "approval on the Mac",
    tcc_accessibility: "Accessibility permission",
    tcc_screen_recording: "Screen Recording permission",
  },
  holder: {
    active: "In use by a session",
    parked: "Kept for the session until {{time}}",
    parkedOpen: "Kept for the session",
    ending: "Its lease is ending",
    since: "since {{when}}",
    open: "Open session",
    openLabel: "Open the session holding {{name}}",
    queue_one: "{{count}} session waiting",
    queue_other: "{{count}} sessions waiting",
    preempt: "Will be given to the waiting session at {{time}}",
    resetting:
      "Resetting after the last session; available once the device confirms.",
  },
  lease: {
    release: "Release",
    releasing: "Releasing…",
    released: "Released. The device resets it before the next session gets it.",
    extend: "Let it finish",
    extending: "Postponing…",
    extended: "Postponed: the waiting session gets it at {{time}}.",
    releaseTitle: "Release {{name}}?",
    releaseDescription: "The session holding it loses its lease at once.",
    releaseItems: {
      fails:
        "The session's next operation on it fails; it can ask for the resource again.",
      reset:
        "The device resets it: held keys and mouse buttons are let go, open menus are closed.",
      next: "A session waiting for it gets it next.",
    },
    releaseConfirm: "Release now",
  },
  stop: {
    action: "Stop all on {{device}}",
    title: "Stop all on {{device}}?",
    description:
      "Every session using this device's resources loses its lease at once.",
    items: {
      fails: "Their next operation on any of this device's resources fails.",
      reset: "Every screen and resource they held on {{device}} is reset.",
      waiting: "Sessions waiting for them get them next.",
    },
    confirm: "Stop all",
    stopping: "Stopping…",
    done_one: "Released {{count}} lease on {{device}}.",
    done_other: "Released {{count}} leases on {{device}}.",
    none: "Nothing on {{device}} was held.",
  },
  install: {
    action: "Install cua-driver",
    installing: "Installing cua-driver…",
    wait: "The installer runs on {{device}}; this can take a few minutes.",
    title: "Install cua-driver on {{device}}?",
    description:
      "Foundry runs cua-driver's official installer on this device only, because you asked.",
    items: {
      source:
        "It downloads and runs the official installer from cua.ai on {{device}} only.",
      telemetry: "It turns cua-driver's telemetry off.",
      license:
        "cua-driver is third-party software under the MIT license, not part of Foundry.",
      grants:
        "Afterwards macOS asks for Accessibility and Screen Recording for CuaDriver.app; approve both on {{device}}.",
    },
    confirm: "Install",
    done: "cua-driver installed on {{device}}",
    failed: "Could not install cua-driver on {{device}}",
    stillMissing: "Still needed: {{missing}}.",
    nothingMissing: "Nothing else is needed.",
    output: "Installer output",
  },
  access: {
    action: "Request access",
    retryAction: "Try again",
    requesting: "Asking {{device}}…",
    requested:
      "{{device}} is asking for Accessibility, Screen Recording and screen capture for CuaDriver.app. Approve each prompt on the Mac; readiness here updates once it does.",
    opening: "Opening on {{device}}…",
    panes: {
      accessibility: {
        action: "Open Accessibility settings",
        hint: "Accessibility: in System Settings → Privacy & Security → Accessibility, turn on CuaDriver.",
        opened:
          "System Settings opened on {{device}} at Accessibility: turn on CuaDriver. Foundry checks again every few seconds and updates here.",
      },
      "screen-recording": {
        action: "Open Screen Recording settings",
        hint: "Screen Recording: in System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording before macOS 15), turn on CuaDriver. On macOS 26, CuaDriver may also ask once to record your screen: choose Allow.",
        opened:
          "System Settings opened on {{device}} at Screen Recording: turn on CuaDriver. Foundry checks again every few seconds and updates here.",
      },
    },
    check: {
      waiting:
        "Permission check running on {{device}}: cua-driver confirms as soon as CuaDriver is allowed.",
      live: "Checking CuaDriver's permissions on {{device}} every few seconds; this page updates by itself.",
      verified: "cua-driver verified CuaDriver's permissions on {{device}}.",
      failed:
        "cua-driver could not verify CuaDriver's permissions on {{device}}",
      timedOut:
        "The permission check on {{device}} stopped waiting before CuaDriver was allowed",
      retry:
        "Try again restarts CuaDriver on {{device}} and asks again; a permission turned on in System Settings counts after that restart.",
      output: "cua-driver's last lines",
    },
  },
  compute: {
    cpus_one: "{{count}} CPU",
    cpus_other: "{{count}} CPUs",
    memory: "{{gib}} GiB",
    load: "load {{load}}",
    allow: "Allow remote commands from my sessions",
    hint: "Commands run as the worker's user in Foundry's scratch folder, or in a workspace on this device the session may work in. Every run is audited. On by default; turn off to stop your sessions on other devices from running commands here.",
    saving: "Saving…",
    notApplied:
      "Saved. It takes effect once {{device}}'s worker is online and up to date.",
    offTitle: "Stop remote commands on {{device}}?",
    offDescription:
      "A session is using this device's compute resource; turning this off ends its use at once.",
    offItems: {
      ends: "The session holding it loses its lease; its next command fails.",
      later: "No session can run commands here until you turn this on again.",
    },
    offConfirm: "Turn off",
  },
  activity: {
    action: "Activity",
    actionLabel: "Activity on {{name}}",
    title: "Activity on {{name}}",
    description:
      "The latest operations sessions ran on it, newest first. Typed text is kept only as its length; screenshots are never kept.",
    loading: "Reading the activity…",
    failed: "Could not read the activity",
    emptyTitle: "No operations yet",
    emptyBody: "Operations sessions run on it appear here.",
    list: "Operations on {{name}}",
    ok: "OK",
    error: "Failed · {{code}}",
    errorNoCode: "Failed",
    duration: "{{ms}} ms",
    noArgs: "no arguments",
    openSession: "Open session",
  },
  cancel: "Cancel",
  lastSeen: "Last seen {{when}}",
  goneSince: "Gone {{when}}",
  count_one: "{{count}} resource",
  count_other: "{{count}} resources",
  source: {
    online: "Online",
    offline: "Offline",
    lastReport: "last report {{when}}",
    noReport: "no report yet",
    open: "Open device {{device}}",
  },
  problems: {
    title: "Detection problems",
    detectorError: "{{device}} · {{type}}: {{error}}",
    offline: "{{device}} is offline; its resources show what it last reported.",
  },
  listLabel: "{{type}} on {{device}}",
  loading: "Reading the resource inventory…",
  loadFailed: "Could not read the resource inventory",
  retry: "Try again",
  emptyTitle: "No resources yet",
  emptyBody:
    "Devices list their resources once their worker connects and detects them.",
  emptyFilteredTitle: "No matching resources",
  emptyFilteredBody: "No resource matches these filters.",
};
