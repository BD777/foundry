// Package redact takes secrets and connection details out of what people
// wrote, before it is kept, shown, ranked on or handed to a model as data
// (the Personal Agent's workspace digests). What is left keeps its meaning:
// "配一下这个机器到本地 ssh config，IP：5.60.131.62" becomes
// "配一下这个机器到本地 ssh config，IP：‹ip›".
//
// Text is idempotent: its placeholders match none of its patterns.
package redact

import (
	"net"
	"regexp"
	"strings"
	"unicode"
)

// Placeholders, one per kind of thing removed.
const (
	Secret     = "‹secret›"
	PrivateKey = "‹private key›"
	IP         = "‹ip›"
	Host       = "‹host›"
	User       = "‹user›"
	Email      = "‹email›"
	Phone      = "‹phone›"
)

// A value after a marker: printable ASCII but quotes and commas, so it
// ends where Chinese prose or a JSON string does.
const markedValue = `[\x21\x23-\x26\x28-\x2B\x2D-\x7E]+`

var (
	privateKeyPattern = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)`)
	// scheme://user:password@ — the credentials, not the URL.
	urlCredentialsPattern = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@`)
	// ?token=… &sig=… — the value, not the URL.
	urlQuerySecretPattern = regexp.MustCompile(`(?i)([?&#][\w.-]*(?:token|key|secret|sig|signature|password|passwd|pwd|auth|credential|session|code)[\w.-]*=)[^&\s#"']+`)
	tokenPatterns         = []*regexp.Regexp{
		regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`),
		regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
		regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{20,}`),
		regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`),
		regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
		regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}`),
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	}
	bearerPattern    = regexp.MustCompile(`(?i)\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})`)
	basicAuthPattern = regexp.MustCompile(`(?i)\b(authorization\s*[:=：]\s*basic\s+)[A-Za-z0-9+/=]{8,}`)
	// Cookie: name=value; …
	cookiePattern = regexp.MustCompile(`(?i)\b((?:set-)?cookie\s*:\s*)[^\s=;]+=[^\n]*`)
	// password: x, 密码是 x, "password": "x" — any value.
	passwordMarkerPattern = regexp.MustCompile(`(?i)((?:[\w-]*(?:password|passwd|passphrase)[\w-]*|\bpwd|密码|口令)["']?\s*(?:[:=：]|是|为|\bis\b)\s*["']?)` + markedValue)
	// OPENAI_API_KEY=x, token: x, 密钥：x — a value long enough to be a
	// secret ("max_tokens=4096" is not).
	secretMarkerPattern = regexp.MustCompile(`(?i)((?:[\w-]*(?:secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id|cookie)[\w-]*|密钥|秘钥|令牌)["']?\s*(?:[:=：]|是|为)\s*["']?)(` + markedValue + `)`)
	userMarkerPattern   = regexp.MustCompile(`(?i)(\buser(?:name)?["']?\s*[:=：]\s*["']?|(?:用户名|登录名|账号|帐号)\s*(?:[:=：]|是|为)\s*)[A-Za-z0-9._-]+`)
	// ssh_config's HostName x and User x: a User line, or "User x" in
	// prose when x looks like a login (ec2-user, root), not a word.
	sshHostNamePattern = regexp.MustCompile(`(?m)^(\s*HostName\s+)\S+`)
	sshUserLinePattern = regexp.MustCompile(`(?m)^(\s*User\s+)[A-Za-z0-9._-]+(\s*)$`)
	sshUserPattern     = regexp.MustCompile(`\b(User\s+)(root|ubuntu|admin|centos|debian|azureuser|[A-Za-z][A-Za-z0-9._]*[0-9_-][A-Za-z0-9._-]*[A-Za-z0-9])\b`)
	// someone@somewhere, with an scp/git :path after it or not.
	atPattern = regexp.MustCompile(`[A-Za-z0-9._%+-]+@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(:\S*)?`)
	// The target of ssh/sftp/mosh after its options.
	sshTargetPattern = regexp.MustCompile(`(?i)\b((?:ssh|sftp|mosh)(?:\s+-[A-Za-z]+(?:\s+[^\s-]\S*)?)*\s+)([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])\b`)
	// host:path in an scp or rsync command.
	remoteCopyPattern = regexp.MustCompile(`(?i)\b(?:scp|rsync)\b[^\n]*`)
	remotePathPattern = regexp.MustCompile(`(^|\s)[A-Za-z0-9][A-Za-z0-9.-]*:([~/]\S*)`)
	ipv6Pattern       = regexp.MustCompile(`(?i)\[?\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\]?`)
	ipv4Pattern       = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`)
	phonePatterns     = []*regexp.Regexp{
		// +86 138 1234 5678, 13812345678
		regexp.MustCompile(`(?:\+?86[\s-]?)?\b1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}\b`),
		// 010-12345678
		regexp.MustCompile(`\b0\d{2,3}-\d{7,8}\b`),
		// +1 (415) 555-2671, +44 20 7946 0958
		regexp.MustCompile(`\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b`),
		// (415) 555-2671, 415-555-2671
		regexp.MustCompile(`(?:\(\d{3}\)\s?|\b\d{3}[.-])\d{3}[.-]\d{4}\b`),
	}
	longHexPattern    = regexp.MustCompile(`\b[0-9a-fA-F]{32,}\b`)
	longSecretPattern = regexp.MustCompile(`[A-Za-z0-9+/_=-]{32,}`)
)

// Text is text without secrets and connection details: API keys and
// tokens, passwords after a marker, private keys, credentials and tokens
// in URLs, cookies, IP addresses, user@host and ssh/scp targets, login
// users, email addresses and phone numbers, each replaced by a
// placeholder.
func Text(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	text = privateKeyPattern.ReplaceAllString(text, PrivateKey)
	text = urlCredentialsPattern.ReplaceAllString(text, "${1}"+Secret+"@")
	text = urlQuerySecretPattern.ReplaceAllString(text, "${1}"+Secret)
	for _, pattern := range tokenPatterns {
		text = pattern.ReplaceAllString(text, Secret)
	}
	text = cookiePattern.ReplaceAllString(text, "${1}"+Secret)
	text = basicAuthPattern.ReplaceAllString(text, "${1}"+Secret)
	text = bearerPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := bearerPattern.FindStringSubmatch(match)
		if !strings.ContainsAny(parts[2], "0123456789._~+/=-") {
			return match
		}
		return parts[1] + Secret
	})
	text = passwordMarkerPattern.ReplaceAllString(text, "${1}"+Secret)
	text = secretMarkerPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := secretMarkerPattern.FindStringSubmatch(match)
		if len(parts[2]) < 8 || strings.Trim(parts[2], "0123456789") == "" {
			return match
		}
		return parts[1] + Secret
	})
	text = userMarkerPattern.ReplaceAllString(text, "${1}"+User)
	text = sshHostNamePattern.ReplaceAllString(text, "${1}"+Host)
	text = sshUserLinePattern.ReplaceAllString(text, "${1}"+User+"${2}")
	text = sshUserPattern.ReplaceAllString(text, "${1}"+User)
	text = atPattern.ReplaceAllStringFunc(text, redactAt)
	text = remoteCopyPattern.ReplaceAllStringFunc(text, func(command string) string {
		return remotePathPattern.ReplaceAllStringFunc(command, func(target string) string {
			parts := remotePathPattern.FindStringSubmatch(target)
			if strings.HasPrefix(parts[2], "//") {
				return target
			}
			return parts[1] + Host + ":" + parts[2]
		})
	})
	text = ipv6Pattern.ReplaceAllStringFunc(text, func(candidate string) string {
		if isIPv6(strings.Trim(candidate, "[]")) {
			return IP
		}
		return candidate
	})
	text = ipv4Pattern.ReplaceAllString(text, IP)
	text = sshTargetPattern.ReplaceAllStringFunc(text, redactSSHTarget)
	for _, pattern := range phonePatterns {
		text = pattern.ReplaceAllString(text, Phone)
	}
	text = longHexPattern.ReplaceAllString(text, Secret)
	return longSecretPattern.ReplaceAllStringFunc(text, func(candidate string) string {
		if looksRandom(candidate) {
			return Secret
		}
		return candidate
	})
}

// redactAt tells an email address from an ssh/scp/git target: one with a
// :path, an IP or a bare host name is a target. A package version
// (react@18.2.0, pnpm@9) is neither. A git remote's "git@" names no one:
// git@github.com:org/repo.git keeps github.com:org/repo.git (an IP there
// goes with the IPs).
func redactAt(match string) string {
	at := strings.LastIndexByte(match, '@')
	host, path := match[at+1:], ""
	if colon := strings.IndexByte(host, ':'); colon >= 0 && !strings.HasPrefix(host, "[") {
		host, path = host[:colon], host[colon:]
	} else if strings.HasPrefix(host, "[") {
		if end := strings.IndexByte(host, ']'); end >= 0 {
			host, path = host[:end+1], host[end+1:]
		}
	}
	if match[:at] == "git" && path != "" {
		return host + path
	}
	ip := net.ParseIP(strings.Trim(host, "[]")) != nil
	labels := strings.Split(host, ".")
	alphaTLD := len(labels) > 1 && isLetters(labels[len(labels)-1])
	switch {
	case ip:
		return Host + path
	case alphaTLD && path == "":
		return Email
	case alphaTLD || (path != "" && len(labels) == 1 && host != ""):
		return Host + path
	}
	return match
}

func redactSSHTarget(match string) string {
	submatch := sshTargetPattern.FindStringSubmatch(match)
	target := submatch[2]
	// Only a host's address: a dotted name. An alias from ~/.ssh/config
	// ("ssh sats-tokyo-7") holds no address and says which machine a
	// request is about; a word after "ssh" in prose ("ssh config") is none.
	if !strings.Contains(target, ".") || !strings.ContainsFunc(target, unicode.IsLetter) {
		return match
	}
	return submatch[1] + Host
}

func isIPv6(candidate string) bool {
	ip := net.ParseIP(candidate)
	return ip != nil && ip.To4() == nil && strings.ContainsAny(candidate, "0123456789") && strings.Count(candidate, ":") >= 2
}

func isLetters(text string) bool {
	if len(text) < 2 {
		return false
	}
	for _, r := range text {
		if !unicode.IsLetter(r) {
			return false
		}
	}
	return true
}

// looksRandom: a long run with upper and lower case letters and digits,
// and not a path.
func looksRandom(text string) bool {
	if strings.Count(text, "/") > 3 {
		return false
	}
	var upper, lower, digit bool
	for _, r := range text {
		switch {
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	return upper && lower && digit
}
