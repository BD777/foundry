package store

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The JSON Schema 2020-12 bundle generated from contracts/evidence.openapi.yaml.
//
//go:embed evidence-schema.json
var evidenceSchemaJSON []byte

type evidenceDefinition struct {
	OneOf []struct {
		Ref string `json:"$ref"`
	} `json:"oneOf"`
	Required   []string `json:"required"`
	Properties map[string]struct {
		Type string `json:"type"`
		Enum []any  `json:"enum"`
	} `json:"properties"`
}

var evidenceDefinitions = func() map[string]evidenceDefinition {
	var bundle struct {
		Defs map[string]evidenceDefinition `json:"$defs"`
	}
	if err := json.Unmarshal(evidenceSchemaJSON, &bundle); err != nil {
		panic(err)
	}
	return bundle.Defs
}()

// Every model is compiled once, on first use.
var evidenceValidators = sync.OnceValue(func() map[string]*jsonschema.Schema {
	const url = "evidence-schema.json"
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(evidenceSchemaJSON))
	if err != nil {
		panic(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	compiler.RegisterFormat(&jsonschema.Format{Name: "non-blank", Validate: func(v any) error {
		if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
			return errors.New("blank string")
		}
		return nil
	}})
	if err := compiler.AddResource(url, doc); err != nil {
		panic(err)
	}
	validators := map[string]*jsonschema.Schema{}
	for name := range evidenceDefinitions {
		validators[name] = compiler.MustCompile(url + "#/$defs/" + name)
	}
	return validators
})

func ValidateEvidenceJSON(name string, raw []byte) error {
	schema, ok := evidenceValidators()[name]
	if !ok {
		return fmt.Errorf("unknown evidence model %s", name)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	if err := schema.Validate(value); err != nil {
		return evidenceWireError(name, err)
	}
	if name == "ContractContent" || name == "IssueContract" {
		var content ContractContent
		if err := json.Unmarshal(raw, &content); err != nil {
			return err
		}
		confirmed := false
		if name == "IssueContract" {
			var contract IssueContract
			if err := json.Unmarshal(raw, &contract); err != nil {
				return err
			}
			confirmed = contract.Status == "confirmed"
			if confirmed && (contract.Confirmation == nil || contract.Confirmation.ContentDigest != contract.ContentDigest || !IsHumanActor(contract.Confirmation.Actor)) {
				return fmt.Errorf("confirmed contract requires exact human confirmation")
			}
			if (contract.Status == "draft" || contract.Status == "discarded") && contract.Confirmation != nil {
				return fmt.Errorf("unconfirmed draft cannot carry a confirmation")
			}
		}
		if err := ValidateContractContent(content, confirmed); err != nil {
			return err
		}
	}
	if name == "Verification" {
		var v Verification
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		if (v.Status == "completed") != (v.Result != nil) {
			return fmt.Errorf("only completed verification has a result")
		}
		if v.Mode == "deterministic" && v.Executor.Kind != "program" {
			return fmt.Errorf("deterministic verification requires program")
		}
		if v.Mode == "agent" && v.Executor.Kind != "agent" {
			return fmt.Errorf("agent verification requires isolated agent")
		}
		if v.Status == "failed" && v.Error == nil {
			return fmt.Errorf("failed verification requires technical error")
		}
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	return validateNestedSelectors(decoded)
}

// The deepest failing value and why, e.g. "MaterialSelector/page: minimum: got 0, want 1".
// Union variants whose `kind` does not match are not the reason, unless none matches.
func evidenceWireError(name string, err error) error {
	var invalid *jsonschema.ValidationError
	if !errors.As(err, &invalid) {
		return err
	}
	var leaves func(*jsonschema.ValidationError) []*jsonschema.ValidationError
	leaves = func(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
		if len(e.Causes) == 0 {
			return []*jsonschema.ValidationError{e}
		}
		var found []*jsonschema.ValidationError
		for _, cause := range e.Causes {
			found = append(found, leaves(cause)...)
		}
		return found
	}
	var reasons func(*jsonschema.ValidationError) []*jsonschema.ValidationError
	reasons = func(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
		switch len(e.Causes) {
		case 0:
			return []*jsonschema.ValidationError{e}
		case 1:
			return reasons(e.Causes[0])
		}
		var matching []*jsonschema.ValidationError
		for _, cause := range e.Causes {
			if !slices.ContainsFunc(leaves(cause), func(leaf *jsonschema.ValidationError) bool {
				return len(leaf.InstanceLocation) == len(e.InstanceLocation)+1 && leaf.InstanceLocation[len(e.InstanceLocation)] == "kind"
			}) {
				matching = append(matching, reasons(cause)...)
			}
		}
		if len(matching) == 0 {
			return leaves(e)
		}
		return matching
	}
	deepest := invalid
	for _, leaf := range reasons(invalid) {
		if deepest == invalid || len(leaf.InstanceLocation) > len(deepest.InstanceLocation) {
			deepest = leaf
		}
	}
	unit := deepest.BasicOutput()
	return fmt.Errorf("%s%s: %s", name, unit.InstanceLocation, unit.Error)
}

func validateNestedSelectors(value any) error {
	switch v := value.(type) {
	case []any:
		for _, child := range v {
			if err := validateNestedSelectors(child); err != nil {
				return err
			}
		}
	case map[string]any:
		kind, _ := v["kind"].(string)
		num := func(k string) float64 { n, _ := v[k].(float64); return n }
		if kind == "text_lines" && num("end") < num("start") {
			return fmt.Errorf("reversed line range")
		}
		if kind == "time_range" && num("endMs") <= num("startMs") {
			return fmt.Errorf("empty time range")
		}
		if kind == "image_region" && (num("width") <= 0 || num("height") <= 0 || num("x")+num("width") > 1 || num("y")+num("height") > 1) {
			return fmt.Errorf("image region out of bounds")
		}
		if kind == "json_pointer" {
			p, _ := v["pointer"].(string)
			if !regexp.MustCompile(`^(?:/(?:[^~]|~[01])*)*$`).MatchString(p) {
				return fmt.Errorf("invalid JSON pointer")
			}
		}
		for _, child := range v {
			if err := validateNestedSelectors(child); err != nil {
				return err
			}
		}
	}
	return nil
}

// A union is encoded with its variant's required arrays and maps, never null.
func marshalEvidenceUnion(name, kind string, raw []byte) ([]byte, error) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	for _, ref := range evidenceDefinitions[name].OneOf {
		branch := evidenceDefinitions[strings.TrimPrefix(ref.Ref, "#/$defs/")]
		if tag := branch.Properties["kind"].Enum; len(tag) != 1 || tag[0] != kind {
			continue
		}
		for _, key := range branch.Required {
			if object[key] != nil {
				continue
			}
			switch branch.Properties[key].Type {
			case "array":
				object[key] = []any{}
			case "object":
				object[key] = map[string]any{}
			}
		}
	}
	return json.Marshal(object)
}

func IsHumanActor(actor ActorRef) bool {
	return actor.ID != "" && (actor.Kind == "user" || actor.Kind == "local_owner")
}

func ValidateContractContent(c ContractContent, confirming bool) error {
	if c.Criteria == nil || c.Goal.Media == nil || c.InScope == nil || c.OutOfScope == nil || c.Constraints == nil {
		return fmt.Errorf("contract arrays must not be null")
	}
	ids := map[string]bool{}
	required := 0
	for _, criterion := range c.Criteria {
		if ids[criterion.ID] {
			return fmt.Errorf("duplicate criterion %s", criterion.ID)
		}
		ids[criterion.ID] = true
		if criterion.Required {
			required++
		}
		if strings.TrimSpace(criterion.Statement) == "" || strings.TrimSpace(criterion.Rubric.Text) == "" {
			return fmt.Errorf("observable statement and rubric required")
		}
		if criterion.ProofKind == "other" && (criterion.ProofKindLabel == nil || strings.TrimSpace(*criterion.ProofKindLabel) == "") {
			return fmt.Errorf("proofKindLabel required")
		}
		if criterion.EvaluationMode == "agent" && criterion.Checker != nil {
			return fmt.Errorf("agent criterion cannot have checker")
		}
		// A deterministic criterion without its checker can never be verified;
		// confirming one would deadlock acceptance.
		if confirming && criterion.EvaluationMode == "deterministic" && criterion.Checker == nil {
			return fmt.Errorf("deterministic criterion requires a runnable checker")
		}
		if len(criterion.EvidenceRequirements) == 0 {
			return fmt.Errorf("evidence requirement required")
		}
		requirements := map[string]bool{}
		for _, r := range criterion.EvidenceRequirements {
			if requirements[r.ID] || len(r.AcceptedCarriers) == 0 || r.MinimumCount < 1 {
				return fmt.Errorf("invalid or duplicate evidence requirement")
			}
			requirements[r.ID] = true
			if criterion.EvaluationMode == "deterministic" && r.BindingPolicy != "system_observed" {
				return fmt.Errorf("deterministic evidence must be system observed")
			}
		}
		if checker := criterion.Checker; checker != nil && (checker.Configuration.Kind == "command" || checker.Configuration.Kind == "project_command") {
			config := checker.Configuration
			paths := []*string{config.CwdRelativePath}
			if config.Kind == "command" {
				paths = append(paths, config.Entrypoint)
			}
			for _, path := range paths {
				if path == nil || *path == "" || strings.HasPrefix(*path, "/") || strings.Contains(*path, `\`) {
					return fmt.Errorf("unsafe checker path")
				}
				for _, part := range strings.Split(*path, "/") {
					if part == ".." {
						return fmt.Errorf("unsafe checker path")
					}
				}
			}
			if len(config.ExpectedExitCodes) == 0 {
				return fmt.Errorf("expected exit codes required")
			}
			if config.Executable == nil || strings.TrimSpace(*config.Executable) == "" {
				return fmt.Errorf("checker executable required")
			}
			// The project's own command carries no checker bundle, fixtures or
			// secret bindings; anything else would never be run as declared.
			if config.Kind == "project_command" && (config.CheckerBundleMaterialID != nil ||
				len(config.FixtureMaterialIDs) > 0 || len(config.SecretBindings) > 0 ||
				config.ResultFormat != nil || config.MinimumAssertions != nil) {
				return fmt.Errorf("project command takes only executable, args, cwd, environment and exit codes")
			}
		}
	}
	if confirming && (strings.TrimSpace(c.Goal.Text) == "" || required == 0) {
		return fmt.Errorf("confirmation requires goal and at least one required criterion")
	}
	raw, _ := json.Marshal(c)
	var value any
	_ = json.Unmarshal(raw, &value)
	return validateNestedSelectors(value)
}
