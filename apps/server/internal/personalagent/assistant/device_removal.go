package assistant

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// removeDeviceSpec is remove_device's arguments. Note is included in the
// confirmation card; removal itself uses only DeviceID.
type removeDeviceSpec struct {
	DeviceID string `json:"deviceId"`
	Note     string `json:"note,omitempty"`
}

// planRemoveDevice always asks. Removing a device is destructive and cannot
// be undone, so it is deliberately outside the configurable policy.
func (s *Service) planRemoveDevice(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec removeDeviceSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "remove_device"}, err
	}
	spec.DeviceID = strings.TrimSpace(spec.DeviceID)
	spec.Note = strings.TrimSpace(spec.Note)
	write := Write{ArgsSummary: "remove_device " + spec.DeviceID, Spec: spec}
	if spec.DeviceID == "" {
		return write, invalid("deviceId is required")
	}
	unknown := refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound,
		"device %q was not found", spec.DeviceID)
	if !scope.owned[spec.DeviceID] {
		if _, err := s.store.DeviceRemovalPreview(ctx, spec.DeviceID); errors.Is(err, store.ErrNotFound) {
			return write, unknown
		} else if err != nil {
			return write, err
		}
		return write, refuse(store.PersonalAgentRefusalNotOwner, http.StatusUnprocessableEntity,
			"not allowed: %q is not one of the person's own devices", spec.DeviceID)
	}
	assistantDeviceID := scope.Agent.HomeDeviceID
	if workspace, err := s.store.GetWorkspace(ctx, scope.Agent.WorkspaceID); err == nil && workspace.DeviceID != "" {
		assistantDeviceID = workspace.DeviceID
	}
	if spec.DeviceID == assistantDeviceID {
		return write, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusUnprocessableEntity,
			"not allowed: %q is the device the assistant itself runs on", spec.DeviceID)
	}
	preview, err := s.store.DeviceRemovalPreview(ctx, spec.DeviceID)
	if errors.Is(err, store.ErrNotFound) {
		return write, unknown
	}
	if err != nil {
		return write, err
	}
	if s.devices.Connected(spec.DeviceID) {
		turns, err := s.store.RunningDeviceTurns(ctx, spec.DeviceID)
		if err != nil {
			return write, err
		}
		if turns > 0 {
			return write, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusConflict,
				"not allowed: %d turn(s) are running on %q. The person must wait for them to finish or stop them before removing the device.",
				turns, spec.DeviceID)
		}
	}
	label := cmp.Or(s.devices.Label(ctx, spec.DeviceID), spec.DeviceID)
	write.Subject = label
	write.ProposalSummary = removeDeviceSummary(
		personalagent.LanguageOf(scope.Agent.Settings, s.AccountLocale(ctx, scope.Agent.UserID)),
		label, preview, spec.Note,
	)
	write.Decisions = []Decision{{store.PersonalAgentActionRemoveDevice, store.PersonalAgentAsk}}
	// Belt and braces: the dedicated action cannot be ruled into auto, and
	// ProposalKind makes this a proposal even if a decision is persisted by an
	// older client.
	write.ProposalKind = store.PersonalAgentActionRemoveDevice
	write.Apply = func(ctx context.Context) (any, error) {
		device, err := s.devices.RemoveDevice(ctx, spec.DeviceID, false)
		if err != nil {
			return nil, err
		}
		return map[string]any{"status": "applied", "device": device}, nil
	}
	return write, nil
}

// removeDeviceSummary names what the preview says will be deleted. At most
// five project names are listed; the rest are counted.
func removeDeviceSummary(language, label string, preview store.DeviceRemovalPreview, note string) string {
	names := make([]string, 0, min(len(preview.Workspaces), 5))
	for _, workspace := range preview.Workspaces[:min(len(preview.Workspaces), 5)] {
		names = append(names, workspace.Name)
	}
	if more := len(preview.Workspaces) - len(names); more > 0 {
		names = append(names, fmt.Sprintf("and %d more", more))
	}
	other := 0
	for _, count := range preview.Other {
		other += count
	}
	workspaceCount := countText(len(preview.Workspaces), "workspace")
	if len(names) > 0 {
		workspaceCount += " (" + strings.Join(names, ", ") + ")"
	}
	if language == "zh" {
		if more := len(preview.Workspaces) - 5; more > 0 {
			workspaceCount = fmt.Sprintf("%d 个项目（%s，以及另外 %d 个）", len(preview.Workspaces),
				strings.Join(names[:min(len(names), 5)], "、"), more)
		} else if len(names) > 0 {
			workspaceCount = fmt.Sprintf("%d 个项目（%s）", len(preview.Workspaces), strings.Join(names, "、"))
		}
		summary := fmt.Sprintf("移除设备“%s”：将删除 %s、%d 个会话、%d 个 Issue",
			label, workspaceCount, preview.Sessions, preview.Issues)
		if other > 0 {
			summary += fmt.Sprintf("和其他 %d 条记录", other)
		}
		summary += "；此操作无法撤销。"
		if note != "" {
			summary += " 备注：" + note
		}
		return summary
	}
	summary := fmt.Sprintf("Remove the device “%s”: deletes %s, %s, %s",
		label, workspaceCount, countText(preview.Sessions, "session"), countText(preview.Issues, "issue"))
	if other > 0 {
		summary += ", and " + countText(other, "other record")
	}
	summary += "; this cannot be undone."
	if note != "" {
		summary += " Note: " + note
	}
	return summary
}

func countText(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}
