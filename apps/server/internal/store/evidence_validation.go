package store

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strings"
)

//go:embed evidence-schema.json
var evidenceSchemaJSON []byte

type wireSchema struct {
	Ref        string                `json:"$ref"`
	Type       string                `json:"type"`
	Const      json.RawMessage       `json:"const"`
	AnyOf      []wireSchema          `json:"anyOf"`
	Properties map[string]wireSchema `json:"properties"`
	Required   []string              `json:"required"`
	Additional json.RawMessage       `json:"additionalProperties"`
	Items      *wireSchema           `json:"items"`
	Minimum    *float64              `json:"minimum"`
	Maximum    *float64              `json:"maximum"`
	MinLength  int                   `json:"minLength"`
	Pattern    string                `json:"pattern"`
}

var evidenceSchemas = func() map[string]wireSchema {
	var schemas map[string]wireSchema
	if err := json.Unmarshal(evidenceSchemaJSON, &schemas); err != nil {
		panic(err)
	}
	return schemas
}()

func ValidateEvidenceJSON(name string, raw []byte) error {
	schema, ok := evidenceSchemas[name]
	if !ok {
		return fmt.Errorf("unknown evidence model %s", name)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	if err := validateWire(schema, value, name, 0); err != nil {
		return err
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
	return validateNestedSelectors(value)
}

func validateWire(s wireSchema, value any, path string, depth int) error {
	bad := func(why string) error { return fmt.Errorf("%s: %s", path, why) }
	if depth > 80 {
		return bad("nesting limit exceeded")
	}
	if s.Ref != "" {
		return validateWire(evidenceSchemas[s.Ref], value, path, depth+1)
	}
	if len(s.AnyOf) > 0 {
		for _, variant := range s.AnyOf {
			if validateWire(variant, value, path, depth+1) == nil {
				return nil
			}
		}
		return bad("invalid union variant")
	}
	if s.Const != nil {
		var expected any
		_ = json.Unmarshal(s.Const, &expected)
		if !reflect.DeepEqual(value, expected) {
			return bad("unexpected literal")
		}
		return nil
	}
	switch s.Type {
	case "object":
		obj, ok := value.(map[string]any)
		if !ok {
			return bad("expected object")
		}
		for _, key := range s.Required {
			if _, ok := obj[key]; !ok {
				return bad("missing " + key)
			}
		}
		for key, item := range obj {
			property, known := s.Properties[key]
			if !known && len(s.Additional) > 0 && s.Additional[0] == '{' {
				_ = json.Unmarshal(s.Additional, &property)
				known = true
			}
			if !known {
				return bad("unknown field " + key)
			}
			if err := validateWire(property, item, path+"."+key, depth+1); err != nil {
				return err
			}
		}
	case "array":
		items, ok := value.([]any)
		if !ok {
			return bad("expected array")
		}
		for i, item := range items {
			if err := validateWire(*s.Items, item, fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
				return err
			}
		}
	case "string":
		str, ok := value.(string)
		if !ok {
			return bad("expected string")
		}
		if s.MinLength > 0 && strings.TrimSpace(str) == "" {
			return bad("empty string")
		}
		if s.Pattern != "" && !regexp.MustCompile(s.Pattern).MatchString(str) {
			return bad("invalid format")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return bad("expected boolean")
		}
	case "number", "integer":
		n, ok := value.(float64)
		if !ok || math.IsInf(n, 0) || math.IsNaN(n) || (s.Type == "integer" && (n != math.Trunc(n) || math.Abs(n) > 9007199254740991)) || (s.Minimum != nil && n < *s.Minimum) || (s.Maximum != nil && n > *s.Maximum) {
			return bad("invalid number")
		}
	default:
		return bad("unsupported schema")
	}
	return nil
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

// Go unions preserve the discriminator's required empty arrays/maps on marshal.
func marshalEvidenceUnion(name, kind string, raw []byte) ([]byte, error) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	for _, branch := range evidenceSchemas[name].AnyOf {
		if string(branch.Properties["kind"].Const) != fmt.Sprintf("%q", kind) {
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
