package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personnotice"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// noticeSinkPrefix names the notice sinks that are connector instances: a
// notice whose sink is ext:<instanceId> goes through that instance (DEV-294).
const noticeSinkPrefix = "ext:"

// noticeEchoWindow is how far back the echo check looks at sent notices, as
// the own-write check looks at the assistant's writes.
const noticeEchoWindow = 48 * time.Hour

const (
	// noticeAnswerLimit bounds how much of a send's answer is read.
	noticeAnswerLimit = 64 << 10
	// noticeExcerptRunes bounds the answer text kept in a failure's reason.
	noticeExcerptRunes = 300
)

// noticeSinkID is the dispatcher's name for a notice sink: the built-in bot
// keeps its own, every connector instance is ext:<instanceId>.
func noticeSinkID(instanceID string) string {
	if instanceID == feishu.NoticeSinkID {
		return instanceID
	}
	return noticeSinkPrefix + instanceID
}

// resolveNoticeSink is the dispatcher's resolver: an ext: sink id names one
// connector instance, read when a notice is sent.
func (s *Server) resolveNoticeSink(id string) (personnotice.Sink, bool) {
	if id == feishu.NoticeSinkID {
		return feishuNoticeSink{ws: s.feishu}, true
	}
	instanceID, ok := strings.CutPrefix(id, noticeSinkPrefix)
	if !ok || instanceID == "" {
		return nil, false
	}
	return extensionNoticeSink{s: s, instanceID: instanceID}, true
}

// extensionNoticeSink sends a person's notices through one server-held
// connector instance. What is sent, to where, and where the sent message's
// id is in the answer come from the descriptor's notify section; this type
// names no connector.
type extensionNoticeSink struct {
	s          *Server
	instanceID string
}

// Send reads the instance now, so a change to its chat or its descriptor
// applies to the notices not yet sent.
func (k extensionNoticeSink) Send(ctx context.Context, notice store.PersonNotice) (personnotice.SendResult, error) {
	app, err := k.s.store.GetExternalProviderApp(ctx, k.instanceID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return personnotice.SendResult{}, personnotice.Permanent(errors.New("the connector instance is gone"))
	case err != nil:
		return personnotice.SendResult{}, personnotice.Transient(fmt.Errorf("the connector instance could not be read: %w", err))
	case app.OwnerUserID != notice.UserID || app.CreatedVia != "extension":
		return personnotice.SendResult{}, personnotice.Permanent(errors.New("the connector instance is not an extension instance of the person"))
	}
	data, err := k.s.connectors.ServerHeld.ExtensionData(ctx, app)
	if err != nil {
		return personnotice.SendResult{}, personnotice.Transient(fmt.Errorf("the connector instance could not be checked: %w", err))
	}
	request, err := planNoticeRequest(data, notice, k.s.options.AllowedOrigin)
	if err != nil {
		return personnotice.SendResult{}, personnotice.Permanent(err)
	}
	deviceID, err := k.s.messageChannelDevice(data)
	if err != nil {
		return personnotice.SendResult{}, personnotice.Transient(err)
	}
	return sendNotice(ctx, request, func(ctx context.Context, method, path string, headers http.Header, body io.Reader) (*http.Response, error) {
		return k.s.connectors.ServerHeld.DoExtensionRequest(ctx, app, deviceID, method, path, nil, headers, body)
	})
}

// noticeRequest is one notice send, filled from the descriptor and the notice.
type noticeRequest struct {
	method, path string
	body         []byte
	// messageIDPointer is the descriptor's JSON pointer to the sent message's
	// id in a successful answer.
	messageIDPointer string
}

// planNoticeRequest fills the descriptor's notify send for one notice. A
// descriptor that takes no notices, a notify version this Foundry does not
// read, a connector without a notice chat, a notice with no Web address, or
// a send route the instance's directory does not allow as a write cannot be
// fixed by retrying: they are reported as errors for the caller to make
// permanent.
func planNoticeRequest(data store.ExtensionInstanceData, notice store.PersonNotice, origin string) (noticeRequest, error) {
	serverHeld := data.Descriptor.ServerHeld
	if serverHeld == nil || serverHeld.Notify == nil {
		return noticeRequest{}, errors.New("the connector does not take notices")
	}
	notify := serverHeld.Notify
	if notify.Version != 1 {
		return noticeRequest{}, fmt.Errorf("the connector's notify version %d needs a newer Foundry", notify.Version)
	}
	target := strings.TrimSpace(data.Values[notify.Target.Field])
	if target == "" {
		return noticeRequest{}, fmt.Errorf("the connector has no notice chat; set %s", notify.Target.Field)
	}
	values := map[string]string{"target": target, "notice.id": notice.ID}
	path, err := connectors.FillRequestTemplate(notify.Send.Path, values, false)
	if err != nil {
		return noticeRequest{}, fmt.Errorf("the notice path: %w", err)
	}
	link := notice.Link
	if link == "" {
		link = noticeLink(origin)
	}
	if link == "" {
		return noticeRequest{}, errors.New("the notice has no Web address: the server has no allowed origin")
	}
	values["text"] = personnotice.RenderText(notice)
	values["link"] = link
	body, err := connectors.FillRequestTemplate(notify.Send.Body, values, true)
	if err != nil {
		return noticeRequest{}, fmt.Errorf("the notice body: %w", err)
	}
	if err := connectors.CheckWriteRoute(data, notify.Send.Method, path); err != nil {
		return noticeRequest{}, err
	}
	return noticeRequest{method: notify.Send.Method, path: path, body: []byte(body), messageIDPointer: notify.Sent.MessageID}, nil
}

// noticeLink is the Web address a notice opens when it names none: the
// pending items page, since an item has no address of its own yet.
func noticeLink(origin string) string {
	base := strings.TrimRight(strings.TrimSpace(origin), "/")
	if base == "" {
		return ""
	}
	return base + "/pending"
}

// noticeRequester sends one request on the instance's server-held path.
type noticeRequester func(ctx context.Context, method, path string, headers http.Header, body io.Reader) (*http.Response, error)

// sendNotice sends a filled notice request and classifies the outcome for the
// dispatcher. The notice id is the request's clientId, so a resend carries the
// same id and the provider can drop the duplicate.
func sendNotice(ctx context.Context, request noticeRequest, send noticeRequester) (personnotice.SendResult, error) {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	response, err := send(ctx, request.method, request.path, headers, bytes.NewReader(request.body))
	if err != nil {
		return personnotice.SendResult{}, classifyNoticeTransport(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, noticeAnswerLimit))
	if err != nil {
		// The provider may have taken the notice before the answer broke.
		return personnotice.SendResult{}, personnotice.Ambiguous(fmt.Errorf("the send's answer could not be read: %w", err))
	}
	return noticeAnswer(response.StatusCode, payload, request.messageIDPointer)
}

// classifyNoticeTransport classifies a send that got no answer. A timeout may
// have reached the provider, so the notice may be there already; any other
// failure to reach it is transient.
func classifyNoticeTransport(err error) error {
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return personnotice.Ambiguous(err)
	}
	return personnotice.Transient(err)
}

// noticeAnswer classifies the answer to a notice send. A 2xx answer counts as
// sent only when it names the message at pointer: the reply path matches
// replies by that id, and a resend would repeat a notice already sent.
func noticeAnswer(status int, payload []byte, pointer string) (personnotice.SendResult, error) {
	switch {
	case status >= 200 && status <= 299:
		id := strings.TrimSpace(connectors.PointerText(payload, pointer))
		if id == "" {
			return personnotice.SendResult{}, personnotice.Permanent(fmt.Errorf("the send answered %d without a message id at %s", status, pointer))
		}
		return personnotice.SendResult{ProviderMessageID: id}, nil
	case status == http.StatusTooManyRequests || status >= 500:
		return personnotice.SendResult{}, personnotice.Transient(fmt.Errorf("the send answered %d: %s", status, answerExcerpt(payload)))
	default:
		return personnotice.SendResult{}, personnotice.Permanent(fmt.Errorf("the send answered %d: %s", status, answerExcerpt(payload)))
	}
}

// answerExcerpt is the start of an answer, for a failure's reason.
func answerExcerpt(payload []byte) string {
	text := strings.TrimSpace(string(payload))
	if runes := []rune(text); len(runes) > noticeExcerptRunes {
		return string(runes[:noticeExcerptRunes])
	}
	return text
}

// messageChannelNoticeEchoes is the channel's echo set: the ids of the notices
// Foundry sent through the channel's account's connector instance.
func (s *Server) messageChannelNoticeEchoes(ctx context.Context, channel store.MessageChannelRecord) (map[string]bool, error) {
	account, err := s.store.GetExternalAccount(ctx, channel.Source.AccountID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids, err := s.store.PersonNoticeSentIDs(ctx, noticeSinkID(account.AppID), time.Now().UTC().Add(-noticeEchoWindow))
	if err != nil {
		return nil, err
	}
	echoes := make(map[string]bool, len(ids))
	for _, id := range ids {
		echoes[id] = true
	}
	return echoes, nil
}
