package store

import "context"

// ChatQueueRef names a chat whose queue holds messages.
type ChatQueueRef struct {
	WorkspaceID string
	ChatID      string
}

// ChatQueueStore keeps the messages people queue in chats until the server
// sends them. A chat is a Foundry chat session (its thread id) or a device's
// native chat; adopting a native chat moves its queue to the session.
type ChatQueueStore interface {
	ChatQueue(ctx context.Context, workspaceID, chatID string) (ChatQueue, error)
	EnqueueChatMessage(ctx context.Context, workspaceID, chatID, createdBy string, input EnqueueChatMessageInput) (ChatQueue, error)
	// EditChatQueueItem refuses ErrChatQueueConflict on a stale revision and
	// ErrChatQueueItemSending / ErrChatQueueItemSent once it went out.
	EditChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string, input EditChatQueueItemInput) (ChatQueue, error)
	DeleteChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string) (ChatQueue, error)
	ReorderChatQueue(ctx context.Context, workspaceID, chatID string, input ReorderChatQueueInput) (ChatQueue, error)
	// RetryChatQueueItem queues a failed message again, first in line.
	RetryChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string) (ChatQueue, error)
	// ClaimChatQueueItem marks a message dispatching, atomically. head
	// requires it to be the chat's next message and queued (a failed next
	// message pauses the queue: ErrChatQueuePaused). A chat sends one
	// message at a time (ErrChatQueueBusy).
	ClaimChatQueueItem(ctx context.Context, workspaceID, chatID, itemID string, head bool) (ChatQueueItem, ChatQueue, error)
	// SettleChatQueueItem ends a dispatch: sent (to sessionID), failed (with
	// message) or queued again. A message no longer dispatching is left as is.
	SettleChatQueueItem(ctx context.Context, itemID, state, sessionID, message string) (ChatQueue, error)
	// ChatQueueInputSession is the session that recorded the message as an
	// input, if any: the evidence a dispatch reached its session.
	ChatQueueInputSession(ctx context.Context, itemID string) (string, bool, error)
	// RecoverChatQueueDispatches settles the messages a stopped server left
	// dispatching: sent when a session recorded them, otherwise queued.
	RecoverChatQueueDispatches(ctx context.Context) ([]ChatQueue, error)
	// PendingChatQueues lists the chats with queued messages.
	PendingChatQueues(ctx context.Context) ([]ChatQueueRef, error)
	// DeleteChatQueueItemsBy drops the unsent messages an account queued in a workspace.
	DeleteChatQueueItemsBy(ctx context.Context, workspaceID, userID string) ([]ChatQueueRef, error)
	// ChatQueueSession is the chat's latest Foundry session, if it has one,
	// and whether any session of the chat is handling an input.
	ChatQueueSession(ctx context.Context, workspaceID, chatID string) (AgentSession, bool, bool, error)
}
