package redact

import (
	"strings"
	"testing"
)

// Each sample: what must go, and the words routing needs that must stay.
func TestTextRedactsSecretsAndConnectionDetails(t *testing.T) {
	cases := []struct {
		name  string
		input string
		gone  []string
		kept  []string
	}{
		{"server ip and login user (zh)",
			"配一下这个机器到本地 ~/.ssh/config，准备用来跑 rapidmaker IP：5.60.131.62 user：ec2-user",
			[]string{"5.60.131.62", "ec2-user"}, []string{"配一下这个机器到本地", "ssh/config", "rapidmaker", "IP：‹ip›", "user：‹user›"}},
		{"ssh command (en)", "ssh -i ~/.ssh/prod.pem ec2-user@5.60.131.62 and restart the rapidmaker worker",
			[]string{"5.60.131.62", "ec2-user"}, []string{"ssh -i", "‹host›", "restart the rapidmaker worker"}},
		{"ssh to a host name", "ssh -p 2222 build-01.corp.example.net 然后看下 nginx 日志",
			[]string{"build-01.corp.example.net"}, []string{"ssh -p 2222 ‹host›", "nginx 日志"}},
		{"ssh in prose and to an alias stays", "配一下 ssh config 的 ProxyJump，再 ssh sats-tokyo-7 排查延迟", nil, []string{"配一下 ssh config 的 ProxyJump，再 ssh sats-tokyo-7 排查延迟"}},
		{"scp target", "scp dist.tar.gz deploy@10.0.3.17:/srv/app/ 再 rsync -av ./site/ web1:/var/www/",
			[]string{"10.0.3.17", "deploy@", "web1:"}, []string{"scp dist.tar.gz", "/srv/app/", "rsync -av ./site/", "/var/www/"}},
		{"ssh config block", "Host gpu\n  HostName 203.0.113.9\n  User ubuntu\n  IdentityFile ~/.ssh/id_ed25519",
			[]string{"203.0.113.9", "ubuntu"}, []string{"Host gpu", "IdentityFile ~/.ssh/id_ed25519"}},
		{"login user in prose", "Added Host gpu with HostName 203.0.113.9 and User ec2-user to ~/.ssh/config",
			[]string{"203.0.113.9", "ec2-user"}, []string{"Added Host gpu", "User ‹user›", "~/.ssh/config"}},
		{"ipv6", "服务器 IPv6 是 2001:db8:85a3::8a2e:370:7334，端口 22，[fe80::1ff:fe23:4567:890a]:8080 也行",
			[]string{"2001:db8:85a3::8a2e:370:7334", "fe80::1ff:fe23:4567:890a"}, []string{"服务器 IPv6 是 ‹ip›", "端口 22"}},
		{"openai key (en)", "use this key sk-proj-AbCdEf1234567890GhIjKlMnOp to call the summarizer",
			[]string{"sk-proj-AbCdEf1234567890GhIjKlMnOp"}, []string{"use this key ‹secret› to call the summarizer"}},
		{"github token (zh)", "用 ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5 推一下 foundry 仓库",
			[]string{"ghp_aB3d"}, []string{"推一下 foundry 仓库"}},
		{"slack and aws", "slack bot xoxb-1234567890-0987654321-AbCdEfGhIjKl, aws AKIAIOSFODNN7EXAMPLE",
			[]string{"xoxb-1234567890", "AKIAIOSFODNN7EXAMPLE"}, []string{"slack bot", "aws"}},
		{"jwt", "调接口返回 401，token 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			[]string{"eyJhbGci", "dozjgNry"}, []string{"调接口返回 401"}},
		{"bearer header", "curl -H 'Authorization: Bearer 9f8a7b6c5d4e3f2a1b0c' https://api.example.com/v1/items",
			[]string{"9f8a7b6c5d4e3f2a1b0c"}, []string{"curl -H", "Bearer ‹secret›"}},
		{"basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", []string{"dXNlcjpwYXNzd29yZA=="}, []string{"Authorization: Basic ‹secret›"}},
		{"password (zh)", "数据库密码：Pa55w0rd!，账号：admin，帮我迁移 postgres 表结构",
			[]string{"Pa55w0rd!", "admin"}, []string{"数据库密码：‹secret›", "帮我迁移 postgres 表结构"}},
		{"password (en)", `the staging password is hunter2 and "password": "s3cr3t" in config.json`,
			[]string{"hunter2", "s3cr3t"}, []string{"the staging password is ‹secret›", "config.json"}},
		{"env style keys", "OPENAI_API_KEY=abcd1234efgh5678 FEISHU_APP_SECRET=Zx9Yw8Vu7Ts6 max_tokens=4096",
			[]string{"abcd1234efgh5678", "Zx9Yw8Vu7Ts6"}, []string{"OPENAI_API_KEY=‹secret›", "max_tokens=4096"}},
		{"private key", "部署用这个 key\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n然后 ssh 上去",
			[]string{"b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "BEGIN OPENSSH"}, []string{"部署用这个 key", "‹private key›", "然后 ssh 上去"}},
		{"url with credentials", "clone https://bd777:glpat-xyz123@gitlab.example.com/team/repo.git and postgres://app:hunter2@db.internal:5432/main",
			[]string{"glpat-xyz123", "hunter2", "bd777:"}, []string{"https://‹secret›@gitlab.example.com/team/repo.git", "postgres://‹secret›@db.internal:5432/main"}},
		{"url token query", "打开 https://open.feishu.cn/app?app_id=cli_1&access_token=u-abc123def456&tab=perm 看权限",
			[]string{"u-abc123def456"}, []string{"app_id=cli_1", "access_token=‹secret›", "tab=perm", "看权限"}},
		{"cookie", "Cookie: session=7d8f9a0b1c2d; csrftoken=Zq81Kx\nthen open the dashboard",
			[]string{"7d8f9a0b1c2d", "Zq81Kx"}, []string{"Cookie: ‹secret›", "then open the dashboard"}},
		{"email", "把周报发给 alice.wang@example.com 和 bob@corp.io，抄送团队", []string{"alice.wang@", "bob@corp.io"}, []string{"把周报发给 ‹email› 和 ‹email›，抄送团队"}},
		{"git ssh remote", "remote 改成 git@github.com:BD777/foundry.git，内网的 git@10.0.3.17:infra/deploy.git 也加上",
			[]string{"git@", "10.0.3.17"}, []string{"remote 改成 github.com:BD777/foundry.git", "‹ip›:infra/deploy.git"}},
		{"phone (zh)", "联系人电话 13812345678 或 +86 139-1234-5678，座机 010-62345678",
			[]string{"13812345678", "139-1234-5678", "62345678"}, []string{"联系人电话 ‹phone›", "座机 ‹phone›"}},
		{"phone (en)", "call me at (415) 555-2671 or +44 20 7946 0958 about the resume",
			[]string{"555-2671", "7946 0958"}, []string{"call me at ‹phone›", "about the resume"}},
		{"long secrets", "webhook secret 4f9c2e7a1b3d5f6e8a0c9b2d4e6f8a1c3e5d7b9a and key Qm9vdHN0cmFwVG9rZW4xMjM0NTY3ODkwQUJDREVG",
			[]string{"4f9c2e7a1b3d5f6e8a0c9b2d4e6f8a1c3e5d7b9a", "Qm9vdHN0cmFw"}, []string{"webhook secret", "and key"}},
	}
	for _, c := range cases {
		got := Text(c.input)
		for _, gone := range c.gone {
			if strings.Contains(got, gone) {
				t.Errorf("%s: %q survived in %q", c.name, gone, got)
			}
		}
		for _, kept := range c.kept {
			if !strings.Contains(got, kept) {
				t.Errorf("%s: %q missing from %q", c.name, kept, got)
			}
		}
		if again := Text(got); again != got {
			t.Errorf("%s: not idempotent: %q -> %q", c.name, got, again)
		}
	}
}

// Routing words, versions, paths, dates and ids are not secrets.
func TestTextKeepsOrdinaryRequests(t *testing.T) {
	for _, text := range []string{
		"帮我改一下简历，投字节的后端岗位，猎头说下周三面试",
		"升级 react@18.2.0 和 pnpm@9，修 apps/web/src/features/personal-agent/index.ts 的类型错误",
		"Fix the flaky TestWorkspaceDigestSummaryLoop test in sqlitestore",
		"2026-10-15 的周报：token 用量涨了 30%，context window 200k",
		"merge PR #132 into main, tag v0.12.3, then deploy to sg-chaos",
		"user experience of the Workspaces page on narrow layouts",
		"User settings page: add a dark-mode toggle",
		"把 std::vector 换成 slice，时间 12:30:45 之后再跑",
		"go get golang.org/x/tools@v0.24.0",
	} {
		if got := Text(text); got != text {
			t.Errorf("Text(%q) = %q", text, got)
		}
	}
}
