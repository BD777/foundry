package workspacedigest

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// How much a match in each part of a digest counts. A match in notWhen
// counts against the project.
var rankFields = []struct {
	name, label string
	weight      float64
}{
	{"name", "name", 3},
	{"purpose", "purpose", 2},
	{"l0", "summary line", 2},
	{"routeWhen", "route here when", 2.5},
	{"note", "your note", 2.5},
	{"summary", "summary", 1},
	{"intro", "instructions", 1.5},
	{"sessions", "recent work", 1},
	{"issues", "open Issues", 1},
	{"history", "earlier requests", 1},
	{"files", "files", 0.8},
	{"tools", "skills and connectors", 0.8},
	{"notWhen", "not when", -2.5},
}

// longFields are normalized by their length, BM25's b.
var longFields = map[string]bool{"history": true, "summary": true, "sessions": true}

const lengthNormalization = 0.75

const (
	// nameMentionBonus is added when the request names the project.
	nameMentionBonus = 3
	// recencyBonus is the most recent activity adds, as a fraction of the
	// match: it orders near-equal matches, never makes one.
	recencyBonus     = 0.15
	recencyHalfLife  = 14 * 24 * time.Hour
	scoreScale       = 4
	cjkUnigramWeight = 0.15
	reasonFields     = 3
	reasonTerms      = 3
)

// Rank orders digests for a request, best first, at most limit: those
// archived, the assistant's own workspace and those nothing matched are
// left out. notes are the assistant's routing notes by workspace id.
func Rank(query string, digests []store.WorkspaceDigest, notes map[string]string, now time.Time, limit int) []store.WorkspaceCandidate {
	records := make([]store.WorkspaceDigestRecord, len(digests))
	for i, digest := range digests {
		records[i] = store.WorkspaceDigestRecord{Digest: digest}
	}
	return RankRecords(query, records, notes, now, limit)
}

// RankRecords is Rank over stored records, which also rank by their
// history and files.
func RankRecords(query string, records []store.WorkspaceDigestRecord, notes map[string]string, now time.Time, limit int) []store.WorkspaceCandidate {
	if limit <= 0 || limit > personalagent.FindWorkspaceLimit {
		limit = personalagent.FindWorkspaceLimit
	}
	terms := queryTerms(query)
	normalizedQuery := normalizeText(query)
	docs := []rankDoc{}
	for _, record := range records {
		digest := record.Digest
		if digest.Archived || digest.Kind == store.WorkspaceKindPersonalAgent {
			continue
		}
		docs = append(docs, newRankDoc(record, notes[digest.WorkspaceID]))
	}
	// How rare a term is counts over every request and field of every
	// project, not over projects: with a few projects and long histories,
	// everyday words reach most projects but few requests.
	documentFrequency, items := map[string]int{}, 0
	lengths := map[string]float64{}
	for _, doc := range docs {
		for _, item := range doc.items {
			for term := range item {
				documentFrequency[term]++
			}
		}
		items += len(doc.items)
		for field, length := range doc.lengths {
			lengths[field] += float64(length) / float64(len(docs))
		}
	}
	// A term most of the person's projects hold tells them apart less than
	// one only a few hold, however rare it is among their requests.
	projectFrequency := map[string]int{}
	for _, doc := range docs {
		for term := range doc.terms() {
			projectFrequency[term]++
		}
	}
	spread := func(term string) float64 {
		n, projects := float64(projectFrequency[term]), float64(len(docs))
		if n == 0 || projects <= 1 {
			return 1
		}
		return math.Log(1+(projects-n+0.5)/(n+0.5)) / math.Log(1+(projects-0.5)/1.5)
	}
	candidates := []store.WorkspaceCandidate{}
	for _, doc := range docs {
		score, reasons := doc.score(terms, documentFrequency, items, lengths, spread)
		if name := normalizeText(doc.digest.Name); len([]rune(name)) >= 2 && strings.Contains(normalizedQuery, name) {
			score += nameMentionBonus
			reasons = append([]string{"the request names it"}, reasons...)
		}
		if score <= 0 {
			continue
		}
		if at, ok := parseTime(doc.digest.LastActivityAt); ok {
			score *= 1 + recencyBonus*math.Exp2(-float64(now.Sub(at))/float64(recencyHalfLife))
		}
		stale := Stale(doc.digest, now)
		reasons = append(reasons, conditionReasons(doc.digest, stale)...)
		candidates = append(candidates, store.WorkspaceCandidate{
			WorkspaceID: doc.digest.WorkspaceID,
			Name:        doc.digest.Name,
			Reason:      strings.Join(reasons, "; "),
			Score:       math.Round(score/(score+scoreScale)*1000) / 1000,
			CompiledAt:  doc.digest.CompiledAt,
			Stale:       stale,
		})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].Name < candidates[j].Name
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

// Stale reports a digest to check live before acting on it: its summary
// predates what it summarizes, or nothing about it changed in a week.
func Stale(digest store.WorkspaceDigest, now time.Time) bool {
	if digest.Dirty {
		return true
	}
	compiled, ok := parseTime(digest.CompiledAt)
	return !ok || now.Sub(compiled) > personalagent.DigestStaleAfter
}

func conditionReasons(digest store.WorkspaceDigest, stale bool) []string {
	reasons := []string{}
	if digest.Unavailable {
		reasons = append(reasons, "its folder is unavailable on its device")
	} else if !digest.DeviceOnline {
		reasons = append(reasons, "its device is offline")
	}
	switch {
	case digest.SummarizedAt == "":
		reasons = append(reasons, "not summarized yet")
	case stale:
		reasons = append(reasons, "summary may be out of date")
	}
	return reasons
}

type rankDoc struct {
	digest  store.WorkspaceDigest
	fields  map[string]map[string]int
	lengths map[string]int
	// items are its fields and its history's requests, each a set of terms.
	items []map[string]bool
}

func newRankDoc(record store.WorkspaceDigestRecord, note string) rankDoc {
	digest := record.Digest
	sessions, issues := []string{}, []string{}
	for _, session := range digest.RecentSessions {
		sessions = append(sessions, session.Title)
	}
	for _, issue := range digest.OpenIssues {
		issues = append(issues, issue.Title)
	}
	texts := map[string]string{
		"name":      digest.Name,
		"purpose":   digest.Purpose,
		"l0":        digest.L0,
		"routeWhen": strings.Join(digest.RouteWhen, "\n"),
		"note":      note,
		"summary":   digest.Summary,
		"intro":     digest.Intro,
		"sessions":  strings.Join(sessions, "\n"),
		"issues":    strings.Join(issues, "\n"),
		"tools":     strings.Join(append(append([]string{}, digest.Skills...), digest.Connectors...), "\n"),
		"notWhen":   strings.Join(digest.NotWhen, "\n"),
		"history":   strings.Join(record.History, "\n"),
		"files":     strings.Join(record.Files, "\n"),
	}
	doc := rankDoc{digest: digest, fields: map[string]map[string]int{}, lengths: map[string]int{}}
	for field, text := range texts {
		counts := map[string]int{}
		words := textTerms(text)
		for _, term := range words {
			counts[term.text]++
		}
		doc.fields[field] = counts
		doc.lengths[field] = len(words)
		if field != "history" && field != "notWhen" && len(counts) > 0 {
			doc.items = append(doc.items, termSet(words))
		}
	}
	for _, request := range record.History {
		doc.items = append(doc.items, termSet(textTerms(request)))
	}
	return doc
}

// score is the doc's match for the request's terms, BM25-like: each term
// weighs by how rare it is among the person's projects, each field by
// rankFields, repeated matches saturate. reasons name the fields that
// counted most and their terms.
func (d rankDoc) score(terms []term, documentFrequency map[string]int, documents int, averageLengths map[string]float64, spread func(string) float64) (float64, []string) {
	type contribution struct {
		label string
		value float64
		terms []string
	}
	contributions := []contribution{}
	total := 0.0
	for _, field := range rankFields {
		counts := d.fields[field.name]
		// Long fields (a history of many requests) match more by chance.
		saturation := 1.2
		if average := averageLengths[field.name]; average > 0 && longFields[field.name] {
			saturation *= 1 - lengthNormalization + lengthNormalization*float64(d.lengths[field.name])/average
		}
		value, matched := 0.0, []string{}
		for _, term := range terms {
			count := counts[term.text]
			if count == 0 {
				continue
			}
			frequency := documentFrequency[term.text]
			idf := math.Log(1+(float64(documents-frequency)+0.5)/(float64(frequency)+0.5)) * spread(term.text)
			value += term.weight * idf * float64(count) / (float64(count) + saturation)
			matched = append(matched, term.surface)
		}
		if value == 0 {
			continue
		}
		value *= field.weight
		total += value
		if value > 0 {
			contributions = append(contributions, contribution{field.label, value, matched})
		} else {
			contributions = append(contributions, contribution{"but " + field.label, -value, matched})
		}
	}
	sort.SliceStable(contributions, func(i, j int) bool { return contributions[i].value > contributions[j].value })
	reasons := []string{}
	for _, item := range contributions {
		if len(reasons) == reasonFields {
			break
		}
		if len(item.terms) > reasonTerms {
			item.terms = item.terms[:reasonTerms]
		}
		reasons = append(reasons, fmt.Sprintf("%s matches %q", item.label, strings.Join(item.terms, " ")))
	}
	return total, reasons
}

// term is one matchable unit of text: a stemmed word, or two adjacent CJK
// characters (a lone one counts less).
type term struct {
	text, surface string
	weight        float64
}

// terms are every term the doc holds in a field that counts for it.
func (d rankDoc) terms() map[string]bool {
	all := map[string]bool{}
	for _, field := range rankFields {
		if field.weight <= 0 {
			continue
		}
		for term := range d.fields[field.name] {
			all[term] = true
		}
	}
	return all
}

func termSet(terms []term) map[string]bool {
	set := map[string]bool{}
	for _, term := range terms {
		set[term.text] = true
	}
	return set
}

// queryTerms are the request's distinct terms.
func queryTerms(query string) []term {
	seen := map[string]bool{}
	terms := []term{}
	for _, term := range textTerms(query) {
		if !seen[term.text] {
			seen[term.text] = true
			terms = append(terms, term)
		}
	}
	return terms
}

func textTerms(text string) []term {
	terms := []term{}
	var run []rune
	runCJK := false
	flush := func() {
		if len(run) == 0 {
			return
		}
		if runCJK {
			terms = append(terms, cjkTerms(run)...)
		} else if word := string(run); !stopWords[word] {
			terms = append(terms, term{text: stem(word), surface: word, weight: 1})
		}
		run = run[:0]
	}
	for _, r := range strings.ToLower(text) {
		cjk := isCJK(r)
		switch {
		case cjk:
			if !runCJK {
				flush()
			}
			runCJK = true
			run = append(run, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if runCJK {
				flush()
			}
			runCJK = false
			run = append(run, r)
		default:
			flush()
		}
	}
	flush()
	return terms
}

func cjkTerms(run []rune) []term {
	terms := []term{}
	for i, r := range run {
		if !cjkStopRunes[r] {
			terms = append(terms, term{text: string(r), surface: string(r), weight: cjkUnigramWeight})
		}
		if i+1 < len(run) {
			pair := string(run[i : i+2])
			if !cjkStopPairs[pair] && !(cjkStopRunes[run[i]] && cjkStopRunes[run[i+1]]) {
				terms = append(terms, term{text: pair, surface: pair, weight: 1})
			}
		}
	}
	return terms
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// stem folds the common English inflections together.
func stem(word string) string {
	if len(word) <= 3 || !isASCII(word) {
		return word
	}
	for _, rule := range []struct{ suffix, replacement string }{
		{"ies", "y"}, {"sses", "ss"}, {"ing", ""}, {"ed", ""}, {"es", ""}, {"s", ""},
	} {
		if strings.HasSuffix(word, rule.suffix) && len(word)-len(rule.suffix) >= 3 {
			stemmed := word[:len(word)-len(rule.suffix)] + rule.replacement
			if rule.suffix == "s" && strings.HasSuffix(word, "ss") {
				return word
			}
			return stemmed
		}
	}
	return word
}

func isASCII(word string) bool {
	for _, r := range word {
		if r > unicode.MaxASCII {
			return false
		}
	}
	return true
}

// normalizeText is text as a name is looked for in it: lower case,
// letters, digits and CJK only.
func normalizeText(text string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

var stopWords = setOf(strings.Fields(`a an the and or but if then else of to in on at by for from with without
	into onto about over under as is are was were be been being am do does did done doing have has had
	i me my mine we us our you your he him his she her it its they them their this that these those
	there here what which who whom whose when where why how can could would should will shall may might must
	please pls help let lets make get got go going want wanted need needed some any all more most very just
	also too so not no yes ok okay hi hello thanks thank up out again new now today tomorrow one thing stuff
	add update fix change check look try use show set create remove delete improve after before`))

var cjkStopRunes = func() map[rune]bool {
	stops := map[rune]bool{}
	for _, r := range "的了是在我你他她它们这那个和与或把被给帮一下吗呢吧啊呀要想做能会可以有没不也都就还让请去来到上中里对用说看再很太更最些点么什怎" {
		stops[r] = true
	}
	return stops
}()

var cjkStopPairs = setOf(strings.Fields(`帮我 一下 一个 我们 你们 他们 可以 这个 那个 什么 怎么 需要 想要 我想 给我 然后 现在 今天 明天
	看看 能不 不能 有没 没有 是不 还是 应该 已经 一些 比如 如果 帮忙 麻烦 一点 东西 事情 弄个 搞个 做个 一样 下吧`))

func setOf(values []string) map[string]bool {
	set := map[string]bool{}
	for _, value := range values {
		set[value] = true
	}
	return set
}

// closeMargin is how near the second candidate's score comes to the first
// before the two count as close (scores run 0-1). On the person's own
// requests the first of two that close is the right one about half the
// time.
const closeMargin = 0.05

// Close reports whether the ranking does not tell the first two
// candidates apart: then the request itself, or the person, has to.
func Close(candidates []store.WorkspaceCandidate) bool {
	return len(candidates) >= 2 && candidates[0].Score-candidates[1].Score < closeMargin
}
