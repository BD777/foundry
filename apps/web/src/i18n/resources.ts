import { account as enAccount } from "./locales/en/account";
import { agents as enAgents } from "./locales/en/agents";
import { assets as enAssets } from "./locales/en/assets";
import { chat as enChat } from "./locales/en/chat";
import { common as enCommon } from "./locales/en/common";
import { conversation as enConversation } from "./locales/en/conversation";
import { devices as enDevices } from "./locales/en/devices";
import { feishu as enFeishu } from "./locales/en/feishu";
import { issueDetail as enIssueDetail } from "./locales/en/issueDetail";
import { issues as enIssues } from "./locales/en/issues";
import { profiles as enProfiles } from "./locales/en/profiles";
import { runs as enRuns } from "./locales/en/runs";
import { sharing as enSharing } from "./locales/en/sharing";
import { shell as enShell } from "./locales/en/shell";
import { skills as enSkills } from "./locales/en/skills";
import { ui as enUi } from "./locales/en/ui";
import { workspaces as enWorkspaces } from "./locales/en/workspaces";
import { account as zhAccount } from "./locales/zh-CN/account";
import { agents as zhAgents } from "./locales/zh-CN/agents";
import { assets as zhAssets } from "./locales/zh-CN/assets";
import { chat as zhChat } from "./locales/zh-CN/chat";
import { common as zhCommon } from "./locales/zh-CN/common";
import { conversation as zhConversation } from "./locales/zh-CN/conversation";
import { devices as zhDevices } from "./locales/zh-CN/devices";
import { feishu as zhFeishu } from "./locales/zh-CN/feishu";
import { issueDetail as zhIssueDetail } from "./locales/zh-CN/issueDetail";
import { issues as zhIssues } from "./locales/zh-CN/issues";
import { profiles as zhProfiles } from "./locales/zh-CN/profiles";
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
  chat: enChat,
  common: enCommon,
  conversation: enConversation,
  devices: enDevices,
  feishu: enFeishu,
  issueDetail: enIssueDetail,
  issues: enIssues,
  profiles: enProfiles,
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
    chat: zhChat,
    common: zhCommon,
    conversation: zhConversation,
    devices: zhDevices,
    feishu: zhFeishu,
    issueDetail: zhIssueDetail,
    issues: zhIssues,
    profiles: zhProfiles,
    runs: zhRuns,
    sharing: zhSharing,
    shell: zhShell,
    skills: zhSkills,
    ui: zhUi,
    workspaces: zhWorkspaces,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
