package personalagent

import (
	"fmt"
	"slices"
	"strings"
)

// SettingsClass is how a change to the assistant's own settings is decided
// (docs/personal-agent.md §5, DEV-298). The class belongs to the field.
type SettingsClass string

const (
	// SettingsImmediate applies at once: it only decides where the person's
	// notices and digests go and when they arrive. It is audited and can be
	// undone.
	SettingsImmediate SettingsClass = "immediate"
	// SettingsProposal spends money (which models run) or widens what the
	// assistant reaches outside the person's own space (the Feishu direct
	// chat). The person accepts a card first; nothing changes until then.
	SettingsProposal SettingsClass = "proposal"
)

// assistantSettingClasses maps each settings field assistant_settings may
// change to its class. A field not listed is the person's to set in
// Settings: the assistant cannot change it. Permission packages are a
// proposal class too, but they have no field here yet and are refused.
var assistantSettingClasses = map[string]SettingsClass{
	"notify":           SettingsImmediate,
	"activeHoursStart": SettingsImmediate,
	"activeHoursEnd":   SettingsImmediate,
	"urgentAnytime":    SettingsImmediate,
	"dailyDigest":      SettingsImmediate,
	"dailyDigestTime":  SettingsImmediate,
	"simpleInterface":  SettingsImmediate,
	"homePage":         SettingsImmediate,

	"assistantModel":     SettingsProposal,
	"delegateModel":      SettingsProposal,
	"assistantProfileId": SettingsProposal,
	"executionModels":    SettingsProposal,
	"runDefault":         SettingsProposal,
	"roleOverrides":      SettingsProposal,
	"feishuDirectChat":   SettingsProposal,
	"feishuAppId":        SettingsProposal,
}

// settingFieldLabels name each field on a proposal card: Chinese, English.
var settingFieldLabels = map[string][2]string{
	"notify":             {"通知去向", "where notices go"},
	"activeHoursStart":   {"活跃时段开始", "active hours start"},
	"activeHoursEnd":     {"活跃时段结束", "active hours end"},
	"urgentAnytime":      {"紧急时随时通知", "urgent notices at any hour"},
	"dailyDigest":        {"每日摘要", "daily summary"},
	"dailyDigestTime":    {"每日摘要时间", "daily summary time"},
	"simpleInterface":    {"界面模式", "interface mode"},
	"homePage":           {"打开时进入助理", "open on the assistant"},
	"assistantModel":     {"助理的模型", "the assistant's model"},
	"delegateModel":      {"派出工作的模型", "the model for delegated work"},
	"assistantProfileId": {"助理的模型配置", "the assistant's model profile"},
	"executionModels":    {"派出工作的模型选择", "the model choice for delegated work"},
	"runDefault":         {"默认运行方式", "the default run"},
	"roleOverrides":      {"各角色的运行方式", "the run per role"},
	"feishuDirectChat":   {"飞书单聊回复", "replies in the Feishu direct chat"},
	"feishuAppId":        {"飞书单聊应用", "the Feishu direct-chat app"},
}

// SettingsFieldClass is a field's class, false when the assistant may not
// change it.
func SettingsFieldClass(field string) (SettingsClass, bool) {
	class, ok := assistantSettingClasses[field]
	return class, ok
}

// SettingsFieldNames are the fields the assistant may change, sorted.
func SettingsFieldNames(class SettingsClass) []string {
	names := []string{}
	for field, fieldClass := range assistantSettingClasses {
		if fieldClass == class {
			names = append(names, field)
		}
	}
	slices.Sort(names)
	return names
}

// SettingsPatchClass decides one patch: every field must be one the
// assistant may change, and they must share a class. A patch mixing the two
// is refused, so each update either applies at once or becomes one proposal.
func SettingsPatchClass(fields []string) (SettingsClass, error) {
	if len(fields) == 0 {
		return "", fmt.Errorf("the patch names no setting")
	}
	var class SettingsClass
	for _, field := range fields {
		fieldClass, ok := SettingsFieldClass(field)
		if !ok {
			return "", fmt.Errorf("%s is not a setting the assistant changes: the person sets it in Settings", field)
		}
		if class != "" && fieldClass != class {
			return "", fmt.Errorf("immediate and proposal settings cannot be changed in one update: send %s in a separate update", strings.Join(fields, ", "))
		}
		class = fieldClass
	}
	return class, nil
}

// SettingsProposalSummary is the question a proposal card asks about a patch.
func SettingsProposalSummary(language string, fields []string) string {
	index := 0
	if language == "en" {
		index = 1
	}
	labels := make([]string, 0, len(fields))
	sorted := slices.Clone(fields)
	slices.Sort(sorted)
	for _, field := range sorted {
		if label, ok := settingFieldLabels[field]; ok {
			labels = append(labels, label[index])
		} else {
			labels = append(labels, field)
		}
	}
	if index == 1 {
		return fmt.Sprintf("Shall I change %s?", strings.Join(labels, ", "))
	}
	return fmt.Sprintf("要改助理的设置吗：%s？", strings.Join(labels, "、"))
}
