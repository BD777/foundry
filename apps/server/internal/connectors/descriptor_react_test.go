package connectors

import "testing"

func TestDescriptorChecksTheReactionCommand(t *testing.T) {
	descriptor := ackDescriptor()
	if err := checkDescriptor(descriptor); err != nil {
		t.Fatalf("a descriptor without react: %v", err)
	}
	descriptor.ServerHeld.Events.React = "olk im react {message.id} OneSecond --yes"
	if err := checkDescriptor(descriptor); err != nil {
		t.Fatalf("a valid react command: %v", err)
	}
	for _, command := range []string{
		"olk im react {reaction} OneSecond --yes",
		"olk im react {message.id} {key}",
		"olk im react {message.id} OneSecond {unknown}",
	} {
		descriptor.ServerHeld.Events.React = command
		if err := checkDescriptor(descriptor); err == nil {
			t.Errorf("react %q is accepted, want a placeholder error", command)
		}
	}
}
