package wirerecord

import (
	"cmp"
	"slices"
	"strconv"
)

// KindReport is what a recording holds of one kind of message and how it
// differs from the type declared for it.
type KindReport struct {
	Channel string `json:"channel"`
	Dir     string `json:"dir,omitempty"`
	Kind    string `json:"kind"`
	Samples int    `json:"samples"`
	Shapes  int    `json:"shapes"`
	// Omitted samples kept no body (too large, not JSON); Errors carried
	// an envelope error; Statuses counts REST answers by status.
	Omitted  int            `json:"omitted,omitempty"`
	Errors   int            `json:"errors,omitempty"`
	Statuses map[string]int `json:"statuses,omitempty"`
	// Declared names the type the samples were checked against;
	// Unchecked says why there was none.
	Declared  string       `json:"declared,omitempty"`
	Unchecked string       `json:"unchecked,omitempty"`
	Issues    []IssueCount `json:"issues,omitempty"`
}

// IssueCount is an issue and how many samples had it.
type IssueCount struct {
	Issue
	Samples int `json:"samples"`
}

// Report sums checked records by kind.
type Report struct {
	kinds  map[string]*KindReport
	shapes map[string]map[string]bool
	issues map[string]map[Issue]int
}

func NewReport() *Report {
	return &Report{kinds: map[string]*KindReport{}, shapes: map[string]map[string]bool{}, issues: map[string]map[Issue]int{}}
}

// Add counts one record with the issues its check found; an issue found
// several times in one record (each element of a list) counts once.
func (r *Report) Add(record Record, declared, unchecked string, issues []Issue) {
	k := key(record.Channel, record.Dir, record.Kind)
	kind := r.kinds[k]
	if kind == nil {
		kind = &KindReport{Channel: record.Channel, Dir: record.Dir, Kind: record.Kind}
		r.kinds[k] = kind
		r.shapes[k] = map[string]bool{}
		r.issues[k] = map[Issue]int{}
	}
	kind.Samples++
	kind.Declared, kind.Unchecked = declared, unchecked
	r.shapes[k][record.Shape] = true
	kind.Shapes = len(r.shapes[k])
	if record.Omitted != "" {
		kind.Omitted++
	}
	if record.Error != "" {
		kind.Errors++
	}
	if record.Status != 0 {
		if kind.Statuses == nil {
			kind.Statuses = map[string]int{}
		}
		kind.Statuses[strconv.Itoa(record.Status)]++
	}
	seen := map[Issue]bool{}
	for _, issue := range issues {
		if !seen[issue] {
			seen[issue] = true
			r.issues[k][issue]++
		}
	}
}

// Kinds lists the kinds by channel, direction and name, each one's issues
// most frequent first.
func (r *Report) Kinds() []KindReport {
	out := make([]KindReport, 0, len(r.kinds))
	for k, kind := range r.kinds {
		report := *kind
		report.Issues = nil
		for issue, samples := range r.issues[k] {
			report.Issues = append(report.Issues, IssueCount{Issue: issue, Samples: samples})
		}
		slices.SortFunc(report.Issues, func(a, b IssueCount) int {
			return cmp.Or(cmp.Compare(b.Samples, a.Samples), cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.Path, b.Path), cmp.Compare(a.Detail, b.Detail))
		})
		out = append(out, report)
	}
	slices.SortFunc(out, func(a, b KindReport) int {
		return cmp.Or(cmp.Compare(a.Channel, b.Channel), cmp.Compare(a.Dir, b.Dir), cmp.Compare(a.Kind, b.Kind))
	})
	return out
}
