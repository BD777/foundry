package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type wsSkillFileReadPayload struct {
	Content string `json:"content"`
	Digest  string `json:"digest"`
	Error   string `json:"error,omitempty"`
}
type skillFileChange = store.SkillFileChange

func (s *Server) skillComparisonMetadata(ctx context.Context, input store.SkillComparisonInput) ([]store.SkillFileInfo, []store.SkillFileInfo, error) {
	if input.DeviceID == "" || input.Root == "" || input.DirName == "" || input.SkillID == "" || input.Revision <= 0 || input.SourceDigest == "" {
		return nil, nil, fmt.Errorf("exact source and server revision are required")
	}
	local, err := s.store.GetDeviceSkillIndex(ctx, input.DeviceID, input.Root, input.DirName)
	if err != nil {
		return nil, nil, err
	}
	if local.SourceDigest != input.SourceDigest {
		return nil, nil, fmt.Errorf("local scan changed; reopen the comparison")
	}
	remote, err := s.store.GetSkillRevisionIndex(ctx, input.SkillID, input.Revision)
	if err != nil {
		return nil, nil, err
	}
	return local.Files, remote.Files, nil
}
func (s *Server) handleSkillCompare(w http.ResponseWriter, r *http.Request) {
	var input store.SkillComparisonInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	local, remote, err := s.skillComparisonMetadata(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	before := map[string]store.SkillFileInfo{}
	after := map[string]store.SkillFileInfo{}
	paths := map[string]bool{}
	for _, f := range remote {
		before[f.Path] = f
		paths[f.Path] = true
	}
	for _, f := range local {
		after[f.Path] = f
		paths[f.Path] = true
	}
	changes := []skillFileChange{}
	unchanged := 0
	for p := range paths {
		old, hasOld := before[p]
		next, hasNew := after[p]
		if hasOld && hasNew && old.Digest == next.Digest {
			unchanged++
			continue
		}
		c := skillFileChange{Path: p, Kind: "modified"}
		if hasOld {
			c.Before = &old
		} else {
			c.Kind = "added"
		}
		if hasNew {
			c.After = &next
		} else {
			c.Kind = "removed"
		}
		changes = append(changes, c)
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	writeResult(w, store.SkillComparison{Files: changes, Unchanged: unchanged, Revision: input.Revision}, nil)
}
func (s *Server) handleSkillCompareFile(w http.ResponseWriter, r *http.Request) {
	var input store.SkillComparisonInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	local, remote, err := s.skillComparisonMetadata(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	var before, after *store.SkillFileInfo
	for _, f := range remote {
		if f.Path == input.Path {
			copy := f
			before = &copy
		}
	}
	for _, f := range local {
		if f.Path == input.Path {
			copy := f
			after = &copy
		}
	}
	if before == nil && after == nil {
		writeError(w, http.StatusNotFound, "file is not part of this comparison")
		return
	}
	result := store.SkillFileComparison{}
	for _, f := range []*store.SkillFileInfo{before, after} {
		if f != nil && (f.Binary || f.SizeBytes > 512*1024) {
			result.Unavailable = "Binary or large file. Download the archives to inspect the complete contents."
			writeResult(w, result, nil)
			return
		}
	}
	if before != nil {
		pkg, err := s.store.GetSkillPackage(r.Context(), input.SkillID, input.Revision)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		data, err := skillarchive.ReadStoredFile(pkg.Content, pkg.Checksum, input.Path)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != before.Digest {
			writeError(w, http.StatusConflict, "stored revision contents do not match the file index")
			return
		}
		result.Before = string(data)
	}
	if after != nil {
		conn := s.hub.connectionFor(input.DeviceID)
		if conn == nil {
			writeError(w, http.StatusBadGateway, "device offline; connect it to read the selected local file")
			return
		}
		request, _ := json.Marshal(map[string]string{"root": input.Root, "dirName": input.DirName, "path": input.Path})
		reply, err := daemonRequest[wsSkillFileReadPayload](r.Context(), conn, wsReadSkillFileType, request)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		digest := sha256.Sum256([]byte(reply.Content))
		if reply.Digest != after.Digest || hex.EncodeToString(digest[:]) != after.Digest {
			writeError(w, http.StatusConflict, "local file changed since the scan; run Scan now and compare again")
			return
		}
		result.After = reply.Content
	}
	writeResult(w, result, nil)
}
func (s *Server) handleSkillComparePackage(w http.ResponseWriter, r *http.Request) {
	var input store.SkillComparisonInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	if _, _, err := s.skillComparisonMetadata(r.Context(), input); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	var data []byte
	if input.Side == "server" {
		pkg, err := s.store.GetSkillPackage(r.Context(), input.SkillID, input.Revision)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		data, err = skillarchive.ExportStored(pkg.Content, pkg.Checksum)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
	} else if input.Side == "local" {
		pkg, err := s.hub.ReadDeviceSkillContent(r.Context(), input.DeviceID, input.Root, input.DirName)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if pkg.SourceDigest != input.SourceDigest {
			writeError(w, http.StatusConflict, "local source changed; scan again")
			return
		}
		data, err = base64.StdEncoding.DecodeString(pkg.ContentB64)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
	} else {
		writeError(w, http.StatusBadRequest, "side must be local or server")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="skill.zip"`)
	w.Write(data)
}
