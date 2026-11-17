package connectors

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// Bounds on what a person's card shows of a recorded request body.
const (
	connectorPreviewLines      = 12
	connectorPreviewValueLimit = 200
	connectorPreviewBodyLimit  = 8000
)

// PreviewBody is what a card shows of a recorded request: its top-level
// string fields as "key: value" lines, and the full JSON (bounded) for a
// disclosure. A body that is not JSON is shown as text, never as a
// headline.
func PreviewBody(body []byte) ([]string, string) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, ""
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var document any
	if decoder.Decode(&document) != nil {
		return nil, clipPreviewText(string(trimmed), connectorPreviewBodyLimit)
	}
	preview := []string{}
	if object, ok := document.(map[string]any); ok {
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value, ok := object[key].(string)
			if !ok || strings.TrimSpace(value) == "" {
				continue
			}
			preview = append(preview, key+": "+clipPreviewText(value, connectorPreviewValueLimit))
			if len(preview) >= connectorPreviewLines {
				break
			}
		}
	}
	text := string(trimmed)
	if marshaled, err := json.MarshalIndent(document, "", "  "); err == nil {
		text = string(marshaled)
	}
	return preview, clipPreviewText(text, connectorPreviewBodyLimit)
}

func clipPreviewText(text string, limit int) string {
	runes := []rune(text)
	if limit <= 0 || len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
