package feishu

import (
	"testing"
)

func TestExtractMessageTextExtended(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain text message with mention",
			input:    `{"text":"@_user_1 /pair FND-CFTY"}`,
			expected: "/pair FND-CFTY",
		},
		{
			name:     "plain text message with multiple mentions",
			input:    `{"text":"@_user_1 @_user_2 hello world"}`,
			expected: "hello world",
		},
		{
			name:     "plain text message without mention",
			input:    `{"text":"/pair FND-CFTY"}`,
			expected: "/pair FND-CFTY",
		},
		{
			name: "post message with at and text elements",
			input: `{
				"title": "",
				"content": [
					[
						{"tag": "at", "user_id": "ou_12345", "user_name": "机智的打工人"},
						{"tag": "text", "text": " /pair FND-CFTY", "un_escape": true}
					]
				]
			}`,
			expected: "/pair FND-CFTY",
		},
		{
			name: "post message localized zh_cn",
			input: `{
				"zh_cn": {
					"title": "任务标题",
					"content": [
						[
							{"tag": "at", "user_id": "ou_12345", "user_name": "机智的打工人"},
							{"tag": "text", "text": " 请帮我审查代码"}
						],
						[
							{"tag": "text", "text": "第二行详细内容"}
						]
					]
				}
			}`,
			expected: "任务标题\n请帮我审查代码\n第二行详细内容",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractMessageText(tc.input)
			got = cleanLeadingMentions(got)
			if got != tc.expected {
				t.Errorf("extractMessageText(%s) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestCleanLeadingMentions(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"@机智的打工人 /pair FND-CFTY", "/pair FND-CFTY"},
		{"@bot1 @bot2 /pair FND-CFTY", "/pair FND-CFTY"},
		{"/pair FND-CFTY", "/pair FND-CFTY"},
		{"@bot", ""},
		{"hello world", "hello world"},
	}

	for _, tc := range tests {
		got := cleanLeadingMentions(tc.input)
		if got != tc.expected {
			t.Errorf("cleanLeadingMentions(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}
