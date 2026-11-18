package store

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
)

// ContractOutline and ContractProblemHints make a contract draft writable from
// the tool's own answers. Both read the schema validation checks against
// (contract-schema.json), so a field, a required list or an allowed value
// cannot drift from what the validator accepts. The rules the schema cannot
// state are listed in words, in the order ValidateContractContent checks them.

// contractOutlineParts are the parts of a draft an outline can be asked for, by
// the model each describes. A part names the others it points to with "see".
var contractOutlineParts = map[string]string{
	"contract":    "ContractContentFields",
	"criterion":   "AcceptanceCriterion",
	"richContent": "RichContent",
	"evidence":    "EvidenceRequirement",
}

// contractSeeParts maps a model a part refers to onto the part that describes it.
var contractSeeParts = map[string]string{
	"AcceptanceCriterion": "criterion",
	"RichContent":         "richContent",
	"EvidenceRequirement": "evidence",
}

// contractOutlineRules are the rules beyond the schema, per part, in words.
var contractOutlineRules = map[string][]string{
	"contract": {
		"criteria: each id is unique within the contract.",
		"Saving needs no more; confirming needs goal.text and at least one required criterion.",
	},
	"criterion": {
		"rubric.text is not blank.",
		"proofKind other: set proofKindLabel.",
		"evaluationMode agent: no checker.",
		"evaluationMode deterministic: confirming needs a checker, and its evidence is bindingPolicy system_observed.",
		"evidenceRequirements: at least one, ids unique within the criterion.",
	},
	"richContent": {
		"media is [] unless the person attached material; each item needs materialId, role and caption.",
	},
	"evidence": {
		"acceptedCarriers: at least one, and one of them must be produced by source (carriersBySource).",
		"source: confirming an agent criterion needs one of candidate_file, candidate_changes, human_upload.",
		"source human_upload needs bindingPolicy system_or_human_attested.",
		"source checker_command and checker_http serve deterministic criteria only.",
	},
}

// contractEnumNotes say what an allowed value means where the choice is not
// obvious from its name.
var contractEnumNotes = map[string]map[string]string{
	"evaluationMode": {
		"agent":         "an independent agent judges the evidence; no checker",
		"deterministic": "a runnable checker produces the evidence; needs a checker to confirm",
	},
	"proofKind": {"other": "also set proofKindLabel"},
	"source": {
		"candidate_file":    "a file from the sealed candidate; the usual source for agent criteria",
		"candidate_changes": "the candidate's change list against its base",
		"human_upload":      "a person uploads it; bindingPolicy system_or_human_attested",
		"checker_command":   "deterministic criteria only",
		"checker_http":      "deterministic criteria only",
	},
}

// contractArrayMinimums are the arrays a draft must not leave empty.
var contractArrayMinimums = map[string]int{"criteria": 1, "evidenceRequirements": 1, "acceptedCarriers": 1}

var contractDefRef = regexp.MustCompile(`^#/\$defs/(.+)$`)

// ContractOutline is the compact outline of one part of a contract draft: its
// required fields, each field's type or allowed values, and the rules beyond
// the schema. It is what the issues tool answers for op schema.
func ContractOutline(part string) (string, error) {
	model, ok := contractOutlineParts[part]
	if !ok {
		return "", fmt.Errorf("unknown part %q: part is one of %s", part, strings.Join(ContractPartNames(), ", "))
	}
	def, err := contractDefinition(model)
	if err != nil {
		return "", err
	}
	outline := outlineObject(def, 0)
	outline["part"] = part
	outline["rules"] = contractOutlineRules[part]
	if part == "evidence" {
		outline["carriersBySource"] = carriersBySource()
	}
	encoded, err := json.Marshal(outline)
	return string(encoded), err
}

// ContractPartNames lists the parts ContractOutline answers, sorted.
func ContractPartNames() []string {
	names := make([]string, 0, len(contractOutlineParts))
	for name := range contractOutlineParts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ContractProblemHints appends the allowed values of each enum field a
// validation problem names, so an agent can fix the draft from the answer
// alone. A problem naming no enum field comes back unchanged.
func ContractProblemHints(problem string) string {
	values := contractEnumValues()
	var hints []string
	seen := map[string]bool{}
	for _, match := range contractFieldMention.FindAllStringSubmatch(problem, -1) {
		name := match[1] + match[2]
		allowed, ok := values[name]
		if !ok || seen[name] {
			continue
		}
		seen[name] = true
		hints = append(hints, name+": "+strings.Join(allowed, ", "))
	}
	if len(hints) == 0 {
		return problem
	}
	return problem + " [allowed: " + strings.Join(hints, "; ") + "]"
}

// contractFieldMention is a property name as validation names it: quoted, as
// in "missing properties 'proofKind'", or a JSON pointer segment, as in
// "/criteria/0/proofKind". Both groups capture the name.
var contractFieldMention = regexp.MustCompile(`'([A-Za-z][A-Za-z0-9_]*)'|/([A-Za-z][A-Za-z0-9_]*)`)

// contractEnumValues maps each enum field reachable from a contract to its
// allowed values. A name that means different values in different places is
// left out: a hint there would be wrong for one of them.
var contractEnumValues = sync.OnceValue(func() map[string][]string {
	values := map[string][]string{}
	conflicting := map[string]bool{}
	visited := map[string]bool{}
	var visit func(model string)
	record := func(name string, allowed []string) {
		if previous, ok := values[name]; ok && !slices.Equal(previous, allowed) {
			conflicting[name] = true
		}
		values[name] = allowed
	}
	visit = func(model string) {
		if visited[model] {
			return
		}
		visited[model] = true
		def, err := contractDefinition(model)
		if err != nil {
			return
		}
		properties, _ := def["properties"].(map[string]any)
		for name, raw := range properties {
			prop, _ := raw.(map[string]any)
			if enum, ok := enumOfProperty(prop); ok {
				record(name, enum)
				continue
			}
			if target, ok := refModel(prop); ok {
				visit(target)
			} else if items, ok := prop["items"].(map[string]any); ok {
				if target, ok := refModel(items); ok {
					visit(target)
				}
			}
		}
	}
	visit("ContractContentFields")
	for name := range conflicting {
		delete(values, name)
	}
	return values
})

// outlineObject describes an object model: its required fields and each field.
// depth bounds how far a model is spelled out inline; further models are named
// with "see" and their own part.
func outlineObject(def map[string]any, depth int) map[string]any {
	required := stringsOfAny(def["required"])
	fields := map[string]any{}
	properties, _ := def["properties"].(map[string]any)
	for name, raw := range properties {
		prop, _ := raw.(map[string]any)
		field := outlineProperty(name, prop, depth)
		if !slices.Contains(required, name) {
			field["optional"] = true
		}
		fields[name] = field
	}
	outline := map[string]any{"required": required, "fields": fields}
	return outline
}

// outlineProperty describes one property of a model.
func outlineProperty(name string, prop map[string]any, depth int) map[string]any {
	if target, ok := refModel(prop); ok {
		return outlineModel(name, target, depth)
	}
	if enum, ok := enumValuesOf(prop); ok {
		return enumOutline(name, enum)
	}
	switch prop["type"] {
	case "array":
		items, _ := prop["items"].(map[string]any)
		field := map[string]any{"type": "array"}
		if minimum, ok := contractArrayMinimums[name]; ok {
			field["minItems"] = minimum
		}
		if enum, ok := enumOfProperty(items); ok && refIsEnum(items) {
			field["of"] = "enum"
			field["values"] = enum
			return field
		}
		if target, ok := refModel(items); ok {
			inner := outlineModel(name, target, depth)
			field["of"] = inner["type"]
			for key, value := range inner {
				if key != "type" {
					field[key] = value
				}
			}
			return field
		}
		field["of"] = stringOr(items["type"], "any")
		return field
	case "string":
		field := map[string]any{"type": "string"}
		if prop["format"] == "non-blank" {
			field["nonBlank"] = true
		}
		return field
	case "integer":
		field := map[string]any{"type": "integer"}
		if minimum, ok := prop["minimum"].(float64); ok {
			field["min"] = minimum
		}
		return field
	case "boolean":
		return map[string]any{"type": "boolean"}
	case "object":
		return outlineModelInline(prop, depth)
	}
	return map[string]any{"type": "object", "note": "one of several shapes; see the schema"}
}

// outlineModel names a referenced model: an enum by its values, a model with a
// part by "see", and any other object inline one level down.
func outlineModel(name, target string, depth int) map[string]any {
	if enum, ok := enumDef(target); ok {
		return enumOutline(name, enum)
	}
	if part, ok := contractSeeParts[target]; ok {
		return map[string]any{"type": "object", "see": part}
	}
	def, err := contractDefinition(target)
	if err != nil {
		return map[string]any{"type": "object", "note": err.Error()}
	}
	if _, hasProperties := def["properties"]; hasProperties {
		if depth >= 2 {
			return map[string]any{"type": "object", "note": "see the schema"}
		}
		return outlineModelInline(def, depth+1)
	}
	if def["type"] == "string" {
		return outlineProperty(name, def, depth)
	}
	return map[string]any{"type": "object", "note": "one of several shapes; see the schema"}
}

// enumOfProperty is the allowed values a property takes: an inline enum, a
// reference to an enum model, or the items of an array of either.
func enumOfProperty(prop map[string]any) ([]string, bool) {
	if enum, ok := enumValuesOf(prop); ok {
		return enum, true
	}
	if target, ok := refModel(prop); ok {
		return enumDef(target)
	}
	if items, ok := prop["items"].(map[string]any); ok {
		return enumOfProperty(items)
	}
	return nil, false
}

func outlineModelInline(def map[string]any, depth int) map[string]any {
	outline := outlineObject(def, depth)
	outline["type"] = "object"
	return outline
}

func enumOutline(name string, enum []string) map[string]any {
	field := map[string]any{"type": "enum", "values": enum}
	if notes, ok := contractEnumNotes[name]; ok {
		field["notes"] = notes
	}
	return field
}

// enumValuesOf is the allowed values when prop is a string enum written inline.
func enumValuesOf(prop map[string]any) ([]string, bool) {
	if prop == nil || prop["type"] != "string" {
		return nil, false
	}
	raw, ok := prop["enum"].([]any)
	if !ok {
		return nil, false
	}
	return stringsOfAny(raw), true
}

// refIsEnum is whether prop refers to a model that is a string enum, or is one.
func refIsEnum(prop map[string]any) bool {
	if _, ok := enumValuesOf(prop); ok {
		return true
	}
	if target, ok := refModel(prop); ok {
		_, isEnum := enumDef(target)
		return isEnum
	}
	return false
}

// enumDef is the allowed values of a model that is a string enum.
func enumDef(model string) ([]string, bool) {
	def, err := contractDefinition(model)
	if err != nil {
		return nil, false
	}
	return enumValuesOf(def)
}

// refModel is the model a "$ref" to a definition names, when prop is one.
func refModel(prop map[string]any) (string, bool) {
	ref, ok := prop["$ref"].(string)
	if !ok {
		return "", false
	}
	match := contractDefRef.FindStringSubmatch(ref)
	if match == nil {
		return "", false
	}
	return match[1], true
}

// contractDefinition is a schema definition of the contract's bundle, decoded.
func contractDefinition(model string) (map[string]any, error) {
	raw, ok := evidenceDefinitions[model]
	if !ok {
		return nil, fmt.Errorf("no schema definition %s", model)
	}
	var def map[string]any
	if err := json.Unmarshal(raw, &def); err != nil {
		return nil, err
	}
	return def, nil
}

// carriersBySource is which carriers each evidence source produces: the table
// the validator checks acceptedCarriers against.
func carriersBySource() map[string][]CarrierKind {
	carriers := map[string][]CarrierKind{}
	sources, _ := enumDef("EvidenceRequirementSource")
	for _, source := range sources {
		carriers[source] = SourceCarriers(EvidenceRequirementSource(source))
	}
	return carriers
}

func stringsOfAny(raw any) []string {
	list, _ := raw.([]any)
	values := make([]string, 0, len(list))
	for _, item := range list {
		if text, ok := item.(string); ok {
			values = append(values, text)
		}
	}
	return values
}

func stringOr(value any, fallback string) string {
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}
