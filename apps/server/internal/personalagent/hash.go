package personalagent

// IsSHA256Hex reports whether v is a SHA-256 digest in lowercase hex: a
// reviewed source's hash, as the person or a review hands it back.
func IsSHA256Hex(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
