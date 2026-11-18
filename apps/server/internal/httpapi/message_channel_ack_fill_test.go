package httpapi

import (
	"encoding/json"
	"os"
	"testing"
)

// The open-lark acknowledgement requests fill to the same path and body they
// sent before the shared template fill (DEV-294), read from the bundled manifest.
func TestAckTemplatesFillOpenLarkRequestsAsBefore(t *testing.T) {
	data, err := os.ReadFile("../../../../extensions/open-lark/foundry-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Connectors []struct {
			ServerHeld struct {
				Events struct {
					Ack struct {
						Reaction string `json:"reaction"`
						Add      struct {
							Path string `json:"path"`
							Body string `json:"body"`
						} `json:"add"`
						Remove struct {
							Path string `json:"path"`
						} `json:"remove"`
					} `json:"ack"`
				} `json:"events"`
			} `json:"serverHeld"`
		} `json:"connectors"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	ack := manifest.Connectors[0].ServerHeld.Events.Ack

	add, err := fillAckTemplate(ack.Add.Path, false, "om_abc123", ack.Reaction)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/agent/v1/messages/om_abc123/reactions"; add != want {
		t.Errorf("add path = %q, want %q", add, want)
	}
	body, err := fillAckTemplate(ack.Add.Body, true, "om_abc123", ack.Reaction)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"key":"OnIt"}`; body != want {
		t.Errorf("add body = %q, want %q", body, want)
	}
	remove, err := fillAckTemplate(ack.Remove.Path, false, "om_abc123", ack.Reaction)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/agent/v1/messages/om_abc123/reactions/OnIt"; remove != want {
		t.Errorf("remove path = %q, want %q", remove, want)
	}
	checkPath, err := fillAckTemplate(ack.Add.Path, false, "<message>", ack.Reaction)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/agent/v1/messages/%3Cmessage%3E/reactions"; checkPath != want {
		t.Errorf("route check path = %q, want %q", checkPath, want)
	}
}
