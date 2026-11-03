// Package jsonempty holds the collection types the generated contract models use for
// required arrays and maps: a nil value encodes as [] or {}, never null, so Go code may
// leave a required collection unset. A plain slice or map converts to them implicitly,
// and range, len, append and indexing work as on the underlying type.
//
// encoding/json/v2 encodes nil slices and maps as empty by default; once the server
// builds with it, these types can go.
package jsonempty

import "encoding/json"

// List is a slice that encodes nil as [].
type List[T any] []T

func (l List[T]) MarshalJSON() ([]byte, error) {
	if l == nil {
		return []byte("[]"), nil
	}
	return json.Marshal([]T(l))
}

// Map is a map that encodes nil as {}.
type Map[V any] map[string]V

func (m Map[V]) MarshalJSON() ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(map[string]V(m))
}
