package feishu

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCardBuilders(t *testing.T) {
	t.Run("running card", func(t *testing.T) {
		raw := BuildRunningCard("测试任务", "正在读取文件", "执行中")
		var card FeishuCard
		if err := json.Unmarshal([]byte(raw), &card); err != nil {
			t.Fatalf("unmarshal running card: %v", err)
		}
		if card.Schema != "2.0" {
			t.Errorf("expected schema 2.0, got %s", card.Schema)
		}
		if card.Header.Template != "blue" {
			t.Errorf("expected blue template, got %s", card.Header.Template)
		}
		if !strings.Contains(card.Header.Title.Content, "测试任务") {
			t.Errorf("expected title to contain 测试任务, got %s", card.Header.Title.Content)
		}
		if len(card.Body.Elements) == 0 {
			t.Errorf("expected non-empty body elements")
		}
	})

	t.Run("completed card", func(t *testing.T) {
		raw := BuildCompletedCard("测试任务", "这是结果", 2*time.Second)
		var card FeishuCard
		if err := json.Unmarshal([]byte(raw), &card); err != nil {
			t.Fatalf("unmarshal completed card: %v", err)
		}
		if card.Schema != "2.0" {
			t.Errorf("expected schema 2.0, got %s", card.Schema)
		}
		if card.Header.Template != "turquoise" {
			t.Errorf("expected turquoise template, got %s", card.Header.Template)
		}
	})

	t.Run("failed card", func(t *testing.T) {
		raw := BuildFailedCard("测试任务", "已部分输出", "超时错误")
		var card FeishuCard
		if err := json.Unmarshal([]byte(raw), &card); err != nil {
			t.Fatalf("unmarshal failed card: %v", err)
		}
		if card.Schema != "2.0" {
			t.Errorf("expected schema 2.0, got %s", card.Schema)
		}
		if card.Header.Template != "red" {
			t.Errorf("expected red template, got %s", card.Header.Template)
		}
	})

	t.Run("pairing success card", func(t *testing.T) {
		raw := BuildPairingSuccessCard("Foundry-Main")
		var card FeishuCard
		if err := json.Unmarshal([]byte(raw), &card); err != nil {
			t.Fatalf("unmarshal pairing card: %v", err)
		}
		if card.Schema != "2.0" {
			t.Errorf("expected schema 2.0, got %s", card.Schema)
		}
		if card.Header.Template != "green" {
			t.Errorf("expected green template, got %s", card.Header.Template)
		}
	})
}

func TestNormalizeFeishuMarkdown(t *testing.T) {
	input := "- item:\n| a | b |\n|---|---|\n| 1 | 2 |\n#title\ntext"
	got := NormalizeFeishuMarkdown(input)
	if !strings.Contains(got, "\n\n| a | b |") {
		t.Errorf("expected empty line before table header, got:\n%s", got)
	}
	if !strings.Contains(got, "\n\n# title") {
		t.Errorf("expected empty line and space for heading, got:\n%s", got)
	}
}

// Each pairing card says what its chat is linked to: a group's copy names the
// group and its @ mention, a direct chat's copy says where its messages go.
func TestPairingSuccessCardCopyMatchesTheChat(t *testing.T) {
	group := BuildPairingSuccessCard("Foundry-Main")
	if !strings.Contains(group, "本飞书群已成功绑定至工作区") || !strings.Contains(group, "@机器人") {
		t.Errorf("group card = %s, want the group copy", group)
	}
	toAssistant := BuildDirectPairingSuccessCard("Foundry-Main", true)
	if !strings.Contains(toAssistant, "本单聊已关联至你的助理") || !strings.Contains(toAssistant, "助理会直接在这里回答") || strings.Contains(toAssistant, "群") {
		t.Errorf("direct card to the assistant = %s, want the assistant copy without group wording", toAssistant)
	}
	toWorkspace := BuildDirectPairingSuccessCard("Foundry-Main", false)
	if !strings.Contains(toWorkspace, "本单聊已关联至工作区**：`Foundry-Main`") || strings.Contains(toWorkspace, "群") {
		t.Errorf("direct card to a workspace = %s, want the workspace copy without group wording", toWorkspace)
	}
}
