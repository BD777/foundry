package feishu

import (
	"context"
	"fmt"
	"io"
	"mime"
	"strings"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcontact "github.com/larksuite/oapi-sdk-go/v3/service/contact/v3"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

type Client struct {
	appID     string
	appSecret string
	lark      *lark.Client
}

// botClient is what Foundry asks of a bot: reply to a message with a card,
// update a card, read a chat's or a person's name, and download a file a
// message carries. Client implements it.
type botClient interface {
	ReplyCard(ctx context.Context, messageID string, cardJSON string) (string, error)
	PatchCard(ctx context.Context, cardMessageID string, cardJSON string) error
	ChatName(ctx context.Context, chatID string) (string, error)
	UserName(ctx context.Context, openID string) (string, error)
	MessageResource(ctx context.Context, messageID, fileKey, resourceType string) (MessageFile, error)
}

// NewClient is a bot client for the app; baseURL "" is Feishu's.
func NewClient(appID, appSecret, baseURL string) *Client {
	var options []lark.ClientOptionFunc
	if baseURL != "" {
		options = append(options, lark.WithOpenBaseUrl(baseURL))
	}
	larkClient := lark.NewClient(appID, appSecret, options...)
	return &Client{
		appID:     appID,
		appSecret: appSecret,
		lark:      larkClient,
	}
}

func (c *Client) ReplyCard(ctx context.Context, messageID string, cardJSON string) (string, error) {
	req := larkim.NewReplyMessageReqBuilder().
		MessageId(messageID).
		Body(larkim.NewReplyMessageReqBodyBuilder().
			MsgType(larkim.MsgTypeInteractive).
			Content(cardJSON).
			ReplyInThread(true).
			Build()).
		Build()

	resp, err := c.lark.Im.V1.Message.Reply(ctx, req)
	if err != nil {
		return "", fmt.Errorf("feishu reply card: %w", err)
	}
	if !resp.Success() {
		return "", fmt.Errorf("feishu reply card failed [%d]: %s", resp.Code, resp.Msg)
	}
	if resp.Data == nil || resp.Data.MessageId == nil {
		return "", fmt.Errorf("feishu reply card: missing message id in response")
	}
	return *resp.Data.MessageId, nil
}

func (c *Client) PatchCard(ctx context.Context, cardMessageID string, cardJSON string) error {
	req := larkim.NewPatchMessageReqBuilder().
		MessageId(cardMessageID).
		Body(larkim.NewPatchMessageReqBodyBuilder().
			Content(cardJSON).
			Build()).
		Build()

	resp, err := c.lark.Im.V1.Message.Patch(ctx, req)
	if err != nil {
		return fmt.Errorf("feishu patch card: %w", err)
	}
	if !resp.Success() {
		return fmt.Errorf("feishu patch card failed [%d]: %s", resp.Code, resp.Msg)
	}
	return nil
}

// ChatName is the chat's name in Feishu (GET /open-apis/im/v1/chats/:chat_id,
// with the app's tenant token: scope im:chat, im:chat:read or
// im:chat:readonly); "" when the chat has none, as a direct chat.
func (c *Client) ChatName(ctx context.Context, chatID string) (string, error) {
	resp, err := c.lark.Im.V1.Chat.Get(ctx, larkim.NewGetChatReqBuilder().ChatId(chatID).Build())
	if err != nil {
		return "", fmt.Errorf("feishu get chat: %w", err)
	}
	if !resp.Success() {
		return "", fmt.Errorf("feishu get chat failed [%d]: %s", resp.Code, resp.Msg)
	}
	if resp.Data != nil && resp.Data.Name != nil {
		return strings.TrimSpace(*resp.Data.Name), nil
	}
	return "", nil
}

// UserName is the name of the person with open_id openID (GET
// /open-apis/contact/v3/users/:user_id, with the app's tenant token: scope
// contact:user.base:readonly); "" when Feishu does not say.
func (c *Client) UserName(ctx context.Context, openID string) (string, error) {
	resp, err := c.lark.Contact.V3.User.Get(ctx, larkcontact.NewGetUserReqBuilder().UserId(openID).UserIdType(larkcontact.UserIdTypeOpenId).Build())
	if err != nil {
		return "", fmt.Errorf("feishu get user: %w", err)
	}
	if !resp.Success() {
		return "", fmt.Errorf("feishu get user failed [%d]: %s", resp.Code, resp.Msg)
	}
	if resp.Data != nil && resp.Data.User != nil && resp.Data.User.Name != nil {
		return strings.TrimSpace(*resp.Data.User.Name), nil
	}
	return "", nil
}

// MessageResource downloads a file message messageID carries (GET
// /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file,
// with the app's tenant token): resourceType "image" for an image key,
// "file" for a file, voice or video key. Feishu serves no stickers this way.
func (c *Client) MessageResource(ctx context.Context, messageID, fileKey, resourceType string) (MessageFile, error) {
	resp, err := c.lark.Im.V1.MessageResource.Get(ctx, larkim.NewGetMessageResourceReqBuilder().
		MessageId(messageID).FileKey(fileKey).Type(resourceType).Build())
	if err != nil {
		return MessageFile{}, fmt.Errorf("feishu get message resource: %w", err)
	}
	if !resp.Success() || resp.File == nil {
		return MessageFile{}, fmt.Errorf("feishu get message resource failed [%d]: %s", resp.Code, resp.Msg)
	}
	data, err := io.ReadAll(resp.File)
	if err != nil {
		return MessageFile{}, fmt.Errorf("feishu get message resource: %w", err)
	}
	mimeType := ""
	if resp.ApiResp != nil {
		mimeType, _, _ = mime.ParseMediaType(resp.Header.Get("Content-Type"))
	}
	return MessageFile{Name: strings.TrimSpace(resp.FileName), MIMEType: mimeType, Data: data}, nil
}
