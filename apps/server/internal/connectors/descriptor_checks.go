package connectors

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Limits on what a descriptor may say: the Web renders every word of it,
// and an extension's descriptor comes from a device.
const (
	maxLabel       = 80
	maxDescription = 300
	maxMethods     = 6
	maxFields      = 10
	maxOptions     = 40
	maxCommands    = 5
	maxCommand     = 300
	maxSetupLine   = 2000
	maxLocales     = 8
)

var (
	signInIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	fieldIDPattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
	localePattern   = regexp.MustCompile(`^[a-z]{2}(-[A-Za-z]{2,4})?$`)
	// A git remote git fetches without asking: https (no user in it), ssh,
	// or scp-style host:path.
	gitRemotePattern = regexp.MustCompile(`^(https://[^\s@/]+/\S+|ssh://\S+|([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*)$`)
	gitRefPattern    = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
	commitPattern    = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
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
		switch field.Type {
		case "text", "secret", "url":
			if len(field.Options) > 0 {
				return fmt.Errorf("field %s: only a select field lists options", field.ID)
			}
		case "select":
			if len(field.Options) == 0 || len(field.Options) > maxOptions {
				return fmt.Errorf("field %s: a select field lists 1 to %d options", field.ID, maxOptions)
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
