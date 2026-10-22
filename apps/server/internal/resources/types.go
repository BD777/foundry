package resources

import (
	"fmt"
	"slices"
	"sort"
	"time"
)

// TypeSpec is what the server knows of a resource type: whether sessions
// lease it, the operations a lease may run on it (operate_resource), and
// the timings of its leases. Types not listed here are inventory only.
type TypeSpec struct {
	ID string
	// Operations a lease may run, by name.
	Operations []OperationSpec
	// ParkTTL: how long a lease is kept after its holder's turn ended.
	ParkTTL time.Duration
	// MaxHoldFor bounds holdFor, which keeps a parked lease longer.
	MaxHoldFor time.Duration
	// ContendedCap: how long a holder keeps a lease once another session
	// waits for it.
	ContendedCap time.Duration
	// PreemptWarning: how long before preemption the holder is told it is
	// the last warning.
	PreemptWarning time.Duration
	// MaxDeadline bounds how long one operate_resource call may take on
	// the device.
	MaxDeadline time.Duration
	// MaxArgsBytes bounds the encoded actions of one call.
	MaxArgsBytes int
	// MaxResultText bounds one action's text in the answer; longer text
	// is cut.
	MaxResultText int
	// ResumeHint follows "acquire it again" when a lease ended.
	ResumeHint string
	// RemoteCommands: leasing it needs the device owner's
	// AllowRemoteCommands (store.ResourceSourceSettings).
	RemoteCommands bool
}

// OperationSpec is one operation of a type.
type OperationSpec struct {
	Name string
	// Mutates: it changes what is on the resource (a click), as opposed to
	// reading it (a screenshot).
	Mutates bool
	// Hidden names arguments the audit keeps as their length only (typed
	// text, values set).
	Hidden []string
	// Kept names arguments the audit keeps in full however long (up to
	// keptLimit): a command line.
	Kept []string
	// KeysOnly names object arguments the audit keeps as their keys (env
	// additions, whose values may be secrets).
	KeysOnly []string
}

// keptLimit bounds a Kept argument in the audit: runes of a string, items
// of a list.
const keptLimit = 4000

// computerUseOperations follow packages/protocol computerUseOperations,
// each one cua-driver tool (packages/worker/src/resources/providers).
var computerUseOperations = []OperationSpec{
	{Name: "select_window"},
	{Name: "screenshot"},
	{Name: "get_ui_tree"},
	{Name: "find_elements", Hidden: []string{"query"}},
	{Name: "list_apps"},
	{Name: "list_windows"},
	{Name: "open_app", Mutates: true},
	{Name: "activate_window", Mutates: true},
	{Name: "click", Mutates: true},
	{Name: "double_click", Mutates: true},
	{Name: "right_click", Mutates: true},
	{Name: "type_text", Mutates: true, Hidden: []string{"text"}},
	{Name: "key", Mutates: true},
	{Name: "hotkey", Mutates: true},
	{Name: "scroll", Mutates: true},
	{Name: "drag", Mutates: true},
	{Name: "set_value", Mutates: true, Hidden: []string{"value"}},
	{Name: "screen_size"},
	{Name: "wait"},
}

// computeOperations follow packages/protocol computeOperations, run by the
// worker itself (packages/worker/src/resources/providers/compute.ts).
var computeOperations = []OperationSpec{
	{Name: "run", Mutates: true, Kept: []string{"command", "argv"}, KeysOnly: []string{"env"}},
	{Name: "put_files", Mutates: true, Hidden: []string{"data"}},
	{Name: "get_file"},
	{Name: "git_sync", Mutates: true},
	{Name: "cleanup", Mutates: true},
}

// Bounds of compute operations; the worker enforces the same.
const (
	// MaxComputeRun bounds one run's timeoutSec.
	MaxComputeRun = 30 * time.Minute
	// computeUploadPiece bounds one put_files piece (base64 in the
	// arguments), so a call fits the MCP request and the worker's message
	// limits.
	computeUploadPiece = 768 << 10
)

var typeSpecs = map[string]TypeSpec{
	"computer_use": {
		ID:             "computer_use",
		Operations:     computerUseOperations,
		ParkTTL:        10 * time.Minute,
		MaxHoldFor:     2 * time.Hour,
		ContendedCap:   15 * time.Minute,
		PreemptWarning: time.Minute,
		MaxDeadline:    120 * time.Second,
		MaxArgsBytes:   64 << 10,
		MaxResultText:  100_000,
		ResumeHint:     ", and take a new screenshot: the screen may have changed",
	},
	"compute": {
		ID:             "compute",
		Operations:     computeOperations,
		ParkTTL:        10 * time.Minute,
		MaxHoldFor:     2 * time.Hour,
		ContendedCap:   15 * time.Minute,
		PreemptWarning: time.Minute,
		MaxDeadline:    MaxComputeRun + time.Minute,
		MaxArgsBytes:   computeUploadPiece + 64<<10,
		// get_file answers up to 25 MB as base64; the worker bounds it.
		MaxResultText:  40 << 20,
		RemoteCommands: true,
		ResumeHint:     "; commands it started were stopped, its scratch folder stays",
	},
}

// Spec is the spec of a leasable type; false for a type only listed.
func Spec(typeID string) (TypeSpec, bool) {
	spec, ok := typeSpecs[typeID]
	return spec, ok
}

// Operation is the spec of one of the type's operations.
func (t TypeSpec) Operation(name string) (OperationSpec, bool) {
	for _, operation := range t.Operations {
		if operation.Name == name {
			return operation, true
		}
	}
	return OperationSpec{}, false
}

// OperationNames lists the type's operations in order.
func (t TypeSpec) OperationNames() []string {
	names := make([]string, len(t.Operations))
	for index, operation := range t.Operations {
		names[index] = operation.Name
	}
	return names
}

// AuditArgs summarizes an operation's arguments for the audit: hidden ones
// and long strings become their length; nothing else is kept beyond 16
// arguments.
func (o OperationSpec) AuditArgs(args map[string]any) map[string]any {
	if len(args) == 0 {
		return nil
	}
	summary := map[string]any{}
	for name, value := range args {
		if len(summary) == 16 {
			break
		}
		hidden := false
		for _, secret := range o.Hidden {
			hidden = hidden || secret == name
		}
		text, isText := value.(string)
		switch {
		case slices.Contains(o.Kept, name):
			summary[name] = keptValue(value)
		case slices.Contains(o.KeysOnly, name):
			summary[name] = objectKeys(value)
		case hidden && isText:
			summary[name+"Length"] = len([]rune(text))
		case hidden:
			summary[name] = "(hidden)"
		case isText && len(text) > 120:
			summary[name+"Length"] = len([]rune(text))
		case isText:
			summary[name] = text
		default:
			switch typed := value.(type) {
			case float64, int, int64, bool, nil:
				summary[name] = value
			case []any:
				if shortStrings(typed) {
					summary[name] = typed
				} else {
					summary[name] = "(value)"
				}
			default:
				summary[name] = "(value)"
			}
		}
	}
	return summary
}

// keptValue is a kept argument as the audit stores it: a string or a
// list of strings, bounded.
func keptValue(value any) any {
	switch typed := value.(type) {
	case string:
		return clipRunes(typed, keptLimit)
	case []any:
		items := []string{}
		for index, item := range typed {
			if index == keptLimit/40 {
				items = append(items, "…")
				break
			}
			text, ok := item.(string)
			if !ok {
				text = fmt.Sprint(item)
			}
			items = append(items, clipRunes(text, 400))
		}
		return items
	case nil:
		return nil
	default:
		return "(value)"
	}
}

// objectKeys is an object argument's keys, sorted; never its values.
func objectKeys(value any) any {
	object, ok := value.(map[string]any)
	if !ok {
		return "(value)"
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, clipRunes(key, 120))
	}
	sort.Strings(keys)
	if len(keys) > 64 {
		keys = append(keys[:64], "…")
	}
	return keys
}

// shortStrings: a few short strings (keys of a hotkey, modifiers).
func shortStrings(values []any) bool {
	if len(values) > 8 {
		return false
	}
	for _, value := range values {
		text, ok := value.(string)
		if !ok || len(text) > 24 {
			return false
		}
	}
	return true
}
