import { account as enAccount } from "./locales/en/account";
import { agents as enAgents } from "./locales/en/agents";
import { assets as enAssets } from "./locales/en/assets";
import { channels as enChannels } from "./locales/en/channels";
import { chat as enChat } from "./locales/en/chat";
import { common as enCommon } from "./locales/en/common";
import { connectionSetup as enConnectionSetup } from "./locales/en/connectionSetup";
import { conversation as enConversation } from "./locales/en/conversation";
import { devices as enDevices } from "./locales/en/devices";
import { externalAccounts as enExternalAccounts } from "./locales/en/externalAccounts";
import { feishu as enFeishu } from "./locales/en/feishu";
import { issueDetail as enIssueDetail } from "./locales/en/issueDetail";
import { issues as enIssues } from "./locales/en/issues";
import { pending as enPending } from "./locales/en/pending";
import { personalAgent as enPersonalAgent } from "./locales/en/personalAgent";
import { profiles as enProfiles } from "./locales/en/profiles";
import { resources as enResources } from "./locales/en/resources";
import { runs as enRuns } from "./locales/en/runs";
import { sharing as enSharing } from "./locales/en/sharing";
import { shell as enShell } from "./locales/en/shell";
import { skills as enSkills } from "./locales/en/skills";
import { ui as enUi } from "./locales/en/ui";
import { workspaces as enWorkspaces } from "./locales/en/workspaces";
import { account as zhAccount } from "./locales/zh-CN/account";
import { agents as zhAgents } from "./locales/zh-CN/agents";
import { assets as zhAssets } from "./locales/zh-CN/assets";
import { channels as zhChannels } from "./locales/zh-CN/channels";
import { chat as zhChat } from "./locales/zh-CN/chat";
import { common as zhCommon } from "./locales/zh-CN/common";
import { connectionSetup as zhConnectionSetup } from "./locales/zh-CN/connectionSetup";
import { conversation as zhConversation } from "./locales/zh-CN/conversation";
import { devices as zhDevices } from "./locales/zh-CN/devices";
import { externalAccounts as zhExternalAccounts } from "./locales/zh-CN/externalAccounts";
import { feishu as zhFeishu } from "./locales/zh-CN/feishu";
import { issueDetail as zhIssueDetail } from "./locales/zh-CN/issueDetail";
import { issues as zhIssues } from "./locales/zh-CN/issues";
import { pending as zhPending } from "./locales/zh-CN/pending";
import { personalAgent as zhPersonalAgent } from "./locales/zh-CN/personalAgent";
import { profiles as zhProfiles } from "./locales/zh-CN/profiles";
import { resources as zhResources } from "./locales/zh-CN/resources";
import { runs as zhRuns } from "./locales/zh-CN/runs";
import { sharing as zhSharing } from "./locales/zh-CN/sharing";
import { shell as zhShell } from "./locales/zh-CN/shell";
import { skills as zhSkills } from "./locales/zh-CN/skills";
import { ui as zhUi } from "./locales/zh-CN/ui";
import { workspaces as zhWorkspaces } from "./locales/zh-CN/workspaces";

/**
 * Every namespace, per locale. A feature adds its namespace here once, in
 * both locales; zh-CN files are typed against the English ones, so they
 * cannot miss or invent a key.
 */
export const en = {
  account: enAccount,
  agents: enAgents,
  assets: enAssets,
  channels: enChannels,
  chat: enChat,
  common: enCommon,
  connectionSetup: enConnectionSetup,
  conversation: enConversation,
  devices: enDevices,
  externalAccounts: enExternalAccounts,
  feishu: enFeishu,
  issueDetail: enIssueDetail,
  issues: enIssues,
  pending: enPending,
  personalAgent: enPersonalAgent,
  profiles: enProfiles,
  resources: enResources,
  runs: enRuns,
  sharing: enSharing,
  shell: enShell,
  skills: enSkills,
  ui: enUi,
  workspaces: enWorkspaces,
};

export const resources = {
  en,
  "zh-CN": {
    account: zhAccount,
    agents: zhAgents,
    assets: zhAssets,
    channels: zhChannels,
    chat: zhChat,
    common: zhCommon,
    connectionSetup: zhConnectionSetup,
    conversation: zhConversation,
    devices: zhDevices,
    externalAccounts: zhExternalAccounts,
    feishu: zhFeishu,
    issueDetail: zhIssueDetail,
    issues: zhIssues,
    pending: zhPending,
    personalAgent: zhPersonalAgent,
    profiles: zhProfiles,
    resources: zhResources,
    runs: zhRuns,
    sharing: zhSharing,
    shell: zhShell,
    skills: zhSkills,
    ui: zhUi,
    workspaces: zhWorkspaces,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
