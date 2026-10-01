import { account as enAccount } from "./locales/en/account";
import { common as enCommon } from "./locales/en/common";
import { issueDetail as enIssueDetail } from "./locales/en/issueDetail";
import { issues as enIssues } from "./locales/en/issues";
import { runs as enRuns } from "./locales/en/runs";
import { shell as enShell } from "./locales/en/shell";
import { account as zhAccount } from "./locales/zh-CN/account";
import { common as zhCommon } from "./locales/zh-CN/common";
import { issueDetail as zhIssueDetail } from "./locales/zh-CN/issueDetail";
import { issues as zhIssues } from "./locales/zh-CN/issues";
import { runs as zhRuns } from "./locales/zh-CN/runs";
import { shell as zhShell } from "./locales/zh-CN/shell";

/**
 * Every namespace, per locale. A feature adds its namespace here once, in
 * both locales; zh-CN files are typed against the English ones, so they
 * cannot miss or invent a key.
 */
export const en = {
  account: enAccount,
  common: enCommon,
  issueDetail: enIssueDetail,
  issues: enIssues,
  runs: enRuns,
  shell: enShell,
};

export const resources = {
  en,
  "zh-CN": {
    account: zhAccount,
    common: zhCommon,
    issueDetail: zhIssueDetail,
    issues: zhIssues,
    runs: zhRuns,
    shell: zhShell,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
