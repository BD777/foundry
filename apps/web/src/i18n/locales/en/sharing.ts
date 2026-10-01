/** Sharing a workspace with members. */
export const sharing = {
  updateFailed: "Sharing could not be updated",
  thisDevice: "this workspace's device",
  itsOwner: "its owner",
  add: {
    title: "Add a person",
    body: "Enter the exact username of someone with a Foundry account.",
    username: "Username to add",
    usernamePlaceholder: "Username",
    role: "Role for the new person",
    submit: "Add",
    submitting: "Adding…",
    invite: "Invite someone new",
  },
  runsCode: {
    title: "This role can run code",
    body: "A {{role}} can start Chats and Issues that run commands on {{device}} as {{owner}}'s OS account, inside this workspace. Choose Viewer for people who only need to read.",
  },
  inviteLink: {
    body: "Invite link for a new account that joins as {{role}} · shown only once, expires in 7 days",
    label: "Invite link",
    copy: "Copy link",
  },
  people: {
    title: "People with access",
    manageHint: "Owners manage who can see and run in this workspace.",
    readOnlyHint: "Only Owners can change who has access.",
  },
  member: {
    you: "{{name}} (you)",
    deviceOwner: "Device owner",
    disabled: "Disabled",
    roleFor: "Role for {{name}}",
    leave: "Leave",
    leaveConfirm: "Leave for good?",
    remove: "Remove",
    removeConfirm: "Remove access?",
  },
  roleDetails: {
    viewer: "Reads Issues, Chats, evidence and files",
    member: "Also chats, creates and runs its own Issues",
    maintainer: "Also accepts work and manages Skills and Feishu",
    owner: "Also manages people, renames and removes",
  },
};
