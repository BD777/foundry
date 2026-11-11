package connectors

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Limits on what a descriptor may say: the Web renders every word of it,
// and an extension's descriptor comes from a device.
const (
	maxLabel            = 80
	maxDescription      = 300
	maxMethods          = 6
	maxFields           = 10
	maxOptions          = 40
	maxCommands         = 5
	maxCommand          = 300
	maxSetupLine        = 2000
	maxLocales          = 8
	maxScopes           = 500
	maxServerHeldProbes = 8
	maxServerHeldSteps  = 8
	maxRouteAllow       = 8
	maxTemplate         = 1000
)

var (
	signInIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	fieldIDPattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
	localePattern   = regexp.MustCompile(`^[a-z]{2}(-[A-Za-z]{2,4})?$`)
	// A git remote git fetches without asking: https (no user in it), ssh,
	// or scp-style host:path.
	gitRemotePattern  = regexp.MustCompile(`^(https://[^\s@/]+/\S+|ssh://\S+|([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*)$`)
	gitRefPattern     = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
	commitPattern     = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	githubRepoPattern = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})/[A-Za-z0-9_.-]{1,100}$`)
	// A scope as vendors spell them: repo, read:org, zone.read, im:message.p2p_msg:readonly.
	scopeIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	templateRefPattern = regexp.MustCompile(`\{([^{}]+)\}`)
)

func checkText(what, value string, limit int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", what)
	}
	if utf8.RuneCountInString(value) > limit || strings.ContainsAny(value, "\x00\r") {
		return fmt.Errorf("%s is longer than %d characters or not plain text", what, limit)
	}
	return nil
}

func checkLocalized(what string, values map[string]string, limit int) error {
	if len(values) > maxLocales {
		return fmt.Errorf("%s has too many languages", what)
	}
	for locale, value := range values {
		if !localePattern.MatchString(locale) {
			return fmt.Errorf("%s names an unknown language %q", what, locale)
		}
		if err := checkText(what, value, limit, true); err != nil {
			return err
		}
	}
	return nil
}

// checkPresentation bounds the names and sentences a descriptor shows.
func checkPresentation(descriptor store.ConnectorDescriptor) error {
	if err := checkText("label", descriptor.Label, maxLabel, true); err != nil {
		return err
	}
	if err := checkLocalized("labels", descriptor.Labels, maxLabel); err != nil {
		return err
	}
	if err := checkText("description", descriptor.Description, maxDescription, false); err != nil {
		return err
	}
	return checkLocalized("descriptions", descriptor.Descriptions, maxDescription)
}

// checkSignIn checks the sign-in methods and their fields: ids unique and
// plain, kinds the Web knows, fields of known types, a terminal method's
// commands one line each.
func checkSignIn(signIn store.ConnectorSignIn) error {
	if len(signIn.Methods) == 0 || len(signIn.Methods) > maxMethods {
		return fmt.Errorf("sign-in lists 1 to %d methods", maxMethods)
	}
	if signIn.Repeat != nil {
		if err := checkText("sign-in repeat label", signIn.Repeat.Label, maxLabel, true); err != nil {
			return err
		}
		if err := checkLocalized("sign-in repeat labels", signIn.Repeat.Labels, maxLabel); err != nil {
			return err
		}
	}
	ids := map[string]bool{}
	for _, method := range signIn.Methods {
		if !signInIDPattern.MatchString(method.ID) || ids[method.ID] {
			return fmt.Errorf("sign-in method id %q is not a unique plain name", method.ID)
		}
		ids[method.ID] = true
		if err := checkText("sign-in method label", method.Label, maxLabel, true); err != nil {
			return err
		}
		if err := checkLocalized("sign-in method labels", method.Labels, maxLabel); err != nil {
			return err
		}
		if err := checkText("sign-in method description", method.Description, maxDescription, false); err != nil {
			return err
		}
		if err := checkLocalized("sign-in method descriptions", method.Descriptions, maxDescription); err != nil {
			return err
		}
		switch method.Kind {
		case "guided":
			if len(method.Commands) > 0 {
				return fmt.Errorf("a guided sign-in runs no terminal commands")
			}
		case "terminal":
			if len(method.Commands) == 0 || len(method.Commands) > maxCommands || len(method.Fields) > 0 {
				return fmt.Errorf("a terminal sign-in names 1 to %d commands and no fields", maxCommands)
			}
			for _, command := range method.Commands {
				if err := checkText("terminal command", command, maxCommand, true); err != nil || strings.Contains(command, "\n") {
					return fmt.Errorf("a terminal command is one line of at most %d characters", maxCommand)
				}
			}
		default:
			return fmt.Errorf("sign-in method kind must be guided or terminal")
		}
		if err := checkFields(method.Fields); err != nil {
			return fmt.Errorf("sign-in method %s: %w", method.ID, err)
		}
	}
	return nil
}

func checkFields(fields []store.ConnectorField) error {
	if len(fields) > maxFields {
		return fmt.Errorf("at most %d fields", maxFields)
	}
	ids := map[string]bool{"method": true}
	for _, field := range fields {
		if !fieldIDPattern.MatchString(field.ID) || ids[field.ID] {
			return fmt.Errorf("field id %q is not a unique plain name (and not \"method\")", field.ID)
		}
		ids[field.ID] = true
		for what, text := range map[string]string{"label": field.Label, "help": field.Help, "placeholder": field.Placeholder, "default": field.Default, "pattern": field.Pattern} {
			if err := checkText("field "+what, text, maxDescription, what == "label"); err != nil {
				return err
			}
		}
		if err := checkLocalized("field labels", field.Labels, maxLabel); err != nil {
			return err
		}
		if err := checkLocalized("field helps", field.Helps, maxDescription); err != nil {
			return err
		}
		if field.OptionsFrom != "" {
			if field.Type != "select" || !strings.HasPrefix(field.OptionsFrom, "probe:") || !signInIDPattern.MatchString(strings.TrimPrefix(field.OptionsFrom, "probe:")) {
				return fmt.Errorf("field %s: optionsFrom names a probe for a select field", field.ID)
			}
		}
		switch field.Type {
		case "text", "secret", "url":
			if len(field.Options) > 0 {
				return fmt.Errorf("field %s: only a select field lists options", field.ID)
			}
		case "select":
			if (len(field.Options) == 0) == (field.OptionsFrom == "") || len(field.Options) > maxOptions {
				return fmt.Errorf("field %s: a select field lists options or names a probe, but not both", field.ID)
			}
			for _, option := range field.Options {
				if err := checkText("option value", option.Value, maxLabel, true); err != nil {
					return err
				}
				if err := checkText("option label", option.Label, maxLabel, true); err != nil {
					return err
				}
				if err := checkLocalized("option labels", option.Labels, maxLabel); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("field %s: type must be text, secret, url or select", field.ID)
		}
		if field.Type == "secret" && field.Default != "" {
			return fmt.Errorf("field %s: a secret has no default", field.ID)
		}
	}
	for _, field := range fields {
		if field.ShowWhen != nil && (!ids[field.ShowWhen.Field] || field.ShowWhen.Field == field.ID || field.ShowWhen.Field == "method" || len(field.ShowWhen.Equals) == 0) {
			return fmt.Errorf("field %s: showWhen names another field of the method and its values", field.ID)
		}
	}
	return nil
}

func checkServerHeld(descriptor store.ConnectorDescriptor) error {
	serverHeld := descriptor.ServerHeld
	if descriptor.Extension == nil || descriptor.Holding != store.ConnectorServerHeld || descriptor.Adapter != "extension:"+descriptor.Extension.ID {
		return fmt.Errorf("serverHeld belongs to a server-held extension connector")
	}
	if descriptor.SignIn != nil {
		return fmt.Errorf("a server-held extension declares fields, not device sign-in methods")
	}
	if serverHeld.Instances != "one" && serverHeld.Instances != "many" {
		return fmt.Errorf("serverHeld.instances is one or many")
	}
	if len(serverHeld.Fields) == 0 || len(serverHeld.Fields) > maxFields {
		return fmt.Errorf("serverHeld.fields lists 1 to %d fields", maxFields)
	}
	if err := checkFields(serverHeld.Fields); err != nil {
		return fmt.Errorf("serverHeld.fields: %w", err)
	}
	fields := map[string]store.ConnectorField{}
	for _, field := range serverHeld.Fields {
		fields[field.ID] = field
	}
	if len(serverHeld.Steps) == 0 || len(serverHeld.Steps) > maxServerHeldSteps {
		return fmt.Errorf("serverHeld.steps lists 1 to %d steps", maxServerHeldSteps)
	}
	stepped := map[string]bool{}
	for _, step := range serverHeld.Steps {
		if len(step) == 0 || len(step) > maxFields {
			return fmt.Errorf("a serverHeld step names 1 to %d fields", maxFields)
		}
		for _, id := range step {
			if _, ok := fields[id]; !ok || stepped[id] {
				return fmt.Errorf("serverHeld step field %q is unknown or appears twice", id)
			}
			stepped[id] = true
		}
	}
	if len(serverHeld.Probe) == 0 || len(serverHeld.Probe) > maxServerHeldProbes {
		return fmt.Errorf("serverHeld.probe lists 1 to %d probes", maxServerHeldProbes)
	}
	probes := map[string]store.ConnectorServerHeldProbe{}
	for _, probe := range serverHeld.Probe {
		if !signInIDPattern.MatchString(probe.ID) || probes[probe.ID].ID != "" {
			return fmt.Errorf("serverHeld probe id %q is not unique", probe.ID)
		}
		probes[probe.ID] = probe
		if strings.ToUpper(probe.Method) != "GET" {
			return fmt.Errorf("serverHeld probe %s uses GET", probe.ID)
		}
		if err := checkExtensionPath("serverHeld probe", probe.Path); err != nil {
			return fmt.Errorf("serverHeld probe %s: %w", probe.ID, err)
		}
		for name, pointer := range probe.Extract.Values {
			if !fieldIDPattern.MatchString(name) || !jsonPointer(pointer) {
				return fmt.Errorf("serverHeld probe %s: extracted value %q is not a plain name and JSON pointer", probe.ID, name)
			}
		}
		if probe.Extract.Options.Items != "" {
			for _, pointer := range []string{probe.Extract.Options.Items, probe.Extract.Options.Value, probe.Extract.Options.Label} {
				if !jsonPointer(pointer) {
					return fmt.Errorf("serverHeld probe %s: options extraction is not a JSON pointer", probe.ID)
				}
			}
		}
		if probe.Extract.Routes.Items != "" {
			for _, pointer := range []string{probe.Extract.Routes.Items, probe.Extract.Routes.Method, probe.Extract.Routes.Path, probe.Extract.Routes.Access} {
				if !jsonPointer(pointer) {
					return fmt.Errorf("serverHeld probe %s: route extraction is not a JSON pointer", probe.ID)
				}
			}
			if probe.Extract.Routes.Domain != "" && !jsonPointer(probe.Extract.Routes.Domain) {
				return fmt.Errorf("serverHeld probe %s: route domain extraction is not a JSON pointer", probe.ID)
			}
		}
	}
	for _, field := range serverHeld.Fields {
		if field.OptionsFrom == "" {
			continue
		}
		id := strings.TrimPrefix(field.OptionsFrom, "probe:")
		if probes[id].Extract.Options.Items == "" {
			return fmt.Errorf("field %s: optionsFrom probe %s extracts no options", field.ID, id)
		}
	}
	baseField := fields[serverHeld.Upstream.BaseField]
	if !fieldIDPattern.MatchString(serverHeld.Upstream.BaseField) || baseField.Type != "url" || !baseField.Required {
		return fmt.Errorf("serverHeld.upstream.baseField names a required URL field")
	}
	if err := checkExtensionPath("serverHeld upstream prefix", serverHeld.Upstream.PathPrefix); err != nil {
		return err
	}
	if len(serverHeld.Upstream.Headers) > 40 {
		return fmt.Errorf("serverHeld.upstream.headers lists at most 40 headers")
	}
	for name, value := range serverHeld.Upstream.Headers {
		if http.CanonicalHeaderKey(name) != name || name == "" || len(name) > 128 {
			return fmt.Errorf("serverHeld upstream header %q must be written in canonical form (%q)", name, http.CanonicalHeaderKey(name))
		}
		if len(value) > maxTemplate {
			return fmt.Errorf("serverHeld upstream header %s is too long", name)
		}
		if err := checkTemplate("serverHeld upstream header "+name, value, fields, probes, true, false); err != nil {
			return err
		}
	}
	if serverHeld.Upstream.RequestBodyLimitBytes < 0 || serverHeld.Upstream.RequestBodyLimitBytes > 8<<20 ||
		serverHeld.Upstream.ResponseBodyLimitBytes < 0 || serverHeld.Upstream.ResponseBodyLimitBytes > 16<<20 ||
		serverHeld.Upstream.TimeoutSeconds < 0 || serverHeld.Upstream.TimeoutSeconds > 60 {
		return fmt.Errorf("serverHeld upstream limits are at most 8 MiB, 16 MiB and 60 seconds")
	}
	if !strings.HasPrefix(serverHeld.Access.From, "probe:") {
		return fmt.Errorf("serverHeld.access.from names a probe")
	}
	accessProbe := probes[strings.TrimPrefix(serverHeld.Access.From, "probe:")]
	if accessProbe.ID == "" || accessProbe.Extract.Routes.Items == "" {
		return fmt.Errorf("serverHeld.access.from names a probe with route extraction")
	}
	for _, probe := range serverHeld.Probe {
		if probe.Extract.Routes.Items != "" && probe.ID != accessProbe.ID {
			return fmt.Errorf("only serverHeld.access.from may declare route extraction")
		}
	}
	if serverHeld.Access.Default != "deny" {
		return fmt.Errorf("serverHeld.access.default is deny")
	}
	fixedAccess := len(serverHeld.Access.Allow) > 0
	dynamicAccess := strings.TrimSpace(serverHeld.Access.AllowBy.Value) != ""
	if fixedAccess == dynamicAccess {
		return fmt.Errorf("serverHeld.access declares exactly one of allow or allowBy")
	}
	if fixedAccess {
		if err := checkServerHeldAccessLevels(serverHeld.Access.Allow); err != nil {
			return fmt.Errorf("serverHeld.access.allow: %w", err)
		}
	} else {
		probeID, name, ok := serverHeldProbeValueReference(serverHeld.Access.AllowBy.Value)
		if !ok {
			return fmt.Errorf("serverHeld.access.allowBy.value is probe:<id>/<extracted-name>")
		}
		probe := probes[probeID]
		if probe.ID == "" {
			return fmt.Errorf("serverHeld.access.allowBy.value names a probe")
		}
		if _, ok := probe.Extract.Values[name]; !ok {
			return fmt.Errorf("serverHeld.access.allowBy.value names a value extracted by probe %s", probeID)
		}
		if len(serverHeld.Access.AllowBy.Map) == 0 || len(serverHeld.Access.AllowBy.Map) > 16 {
			return fmt.Errorf("serverHeld.access.allowBy.map lists 1 to 16 probe values")
		}
		for value, levels := range serverHeld.Access.AllowBy.Map {
			if strings.TrimSpace(value) == "" || len(value) > 80 {
				return fmt.Errorf("serverHeld.access.allowBy.map value is empty or too long")
			}
			if err := checkServerHeldAccessLevels(levels); err != nil {
				return fmt.Errorf("serverHeld.access.allowBy.map[%q]: %w", value, err)
			}
		}
		if len(serverHeld.Access.AllowBy.Otherwise) > 0 {
			if err := checkServerHeldAccessLevels(serverHeld.Access.AllowBy.Otherwise); err != nil {
				return fmt.Errorf("serverHeld.access.allowBy.otherwise: %w", err)
			}
		}
	}
	if len(serverHeld.Session.Env) == 0 || len(serverHeld.Session.Env) > 40 {
		return fmt.Errorf("serverHeld.session.env lists 1 to 40 variables")
	}
	for name, value := range serverHeld.Session.Env {
		if !envNamePattern.MatchString(name) || len(value) > maxTemplate {
			return fmt.Errorf("serverHeld session variable %s is not a plain name with a bounded value", name)
		}
		if err := checkTemplate("serverHeld session variable "+name, value, fields, probes, false, true); err != nil {
			return err
		}
	}
	if len(serverHeld.Network.Holdings) == 0 || len(serverHeld.Network.Holdings) > 2 {
		return fmt.Errorf("serverHeld.network.holdings lists server, device or both")
	}
	holdings := map[string]bool{}
	for _, holding := range serverHeld.Network.Holdings {
		if holding != "server" && holding != "device" || holdings[holding] {
			return fmt.Errorf("serverHeld.network.holdings lists server, device or both once")
		}
		holdings[holding] = true
	}
	if holdings["server"] && !serverHeld.Network.PublicOnly {
		return fmt.Errorf("serverHeld.network.publicOnly must be true when instances may use the server path")
	}
	return nil
}

func checkExtensionPath(what, path string) error {
	if path == "" || !strings.HasPrefix(path, "/") || len(path) > 1000 || strings.ContainsAny(path, "\\\x00\r\n?#") || strings.Contains(path, "..") {
		return fmt.Errorf("%s is a path beginning with / and without query, fragment or traversal", what)
	}
	return nil
}

func jsonPointer(pointer string) bool {
	if pointer == "" {
		return true
	}
	if !strings.HasPrefix(pointer, "/") || len(pointer) > 500 {
		return false
	}
	for _, part := range strings.Split(pointer[1:], "/") {
		for index := 0; index < len(part); index++ {
			if part[index] == '~' && (index+1 >= len(part) || (part[index+1] != '0' && part[index+1] != '1')) {
				return false
			}
		}
	}
	return true
}

func checkServerHeldAccessLevels(levels []store.ConnectorServerHeldAccessLevel) error {
	if len(levels) == 0 || len(levels) > maxRouteAllow {
		return fmt.Errorf("lists 1 to %d access levels", maxRouteAllow)
	}
	seen := map[string]bool{}
	for _, raw := range levels {
		level := strings.ToLower(strings.TrimSpace(string(raw)))
		if level != "read" && level != "write" {
			return fmt.Errorf("access level %q is read or write", raw)
		}
		if seen[level] {
			return fmt.Errorf("access level %q is repeated", level)
		}
		seen[level] = true
	}
	return nil
}

func serverHeldProbeValueReference(reference string) (string, string, bool) {
	reference = strings.TrimPrefix(strings.TrimSpace(reference), "probe:")
	parts := strings.SplitN(reference, "/", 2)
	if len(parts) != 2 || !signInIDPattern.MatchString(parts[0]) || !fieldIDPattern.MatchString(parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func validServerHeldProbeMap(expression string, probes map[string]store.ConnectorServerHeldProbe) bool {
	parts := strings.Split(strings.TrimPrefix(expression, "probeMap:"), "|")
	if len(parts) < 2 {
		return false
	}
	probeID, name, ok := serverHeldProbeValueReference("probe:" + parts[0])
	if !ok {
		return false
	}
	if _, ok := probes[probeID].Extract.Values[name]; !ok {
		return false
	}
	returnedMatch := map[string]bool{}
	for _, rule := range parts[1:] {
		match, replacement, ok := strings.Cut(rule, "=")
		if !ok || match == "" || len(match) > 80 || len(replacement) > 500 ||
			strings.ContainsAny(match+replacement, "{}\r\n\x00") || returnedMatch[match] {
			return false
		}
		returnedMatch[match] = true
	}
	return true
}

func checkTemplate(what, value string, fields map[string]store.ConnectorField, probes map[string]store.ConnectorServerHeldProbe, allowSecret, allowRuntime bool) error {
	rest := templateRefPattern.ReplaceAllStringFunc(value, func(reference string) string {
		match := templateRefPattern.FindStringSubmatch(reference)
		if len(match) != 2 {
			return reference
		}
		name := match[1]
		switch {
		case strings.HasPrefix(name, "secret:"):
			if !allowSecret || !fieldIDPattern.MatchString(strings.TrimPrefix(name, "secret:")) || fields[strings.TrimPrefix(name, "secret:")].Type != "secret" {
				return reference
			}
		case strings.HasPrefix(name, "field:"):
			if _, ok := fields[strings.TrimPrefix(name, "field:")]; !ok {
				return reference
			}
		case strings.HasPrefix(name, "probeMap:") && allowRuntime && validServerHeldProbeMap(name, probes):
		case (name == "gatewayBase" || name == "standIn") && allowRuntime:
		default:
			return reference
		}
		return ""
	})
	if rest != "" && strings.ContainsAny(rest, "{}") {
		return fmt.Errorf("%s uses an unknown template reference", what)
	}
	return nil
}

// CheckExtensionRepository: a remote git fetches without asking, a folder
// inside the repository, a branch or tag name.
func CheckExtensionRepository(repository store.ConnectorExtensionRepository) error {
	if len(repository.Git) > 512 || !gitRemotePattern.MatchString(repository.Git) {
		return fmt.Errorf("the source is an https, ssh or host:path git remote")
	}
	if len(repository.Path) > 300 || strings.HasPrefix(repository.Path, "/") {
		return fmt.Errorf("the source folder is a path inside the repository")
	}
	for _, part := range strings.Split(repository.Path, "/") {
		if part == ".." || part == "." {
			return fmt.Errorf("the source folder is a path inside the repository")
		}
	}
	if repository.Ref != "" && (!gitRefPattern.MatchString(repository.Ref) || strings.HasPrefix(repository.Ref, "-") || strings.Contains(repository.Ref, "..")) {
		return fmt.Errorf("the source ref is a branch or tag name")
	}
	return nil
}

func checkExtensionSource(extension store.ConnectorExtensionSource) error {
	if extension.State != "" && extension.State != "installed" && extension.State != "available" {
		return fmt.Errorf("an extension state is installed or available")
	}
	if extension.Bundled != nil && *extension.Bundled && extension.Source != nil {
		return fmt.Errorf("a bundled extension has no git source")
	}
	if extension.State == "available" && (extension.Bundled == nil || !*extension.Bundled) {
		return fmt.Errorf("only a bundled extension can be available without being installed")
	}
	if extension.AutoUpdate != nil && extension.Source == nil {
		return fmt.Errorf("only a git-installed extension has automatic updates")
	}
	if extension.Source != nil {
		if err := CheckExtensionRepository(*extension.Source); err != nil {
			return err
		}
	}
	for _, commit := range []string{extension.Commit, extension.LatestCommit} {
		if commit != "" && !commitPattern.MatchString(commit) {
			return fmt.Errorf("a commit is a full git object name")
		}
	}
	return nil
}

// checkSetup: a setup command is one line; a setup page is https.
func checkSetup(setup store.ConnectorSetup) error {
	if err := checkText("setup command", setup.Command, maxSetupLine, false); err != nil || strings.Contains(setup.Command, "\n") {
		return fmt.Errorf("a setup command is one line of at most %d characters", maxSetupLine)
	}
	if setup.URL != "" {
		parsed, err := url.Parse(setup.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || len(setup.URL) > 500 {
			return fmt.Errorf("a setup page is an https address")
		}
	}
	return nil
}

// checkPermissionSets: an authorization group's scopes are plain, unique
// and cite their source; a sign-in method chooses scopes only from a group
// that lists them; permissions managed elsewhere say where, over https.
func checkPermissionSets(descriptor store.ConnectorDescriptor) error {
	withScopes := map[string]bool{}
	for _, group := range descriptor.AuthorizationGroups {
		if len(group.Scopes) > maxScopes {
			return fmt.Errorf("authorization %s lists more than %d scopes", group.ID, maxScopes)
		}
		ids := map[string]bool{}
		for _, scope := range group.Scopes {
			if !scopeIDPattern.MatchString(scope.ID) || ids[scope.ID] {
				return fmt.Errorf("authorization %s: scope %q is not a unique plain name", group.ID, scope.ID)
			}
			ids[scope.ID] = true
			if err := checkText("scope label", scope.Label, maxLabel, true); err != nil {
				return err
			}
			if err := checkLocalized("scope labels", scope.Labels, maxLabel); err != nil {
				return err
			}
		}
		for _, scope := range group.Scopes {
			for _, parent := range scope.ImpliedBy {
				if !ids[parent] || parent == scope.ID {
					return fmt.Errorf("authorization %s: scope %s is implied by an unlisted scope", group.ID, scope.ID)
				}
			}
		}
		if source := group.ScopeSource; source != nil {
			if len(group.Scopes) == 0 {
				return fmt.Errorf("authorization %s cites a scope source but lists no scopes", group.ID)
			}
			if err := checkText("scope source", source.Label, maxLabel, true); err != nil {
				return err
			}
			if err := checkLocalized("scope source labels", source.Labels, maxLabel); err != nil {
				return err
			}
			if !httpsURL(source.URL) {
				return fmt.Errorf("authorization %s: a scope source is an https address", group.ID)
			}
		}
		if len(group.Scopes) > 0 {
			withScopes[group.ID] = true
		}
	}
	if descriptor.SignIn != nil {
		for _, method := range descriptor.SignIn.Methods {
			if method.ScopesGroup != "" && (method.Kind != "guided" || !withScopes[method.ScopesGroup]) {
				return fmt.Errorf("sign-in method %s chooses scopes from an authorization that lists them", method.ID)
			}
		}
	}
	if permissions := descriptor.Permissions; permissions != nil {
		if permissions.ManagedBy != "vendor_policy" {
			return fmt.Errorf("permissions are managed by vendor_policy")
		}
		if err := checkText("permissions description", permissions.Description, maxDescription, true); err != nil {
			return err
		}
		if err := checkLocalized("permissions descriptions", permissions.Descriptions, maxDescription); err != nil {
			return err
		}
		if permissions.URL != "" && !httpsURL(permissions.URL) {
			return fmt.Errorf("a permissions page is an https address")
		}
	}
	return nil
}

func httpsURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && len(value) <= 500
}

func (c *Catalog) checkConnectorPackage(pkg store.ConnectorPackage, reported []store.ConnectorDescriptor) error {
	if err := checkConnectorPackageShape(pkg); err != nil {
		return err
	}
	provider, ok := c.repositoryProvider(pkg.Upstream.Via, reported)
	if !ok {
		return fmt.Errorf("package.upstream.via names a device-held connector that declares repositoryAccess")
	}
	if pkg.Upstream.Via != "github" || provider.Tool.Command != "gh" {
		return fmt.Errorf("this worker slice reads package repositories through the GitHub CLI connector only")
	}
	return nil
}

func checkConnectorPackageShape(pkg store.ConnectorPackage) error {
	if pkg.Upstream.Via == "" {
		return fmt.Errorf("package.upstream.via names a connector")
	}
	repository := strings.TrimSuffix(strings.TrimSpace(pkg.Upstream.Repository), ".git")
	if len(repository) > 500 || !githubRepoPattern.MatchString(repository) {
		return fmt.Errorf("package.upstream.repository is a GitHub HTTPS repository")
	}
	if pkg.Upstream.Ref != "" && (!gitRefPattern.MatchString(pkg.Upstream.Ref) || strings.HasPrefix(pkg.Upstream.Ref, "-") || strings.Contains(pkg.Upstream.Ref, "..")) {
		return fmt.Errorf("package.upstream.ref is a branch or tag name")
	}
	if err := checkPackagePath("package.skills.path", pkg.Skills.Path); err != nil {
		return err
	}
	if len(pkg.Tools) == 0 || len(pkg.Tools) > 4 {
		return fmt.Errorf("package.tools lists 1 to 4 tools")
	}
	seen := map[string]bool{}
	for _, tool := range pkg.Tools {
		if !commandPattern.MatchString(tool.Command) || seen[tool.Command] {
			return fmt.Errorf("package tool command %q is not a unique plain name", tool.Command)
		}
		seen[tool.Command] = true
		if tool.Source != "repository" {
			return fmt.Errorf("package tool %s installs from repository", tool.Command)
		}
		if err := checkPackagePath("package tool "+tool.Command+" path", tool.Path); err != nil {
			return err
		}
		if len(tool.Bins) == 0 || len(tool.Bins) > 32 {
			return fmt.Errorf("package tool %s bins lists 1 to 32 commands", tool.Command)
		}
		if _, ok := tool.Bins[tool.Command]; !ok {
			return fmt.Errorf("package tool %s bins includes the command", tool.Command)
		}
		for name, toolPath := range tool.Bins {
			if !commandPattern.MatchString(name) {
				return fmt.Errorf("package tool %s bin name %q is not a plain command", tool.Command, name)
			}
			if err := checkPackagePath("package tool "+tool.Command+" bin "+name, toolPath); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkPackagePath(what, value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 300 || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\\x00\r\n") {
		return fmt.Errorf("%s is a relative folder inside the repository", what)
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%s is a relative folder inside the repository", what)
		}
	}
	return nil
}
