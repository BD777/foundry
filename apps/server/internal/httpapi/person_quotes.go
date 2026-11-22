package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session that hands work on (create_session, send_message, dispatch_item)
// may pass on the person's own words, such as an approval they gave it, as
// personQuote. Foundry finds them in one of the person's messages in the
// sender's conversation, the check update_list applies to a quote
// (assistant.PersonQuoteSource), and adds them to the message as a fact:
// whose words, when and where they were said. Words it does not find there
// are refused. What the recipient makes of them is its own judgement.

const (
	// personQuoteMaxLength is the longest personQuote, in characters.
	personQuoteMaxLength = store.PersonalAgentItemDecisionMaxLength
	// personQuoteHeading opens the fact in the message.
	personQuoteHeading = "[Foundry checked: the person's own words]"
)

// personQuoteFact is the fact the message carries for args' personQuote,
// "" when it has none.
func (s *Server) personQuoteFact(ctx context.Context, actor Actor, args map[string]json.RawMessage) (string, error) {
	quote := mcpArgString(args, "personQuote")
	if quote == "" {
		return "", nil
	}
	if !actor.Agent() {
		return "", invalid("personQuote passes on the person's words from an agent's conversation with them; a person's own message needs none")
	}
	if utf8.RuneCountInString(quote) > personQuoteMaxLength {
		return "", invalid("personQuote is at most %d characters", personQuoteMaxLength)
	}
	conversation, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
	if err != nil {
		return "", err
	}
	source, found, err := s.assistant.PersonQuoteSource(ctx, conversation.ID, conversation.Input, quote)
	if err != nil {
		return "", err
	}
	if !found {
		return "", invalid("personQuote is not in any one of the person's own messages in this conversation (%s): copy their words from one message as they wrote them, marking words left out with …", conversation.ID)
	}
	person := "The person"
	if user, err := s.store.GetUser(ctx, conversation.CreatedByUserID); err == nil {
		person = cmp.Or(user.DisplayName, user.Username, person)
	}
	at := source.At
	if parsed, err := time.Parse(time.RFC3339Nano, source.At); err == nil {
		at = parsed.UTC().Format(time.RFC3339)
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s\n%s wrote this at %s in their own message in session %s", personQuoteHeading, person, at, conversation.ID)
	if link := s.assistant.SessionURL(conversation); link != "" {
		fmt.Fprintf(&builder, " (%s)", link)
	}
	builder.WriteString(":\n")
	for _, line := range strings.Split(quote, "\n") {
		fmt.Fprintf(&builder, "> %s\n", line)
	}
	return builder.String(), nil
}

// withPersonQuoteFact is prompt followed by the fact, if any.
func withPersonQuoteFact(prompt, fact string) string {
	if fact == "" {
		return prompt
	}
	return strings.TrimRight(prompt, "\n") + "\n\n" + fact
}
