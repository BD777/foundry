package httpapi

import (
	"regexp"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What the server keeps of a tool version check (docs/skills.md, Bundle
// 版本): one line per step, never a passed command's output. An account
// check prints the person's name, ids and scopes, which every Admin would
// otherwise read; a failed step keeps why, with such values masked.

var (
	checkVersion = regexp.MustCompile(`v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*`)
	// A JSON string whose key names an identity, a credential or a link.
	checkIdentityField = regexp.MustCompile(`(?i)("[a-z_]*(?:id|ids|key|token|secret|email|mobile|phone|name|url|avatar|profile)[a-z_]*"\s*:\s*)"[^"]*"`)
	// Feishu-style ids and Foundry profile names outside JSON.
	checkIdentityValue = regexp.MustCompile(`\b(?:ou|on|oc)_[0-9a-f]{8,}\b|\bfoundry-[0-9a-f-]{20,}\b`)
)

// redactCheckDetail masks the identity values a failed step's output may
// hold.
func redactCheckDetail(detail string) string {
	detail = checkIdentityField.ReplaceAllString(detail, `$1"…"`)
	return checkIdentityValue.ReplaceAllString(detail, "…")
}

// keptCheckSteps are the steps of tool's check as the server keeps and
// shows them: each with its kind (from the connector's catalog when the
// device did not say) and one-line value, a passed step without output, a
// failed one with its output masked.
func (s *Server) keptCheckSteps(tool string, steps []store.SkillBundleCheckStep) []store.SkillBundleCheckStep {
	var commands []store.ConnectorVersionCheckCommand
	label := ""
	if s.connectors != nil {
		if descriptor, ok := s.connectors.CheckedConnector(tool); ok {
			commands, label = descriptor.Tool.VersionCheck.Commands, descriptor.Label
		}
	}
	kept := make([]store.SkillBundleCheckStep, 0, len(steps))
	for _, step := range steps {
		if step.Kind == "" {
			if strings.HasSuffix(step.Name, " --version") {
				step.Kind = "version"
			}
			for _, command := range commands {
				if step.Name == strings.TrimSpace(tool+" "+strings.Join(command.Args, " ")) {
					step.Kind = string(command.Result)
				}
			}
		}
		if step.Kind != "" && step.Kind != "version" && step.Service == "" {
			step.Service = label
		}
		if step.Kind == "version" && step.Value == "" && step.State == store.CheckPassed {
			step.Value = checkVersion.FindString(step.Detail)
		}
		switch step.State {
		case store.CheckPassed:
			step.Detail = ""
		case store.CheckFailed:
			step.Detail = redactCheckDetail(step.Detail)
		}
		kept = append(kept, step)
	}
	return kept
}

// checkStepsTool is the bundle tool a step checked, by its name.
func checkStepsTool(repo store.SkillRepository, step store.SkillBundleCheckStep) string {
	for _, tool := range repo.Tools {
		if strings.HasPrefix(step.Name, tool.Name+" ") {
			return tool.Name
		}
	}
	return ""
}

// keptCheck is a stored check as it is served (checks recorded before the
// server dropped passed output are cleaned the same way).
func (s *Server) keptCheck(repo store.SkillRepository, check *store.SkillBundleCheck) *store.SkillBundleCheck {
	if check == nil {
		return nil
	}
	cleaned := *check
	cleaned.Steps = make([]store.SkillBundleCheckStep, 0, len(check.Steps))
	for _, step := range check.Steps {
		cleaned.Steps = append(cleaned.Steps, s.keptCheckSteps(checkStepsTool(repo, step), []store.SkillBundleCheckStep{step})...)
	}
	return &cleaned
}

// withKeptChecks serves every check of a bundle's versions and rollout as
// the server keeps them.
func (s *Server) withKeptChecks(repo *store.SkillRepository) {
	for i := range repo.Versions {
		repo.Versions[i].Check = s.keptCheck(*repo, repo.Versions[i].Check)
	}
	if repo.Rollout != nil {
		rollout := *repo.Rollout
		rollout.Devices = append([]store.SkillBundleRolloutDevice(nil), repo.Rollout.Devices...)
		for i := range rollout.Devices {
			rollout.Devices[i].Check = s.keptCheck(*repo, rollout.Devices[i].Check)
		}
		repo.Rollout = &rollout
	}
}
