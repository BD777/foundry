/** Words several features share: roles, generic actions and states. */
export const common = {
  actions: {
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    copy: "Copy",
    copied: "Copied",
    retry: "Retry",
    refresh: "Refresh",
    close: "Close",
    pleaseWait: "Please wait…",
  },
  states: {
    loading: "Loading…",
    saving: "Saving…",
  },
  roles: {
    admin: "Admin",
    member: "Member",
    viewer: "Viewer",
    maintainer: "Maintainer",
    owner: "Owner",
  },
  /** A role inside a sentence ("invited as member"). */
  roleNouns: {
    admin: "admin",
    member: "member",
    viewer: "viewer",
    maintainer: "maintainer",
    owner: "owner",
  },
  access: {
    denied:
      "You are a {{have}} in this workspace; this needs {{need}} or higher.",
  },
  errors: {
    serverUnreachable: "The Foundry server did not answer. Try again.",
  },
  language: {
    label: "Language",
    followBrowser: "Follow the browser",
    en: "English",
    "zh-CN": "简体中文",
  },
};
