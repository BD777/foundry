import { account as enAccount } from "./locales/en/account";
import { agents as enAgents } from "./locales/en/agents";
import { chat as enChat } from "./locales/en/chat";
import { common as enCommon } from "./locales/en/common";
import { conversation as enConversation } from "./locales/en/conversation";
import { shell as enShell } from "./locales/en/shell";
import { ui as enUi } from "./locales/en/ui";
import { account as zhAccount } from "./locales/zh-CN/account";
import { agents as zhAgents } from "./locales/zh-CN/agents";
import { chat as zhChat } from "./locales/zh-CN/chat";
import { common as zhCommon } from "./locales/zh-CN/common";
import { conversation as zhConversation } from "./locales/zh-CN/conversation";
import { shell as zhShell } from "./locales/zh-CN/shell";
import { ui as zhUi } from "./locales/zh-CN/ui";

/**
 * Every namespace, per locale. A feature adds its namespace here once, in
 * both locales; zh-CN files are typed against the English ones, so they
 * cannot miss or invent a key.
 */
export const en = {
  account: enAccount,
  agents: enAgents,
  chat: enChat,
  common: enCommon,
  conversation: enConversation,
  shell: enShell,
  ui: enUi,
};

export const resources = {
  en,
  "zh-CN": {
    account: zhAccount,
    agents: zhAgents,
    chat: zhChat,
    common: zhCommon,
    conversation: zhConversation,
    shell: zhShell,
    ui: zhUi,
  },
} satisfies Record<string, Record<keyof typeof en, unknown>>;
