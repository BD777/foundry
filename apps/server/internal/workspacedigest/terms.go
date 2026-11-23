package workspacedigest

import (
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/redact"
)

// Terms: the names a workspace's chats, sessions, files and connectors
// mention (hosts, services, code names, file and skill names), counted per
// source, so "sats-tokyo-7" or "cliproxyapi" points at the projects that
// talked about it. Counting is deterministic; it keeps names and counts,
// never what was said, and reads what a digest does not: the whole of each
// chat but tool calls, their output and reasoning.

const (
	// maxTermTextBytes is how much of one source's text is counted: its
	// latest messages.
	maxTermTextBytes = 256 << 10
	// maxTermsPerSource keeps a source's most frequent terms.
	maxTermsPerSource = 2000
	minTermBytes      = 2
	maxTermBytes      = 48
)

// CountTerms counts the terms of a source's texts, oldest first: only the
// latest maxTermTextBytes, without what redact.Text takes out of what
// people wrote (secrets, passwords and logins after their markers, e-mail
// addresses and user@host, hosts' addresses after ssh, tokens; termsOf).
// Redacting whole texts first would cost seconds per megabyte; a term
// stands alone, so judging each term and its neighbours keeps the same out.
func CountTerms(texts []string) map[string]int {
	budget := maxTermTextBytes
	start := len(texts)
	for start > 0 && budget > 0 {
		start--
		budget -= len(texts[start])
	}
	counts := map[string]int{}
	safe := map[string]bool{}
	for i := start; i < len(texts); i++ {
		text := texts[i]
		if i == start && budget < 0 {
			text = text[-budget:]
		}
		if strings.Contains(text, "PRIVATE KEY") {
			text = redact.Text(text)
		}
		for _, term := range termsOf(text, func(raw string) bool {
			// Every pattern redact.Text applies to a lone run needs a digit
			// or at least 16 characters (keys, tokens, numbers).
			if len(raw) < 16 && !strings.ContainsAny(raw, "0123456789") {
				return true
			}
			ok, judged := safe[raw]
			if !judged {
				ok = redact.Text(raw) == raw
				safe[raw] = ok
			}
			return ok
		}) {
			counts[term]++
		}
	}
	if len(counts) <= maxTermsPerSource {
		return counts
	}
	terms := make([]string, 0, len(counts))
	for term := range counts {
		terms = append(terms, term)
	}
	sort.Slice(terms, func(i, j int) bool {
		if counts[terms[i]] != counts[terms[j]] {
			return counts[terms[i]] > counts[terms[j]]
		}
		return terms[i] < terms[j]
	})
	kept := make(map[string]int, maxTermsPerSource)
	for _, term := range terms[:maxTermsPerSource] {
		kept[term] = counts[term]
	}
	return kept
}

// QueryTerms are the terms a query looks up, in order, without repeats.
func QueryTerms(query string) []string {
	seen := map[string]bool{}
	terms := []string{}
	for _, term := range termsOf(query, nil) {
		if !seen[term] {
			seen[term] = true
			terms = append(terms, term)
		}
	}
	return terms
}

// Words after which, joined by ':' or '=' (or "is"), a value is a secret
// or a login, and so is no term; and the commands whose dotted argument is
// a host's address.
var (
	valueMarkers = []string{"password", "passwd", "passphrase", "pwd", "secret", "token", "api_key", "apikey", "api-key",
		"access_key", "access-key", "private_key", "credential", "credentials", "session_id", "sessionid", "cookie", "user", "username", "login"}
	authSchemes = map[string]bool{"bearer": true, "basic": true}
	sshCommands = map[string]bool{"ssh": true, "sftp": true, "mosh": true}
	sshLogins   = map[string]bool{"root": true, "ubuntu": true, "admin": true, "centos": true, "debian": true, "azureuser": true}
)

// termsOf splits text into terms: runs of ASCII letters, digits, '-', '_'
// and '.', lower-cased and trimmed of those marks, that name something.
// A run next to '@', a value after a marker, a credential after an auth
// scheme, a dotted host after ssh, a login after "User" and, with safe, a
// run safe refuses (redact.Text would change it: a token, key or number)
// are left out.
func termsOf(text string, safe func(raw string) bool) []string {
	terms := []string{}
	previous, between := "", ""
	start := -1
	flush := func(end int) {
		if start < 0 {
			return
		}
		raw := text[start:end]
		lower := strings.ToLower(raw)
		adjacentAt := (start > 0 && text[start-1] == '@') || (end < len(text) && text[end] == '@')
		if !adjacentAt && !secretAfter(previous, between, lower) && (safe == nil || safe(raw)) {
			if term, ok := termOf(raw); ok {
				terms = append(terms, term)
			}
		}
		previous, between = strings.Trim(lower, "-_."), ""
		start = -1
	}
	for i := 0; i < len(text); i++ {
		c := text[i]
		if isTermByte(c) {
			if start < 0 {
				start = i
			}
			continue
		}
		flush(i)
		if len(between) < 8 {
			between += string(c)
		}
	}
	flush(len(text))
	return terms
}

// secretAfter: the run that follows previous, with between in between,
// is a value redact.Text would take out.
func secretAfter(previous, between, run string) bool {
	if previous == "" {
		return false
	}
	joined := strings.TrimSpace(strings.Trim(strings.TrimSpace(between), `"'`))
	marked := strings.ContainsAny(joined, ":=") || strings.Contains(joined, "：")
	for _, marker := range valueMarkers {
		if marked && strings.HasSuffix(previous, marker) {
			return true
		}
	}
	plain := strings.TrimSpace(between) == ""
	switch {
	case plain && authSchemes[previous] && len(run) >= 8:
		return true
	case plain && sshCommands[previous] && strings.Contains(run, "."):
		return true
	case plain && previous == "user" && (sshLogins[run] || strings.ContainsAny(run, "0123456789_-")):
		return true
	case plain && previous == "hostname":
		return true
	}
	return false
}

func isTermByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.'
}

// termOf is a raw run as a term, false for a run that names nothing: too
// short or long, a common word, a number or version, an id or a hash.
func termOf(raw string) (string, bool) {
	term := strings.ToLower(strings.Trim(raw, "-_."))
	if len(term) < minTermBytes || len(term) > maxTermBytes {
		return "", false
	}
	letters, digits := 0, 0
	for i := 0; i < len(term); i++ {
		switch c := term[i]; {
		case c >= 'a' && c <= 'z':
			letters++
		case c >= '0' && c <= '9':
			digits++
		}
	}
	if letters == 0 || (len(term) < 3 && digits == 0) || commonWords[term] {
		return "", false
	}
	if isVersion(term) || hasFoundryIDPrefix(term) {
		return "", false
	}
	for _, segment := range strings.FieldsFunc(term, func(r rune) bool { return r == '-' || r == '_' || r == '.' }) {
		if looksRandom(segment) {
			return "", false
		}
	}
	return term, true
}

// isVersion: v1.2, 1.2.3-rc1 and the like.
func isVersion(term string) bool {
	rest := strings.TrimPrefix(term, "v")
	if rest == "" || rest[0] < '0' || rest[0] > '9' || !strings.Contains(rest, ".") {
		return false
	}
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if !(c >= '0' && c <= '9' || c == '.') {
			return strings.HasPrefix(rest[i:], "-") || strings.HasPrefix(rest[i:], "rc") || strings.HasPrefix(rest[i:], "beta") || strings.HasPrefix(rest[i:], "alpha")
		}
	}
	return true
}

// foundryIDPrefixes name Foundry's own ids, which point at one record,
// not at what a project is about.
var foundryIDPrefixes = []string{"sess_", "native_claude_", "native_codex_", "ws_", "iss_", "dev_", "pai_", "res_", "att_", "evt_", "in_", "usr_", "prof_", "lease_"}

func hasFoundryIDPrefix(term string) bool {
	for _, prefix := range foundryIDPrefixes {
		if strings.HasPrefix(term, prefix) && len(term) > len(prefix)+4 {
			return true
		}
	}
	return false
}

// looksRandom: a segment of a hash, uuid or token rather than a name:
// eight or more hex characters with a digit, or twelve or more mixing
// letters and digits.
func looksRandom(segment string) bool {
	letters, digits, hex := 0, 0, true
	for i := 0; i < len(segment); i++ {
		c := segment[i]
		switch {
		case c >= '0' && c <= '9':
			digits++
		case c >= 'a' && c <= 'z':
			letters++
			if c > 'f' {
				hex = false
			}
		default:
			hex = false
		}
	}
	if hex && len(segment) >= 8 && digits > 0 {
		return true
	}
	return len(segment) >= 12 && letters >= 3 && digits >= 3
}

// commonWords are words that say nothing of a project: English function
// words, and words every software conversation uses.
var commonWords = func() map[string]bool {
	words := map[string]bool{}
	for _, word := range strings.Fields(`
a about above after again against all also am an and any are aren as at be because been before
being below between both but by can cannot could did didn do does doesn doing don down during each
few for from further had has have having he her here hers herself him himself his how if in into
is isn it its itself just let me more most must my myself no nor not now of off on once only or other
our ours ourselves out over own same shall she should so some such than that the their theirs them
themselves then there these they this those through to too under until up upon us very was wasn we
were what when where which while who whom why will with won would you your yours yourself yourselves
yes ok okay please thanks thank done also still yet via per etc e.g i.e eg ie vs
one two three first second next last new old get got go going make made use used using need needs
like want see look looks seem seems try tried say said know think way thing things lot lots
able already always another back better case change changed changes check checked come does
end even every example find found give good great keep left less long many maybe much never
part put read right run running runs set show since small start started state step steps still
sure take tell time times today true false null none nil undefined work works working
add added adds call called calls code create created default error errors file files fix fixed
line lines list name names number open output path return returns test tests text type types
update updated value values version view without within
http https www com org net html json yaml yml md txt log logs src lib bin tmp usr etc var
id ids url urls api cli app config main func function const string int bool
secret host user email phone private key
hmm hm ah oh closed connection heading sentence gave dark apps harmless following exactly noted
applying define minimal newest ends beyond saved mark intent continued self rule limit
`) {
		words[word] = true
	}
	return words
}()
