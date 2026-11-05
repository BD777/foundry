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

// The JSON Schema 2020-12 bundle generated from the contract (contracts/).
//
//go:embed contract-schema.json
var evidenceSchemaJSON []byte

var evidenceDefinitions = func() map[string]json.RawMessage {
	var bundle struct {
		Defs map[string]json.RawMessage `json:"$defs"`
	}
	if err := json.Unmarshal(evidenceSchemaJSON, &bundle); err != nil {
		panic(err)
	}
	return bundle.Defs
}()

// Every model is compiled once, on first use.
var evidenceValidators = sync.OnceValue(func() map[string]*jsonschema.Schema {
	const url = "contract-schema.json"
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

// ValidateEvidenceJSON checks a model against the generated schema and then
// against the rules the schema cannot state (cross-field, confirmation,
// checker and selector rules). Those rules live only here: a client that
// wants them checked before it writes asks POST /api/issues/{id}/contracts/validate.
func ValidateEvidenceJSON(name string, raw []byte) error {
	if err := validateEvidenceSchema(name, raw); err != nil {
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
		return ValidateContractContent(content, confirmed)
	}
	if name == "Verification" {
		var v Verification
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		if (v.Status == "completed") != (v.Result != nil) {
			return fmt.Errorf("only completed verification has a result")
		}
		executor, _ := v.Executor.Discriminator()
		if v.Mode == EvaluationModeDeterministic && executor != string(VerifierIdentityProgramKindProgram) {
			return fmt.Errorf("deterministic verification requires program")
		}
		if v.Mode == EvaluationModeAgent && executor != string(VerifierIdentityAgentKindAgent) {
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

// ContractProblems is every reason content would not be saved as a draft or,
// when confirming, could not be confirmed; empty when it would be.
func ContractProblems(raw []byte, confirming bool) []string {
	if err := validateEvidenceSchema("ContractContent", raw); err != nil {
		return []string{err.Error()}
	}
	var content ContractContent
	if err := json.Unmarshal(raw, &content); err != nil {
		return []string{err.Error()}
	}
	problems := []string{}
	if joined, ok := ValidateContractContent(content, confirming).(interface{ Unwrap() []error }); ok {
		for _, problem := range joined.Unwrap() {
			problems = append(problems, problem.Error())
		}
	}
	return problems
}

func validateEvidenceSchema(name string, raw []byte) error {
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
	return nil
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

// sourceCarriers is the contract's EvidenceRequirementSourceCarriers table.
var sourceCarriers = func() map[EvidenceRequirementSource][]CarrierKind {
	var table struct {
		Properties map[EvidenceRequirementSource]struct {
			Const []CarrierKind `json:"const"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(evidenceDefinitions["EvidenceRequirementSourceCarriers"], &table); err != nil {
		panic(err)
	}
	carriers := map[EvidenceRequirementSource][]CarrierKind{}
	for source, entry := range table.Properties {
		carriers[source] = entry.Const
	}
	return carriers
}()

// SourceCarriers is the carriers an evidence requirement source produces.
func SourceCarriers(source EvidenceRequirementSource) []CarrierKind {
	return sourceCarriers[source]
}

// EffectiveRequirementSource is where a requirement's material comes from:
// the source it names, else, for a deterministic criterion, its checker's;
// nil when neither says.
func EffectiveRequirementSource(criterion AcceptanceCriterion, r EvidenceRequirement) *EvidenceRequirementSource {
	if r.Source != nil {
		return r.Source
	}
	if criterion.EvaluationMode == EvaluationModeDeterministic {
		if source := checkerSource(criterion); source != "" {
			return &source
		}
	}
	return nil
}

// checkerSource is the source a deterministic criterion's checker captures
// its material with; "" without a checker.
func checkerSource(criterion AcceptanceCriterion) EvidenceRequirementSource {
	if criterion.Checker == nil {
		return ""
	}
	kind, _ := criterion.Checker.Configuration.Discriminator()
	if kind == "http" {
		return EvidenceRequirementSourceCheckerHTTP
	}
	return EvidenceRequirementSourceCheckerCommand
}

// requirementSourceProblem is why a requirement could never receive material:
// its source does not serve the criterion, or it accepts no carrier the source
// produces. An agent criterion's requirement must name its source to be
// confirmed; a deterministic one gets its material from the checker.
func requirementSourceProblem(criterion AcceptanceCriterion, r EvidenceRequirement, confirming bool) string {
	checker := checkerSource(criterion)
	deterministic := criterion.EvaluationMode == EvaluationModeDeterministic
	source := checker
	switch {
	case r.Source != nil:
		source = *r.Source
	case !deterministic && confirming:
		return fmt.Sprintf("evidence source required (one of %s)", strings.Join(stringsOf(EvidenceRequirementSourceCandidateFile, EvidenceRequirementSourceCandidateChanges, EvidenceRequirementSourceHumanUpload), ", "))
	}
	if source == "" {
		return ""
	}
	isChecker := source == EvidenceRequirementSourceCheckerCommand || source == EvidenceRequirementSourceCheckerHTTP
	switch {
	case deterministic && !isChecker:
		return fmt.Sprintf("source %s cannot serve a deterministic criterion, whose material comes from its checker", source)
	case deterministic && checker != "" && source != checker:
		return fmt.Sprintf("source %s does not match the criterion's checker, which produces %s", source, checker)
	case !deterministic && isChecker:
		return fmt.Sprintf("source %s serves only deterministic criteria", source)
	case source == EvidenceRequirementSourceHumanUpload && r.BindingPolicy != EvidenceRequirementBindingPolicySystemOrHumanAttested:
		return "source human_upload requires bindingPolicy system_or_human_attested"
	}
	if len(r.AcceptedCarriers) == 0 {
		return "" // reported as missing carriers
	}
	produced := SourceCarriers(source)
	for _, carrier := range r.AcceptedCarriers {
		if slices.Contains(produced, carrier) {
			return ""
		}
	}
	return fmt.Sprintf("source %s produces only %s, which acceptedCarriers does not include", source, strings.Join(stringsOf(produced...), ", "))
}

func stringsOf[T ~string](values ...T) []string {
	names := make([]string, len(values))
	for i, v := range values {
		names[i] = string(v)
	}
	return names
}

func IsHumanActor(actor ActorRef) bool {
	return actor.ID != "" && (actor.Kind == "user" || actor.Kind == "local_owner")
}

// ValidateContractContent checks content that already matches the schema
// against the rules the schema cannot state; it reports every problem.
func ValidateContractContent(c ContractContent, confirming bool) error {
	var problems []error
	fail := func(format string, args ...any) { problems = append(problems, fmt.Errorf(format, args...)) }
	ids := map[string]bool{}
	required := 0
	for _, criterion := range c.Criteria {
		if ids[criterion.ID] {
			fail("duplicate criterion %s", criterion.ID)
		}
		ids[criterion.ID] = true
		if criterion.Required {
			required++
		}
		if strings.TrimSpace(criterion.Rubric.Text) == "" {
			fail("%s: rubric required", criterion.ID)
		}
		if criterion.ProofKind == "other" && (criterion.ProofKindLabel == nil || strings.TrimSpace(*criterion.ProofKindLabel) == "") {
			fail("%s: proofKindLabel required", criterion.ID)
		}
		if criterion.EvaluationMode == "agent" && criterion.Checker != nil {
			fail("%s: agent criterion cannot have checker", criterion.ID)
		}
		// A deterministic criterion without its checker can never be verified;
		// confirming one would deadlock acceptance.
		if confirming && criterion.EvaluationMode == "deterministic" && criterion.Checker == nil {
			fail("%s: deterministic criterion requires a runnable checker", criterion.ID)
		}
		if len(criterion.EvidenceRequirements) == 0 {
			fail("%s: evidence requirement required", criterion.ID)
		}
		requirements := map[string]bool{}
		for _, r := range criterion.EvidenceRequirements {
			if requirements[r.ID] {
				fail("%s: duplicate evidence requirement %s", criterion.ID, r.ID)
			}
			requirements[r.ID] = true
			if len(r.AcceptedCarriers) == 0 {
				fail("%s: accepted carriers required", criterion.ID)
			}
			if criterion.EvaluationMode == "deterministic" && r.BindingPolicy != "system_observed" {
				fail("%s: deterministic evidence must be system observed", criterion.ID)
			}
			if problem := requirementSourceProblem(criterion, r, confirming); problem != "" {
				fail("%s/%s: %s", criterion.ID, r.ID, problem)
			}
		}
		if checker := criterion.Checker; checker != nil {
			var paths []string
			var exitCodes []int
			config, _ := checker.Configuration.ValueByDiscriminator()
			switch config := config.(type) {
			case CheckConfigurationCommand:
				paths, exitCodes = []string{config.CwdRelativePath, config.Entrypoint}, config.ExpectedExitCodes
			case CheckConfigurationProjectCommand:
				paths, exitCodes = []string{config.CwdRelativePath}, config.ExpectedExitCodes
			}
			for _, path := range paths {
				if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, `\`) || slices.Contains(strings.Split(path, "/"), "..") {
					fail("%s: unsafe checker path", criterion.ID)
				}
			}
			if paths != nil && len(exitCodes) == 0 {
				fail("%s: expected exit codes required", criterion.ID)
			}
		}
	}
	if confirming && (strings.TrimSpace(c.Goal.Text) == "" || required == 0) {
		fail("confirmation requires goal and at least one required criterion")
	}
	raw, _ := json.Marshal(c)
	var value any
	_ = json.Unmarshal(raw, &value)
	if err := validateNestedSelectors(value); err != nil {
		problems = append(problems, err)
	}
	return errors.Join(problems...)
}
