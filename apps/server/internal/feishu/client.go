package feishu

import (
	"context"
	"fmt"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

type Client struct {
	appID     string
	appSecret string
	lark      *lark.Client
}

func NewClient(appID, appSecret string) *Client {
	larkClient := lark.NewClient(appID, appSecret)
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

func (c *Client) GetChatInfo(ctx context.Context, chatID string) (string, error) {
	req := larkim.NewGetChatReqBuilder().
		ChatId(chatID).
		Build()

	resp, err := c.lark.Im.V1.Chat.Get(ctx, req)
	if err != nil {
		return "", fmt.Errorf("feishu get chat: %w", err)
	}
	if !resp.Success() {
		return "", fmt.Errorf("feishu get chat failed [%d]: %s", resp.Code, resp.Msg)
	}
	if resp.Data != nil && resp.Data.Name != nil {
		return *resp.Data.Name, nil
	}
	return chatID, nil
}
