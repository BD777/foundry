package feishu

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// A notice card is how the person hears of an item that waits for them
// (DEV-300): a card in their direct chat with the Foundry bot, with the item's
// question, its context, the choices, a note box, and a way to open the item.
// Its buttons and note box answer the notice; once it is answered or superseded
// the card shows that instead.

// noticeTexts are the card's words, [Chinese, English] (noticeText).
var noticeTexts = map[string][2]string{
	"kindQuestion": {"需要你决定", "Needs your decision"},
	"kindApproval": {"需要你批准", "Needs your approval"},
	"kindAsk":      {"助理问你", "Your assistant asks"},
	"kindHandOver": {"交给你处理", "Handed to you"},
	"context":      {"背景", "Context"},
	"command":      {"要做的事", "What it will do"},
	"chosen":       {"已处理：你选了 %s", "Done: you chose %s"},
	"replied":      {"已处理：%s", "Done: %s"},
	"closed":       {"已在别处处理", "Handled elsewhere"},
	"noted":        {"已记为补充说明：%s。还没有决定，仍可点按钮决定。", "Noted: %s. Not decided yet; the buttons still work."},
	"unsettled":    {"没能记下这次回答，请再点一次，或在 Foundry 中处理。", "Couldn't record that answer. Press again or handle it in Foundry."},
	"placeholder":  {"补充说明", "Add a note"},
	"send":         {"发送", "Send"},
	"open":         {"在 Foundry 打开", "Open in Foundry"},
}

// noticeContextLines and noticeContextRunes bound the context an item adds:
// two or three lines of its own words.
const (
	noticeContextLines = 3
	noticeContextRunes = 240
	noticeCommandRunes = 600
	noticeTitleRunes   = 200
)

// noticeFormField names the note box's value in the card's form.
const noticeFormField = "reply"

// noticeText is noticeTexts' key in language ("zh" or "en"), with args filled in.
func noticeText(language, key string, args ...any) string {
	index := 0
	if language == "en" {
		index = 1
	}
	text := noticeTexts[key][index]
	if len(args) > 0 {
		return fmt.Sprintf(text, args...)
	}
	return text
}

// NoticeFacts is what a notice card shows beside the notice's own question:
// whose assistant asks, about which project, and the item's context.
type NoticeFacts struct {
	// Assistant and Project name the assistant and the project of the item.
	Assistant string
	Project   string
	// Context is the item's own words: a hand-over's note, a helper's
	// question context, an ask's question.
	Context string
	// Command is what an approval asks the person to allow, shown as code.
	Command string
}

// NoticeView is the part of a notice card that is not the notice's own state:
// what the person's last press left on it while the notice is still open.
type NoticeView struct {
	// Note is text the person typed on an approval: information, not a decision.
	Note string
	// Unsettled says the last press could not be recorded.
	Unsettled bool
}

// BuildNoticeCard renders a notice in language ("zh" or "en"): the card while
// it waits for an answer, and what became of it once it is answered or superseded.
func BuildNoticeCard(notice store.PersonNotice, facts NoticeFacts, view NoticeView, language string) string {
	say := func(key string, args ...any) string { return noticeText(language, key, args...) }
	header := []string{say(noticeKindKey(notice.Kind))}
	if facts.Assistant != "" {
		header = append(header, facts.Assistant)
	}
	if facts.Project != "" {
		header = append(header, facts.Project)
	}
	title := textcut.Excerpt(notice.Title, noticeTitleRunes)
	switch notice.State {
	case store.NoticeAnswered:
		return buildNoticeCardJSON(strings.Join(header, " · "), "green", []CardElement{
			markdownElement("**" + title + "**\n\n" + answeredLine(notice, language)),
		})
	case store.NoticeSuperseded:
		return buildNoticeCardJSON(strings.Join(header, " · "), "grey", []CardElement{
			markdownElement("**" + title + "**\n\n" + say("closed")),
		})
	}
	body := "**" + title + "**"
	if context := firstLines(facts.Context, noticeContextLines); context != "" {
		body += "\n\n" + say("context") + "：\n" + textcut.Excerpt(context, noticeContextRunes)
	}
	if facts.Command != "" {
		body += "\n\n" + say("command") + "：\n" + fencedCode(textcut.Excerpt(facts.Command, noticeCommandRunes))
	}
	if view.Note != "" {
		body += "\n\n" + say("noted", textcut.Excerpt(view.Note, noticeContextRunes))
	}
	if view.Unsettled {
		body += "\n\n" + say("unsettled")
	}
	elements := []CardElement{markdownElement(body)}
	if noticeIsOpen(notice.State) {
		elements = append(elements, noticeActions(notice, language)...)
	}
	if notice.Link != "" {
		elements = append(elements, openButtonRow(say("open"), notice.Link))
	}
	return buildNoticeCardJSON(strings.Join(header, " · "), noticeTemplate(notice.Kind), elements)
}

// answeredLine says what the person chose, or what they wrote.
func answeredLine(notice store.PersonNotice, language string) string {
	answer := notice.AnswerText
	if slices.ContainsFunc(notice.Options, func(option store.PersonNoticeOption) bool { return option.Label == answer }) {
		return noticeText(language, "chosen", answer)
	}
	return noticeText(language, "replied", textcut.Excerpt(answer, noticeContextRunes))
}

// noticeIsOpen reports whether a notice still takes presses: sent or on its way.
func noticeIsOpen(state string) bool {
	return slices.Contains(store.NoticeActiveStates, state)
}

// noticeActions are the choices and the note box of an open notice: one button
// per option, then the note box when the person may write any text.
func noticeActions(notice store.PersonNotice, language string) []CardElement {
	var actions []CardElement
	if len(notice.Options) > 0 {
		buttons := make([]CardElement, 0, len(notice.Options))
		for index, option := range notice.Options {
			kind := "default"
			if index == 0 {
				kind = "primary_filled"
			}
			buttons = append(buttons, cardButton(option.Label, kind, map[string]string{
				"op": cardActionNotice, "noticeId": notice.ID, "option": strconv.Itoa(index),
			}))
		}
		actions = append(actions, cardButtons(buttons...))
	}
	if notice.AllowFreeText {
		actions = append(actions, noticeReplyForm(notice.ID, language))
	}
	return actions
}

// noticeReplyForm is the note box: an input and the button that sends it. The
// button's press carries the input's value in the form.
func noticeReplyForm(noticeID, language string) CardElement {
	return map[string]any{
		"tag":  "form",
		"name": "notice_reply",
		"elements": []any{
			map[string]any{
				"tag":         "input",
				"name":        noticeFormField,
				"placeholder": map[string]string{"tag": "plain_text", "content": noticeText(language, "placeholder")},
			},
			map[string]any{
				"tag":              "button",
				"name":             "notice_send",
				"text":             map[string]string{"tag": "plain_text", "content": noticeText(language, "send")},
				"type":             "primary",
				"form_action_type": "submit",
				"behaviors": []map[string]any{{"type": "callback", "value": map[string]string{
					"foundry": cardActionMarker, "op": cardActionNotice, "noticeId": noticeID, "option": "",
				}}},
			},
		},
	}
}

// openButtonRow is the button that opens the item in Foundry.
func openButtonRow(text, link string) CardElement {
	return map[string]any{
		"tag":       "button",
		"text":      map[string]string{"tag": "plain_text", "content": text},
		"type":      "default",
		"behaviors": []map[string]any{{"type": "open_url", "default_url": link}},
	}
}

func noticeKindKey(kind string) string {
	switch kind {
	case "approval":
		return "kindApproval"
	case "ask":
		return "kindAsk"
	case "hand_over":
		return "kindHandOver"
	default:
		return "kindQuestion"
	}
}

func noticeTemplate(kind string) string {
	switch kind {
	case "approval":
		return "orange"
	case "ask":
		return "turquoise"
	case "hand_over":
		return "purple"
	default:
		return "blue"
	}
}

func markdownElement(content string) CardElement {
	return MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(content)}
}

func buildNoticeCardJSON(title, template string, elements []CardElement) string {
	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{Title: CardTitle{Tag: "plain_text", Content: title}, Template: template},
		Body:   CardBody{Elements: elements},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

// firstLines keeps the first count lines of text, trimmed.
func firstLines(text string, count int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > count {
		lines = lines[:count]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// fencedCode sets text as a monospaced block; a fence inside it would end the block.
func fencedCode(text string) string {
	return "```\n" + strings.ReplaceAll(text, "```", "'''") + "\n```"
}
