package assistant

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A turn cut off by its computer going away (DEV-306) is told to the
// assistant conversation it ran in, once. Only the computer's own answer
// says the turn is lost: after it connects again, the server asks about each
// input it still counts as running and the computer does not claim, and an
// answer that carries no result for the turn is the interruption. A turn the
// computer still runs, or finished while away and recorded its result, is not
// interrupted and is not told. Neither is a turn the server already failed as
// stale while the computer was away: nothing then confirmed it was lost.

// LostTurn is an input the computer lost, as the reconnect asked about it.
type LostTurn struct {
	DeviceID string
	InputID  string
	// DroppedAt is when the computer's connection dropped; zero when the
	// server did not see the drop (a server restart).
	DroppedAt time.Time
	// BackAt is when the computer connected again and was asked.
	BackAt time.Time
}

// turnLostTexts are the notice's texts, [Chinese, English], with and
// without the time the computer dropped.
var turnLostTexts = map[string][2]string{
	"dropped": {
		"你的这一轮被中断了：电脑“%s”%s离线，%s回来，它已经不在运行这一轮，也没有保留结果。被中断的输入：%s",
		"Your turn was interrupted: the computer %q went offline at %s and came back at %s. It no longer runs this turn and kept no result. The input that was running: %s",
	},
	"back": {
		"你的这一轮被中断了：电脑“%s”%s回来，它已经不在运行这一轮，也没有保留结果。被中断的输入：%s",
		"Your turn was interrupted: the computer %q came back at %s. It no longer runs this turn and kept no result. The input that was running: %s",
	},
}

// TurnLost queues the notice that the assistant conversation session's
// input lost.InputID was interrupted. It is queued only for the assistant's
// own conversation (Conversation), and not while the assistant is stopped:
// like the back notice, a stopped assistant is not told. The notice is
// dropped if a later input started in the conversation before it goes out.
func (s *Service) TurnLost(ctx context.Context, session store.AgentSession, lost LostTurn) {
	agent, ok := s.Conversation(ctx, session)
	if !ok || agent.State != store.PersonalAgentActive {
		return
	}
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	location := s.PersonLocation(ctx, agent)
	label := s.devices.Labels(ctx)[lost.DeviceID]
	if label == "" {
		label = lost.DeviceID
	}
	backAt := lost.BackAt.In(location).Format("2006-01-02 15:04 MST")
	input := cutSummary(session.Input.Prompt)
	text := turnLostText(language, label, lost.DroppedAt, location, backAt, input)
	still := s.stillInput(session.ID, lost.InputID)
	s.notices.addLine(session.ID, language, noticeLine{key: "turn-lost:" + lost.InputID, text: text, due: still}, time.Now(), func(text string) {
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive || !still() {
			return
		}
		s.tell(context.Background(), session.ID, store.NoticeKindDeviceBack, text)
	})
}

// turnLostText fills the notice in the person's language.
func turnLostText(language, label string, droppedAt time.Time, location *time.Location, backAt, input string) string {
	index := languageIndex(language)
	if droppedAt.IsZero() {
		return fmt.Sprintf(turnLostTexts["back"][index], label, backAt, input)
	}
	droppedText := droppedAt.In(location).Format("2006-01-02 15:04 MST")
	return fmt.Sprintf(turnLostTexts["dropped"][index], label, droppedText, backAt, input)
}

// stillInput says whether the conversation's current input is still the lost
// one: an input that started after it makes the notice news the person or
// the assistant has moved past.
func (s *Service) stillInput(sessionID, inputID string) func() bool {
	return func() bool {
		current, err := s.store.GetAgentSessionSummary(context.Background(), sessionID)
		return err == nil && current.Input.ID == inputID
	}
}
