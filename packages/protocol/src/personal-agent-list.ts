// 「事项」 (docs/personal-agent.md §6, DEV-258): one list of what someone wants
// done, in their words, tracked until it ends. The shapes are the contract's
// (contracts/models/personal_agent.yaml, PersonalAgentItem*); this module is
// the Web's entry point to them.

import type {
  PersonalAgentItem,
  PersonalAgentItemEditInput,
  PersonalAgentItemRouteDecision,
  PersonalAgentItemStatus,
} from "./contract.gen.js";

export type {
  PersonalAgentCompletionEvidence,
  PersonalAgentItem,
  PersonalAgentItemDetail,
  PersonalAgentItemEditInput,
  PersonalAgentItemEvent,
  PersonalAgentItemEventActor,
  PersonalAgentItemEventDetail,
  PersonalAgentItemEventKind,
  PersonalAgentItemHelper,
  PersonalAgentItemList,
  PersonalAgentItemOrigin,
  PersonalAgentItemOriginKind,
  PersonalAgentItemOwner,
  PersonalAgentItemPlan,
  PersonalAgentItemReport,
  PersonalAgentItemReportCounts,
  PersonalAgentItemReportGroup,
  PersonalAgentItemRouteDecision,
  PersonalAgentItemStatus,
  PersonalAgentWorkReference,
} from "./contract.gen.js";

/**
 * Former names, kept while the Web moves to PersonalAgentItem. The shape
 * changed: owner, summary, origin and helpers are new; taskId is gone (a
 * helper names its item in PersonalAgentItem.helpers).
 */
export type PersonalAgentListItem = PersonalAgentItem;
export type PersonalAgentListItemStatus = PersonalAgentItemStatus;
export type PersonalAgentListItemInput = PersonalAgentItemEditInput;
export type PersonalAgentRouteDecision = PersonalAgentItemRouteDecision;
