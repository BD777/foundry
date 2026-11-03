package wirerecord

import (
	"bytes"
	"encoding"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// Issue is one difference between a recorded value and the type declared
// for it.
type Issue struct {
	// Kind is "unknown" (a field the type does not declare), "missing" (a
	// field the type always has, absent), "type" (another JSON type, or a
	// value the type cannot take) or "null" (null where the type has a
	// list, a map or a value).
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Detail string `json:"detail,omitempty"`
}

var (
	jsonUnmarshaler = reflect.TypeFor[json.Unmarshaler]()
	textUnmarshaler = reflect.TypeFor[encoding.TextUnmarshaler]()
	rawMessage      = reflect.TypeFor[json.RawMessage]()
)

// CheckGo compares a recorded JSON value (decoded with UseNumber) with the
// Go type declared to decode or encode it, as encoding/json reads it, but
// strictly: a field is matched by its exact name, and one without
// omitempty or omitzero counts as required. path names the value in the
// issues ("payload").
func CheckGo(t reflect.Type, value any, path string) []Issue {
	var issues []Issue
	checkGo(t, value, path, &issues, 0)
	return issues
}

func checkGo(t reflect.Type, value any, path string, issues *[]Issue, depth int) {
	if depth > 32 {
		return
	}
	add := func(kind, detail string) { *issues = append(*issues, Issue{Kind: kind, Path: path, Detail: detail}) }
	for t.Kind() == reflect.Pointer {
		if value == nil {
			return
		}
		t = t.Elem()
	}
	if value == nil {
		switch t.Kind() {
		case reflect.Interface:
		case reflect.Slice, reflect.Map:
			if t != rawMessage {
				add("null", "null for "+t.String())
			}
		default:
			add("null", "null for "+t.String())
		}
		return
	}
	if t == rawMessage || t.Kind() == reflect.Interface {
		return
	}
	if reflect.PointerTo(t).Implements(jsonUnmarshaler) || reflect.PointerTo(t).Implements(textUnmarshaler) {
		if s, ok := value.(string); ok && IsPlaceholder(s) {
			return
		}
		encoded, _ := json.Marshal(value)
		if err := json.Unmarshal(encoded, reflect.New(t).Interface()); err != nil {
			add("type", fmt.Sprintf("%s for %s: %v", jsonType(value), t, err))
		}
		return
	}
	mismatch := func() { add("type", fmt.Sprintf("%s for %s", jsonType(value), t)) }
	switch t.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			mismatch()
			return
		}
		fields := goFields(t)
		for name, child := range object {
			field, ok := fields.byName[name]
			if !ok {
				detail := ""
				if other, ok := fields.byFold[strings.ToLower(name)]; ok {
					detail = fmt.Sprintf("encoding/json takes it as %q (case-insensitive)", other.name)
				}
				*issues = append(*issues, Issue{Kind: "unknown", Path: path + "." + name, Detail: detail})
				continue
			}
			checkGo(field.typ, child, path+"."+name, issues, depth+1)
		}
		for _, field := range fields.list {
			if _, ok := object[field.name]; !ok && field.required {
				*issues = append(*issues, Issue{Kind: "missing", Path: path + "." + field.name, Detail: field.typ.String()})
			}
		}
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok {
			mismatch()
			return
		}
		for _, child := range object {
			checkGo(t.Elem(), child, path+"{}", issues, depth+1)
		}
	case reflect.Slice, reflect.Array:
		if t.Elem().Kind() == reflect.Uint8 {
			s, ok := value.(string)
			if !ok {
				mismatch()
			} else if _, err := base64.StdEncoding.DecodeString(s); err != nil && !IsPlaceholder(s) {
				add("type", "not base64 for "+t.String())
			}
			return
		}
		list, ok := value.([]any)
		if !ok {
			mismatch()
			return
		}
		for _, child := range list {
			checkGo(t.Elem(), child, path+"[]", issues, depth+1)
		}
	case reflect.String:
		if _, ok := value.(string); !ok {
			mismatch()
		}
	case reflect.Bool:
		if _, ok := value.(bool); !ok {
			mismatch()
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, ok := value.(json.Number)
		if !ok {
			mismatch()
			return
		}
		if _, err := n.Int64(); err != nil {
			add("type", fmt.Sprintf("%s for %s", n, t))
		}
	case reflect.Float32, reflect.Float64:
		if _, ok := value.(json.Number); !ok {
			mismatch()
		}
	default:
		add("type", "cannot check "+t.String())
	}
}

type goField struct {
	name     string
	typ      reflect.Type
	required bool
	depth    int
}

type goFieldSet struct {
	list   []goField
	byName map[string]goField
	byFold map[string]goField
}

var goFieldCache sync.Map

// goFields lists the JSON fields of a struct as encoding/json does:
// embedded structs without a name are flattened, the shallowest field of a
// name wins, "-" and unexported fields are skipped.
func goFields(t reflect.Type) goFieldSet {
	if cached, ok := goFieldCache.Load(t); ok {
		return cached.(goFieldSet)
	}
	set := goFieldSet{byName: map[string]goField{}, byFold: map[string]goField{}}
	var collect func(t reflect.Type, depth int, seen map[reflect.Type]bool)
	collect = func(t reflect.Type, depth int, seen map[reflect.Type]bool) {
		if seen[t] {
			return
		}
		seen[t] = true
		for i := range t.NumField() {
			field := t.Field(i)
			tag := field.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name, options, _ := strings.Cut(tag, ",")
			fieldType := field.Type
			if field.Anonymous && name == "" {
				embedded := fieldType
				if embedded.Kind() == reflect.Pointer {
					embedded = embedded.Elem()
				}
				if embedded.Kind() == reflect.Struct {
					collect(embedded, depth+1, seen)
					continue
				}
			}
			if !field.IsExported() {
				continue
			}
			if name == "" {
				name = field.Name
			}
			optional := strings.Contains(","+options+",", ",omitempty,") || strings.Contains(","+options+",", ",omitzero,")
			if existing, ok := set.byName[name]; ok && existing.depth <= depth {
				continue
			}
			set.byName[name] = goField{name: name, typ: fieldType, required: !optional, depth: depth}
		}
	}
	collect(t, 0, map[reflect.Type]bool{})
	for _, field := range set.byName {
		set.list = append(set.list, field)
		set.byFold[strings.ToLower(field.name)] = field
	}
	goFieldCache.Store(t, set)
	return set
}

// Decode reads a recorded body for a check: numbers stay json.Number.
func Decode(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	err := decoder.Decode(&value)
	return value, err
}
