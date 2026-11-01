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

func TestContentDigestWorkerCacheVector(t *testing.T) {
	idx, err := Inspect(archive(t, map[string]string{
		"SKILL.md": "method", "references/🚀.txt": "supplementary", "references/\ue000.txt": "bmp",
	}, zip.Deflate))
	if err != nil {
		t.Fatal(err)
	}
	if idx.SourceDigest != "ca23927a531692a2dd71b09ed2195a4415574efd6b1d6a5a1533167664956b35" {
		t.Fatalf("Worker cache digest changed: %s", idx.SourceDigest)
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

// A stored revision is read and exported only under its checksum, and a
// promotion only under the source digest its device reported.
func TestStoredAndPromotedArchivesKeepTheirIdentity(t *testing.T) {
	body := "---\nname: alpha\n---\ndata\n"
	data := archive(t, map[string]string{"SKILL.md": body}, zip.Store)
	checksum := sha256.Sum256(data)
	trusted := hex.EncodeToString(checksum[:])
	idx, err := InspectStored(data, trusted)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InspectStored(data, "wrong"); err == nil {
		t.Fatal("archive identity not verified")
	}
	if text, err := ReadStoredFile(data, trusted, "SKILL.md"); err != nil || string(text) != body {
		t.Fatalf("stored read: %s %v", text, err)
	}
	if exported, err := ExportStored(data, trusted); err != nil || !bytes.Equal(exported, data) {
		t.Fatalf("export: %v", err)
	}
	if _, _, err := PreparePromotion(data, idx.SourceDigest); err != nil {
		t.Fatal(err)
	}
	if _, _, err := PreparePromotion(data, "wrong source"); err == nil {
		t.Fatal("source digest not enforced")
	}
	broken := append([]byte(nil), data...)
	central := bytes.Index(broken, []byte{0x50, 0x4b, 0x01, 0x02})
	binary.LittleEndian.PutUint32(broken[central+16:], 0)
	if _, err := Inspect(broken); err == nil {
		t.Fatal("an incorrect CRC was accepted")
	}
}
