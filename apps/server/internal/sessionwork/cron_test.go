package sessionwork

import "testing"

func TestValidCron(t *testing.T) {
	for _, value := range []string{"*/30 * * * *", "28,58 * * * *", "0 9 * * 0-7"} {
		if !ValidCron(value) {
			t.Error(value)
		}
	}
	for _, value := range []string{"61 * * * *", "*/0 * * * *", "@reboot", "0 9 foo * *"} {
		if ValidCron(value) {
			t.Error(value)
		}
	}
}
