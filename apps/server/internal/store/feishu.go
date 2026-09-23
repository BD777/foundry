package store

type FeishuBotStatus string

const (
	FeishuBotStatusUnconfigured FeishuBotStatus = "unconfigured"
	FeishuBotStatusConnecting   FeishuBotStatus = "connecting"
	FeishuBotStatusConnected    FeishuBotStatus = "connected"
	FeishuBotStatusError        FeishuBotStatus = "error"
)

type WorkspaceFeishuBot struct {
	WorkspaceID  string `json:"workspaceId"`
	AppID        string `json:"appId"`
	HasAppSecret bool   `json:"hasAppSecret"`
	ChatID       string `json:"chatId,omitempty"`
	ChatName     string `json:"chatName,omitempty"`
	// PairingCode is the hash of the current group pairing code; the
	// plaintext is returned only by the request that generated it.
	PairingCode          string `json:"-"`
	PairingCodeCreatedBy string `json:"-"`
	// BoundUserID is the account the bot acts as in its group: whoever
	// generated the pairing code the group used.
	BoundUserID          string          `json:"boundUserId,omitempty"`
	PairingCodeExpiresAt string          `json:"pairingCodeExpiresAt,omitempty"`
	Status               FeishuBotStatus `json:"status"`
	StatusDetail         string          `json:"statusDetail,omitempty"`
	UpdatedAt            string          `json:"updatedAt,omitempty"`
}

type SaveWorkspaceFeishuBotInput struct {
	WorkspaceID string `json:"workspaceId"`
	AppID       string `json:"appId"`
	AppSecret   string `json:"appSecret,omitempty"`
}

type FeishuChatThread struct {
	RootMessageID   string `json:"rootMessageId"`
	WorkspaceID     string `json:"workspaceId"`
	ChatID          string `json:"chatId"`
	LatestSessionID string `json:"latestSessionId"`
	CardMessageID   string `json:"cardMessageId"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}
