// Package integrations is the server's switch for the work it does at
// third-party services with stored credentials or on its own schedule:
// Feishu event connections (for bots and agent subscriptions), Connectors
// (external account) logins, refreshes, revokes and keep-alive, and the
// background skill repository checks.
//
// FOUNDRY_INTEGRATIONS=off turns all of them off, so a server started on a
// copy of another server's database (a scratch stack) never opens a second
// bot connection or rotates the real refresh tokens. Unset (or "on") keeps
// them on. The command's config reads the setting; everything else is handed
// a *Switch.
package integrations

import (
	"errors"
	"fmt"
	"strings"
)

// Env is the environment variable that sets the switch.
const Env = "FOUNDRY_INTEGRATIONS"

// ErrOff is what an integration answers instead of reaching out.
var ErrOff = errors.New("integrations are off on this server (" + Env + "=off)")

// Switch says whether integrations may run. A nil *Switch is on, so callers
// that never configure one keep today's behaviour.
type Switch struct{ off bool }

// New returns a switch in the given position.
func New(on bool) *Switch { return &Switch{off: !on} }

// Parse reads the setting: "" or "on" is on, "off" is off; anything else is
// refused so a typo never leaves integrations running unexpectedly.
func Parse(value string) (*Switch, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "on":
		return New(true), nil
	case "off":
		return New(false), nil
	}
	return New(true), fmt.Errorf("%s must be on or off, not %q", Env, value)
}

// On reports whether integrations may run.
func (s *Switch) On() bool { return s == nil || !s.off }

// Err is nil when integrations may run, else ErrOff.
func (s *Switch) Err() error {
	if s.On() {
		return nil
	}
	return ErrOff
}
