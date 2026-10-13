package store

import (
	"context"
	"time"
)

// A Workspace Feishu Bot is a Connectors Feishu app (ExternalProviderApp,
// its secret sealed on the server) plus the routes that send the app's
// events to workspaces. One app serves any number of workspaces: each chat
// routes to exactly one of them.

type FeishuBotStatus string

const (
	FeishuBotStatusUnconfigured FeishuBotStatus = "unconfigured"
	FeishuBotStatusConnecting   FeishuBotStatus = "connecting"
	FeishuBotStatusConnected    FeishuBotStatus = "connected"
	FeishuBotStatusError        FeishuBotStatus = "error"
)

// FeishuRouteKind is what a route matches.
type FeishuRouteKind string

const (
	// FeishuRoutePairing: the workspace's bot runs on the app; "/pair
	// <code>" with the route's current code binds a chat to the workspace.
	// One per workspace.
	FeishuRoutePairing FeishuRouteKind = "pairing"
	// FeishuRouteChat: a group chat, where the bot answers when mentioned.
	FeishuRouteChat FeishuRouteKind = "chat"
	// FeishuRouteP2P: a person's direct chat with the bot, where every
	// message is for the bot.
	FeishuRouteP2P FeishuRouteKind = "p2p"
)

// FeishuBotRoute sends one Connectors app's events to one workspace.
type FeishuBotRoute struct {
	ID string `json:"id"`
	// AppID is the Connectors app (xapp_…), not Feishu's id of it.
	AppID       string          `json:"appId"`
	WorkspaceID string          `json:"workspaceId"`
	Kind        FeishuRouteKind `json:"kind"`
	// ChatID is the chat a chat or p2p route matches.
	ChatID   string `json:"chatId,omitempty"`
	ChatName string `json:"chatName,omitempty"`
	// ChatNameCheckedAt is when the name was last asked of Feishu, and
	// ChatNameError why that failed (the name kept is the one before).
	ChatNameCheckedAt string `json:"chatNameCheckedAt,omitempty"`
	ChatNameError     string `json:"chatNameError,omitempty"`
	// PeerOpenID is the other person of a direct chat (their open_id with
	// the app), which names the chat.
	PeerOpenID string `json:"-"`
	// BoundUserID is the account the bot acts as in the chat: whoever
	// generated the pairing code the chat used.
	BoundUserID string `json:"boundUserId,omitempty"`
	// PairingCode is the hash of the pairing route's current code; the
	// plaintext is returned only by the request that generated it.
	PairingCode          string `json:"-"`
	PairingCodeCreatedBy string `json:"-"`
	PairingCodeExpiresAt string `json:"pairingCodeExpiresAt,omitempty"`
	CreatedAt            string `json:"createdAt"`
	UpdatedAt            string `json:"updatedAt"`
}

// FeishuBotRouteFilter narrows ListFeishuBotRoutes; empty fields match all.
type FeishuBotRouteFilter struct {
	WorkspaceID string
	AppID       string
}

// WorkspaceFeishuBot is a workspace's Feishu Bot as its page shows it: the
// app it runs on, how the server's connection to the app stands, and the
// chats routed to the workspace.
type WorkspaceFeishuBot struct {
	WorkspaceID string `json:"workspaceId"`
	// App is the Connectors app the bot runs on; nil when none is picked.
	App          *ExternalProviderApp `json:"app,omitempty"`
	Status       FeishuBotStatus      `json:"status"`
	StatusDetail string               `json:"statusDetail,omitempty"`
	// LastEventAt is when the server last received an event of the app.
	LastEventAt string `json:"lastEventAt,omitempty"`
	// Chats are the group and direct chats routed to the workspace.
	Chats []FeishuBotRoute `json:"chats"`
	// PairingCodeExpiresAt is when the current pairing code lapses.
	PairingCodeExpiresAt string `json:"pairingCodeExpiresAt,omitempty"`
	// Choices are the Feishu apps the caller may run the bot on; only in
	// the answer to that caller.
	Choices []ExternalProviderApp `json:"choices,omitempty"`
}

// SelectWorkspaceFeishuBotInput picks the Connectors app a workspace's bot
// runs on.
type SelectWorkspaceFeishuBotInput struct {
	AppID string `json:"appId"`
}

// FeishuPairingCodeResult is a newly generated pairing code: the only
// answer that carries its plaintext.
type FeishuPairingCodeResult struct {
	WorkspaceID          string `json:"workspaceId"`
	PairingCode          string `json:"pairingCode"`
	PairingCodeExpiresAt string `json:"pairingCodeExpiresAt"`
}

// FeishuAppUse is what uses one Connectors Feishu app: the workspaces whose
// bot runs on it, the agent event subscriptions open on it, and its
// connection.
type FeishuAppUse struct {
	AppID      string                  `json:"appId"`
	Workspaces []FeishuAppWorkspaceUse `json:"workspaces"`
	// OtherWorkspaces counts the workspaces the caller cannot see.
	OtherWorkspaces int             `json:"otherWorkspaces,omitempty"`
	Subscriptions   int             `json:"subscriptions"`
	Status          FeishuBotStatus `json:"status"`
	StatusDetail    string          `json:"statusDetail,omitempty"`
	LastEventAt     string          `json:"lastEventAt,omitempty"`
}

// FeishuAppWorkspaceUse is one workspace whose bot runs on the app.
type FeishuAppWorkspaceUse struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Chats       int    `json:"chats"`
}

type FeishuChatThread struct {
	RootMessageID   string `json:"rootMessageId"`
	WorkspaceID     string `json:"workspaceId"`
	ChatID          string `json:"chatId"`
	LatestSessionID string `json:"latestSessionId"`
	CardMessageID   string `json:"cardMessageId"`
	// IssueID is the Issue the thread follows; empty for a chat thread.
	IssueID string `json:"issueId,omitempty"`
	// Reported marks what the thread was last told about its Issue, so a
	// restart neither repeats nor skips an update.
	Reported  string `json:"reported,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// FeishuIssueThreads finds the Feishu thread that follows an Issue.
type FeishuIssueThreads interface {
	FeishuThreadForIssue(ctx context.Context, issueID string) (FeishuChatThread, error)
}

// FeishuBotStore keeps the Workspace Bots' routes and topic threads.
type FeishuBotStore interface {
	// ListFeishuBotRoutes lists routes, each workspace's pairing route
	// before its chats.
	ListFeishuBotRoutes(ctx context.Context, filter FeishuBotRouteFilter) ([]FeishuBotRoute, error)
	// SetWorkspaceFeishuBotApp runs the workspace's bot on Connectors app
	// appID. The chats it had stay when the new app is the same Feishu app
	// (same client id), and are unbound otherwise: the other bot is not in
	// them.
	SetWorkspaceFeishuBotApp(ctx context.Context, workspaceID, appID string) error
	// DeleteWorkspaceFeishuBot removes all of the workspace's routes.
	DeleteWorkspaceFeishuBot(ctx context.Context, workspaceID string) error
	// SetFeishuPairingCode stores a new code (its hash) on the workspace's
	// pairing route; ErrNotFound when the workspace has no bot.
	SetFeishuPairingCode(ctx context.Context, workspaceID, codeHash, createdBy, expiresAt string) (FeishuBotRoute, error)
	// FindFeishuPairingRoute finds the pairing route holding codeHash on
	// an app whose Feishu client id is clientID.
	FindFeishuPairingRoute(ctx context.Context, clientID, codeHash string) (FeishuBotRoute, error)
	// FindFeishuChatRoute finds where chatID routes on an app whose Feishu
	// client id is clientID.
	FindFeishuChatRoute(ctx context.Context, clientID, chatID string) (FeishuBotRoute, error)
	// BindFeishuChat redeems pairing's code for a chat: the chat routes to
	// pairing's workspace from now on (replacing where it routed before on
	// the same Feishu app) and the code is spent.
	BindFeishuChat(ctx context.Context, pairing FeishuBotRoute, chat FeishuBotRoute) (FeishuBotRoute, error)
	// RecordFeishuChatName records a check of a chat route's name: name
	// replaces the stored one unless failure says why the check failed or
	// name is empty.
	RecordFeishuChatName(ctx context.Context, routeID, name, failure string, checkedAt time.Time) error
	// SetFeishuChatPeer records the other person of a direct chat route.
	SetFeishuChatPeer(ctx context.Context, routeID, openID string) error
	// DeleteFeishuBotRoute unbinds one chat of the workspace.
	DeleteFeishuBotRoute(ctx context.Context, workspaceID, routeID string) error
	// FeishuProviderAppsByClientID lists every Connectors app registered
	// for Feishu client id clientID, newest first.
	FeishuProviderAppsByClientID(ctx context.Context, clientID string) ([]ExternalProviderApp, error)
	// RecordFeishuEvent remembers that an event of Feishu app appID
	// arrived and reports whether it is the first time within ttl.
	RecordFeishuEvent(ctx context.Context, appID, eventID string, at time.Time, ttl time.Duration) (bool, error)

	GetFeishuChatThread(ctx context.Context, rootMessageID string) (FeishuChatThread, error)
	SaveFeishuChatThread(ctx context.Context, thread FeishuChatThread) error
}
