package channels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Source is what an adapter provides: batches of envelopes from a cursor.
// The "base class" of DEV-203; which implementation runs is chosen by the
// connector's descriptor, never by product name.
type Source interface {
	// Poll reads the next batch after cursor ("" starts from now), waiting
	// on the feed's side for new items when there are none.
	Poll(ctx context.Context, cursor string) (Batch, error)
	// ContextHint is how an agent reads what surrounds a message with the
	// connector's own tool (a template over the envelope), or "".
	ContextHint(language string) string
}

// Batch is one poll's answer. Commit Cursor only after the envelopes are
// stored (at least once, Kafka-offset style).
type Batch struct {
	Envelopes []store.MessageEnvelope
	// Skipped counts items the mapping ignored on purpose; Invalid those it
	// could not read.
	Skipped, Invalid int
	Cursor           string
	More             bool
	// Gap is set when the feed no longer has the cursor: what lay between
	// it and Gap.Reset is lost, and Cursor is Gap.Reset.
	Gap *Gap
}

// Gap is a lost stretch of the feed.
type Gap struct {
	Reset  string
	Reason string
}

// Upstream sends one request to the connector instance the way Foundry's
// gateway does (sealed credentials, device forwarding), and returns the
// status and body.
type Upstream interface {
	Get(ctx context.Context, path string, query url.Values) (status int, body []byte, header http.Header, err error)
}

// ErrBusy is a feed that asked to be called again later.
type ErrBusy struct{ RetryAfter time.Duration }

func (e ErrBusy) Error() string { return "the feed is busy" }

// FeedError is a feed answer the channel cannot use.
type FeedError struct {
	Status  int
	Message string
}

func (e *FeedError) Error() string {
	if e.Status == 0 {
		return e.Message
	}
	return fmt.Sprintf("the feed answered %d: %s", e.Status, e.Message)
}

// LongPoll is the declarative HTTP long-poll source of a server-held
// connector extension (serverHeld.events.poll).
type LongPoll struct {
	Spec     store.ConnectorEventsSpec
	Upstream Upstream
}

func (p LongPoll) ContextHint(language string) string {
	if hint := p.Spec.Context.Hints[language]; hint != "" {
		return hint
	}
	return p.Spec.Context.Hint
}

func (p LongPoll) Poll(ctx context.Context, cursor string) (Batch, error) {
	poll := p.Spec.Poll
	query := url.Values{}
	for name, template := range poll.Query {
		value := strings.ReplaceAll(template, "{cursor}", cursor)
		if value == "" && slices.Contains(poll.OmitWhenEmpty, name) {
			continue
		}
		query.Set(name, value)
	}
	status, body, header, err := p.Upstream.Get(ctx, poll.Path, query)
	if err != nil {
		return Batch{}, err
	}
	var document any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	decodeErr := decoder.Decode(&document)
	if gap := poll.Gap; gap != nil && status == gap.Status && decodeErr == nil {
		code := ""
		if gap.Code != "" {
			value, _ := Pointer(document, gap.Code)
			code = scalar(value)
		}
		if gap.Code == "" || code == gap.CodeEquals {
			reset, _ := Pointer(document, gap.Reset)
			if value := scalar(reset); value != "" {
				return Batch{Cursor: value, Gap: &Gap{Reset: value, Reason: code}}, nil
			}
		}
	}
	if status == http.StatusTooManyRequests {
		wait := 2 * time.Second
		if seconds, err := time.ParseDuration(strings.TrimSpace(header.Get("Retry-After")) + "s"); err == nil && seconds > 0 {
			wait = seconds
		}
		return Batch{}, ErrBusy{RetryAfter: wait}
	}
	if status < 200 || status > 299 {
		return Batch{}, &FeedError{Status: status, Message: feedMessage(document)}
	}
	if decodeErr != nil {
		return Batch{}, &FeedError{Status: status, Message: "the answer is not JSON"}
	}
	next, ok := Pointer(document, poll.Cursor)
	batch := Batch{Cursor: scalar(next)}
	if !ok || batch.Cursor == "" {
		return Batch{}, &FeedError{Status: status, Message: "the answer has no cursor at " + poll.Cursor}
	}
	if poll.More != "" {
		more, _ := Pointer(document, poll.More)
		batch.More = scalar(more) == "true"
	}
	items, _ := Pointer(document, poll.Items)
	list, _ := items.([]any)
	for _, item := range list {
		envelope, skip, err := MapItem(p.Spec.Envelope, item)
		switch {
		case err != nil:
			batch.Invalid++
		case skip:
			batch.Skipped++
		default:
			batch.Envelopes = append(batch.Envelopes, envelope)
		}
	}
	return batch, nil
}

// feedMessage is a short, single-line message from an error answer.
func feedMessage(document any) string {
	for _, pointer := range []string{"/error/message", "/message", "/error"} {
		if value, ok := Pointer(document, pointer); ok {
			if text, ok := value.(string); ok && text != "" {
				return clip(strings.Join(strings.Fields(text), " "), 300)
			}
		}
	}
	return "no usable answer"
}

// errNoFeed is a source connector that declares no event feed.
var errNoFeed = errors.New("this connector declares no event feed")
