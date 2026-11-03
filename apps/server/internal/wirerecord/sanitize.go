package wirerecord

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"regexp"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/redact"
)

// What a recording keeps of a value is its structure: every key, every JSON
// type, short identifiers and enum values. Strings that could hold a secret
// or someone's content are replaced by a placeholder that is still a
// string, so the shape stays checkable:
//
//   - under a secret-named key (token, credential, apiKey, password,
//     cookie, authorization, env, headers…, the names the server's and
//     the worker's redaction treat as secrets): ‹secret›;
//   - under a content key (file and attachment contents, base64 data,
//     message text, diffs, command lines…): ‹text N bytes›;
//   - any other string longer than MaxStringBytes: ‹string N bytes›;
//   - the rest goes through redact.Text (tokens, keys, URLs' credentials,
//     addresses and the like by their shape).
var (
	secretKeyPattern  = regexp.MustCompile(`(?i)token|secret|passw|passphrase|^pwd$|api[_-]?key|access[_-]?key|private[_-]?key|credential|authori[sz]ation|cookie|^key$|^code$|signature|^sig$|^env$|environment|headers?$|^dsn$|bearer`)
	contentKeyPattern = regexp.MustCompile(`(?i)^(content|contents|data|database64|base64|contentbase64|chunk|text|message|prompt|output|stdout|stderr|diff|patch|before|after|body|html|markdown|preview|snippet|instructions|systemprompt|transcript|command|cmd|args|argv)$`)
)

const placeholderPrefix = "‹"

// IsPlaceholder reports whether a recorded string stands for one that was
// taken out, so a check does not hold its form against it.
func IsPlaceholder(s string) bool { return strings.HasPrefix(s, placeholderPrefix) }

type sanitizeMode int

const (
	modeNormal sanitizeMode = iota
	modeSecret
	modeContent
)

type sanitizer struct {
	maxString, arrayHead, arrayMax int
}

func (s sanitizer) value(value any, mode sanitizeMode) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, child := range v {
			childMode := mode
			if childMode == modeNormal {
				if secretKeyPattern.MatchString(k) {
					childMode = modeSecret
				} else if contentKeyPattern.MatchString(k) {
					childMode = modeContent
				}
			}
			out[s.key(k)] = s.value(child, childMode)
		}
		return out
	case []any:
		return s.array(v, mode)
	case string:
		switch {
		case v == "":
			return v
		case mode == modeSecret:
			return redact.Secret
		case mode == modeContent:
			return fmt.Sprintf("‹text %d bytes›", len(v))
		}
		return s.text(v)
	default:
		// json.Number, bool, nil: no secret fits in them.
		return v
	}
}

// key keeps a map key readable: field names and ids are short; a key
// holding content (a path, a sentence) is cut like any string.
func (s sanitizer) key(k string) string {
	if len(k) > s.maxString {
		return fmt.Sprintf("‹key %d bytes›", len(k))
	}
	return redact.Text(k)
}

func (s sanitizer) text(v string) string {
	if len(v) > s.maxString {
		return fmt.Sprintf("‹string %d bytes›", len(v))
	}
	return redact.Text(v)
}

// array keeps the first elements and later ones of a shape not kept yet.
func (s sanitizer) array(values []any, mode sanitizeMode) []any {
	out := make([]any, 0, min(len(values), s.arrayMax))
	seen := map[string]bool{}
	for i, element := range values {
		if len(out) >= s.arrayMax {
			break
		}
		clean := s.value(element, mode)
		digest := shapeDigest(shapeOf(clean))
		if i >= s.arrayHead && seen[digest] {
			continue
		}
		seen[digest] = true
		out = append(out, clean)
	}
	return out
}

// shapeOf lists a value's field paths with their JSON types, sorted and
// unique: ":object", ".items[]:object", ".items[].id:string"….
func shapeOf(value any) []string {
	set := map[string]bool{}
	var walk func(path string, value any)
	walk = func(path string, value any) {
		set[path+":"+jsonType(value)] = true
		switch v := value.(type) {
		case map[string]any:
			for k, child := range v {
				walk(path+"."+k, child)
			}
		case []any:
			for _, child := range v {
				walk(path+"[]", child)
			}
		}
	}
	walk("", value)
	shapes := make([]string, 0, len(set))
	for entry := range set {
		shapes = append(shapes, entry)
	}
	slices.Sort(shapes)
	return shapes
}

func shapeDigest(shapes []string) string {
	h := fnv.New64a()
	for _, entry := range shapes {
		h.Write([]byte(entry))
		h.Write([]byte{0})
	}
	return fmt.Sprintf("%016x", h.Sum64())
}

func jsonType(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case json.Number:
		if strings.ContainsAny(string(v), ".eE") {
			return "number"
		}
		return "integer"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return fmt.Sprintf("%T", value)
}
