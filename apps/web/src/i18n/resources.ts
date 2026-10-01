import { account as enAccount } from "./locales/en/account";
import { common as enCommon } from "./locales/en/common";
import { shell as enShell } from "./locales/en/shell";
import { account as zhAccount } from "./locales/zh-CN/account";
import { common as zhCommon } from "./locales/zh-CN/common";
import { shell as zhShell } from "./locales/zh-CN/shell";

/**
 * Every namespace, per locale. A feature adds its namespace here once, in
 * both locales; zh-CN files are typed against the English ones, so they
 * cannot miss or invent a key.
 */
export const en = {
  account: enAccount,
  common: enCommon,
  shell: enShell,
};

export const resources = {
  en,
  "zh-CN": {
    account: zhAccount,
    common: zhCommon,
    shell: zhShell,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
