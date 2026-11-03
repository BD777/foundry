package jsonempty

import (
	"encoding/json"
	"testing"
)

func TestNilEncodesEmpty(t *testing.T) {
	var value struct {
		Required List[string] `json:"required"`
		Values   Map[int]     `json:"values"`
		Items    List[int]    `json:"items"`
		Optional List[string] `json:"optional,omitempty"`
	}
	value.Items = []int{1, 2}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"required":[],"values":{},"items":[1,2]}`; string(encoded) != want {
		t.Fatalf("got %s, want %s", encoded, want)
	}
	if err := json.Unmarshal([]byte(`{"required":["a"],"values":{"b":2}}`), &value); err != nil {
		t.Fatal(err)
	}
	if len(value.Required) != 1 || value.Values["b"] != 2 {
		t.Fatalf("decoded %+v", value)
	}
}
