package connectors

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFillRequestTemplateEscapesEachKindOfValue(t *testing.T) {
	values := map[string]string{"target": "oc 1/x", "reaction": "OnIt"}
	path, err := FillRequestTemplate("/api/conversations/{target}/reactions/{reaction}", values, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/api/conversations/oc%201%2Fx/reactions/OnIt"; path != want {
		t.Errorf("path = %q, want %q", path, want)
	}
	body, err := FillRequestTemplate(`{"key":"{reaction}"}`, values, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"key":"OnIt"}`; body != want {
		t.Errorf("body = %q, want %q", body, want)
	}
}

func TestFillRequestTemplateJSONStringsTextThatIsNotJSONSafe(t *testing.T) {
	text := "say \"hi\"\r\nback\\slash\ttab 中文 <b>&amp;</b>"
	body, err := FillRequestTemplate(`{"text":"{text|json}"}`, map[string]string{"text": text}, true)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("filled body is not JSON: %v\n%s", err, body)
	}
	if got.Text != text {
		t.Errorf("text round-trips as %q, want %q", got.Text, text)
	}
}

func TestFillRequestTemplateRefusesBadTemplates(t *testing.T) {
	cases := []struct {
		name     string
		template string
		body     bool
		values   map[string]string
		want     string
	}{
		{"unknown placeholder", "/api/{feedId}", false, map[string]string{"target": "x"}, "not one of its values"},
		{"json placeholder in a path", "/api/{text|json}", false, map[string]string{"text": "x"}, "only for a body"},
		{"body that is not JSON once filled", `{"text":{text|json}}`, true, map[string]string{"text": "x"}, "not JSON"},
	}
	for _, c := range cases {
		if _, err := FillRequestTemplate(c.template, c.values, c.body); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
	}
}

func TestOpenLarkAckTemplatesFillTheSameRequests(t *testing.T) {
	descriptor := openLarkDescriptor(t)
	ack := descriptor.ServerHeld.Events.Ack
	if ack == nil {
		t.Fatal("open-lark declares no ack")
	}
	values := map[string]string{"message.id": "om_abc123", "reaction": ack.Reaction}
	add, err := FillRequestTemplate(ack.Add.Path, values, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/agent/v1/messages/om_abc123/reactions"; add != want {
		t.Errorf("add path = %q, want %q", add, want)
	}
	addBody, err := FillRequestTemplate(ack.Add.Body, values, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"key":"OnIt"}`; addBody != want {
		t.Errorf("add body = %q, want %q", addBody, want)
	}
	remove, err := FillRequestTemplate(ack.Remove.Path, values, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/agent/v1/messages/om_abc123/reactions/OnIt"; remove != want {
		t.Errorf("remove path = %q, want %q", remove, want)
	}
}
