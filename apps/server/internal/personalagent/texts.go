package personalagent

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What the server says itself, without the model, in the person's
// language ("zh" or "en", LanguageOf).

// matchesWord reports whether a whole message is one of words: trimmed,
// case-folded, trailing punctuation ignored.
func matchesWord(message string, words []string) bool {
	message = strings.ToLower(strings.TrimRightFunc(strings.TrimSpace(message), func(r rune) bool {
		return unicode.IsPunct(r) || unicode.IsSpace(r)
	}))
	for _, word := range words {
		if message == word {
			return true
		}
	}
	return false
}

// The fixed words a channel handles before the model (§4, §8).
func IsStop(message string) bool    { return matchesWord(message, StopWords) }
func IsResume(message string) bool  { return matchesWord(message, ResumeWords) }
func IsAccept(message string) bool  { return matchesWord(message, AcceptWords) }
func IsDecline(message string) bool { return matchesWord(message, DeclineWords) }

// StopReply answers the stop switch (§8).
func StopReply(language string, stopped int) string {
	if language == "en" {
		return fmt.Sprintf("New work is paused; %d execution(s) are confirmed stopped. Pending stops still need a device receipt. Independent services are managed separately.", stopped)
	}
	return fmt.Sprintf("已暂停新工作，确认停下了 %d 项执行。未收到回执的停止仍需等设备确认，独立服务需单独管理。", stopped)
}

// ResumeReply answers resuming: nothing that was stopped restarts by
// itself, so the reply names what the stop cancelled and asks which to
// pick up again.
func ResumeReply(language string, stopped []string) string {
	if language == "en" {
		if len(stopped) == 0 {
			return "I'm back. Just tell me what you'd like to do."
		}
		return fmt.Sprintf("I'm back. What I stopped hasn't started again by itself: %s. Tell me which ones to pick up again.", strings.Join(stopped, "; "))
	}
	if len(stopped) == 0 {
		return "我回来了，有什么想做的直接告诉我。"
	}
	return fmt.Sprintf("我回来了。之前停下的事没有自己重新开始：%s。要接着做哪件，告诉我就行。", strings.Join(stopped, "、"))
}

// HomeOfflineReply answers a message while the home device is offline (§2).
func HomeOfflineReply(language, deviceLabel string) string {
	if language == "en" {
		return fmt.Sprintf("The computer I live on (%s) is offline right now. You can move me to another computer in my settings (%s).", deviceLabel, SettingsPath)
	}
	return fmt.Sprintf("助理所在的电脑（%s）现在不在线。可以在助理设置里换一台（%s）。", deviceLabel, SettingsPath)
}

// actionPhrases describe each managed action for a proposal card; %s is
// the project (or folder, or rule) it concerns.
var actionPhrases = map[string][2]string{
	store.PersonalAgentActionCreateWorkspace:    {"要我新建一个项目『%s』吗？", "Shall I set up a new project, “%s”?"},
	store.PersonalAgentActionRegisterFolder:     {"要我把你电脑上的文件夹「%s」当作项目来用吗？我会用到里面原有的文件。", "Shall I use your folder “%s” as a project? I would work with the files already in it."},
	store.PersonalAgentActionRenameWorkspace:    {"要我更新『%s』的名字或用途吗？", "Shall I update the name or purpose of “%s”?"},
	store.PersonalAgentActionAddSkill:           {"要我给『%s』加上新的技能吗？", "Shall I add skills to “%s”?"},
	store.PersonalAgentActionRemoveSkillCreated: {"要我去掉『%s』的一些技能吗？", "Shall I remove some skills from “%s”?"},
	store.PersonalAgentActionRemoveSkill:        {"要我去掉『%s』的一些技能吗？", "Shall I remove some skills from “%s”?"},
	store.PersonalAgentActionBindConnector:      {"要让『%s』里的工作以你的身份使用你的账号吗？", "Shall I let the work in “%s” use your accounts, acting as you?"},
	store.PersonalAgentActionUnbindConnector:    {"要我取消『%s』使用你账号的权限吗？那里正在用它的事可能会停下。", "Shall I take your accounts away from “%s”? Anything there that uses them may stop working."},
	store.PersonalAgentActionArchive:            {"要我把『%s』收起来吗？里面的东西都会保留，随时能拿回来。", "Shall I put “%s” away? Everything in it is kept, and you can bring it back any time."},
	store.PersonalAgentActionRestore:            {"要我把『%s』拿回来吗？", "Shall I bring “%s” back?"},
}

// ProposalSummary is a proposal card's question (§4).
func ProposalSummary(language, kind, subject string) string {
	index := 0
	if language == "en" {
		index = 1
	}
	if kind == store.PersonalAgentProposalRelaxRules {
		if index == 1 {
			return fmt.Sprintf("Shall I ask you less often: %s?", subject)
		}
		return fmt.Sprintf("要放宽规则吗：%s？", subject)
	}
	if phrases, ok := actionPhrases[kind]; ok {
		return fmt.Sprintf(phrases[index], subject)
	}
	return subject
}

// RenameSummary is a rename's card: the question names the new name, which
// "update the name or purpose" alone would hide.
func RenameSummary(language, from, to string) string {
	if language == "en" {
		return fmt.Sprintf("Shall I rename “%s” to “%s”?", from, to)
	}
	return fmt.Sprintf("要把『%s』改名为『%s』吗？", from, to)
}

var actionNames = map[string][2]string{
	store.PersonalAgentActionCreateWorkspace:    {"新建项目", "creating projects"},
	store.PersonalAgentActionRegisterFolder:     {"把已有文件夹当作项目", "using your existing folders as projects"},
	store.PersonalAgentActionRenameWorkspace:    {"改名或改用途", "renaming projects"},
	store.PersonalAgentActionAddSkill:           {"添加技能", "adding skills"},
	store.PersonalAgentActionRemoveSkillCreated: {"去掉助理建的项目的技能", "removing skills from projects I created"},
	store.PersonalAgentActionRemoveSkill:        {"去掉其他项目的技能", "removing skills from other projects"},
	store.PersonalAgentActionBindConnector:      {"让项目使用你的账号", "letting projects use your accounts"},
	store.PersonalAgentActionUnbindConnector:    {"取消项目使用你的账号", "taking your accounts away from projects"},
	store.PersonalAgentActionArchive:            {"收起项目", "putting projects away"},
	store.PersonalAgentActionRestore:            {"拿回收起的项目", "bringing projects back"},
}

var decisionNames = map[string][2]string{
	store.PersonalAgentAuto: {"直接做", "just do it"},
	store.PersonalAgentAsk:  {"先问你", "ask you first"},
	store.PersonalAgentDeny: {"不做", "never do it"},
}

// RuleSummary names a rule change for people: "改名或改用途：直接做".
func RuleSummary(language string, change store.PersonalAgentRuleChange) string {
	index := 0
	if language == "en" {
		index = 1
	}
	action, decision := actionNames[change.Action][index], decisionNames[change.Decision][index]
	if index == 1 {
		return action + ": " + decision
	}
	return action + "：" + decision
}
