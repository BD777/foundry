package sessionwork

import (
	"regexp"
	"strconv"
	"strings"
)

var cronPart = regexp.MustCompile(`^(\*|[0-9]+)(?:-([0-9]+))?(?:/([0-9]+))?$`)

// ValidCron accepts the numeric five-field grammar shared with protocol/cron.ts.
func ValidCron(expression string) bool {
	fields := strings.Fields(expression)
	if len(fields) != 5 {
		return false
	}
	bounds := [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	for i, field := range fields {
		for _, part := range strings.Split(field, ",") {
			match := cronPart.FindStringSubmatch(part)
			if match == nil {
				return false
			}
			start, end := bounds[i][0], bounds[i][1]
			if match[1] != "*" {
				start, _ = strconv.Atoi(match[1])
				end = start
			}
			if match[2] != "" {
				end, _ = strconv.Atoi(match[2])
			}
			step := 1
			if match[3] != "" {
				step, _ = strconv.Atoi(match[3])
			}
			if start < bounds[i][0] || end > bounds[i][1] || end < start || step <= 0 {
				return false
			}
		}
	}
	return true
}
