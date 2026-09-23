// Package skillarchive indexes immutable skill archives without extracting them.
package skillarchive

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"go.yaml.in/yaml/v3"
)

var invocationPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func ValidInvocationName(name string) bool {
	return len(name) <= 64 && invocationPattern.MatchString(name)
}

const MaxExpanded = 256 << 20
const MaxArchive = 64 << 20
const MaxFiles = 50000

type File = store.SkillFileInfo
type Index = store.SkillRevisionIndex

func safe(name string) bool {
	return name != "" && !strings.ContainsAny(name, "\\\x00") && !strings.HasPrefix(name, "/") && !strings.Contains(name, ":") && path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../")
}

// Match the worker's JS UTF-16 path ordering, including supplementary characters.
func less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func entries(data []byte) ([]*zip.File, error) {
	if len(data) > MaxArchive {
		return nil, fmt.Errorf("compressed skill exceeds 64 MiB")
	}
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	files := []*zip.File{}
	seen := map[string]bool{}
	var total uint64
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if !safe(f.Name) || !f.Mode().IsRegular() || seen[f.Name] {
			return nil, fmt.Errorf("invalid or duplicate skill path: %s", f.Name)
		}
		seen[f.Name] = true
		if f.UncompressedSize64 > MaxExpanded {
			return nil, fmt.Errorf("skill member exceeds size limit")
		}
		total += f.UncompressedSize64
		if total > MaxExpanded || len(files) >= MaxFiles {
			return nil, fmt.Errorf("expanded skill exceeds 256 MiB / 50000 files")
		}
		files = append(files, f)
	}
	if !seen["SKILL.md"] {
		return nil, fmt.Errorf("skill archive has no root SKILL.md")
	}
	sort.Slice(files, func(i, j int) bool { return less(files[i].Name, files[j].Name) })
	return files, nil
}
func read(f *zip.File, compatibility ...bool) ([]byte, error) {
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	b, err := io.ReadAll(io.LimitReader(r, MaxExpanded+1))
	if len(compatibility) > 0 && compatibility[0] && errors.Is(err, zip.ErrChecksum) && legacyCRC(b) == f.CRC32 {
		err = nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) > MaxExpanded || uint64(len(b)) != f.UncompressedSize64 {
		return nil, fmt.Errorf("invalid skill member size")
	}
	return b, nil
}
func Inspect(data []byte) (Index, error) { return inspect(data, false) }
func inspect(data []byte, compatibility bool) (Index, error) {
	idx, _, err := inspectDetailed(data, compatibility)
	return idx, err
}
func inspectDetailed(data []byte, compatibility bool) (Index, bool, error) {
	files, err := entries(data)
	if err != nil {
		return Index{}, false, err
	}
	idx := Index{Files: []File{}}
	legacy := false
	tree := sha256.New()
	for _, f := range files {
		b, err := read(f, compatibility)
		if err != nil {
			return Index{}, false, err
		}
		if crc32.ChecksumIEEE(b) != f.CRC32 {
			legacy = true
		}
		sum := sha256.Sum256(b)
		tree.Write([]byte(f.Name + "\x00" + strconv.Itoa(len(b)) + "\x00"))
		tree.Write(b)
		idx.Files = append(idx.Files, File{Path: f.Name, Digest: hex.EncodeToString(sum[:]), SizeBytes: int64(len(b)), Binary: !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0})
	}
	idx.SourceDigest = hex.EncodeToString(tree.Sum(nil))
	return idx, legacy, nil
}
func ReadFile(data []byte, name string) ([]byte, error) {
	if !safe(name) {
		return nil, fmt.Errorf("invalid skill file path")
	}
	files, err := entries(data)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Name == name {
			return read(f)
		}
	}
	return nil, fmt.Errorf("file not found in skill revision: %s", name)
}

// Rename changes the runtime invocation name in the copied archive only.
func Rename(data []byte, name string) ([]byte, error) {
	if !ValidInvocationName(name) {
		return nil, fmt.Errorf("invalid skill invocation name")
	}
	files, err := entries(data)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, f := range files {
		b, err := read(f)
		if err != nil {
			return nil, err
		}
		if f.Name == "SKILL.md" {
			raw := strings.ReplaceAll(string(b), "\r\n", "\n")
			header := ""
			body := raw
			if strings.HasPrefix(raw, "---\n") {
				match := regexp.MustCompile(`(?s)^---\n(.*?)\n---(?:\n|$)`).FindStringSubmatchIndex(raw)
				if match == nil {
					return nil, fmt.Errorf("cannot rename malformed skill frontmatter")
				}
				header = raw[match[2]:match[3]]
				body = raw[match[1]:]
			}
			var doc yaml.Node
			if header != "" {
				if err := yaml.Unmarshal([]byte(header), &doc); err != nil {
					return nil, err
				}
			}
			if len(doc.Content) == 0 {
				doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
			}
			mapping := doc.Content[0]
			if mapping.Kind != yaml.MappingNode {
				return nil, fmt.Errorf("skill frontmatter must be a mapping")
			}
			found := false
			for i := 0; i+1 < len(mapping.Content); i += 2 {
				if mapping.Content[i].Value == "name" {
					mapping.Content[i+1] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}
					found = true
				}
			}
			if !found {
				mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "name"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name})
			}
			encoded, err := yaml.Marshal(&doc)
			if err != nil {
				return nil, err
			}
			b = []byte("---\n" + string(encoded) + "---\n" + body)
		}
		w, err := writer.CreateHeader(&zip.FileHeader{Name: f.Name, Method: zip.Deflate})
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(b); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if out.Len() > MaxArchive {
		return nil, fmt.Errorf("renamed archive exceeds size limit")
	}
	return out.Bytes(), nil
}

// The original worker omitted the 8-bit table mask. Recognize only that exact
// historical encoding, and only behind a trusted package or source SHA-256.
func legacyCRC(data []byte) uint32 {
	table := crc32.MakeTable(crc32.IEEE)
	crc := uint32(0xffffffff)
	for _, b := range data {
		i := crc ^ uint32(b)
		var v uint32
		if i < 256 {
			v = table[i]
		}
		crc = v ^ (crc >> 8)
	}
	return crc ^ 0xffffffff
}
func verifyStored(data []byte, checksum string) error {
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != checksum {
		return fmt.Errorf("stored archive SHA-256 mismatch")
	}
	return nil
}
func InspectStored(data []byte, checksum string) (Index, error) {
	if err := verifyStored(data, checksum); err != nil {
		return Index{}, err
	}
	idx, err := inspect(data, true)
	if err != nil {
		return idx, fmt.Errorf("cannot index stored archive: %w", err)
	}
	return idx, nil
}
func ReadStoredFile(data []byte, checksum, name string) ([]byte, error) {
	if err := verifyStored(data, checksum); err != nil {
		return nil, err
	}
	files, err := entries(data)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Name == name {
			return read(f, true)
		}
	}
	return nil, fmt.Errorf("file is not in the stored revision")
}
func normalizeLegacy(data []byte) ([]byte, error) {
	files, err := entries(data)
	if err != nil {
		return nil, err
	}
	contents := make([][]byte, len(files))
	legacy := false
	for i, f := range files {
		b, err := read(f, true)
		if err != nil {
			return nil, err
		}
		contents[i] = b
		if crc32.ChecksumIEEE(b) != f.CRC32 {
			legacy = true
		}
	}
	if !legacy {
		return data, nil
	}
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for i, f := range files {
		w, err := z.CreateHeader(&zip.FileHeader{Name: f.Name, Method: zip.Deflate})
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(contents[i]); err != nil {
			return nil, err
		}
	}
	if err = z.Close(); err != nil {
		return nil, err
	}
	if out.Len() > MaxArchive {
		return nil, fmt.Errorf("normalized package exceeds size limit")
	}
	return out.Bytes(), nil
}
func PreparePromotion(data []byte, sourceDigest string) ([]byte, Index, error) {
	idx, legacy, err := inspectDetailed(data, true)
	if err != nil {
		return nil, idx, err
	}
	if idx.SourceDigest != sourceDigest {
		return nil, idx, fmt.Errorf("source content SHA-256 mismatch")
	}
	if !legacy {
		return data, idx, nil
	}
	normalized, err := normalizeLegacy(data)
	return normalized, idx, err
}

// Export fixes archive encoding in a copy, never mutating historical revisions.
func ExportStored(data []byte, checksum string) ([]byte, error) {
	if err := verifyStored(data, checksum); err != nil {
		return nil, err
	}
	return normalizeLegacy(data)
}
