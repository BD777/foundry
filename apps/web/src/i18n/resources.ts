import { account as enAccount } from "./locales/en/account";
import { assets as enAssets } from "./locales/en/assets";
import { common as enCommon } from "./locales/en/common";
import { devices as enDevices } from "./locales/en/devices";
import { feishu as enFeishu } from "./locales/en/feishu";
import { profiles as enProfiles } from "./locales/en/profiles";
import { sharing as enSharing } from "./locales/en/sharing";
import { shell as enShell } from "./locales/en/shell";
import { skills as enSkills } from "./locales/en/skills";
import { workspaces as enWorkspaces } from "./locales/en/workspaces";
import { account as zhAccount } from "./locales/zh-CN/account";
import { assets as zhAssets } from "./locales/zh-CN/assets";
import { common as zhCommon } from "./locales/zh-CN/common";
import { devices as zhDevices } from "./locales/zh-CN/devices";
import { feishu as zhFeishu } from "./locales/zh-CN/feishu";
import { profiles as zhProfiles } from "./locales/zh-CN/profiles";
import { sharing as zhSharing } from "./locales/zh-CN/sharing";
import { shell as zhShell } from "./locales/zh-CN/shell";
import { skills as zhSkills } from "./locales/zh-CN/skills";
import { workspaces as zhWorkspaces } from "./locales/zh-CN/workspaces";

/**
 * Every namespace, per locale. A feature adds its namespace here once, in
 * both locales; zh-CN files are typed against the English ones, so they
 * cannot miss or invent a key.
 */
export const en = {
  account: enAccount,
  assets: enAssets,
  common: enCommon,
  devices: enDevices,
  feishu: enFeishu,
  profiles: enProfiles,
  sharing: enSharing,
  shell: enShell,
  skills: enSkills,
  workspaces: enWorkspaces,
};

export const resources = {
  en,
  "zh-CN": {
    account: zhAccount,
    assets: zhAssets,
    common: zhCommon,
    devices: zhDevices,
    feishu: zhFeishu,
    profiles: zhProfiles,
    sharing: zhSharing,
    shell: zhShell,
    skills: zhSkills,
    workspaces: zhWorkspaces,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
