package sqlitestore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

func TestEvidenceCanonicalDigestMatchesJavaScript(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-digest-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Value any `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	// Independent JS canonicalization, not generated expected data from Go.
	script := `const fs=require("fs"),crypto=require("crypto");const text=x=>JSON.stringify(x).replaceAll("\u2028","\\u2028").replaceAll("\u2029","\\u2029");const canonical=x=>Array.isArray(x)?"["+x.map(canonical).join(",")+"]":x&&typeof x==="object"?"{"+Object.keys(x).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>text(k)+":"+canonical(x[k])).join(",")+"}":text(x);console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).map(f=>canonical(f.value))));`
	command := exec.Command("node", "-e", script)
	command.Stdin = bytes.NewReader(raw)
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var canonical []string
	if err = json.Unmarshal(output, &canonical); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		hash := sha256.Sum256([]byte(canonical[i]))
		if got := evidenceDigest(fixture.Value); got != "sha256:"+hex.EncodeToString(hash[:]) {
			t.Fatalf("digest drift fixture %d: %s vs %s", i, canonicalEvidenceJSON(fixture.Value), canonical[i])
		}
	}
}
