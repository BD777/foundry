// Package textdiff writes the unified diff of two texts line by line, as
// `diff -u` would. Foundry's tools hand it to agents, which read how a file
// changed far more cheaply than its two versions.
package textdiff

import (
	"fmt"
	"strings"
)

// MaxEdits bounds the lines added plus removed that Unified diffs; beyond it
// the edit search would cost more than the diff is worth to read.
const MaxEdits = 1000

type op byte

const (
	keep op = iota
	remove
	add
)

type edit struct {
	op   op
	line string
}

// Unified returns the diff from before to after with context unchanged
// lines around each change, headed by the two labels; "" when the texts are
// equal. ok is false when more than MaxEdits lines changed.
func Unified(beforeLabel, afterLabel, before, after string, context int) (diff string, ok bool) {
	if before == after {
		return "", true
	}
	edits, ok := lineEdits(splitLines(before), splitLines(after))
	if !ok {
		return "", false
	}
	var out strings.Builder
	fmt.Fprintf(&out, "--- %s\n+++ %s\n", beforeLabel, afterLabel)
	for _, hunk := range hunks(edits, context) {
		out.WriteString(hunk)
	}
	return out.String(), true
}

// splitLines keeps each line's newline, so a last line without one stays
// distinguishable from one with it.
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.SplitAfter(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// lineEdits is a shortest edit script from a to b (Myers' O(ND) search).
// The common prefix and suffix are kept aside first: most edits are small.
func lineEdits(a, b []string) ([]edit, bool) {
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	middle, ok := myers(a[prefix:len(a)-suffix], b[prefix:len(b)-suffix])
	if !ok {
		return nil, false
	}
	edits := make([]edit, 0, prefix+len(middle)+suffix)
	for _, line := range a[:prefix] {
		edits = append(edits, edit{keep, line})
	}
	edits = append(edits, middle...)
	for _, line := range a[len(a)-suffix:] {
		edits = append(edits, edit{keep, line})
	}
	return edits, true
}

func myers(a, b []string) ([]edit, bool) {
	n, m := len(a), len(b)
	limit := min(n+m, MaxEdits)
	// v[offset+k] is the furthest x reached on diagonal k; trace[d] keeps
	// the diagonals -d-1..d+1 as they were before step d.
	offset := limit + 1
	v := make([]int, 2*limit+3)
	var trace [][]int
	for d := 0; d <= limit; d++ {
		trace = append(trace, append([]int(nil), v[offset-d-1:offset+d+2]...))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[offset+k-1] < v[offset+k+1]) {
				x = v[offset+k+1]
			} else {
				x = v[offset+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x, y = x+1, y+1
			}
			v[offset+k] = x
			if x >= n && y >= m {
				return backtrack(a, b, trace), true
			}
		}
	}
	return nil, false
}

func backtrack(a, b []string, trace [][]int) []edit {
	var reversed []edit
	x, y := len(a), len(b)
	for d := len(trace) - 1; d >= 0; d-- {
		at := func(k int) int { return trace[d][k+d+1] }
		k := x - y
		previous := k - 1
		if k == -d || (k != d && at(k-1) < at(k+1)) {
			previous = k + 1
		}
		previousX := at(previous)
		previousY := previousX - previous
		for x > previousX && y > previousY {
			x, y = x-1, y-1
			reversed = append(reversed, edit{keep, a[x]})
		}
		if d == 0 {
			break
		}
		if x == previousX {
			reversed = append(reversed, edit{add, b[previousY]})
		} else {
			reversed = append(reversed, edit{remove, a[previousX]})
		}
		x, y = previousX, previousY
	}
	edits := make([]edit, len(reversed))
	for index, item := range reversed {
		edits[len(reversed)-1-index] = item
	}
	return edits
}

// hunks groups the edits into `@@` sections with context lines around each
// change; changes closer than twice the context share a section.
func hunks(edits []edit, context int) []string {
	var sections []string
	for start := 0; start < len(edits); {
		if edits[start].op == keep {
			start++
			continue
		}
		first := max(0, start-context)
		end := start
		for last := start; last < len(edits); last++ {
			if edits[last].op != keep {
				end = last
				continue
			}
			if last-end > 2*context {
				break
			}
		}
		stop := min(len(edits), end+context+1)
		sections = append(sections, section(edits, first, stop))
		start = stop
	}
	return sections
}

func section(edits []edit, first, stop int) string {
	beforeStart, afterStart := 1, 1
	for _, item := range edits[:first] {
		if item.op != add {
			beforeStart++
		}
		if item.op != remove {
			afterStart++
		}
	}
	var body strings.Builder
	beforeCount, afterCount := 0, 0
	for _, item := range edits[first:stop] {
		prefix := " "
		switch item.op {
		case remove:
			prefix = "-"
			beforeCount++
		case add:
			prefix = "+"
			afterCount++
		default:
			beforeCount++
			afterCount++
		}
		body.WriteString(prefix + item.line)
		if !strings.HasSuffix(item.line, "\n") {
			body.WriteString("\n\\ No newline at end of file\n")
		}
	}
	return fmt.Sprintf("@@ -%s +%s @@\n%s", lineRange(beforeStart, beforeCount), lineRange(afterStart, afterCount), body.String())
}

// lineRange is a hunk's range as diff writes it: an empty range names the
// line before it.
func lineRange(start, count int) string {
	if count == 0 {
		start--
	}
	if count == 1 {
		return fmt.Sprint(start)
	}
	return fmt.Sprintf("%d,%d", start, count)
}
