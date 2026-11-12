// Message channels (DEV-203): a connector's event feed that brings messages
// to one assistant. The server owns them; the web edits them through
// /api/assistants/{id}/channels. Types come from the contract
// (contracts/models/message_channels.yaml).

export type {
  MessageChannel,
  MessageChannelAction,
  MessageChannelConnectorScope,
  MessageChannelCounts,
  MessageChannelDelivery,
  MessageChannelDeliveryList,
  MessageChannelDeliveryStatus,
  MessageChannelFilters,
  MessageChannelInput,
  MessageChannelLimits,
  MessageChannelList,
  MessageChannelPrerequisites,
  MessageChannelRule,
  MessageChannelScope,
  MessageChannelSource,
  MessageChannelState,
  MessageChannelStatus,
  MessageChannelTriState,
  MessageChannelView,
  MessageConversationKind,
  MessageEnvelope,
} from "./contract.gen.js";
