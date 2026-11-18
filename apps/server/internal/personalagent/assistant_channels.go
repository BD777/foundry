package personalagent

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Message channels the assistant may change (assistant_channels, DEV-298 S3).
// A channel reads one connector source into the assistant's conversations and
// may write back to it (acknowledgements, replies), so what it reaches is
// decided per operation and per field, the same way as the settings above.

// ChannelOpRead changes nothing: the operation only answers.
const ChannelOpRead = "read"

// ChannelOpProposal always waits for the person: a new channel starts reading a source.
const ChannelOpProposal = "proposal"

// ChannelOpByPatch is decided by the fields it changes (ChannelPatchClass).
const ChannelOpByPatch = "by-patch"

// ChannelOpRefused is an operation only the person does, whatever the assistant asks.
const ChannelOpRefused = "person-only"

// ChannelOpClasses is each assistant_channels operation's class. grant-source
// is person-only: it allows a source for the assistant's permission package
// (DEV-265), which is a widening the person decides on the Channels page.
var ChannelOpClasses = map[string]string{
	"list":         ChannelOpRead,
	"peers":        ChannelOpRead,
	"test":         ChannelOpRead,
	"create":       ChannelOpProposal,
	"update":       ChannelOpByPatch,
	"grant-source": ChannelOpRefused,
}

// channelPatchFields are the message channel fields an update may name, by
// their JSON names. resumeFromNow is the save's flag, not a stored field.
var channelPatchFields = []string{
	"name", "enabled", "source", "filters", "guide", "sessionKey", "scope", "limits",
	"workspaceId", "session", "followUps", "ack", "footer", "resumeFromNow",
}

// ChannelFieldClass is a channel field's class in an update. Only the name,
// and pausing a channel (enabled false), change nothing outside the person's
// own space; every other field widens what the channel reads or writes.
func ChannelFieldClass(field string, value string) SettingsClass {
	if field == "name" || (field == "enabled" && strings.TrimSpace(value) == "false") {
		return SettingsImmediate
	}
	return SettingsProposal
}

// ChannelPatchClass decides an update's patch from its fields and values
// (raw JSON). Every field must be a channel field, and the patch must share one
// class: a mixed patch is refused, so it either applies at once or becomes one proposal.
func ChannelPatchClass(patch map[string]string) (SettingsClass, error) {
	if len(patch) == 0 {
		return "", fmt.Errorf("the patch names no channel setting")
	}
	var class SettingsClass
	for _, field := range slices.Sorted(maps.Keys(patch)) {
		if !slices.Contains(channelPatchFields, field) {
			return "", fmt.Errorf("%s is not a channel setting the assistant changes", field)
		}
		fieldClass := ChannelFieldClass(field, patch[field])
		if class != "" && fieldClass != class {
			return "", fmt.Errorf("immediate and proposal channel settings cannot be changed in one update: send %s in a separate update", strings.Join(slices.Sorted(maps.Keys(patch)), ", "))
		}
		class = fieldClass
	}
	return class, nil
}

// ChannelProposalSummary is the question a channel proposal card asks.
func ChannelProposalSummary(language, op, name string, fields []string) string {
	sorted := slices.Clone(fields)
	slices.Sort(sorted)
	if language == "en" {
		if op == "create" {
			return fmt.Sprintf("Shall I add the message channel %q?", name)
		}
		return fmt.Sprintf("Shall I change the message channel %q: %s?", name, strings.Join(sorted, ", "))
	}
	if op == "create" {
		return fmt.Sprintf("要新增消息通道「%s」吗？", name)
	}
	return fmt.Sprintf("要改消息通道「%s」的设置吗：%s？", name, strings.Join(sorted, "、"))
}
