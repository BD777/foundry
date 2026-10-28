package feishu

import (
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
)

// webOrigin is the Foundry web app's origin (FOUNDRY_WEB_ORIGIN) that a
// Foundry id in a card links into; unset, ids stay text.
var webOrigin atomic.Pointer[string]

// SetWebOrigin names the web app's origin the cards link Foundry ids into.
func SetWebOrigin(origin string) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	webOrigin.Store(&origin)
}

const idUUID = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

// The ids the web app links (apps/web/src/lib/foundry-ids.ts): a session,
// an Issue, a device, a workspace. A native chat has no page of its own.
var (
	foundryIDPattern = regexp.MustCompile(`sess_\d+|iss_\d+|dev_` + idUUID + `|ws_` + idUUID)
	wholeIDPattern   = regexp.MustCompile(`^(?:sess_\d+|iss_\d+|dev_` + idUUID + `|ws_` + idUUID + `)$`)
	// Text that keeps its ids: a code span, a link, an autolink, a URL.
	protectedPattern = regexp.MustCompile("`[^`]*`|\\[[^\\]]*\\]\\([^)]*\\)|<[^>\\s]*>|https?://\\S+")
)

// foundryIDPath is the web page of a Foundry id, without a workspace: the
// page opens the object in its own.
func foundryIDPath(id string) string {
	escaped := url.PathEscape(id)
	switch {
	case strings.HasPrefix(id, "sess_"):
		return "/chats/" + escaped
	case strings.HasPrefix(id, "iss_"):
		return "/issues/" + escaped
	case strings.HasPrefix(id, "dev_"):
		return "/devices/" + escaped + "/agents"
	default:
		return "/locations/" + escaped
	}
}

func isIDWordByte(b byte) bool {
	return b == '_' || b == '-' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// linkIDsInText links the ids of plain text that stand alone: not part of
// a longer word, path or address (the web app's boundary rule).
func linkIDsInText(text, origin string) string {
	var out strings.Builder
	at := 0
	for _, match := range foundryIDPattern.FindAllStringIndex(text, -1) {
		start, end := match[0], match[1]
		if start > 0 && (isIDWordByte(text[start-1]) || strings.ContainsRune("/.@#=", rune(text[start-1]))) {
			continue
		}
		if end < len(text) && isIDWordByte(text[end]) {
			continue
		}
		id := text[start:end]
		out.WriteString(text[at:start])
		out.WriteString("[" + id + "](" + origin + foundryIDPath(id) + ")")
		at = end
	}
	out.WriteString(text[at:])
	return out.String()
}

// linkFoundryIDs turns the Foundry ids one Markdown line names into links
// to their web pages, so a person reading the card can open them. Existing
// links, URLs and code keep their text; a code span that is exactly an id
// becomes its link.
func linkFoundryIDs(line string) string {
	origin := webOrigin.Load()
	if origin == nil || *origin == "" || !foundryIDPattern.MatchString(line) {
		return line
	}
	var out strings.Builder
	at := 0
	for _, match := range protectedPattern.FindAllStringIndex(line, -1) {
		out.WriteString(linkIDsInText(line[at:match[0]], *origin))
		token := line[match[0]:match[1]]
		if code := strings.Trim(token, "`"); strings.HasPrefix(token, "`") && wholeIDPattern.MatchString(code) {
			token = "[" + code + "](" + *origin + foundryIDPath(code) + ")"
		}
		out.WriteString(token)
		at = match[1]
	}
	out.WriteString(linkIDsInText(line[at:], *origin))
	return out.String()
}
