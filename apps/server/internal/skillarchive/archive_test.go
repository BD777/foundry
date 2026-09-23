package skillarchive

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

func archive(t *testing.T, files map[string]string, method uint16) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for name, data := range files {
		f, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: method})
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(data))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestContentIndexIgnoresZipEncodingAndOrder(t *testing.T) {
	files := map[string]string{"SKILL.md": "---\nname: alpha\n---\n", "references/🚀.txt": "rocket", "references/\ue000.txt": "private"}
	a, err := Inspect(archive(t, files, zip.Store))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Inspect(archive(t, files, zip.Deflate))
	if err != nil {
		t.Fatal(err)
	}
	if a.SourceDigest != b.SourceDigest || len(a.Files) != 3 {
		t.Fatal("index varies with archive encoding")
	}
	if a.Files[1].Path != "references/🚀.txt" {
		t.Fatal("digest ordering differs from the worker's UTF-16 ordering")
	}
	renamed, err := Rename(archive(t, files, zip.Deflate), "team-alpha")
	if err != nil {
		t.Fatal(err)
	}
	body, err := ReadFile(renamed, "SKILL.md")
	if err != nil || !bytes.Contains(body, []byte("name: team-alpha")) {
		t.Fatalf("bad fork: %s %v", body, err)
	}
	original, _ := ReadFile(archive(t, files, zip.Store), "SKILL.md")
	if !bytes.Contains(original, []byte("name: alpha")) {
		t.Fatal("original changed")
	}
}
func TestRenameSupportsFrontmatterEndingAtEOF(t *testing.T) {
	data := archive(t, map[string]string{"SKILL.md": "---\nname: alpha\n---"}, zip.Store)
	renamed, err := Rename(data, "beta")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := ReadFile(renamed, "SKILL.md")
	if !bytes.Contains(body, []byte("name: beta")) {
		t.Fatal("name not changed")
	}
}
func TestIndexRejectsEscapesAndMissingRoot(t *testing.T) {
	for _, files := range []map[string]string{{"SKILL.md": "ok", "../escape": "bad"}, {"other.md": "no root"}} {
		if _, err := Inspect(archive(t, files, zip.Store)); err == nil {
			t.Fatal("invalid archive accepted")
		}
	}
}

func TestHistoricalCRCRecoveryRequiresStrongIdentityAndPreservesOriginal(t *testing.T) {
	body := "---\nname: alpha\n---\nlegacy data\n"
	original := archive(t, map[string]string{"SKILL.md": body}, zip.Store)
	legacy := append([]byte(nil), original...)
	central := bytes.Index(legacy, []byte{0x50, 0x4b, 0x01, 0x02})
	binary.LittleEndian.PutUint32(legacy[central+16:], legacyCRC([]byte(body)))
	checksum := sha256.Sum256(legacy)
	trusted := hex.EncodeToString(checksum[:])
	if _, err := Inspect(legacy); err == nil {
		t.Fatal("strict index accepted incorrect CRC")
	}
	idx, err := InspectStored(legacy, trusted)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InspectStored(legacy, "wrong"); err == nil {
		t.Fatal("archive identity not verified")
	}
	text, err := ReadStoredFile(legacy, trusted, "SKILL.md")
	if err != nil || string(text) != body {
		t.Fatalf("legacy read: %s %v", text, err)
	}
	fixed, err := ExportStored(legacy, trusted)
	if err != nil {
		t.Fatal(err)
	}
	valid, err := Inspect(fixed)
	if err != nil || valid.SourceDigest != idx.SourceDigest {
		t.Fatal("export changed contents or retained invalid CRC")
	}
	if sha256.Sum256(legacy) != checksum {
		t.Fatal("immutable revision mutated")
	}
	normalized, canonical, err := PreparePromotion(legacy, idx.SourceDigest)
	if err != nil || canonical.SourceDigest != idx.SourceDigest {
		t.Fatal(err)
	}
	if _, err := Inspect(normalized); err != nil {
		t.Fatal("new promotion was not normalized")
	}
	if _, _, err := PreparePromotion(legacy, "wrong source"); err == nil {
		t.Fatal("source digest not enforced")
	}
}
