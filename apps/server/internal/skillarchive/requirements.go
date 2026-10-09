package skillarchive

import (
	"path"
	"regexp"
	"sort"
	"strings"
)

var toolNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$`)

// interpreters maps script extensions to the program that runs them.
var interpreters = map[string]string{
	".py": "python3", ".sh": "bash", ".bash": "bash", ".js": "node", ".mjs": "node",
	".cjs": "node", ".rb": "ruby", ".pl": "perl",
}

// documents are read, not run; a "#!" line in one names nothing.
var documents = map[string]bool{".md": true, ".txt": true, ".json": true, ".yaml": true, ".yml": true, ".html": true, ".csv": true}

// normalizeTool folds names that mean the same program.
func normalizeTool(name string) string {
	name = strings.TrimSpace(name)
	switch name {
	case "python":
		return "python3"
	case "sh":
		return "bash"
	}
	return name
}

// ToolRequirements lists the programs a skill needs: the ones its SKILL.md
// names under metadata.requires, the interpreters of its scripts, and the
// programs named by script shebang lines. The worker applies the same rule.
func ToolRequirements(manifest string, files map[string][]byte) []string {
	found := map[string]bool{}
	add := func(name string) {
		if name = normalizeTool(name); toolNamePattern.MatchString(name) {
			found[name] = true
		}
	}
	if parsed, err := ReadManifest(manifest); err == nil {
		switch value := parsed.Metadata.Requires.(type) {
		case string:
			for _, name := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' }) {
				add(name)
			}
		case []any:
			for _, item := range value {
				if name, ok := item.(string); ok {
					add(name)
				}
			}
		}
	}
	for name, data := range files {
		if tool, ok := interpreters[strings.ToLower(path.Ext(name))]; ok {
			add(tool)
		}
		if documents[strings.ToLower(path.Ext(name))] {
			continue
		}
		if tool := shebangTool(data); tool != "" {
			add(tool)
		}
	}
	tools := make([]string, 0, len(found))
	for name := range found {
		tools = append(tools, name)
	}
	sort.Strings(tools)
	return tools
}

// shebangTool reads the program a "#!" line runs: "#!/usr/bin/env python3"
// and "#!/bin/bash" give python3 and bash.
func shebangTool(data []byte) string {
	if len(data) < 3 || data[0] != '#' || data[1] != '!' {
		return ""
	}
	line := string(data[2:])
	if end := strings.IndexByte(line, '\n'); end >= 0 {
		line = line[:end]
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	program := path.Base(fields[0])
	if program == "env" {
		for _, field := range fields[1:] {
			if !strings.HasPrefix(field, "-") && !strings.Contains(field, "=") {
				return path.Base(field)
			}
		}
		return ""
	}
	return program
}

// ArchiveToolRequirements applies ToolRequirements to a skill zip.
func ArchiveToolRequirements(data []byte) ([]string, error) {
	zipped, err := entries(data)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	manifest := ""
	for _, f := range zipped {
		if f.FileInfo().IsDir() {
			continue
		}
		b, err := read(f, true)
		if err != nil {
			return nil, err
		}
		if f.Name == "SKILL.md" {
			manifest = string(b)
			continue
		}
		files[f.Name] = b
	}
	return ToolRequirements(manifest, files), nil
}
