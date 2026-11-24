package store

// DefaultSkillResolution never guesses which different-content entry to replace.
func DefaultSkillResolution(s DeviceSkill) SkillPromotionResolution {
	r := SkillPromotionResolution{Root: s.Root, DirName: s.DirName, Action: "create"}
	for _, c := range s.ServerCandidates {
		if c.ID == s.PromotedSkillID {
			r.TargetSkillID = c.ID
			r.ExpectedRevision = c.LatestRevision
			r.Action = "update"
			if s.ServerState == "in_sync" {
				r.Action = "reuse"
			}
			return r
		}
	}
	if s.ServerState == "reusable" {
		for _, c := range s.ServerCandidates {
			if c.SourceDigest == s.SourceDigest && c.SourceDigest != "" {
				r.TargetSkillID = c.ID
				r.ExpectedRevision = c.LatestRevision
				r.Action = "reuse"
				return r
			}
		}
	}
	if len(s.ServerCandidates) > 0 {
		r.Action = ""
	}
	return r
}
func ResolveSkillPromotion(s DeviceSkill, choices []SkillPromotionResolution) SkillPromotionResolution {
	for _, c := range choices {
		if c.Root == s.Root && c.DirName == s.DirName {
			return c
		}
	}
	return DefaultSkillResolution(s)
}

// SetPromotionCandidates derives the version choices shown in the shared promotion dialog.
func (s *DeviceSkill) SetPromotionCandidates(candidates []PromotedSkill, c PromotedSkill, boundSource, boundContent string) {
	s.ServerState = "unpublished"
	s.ServerCandidates = candidates
	if c.ID != "" {
		s.ServerRevision = c.LatestRevision
		found := false
		for _, v := range s.ServerCandidates {
			if v.ID == c.ID {
				found = true
			}
		}
		if !found {
			s.ServerCandidates = append([]PromotedSkill{c}, s.ServerCandidates...)
		}
		if s.SourceDigest == "" || c.SourceDigest == "" {
			s.ServerState = "unknown"
		} else if s.SourceDigest == c.SourceDigest || (s.SourceDigest == boundSource && boundContent == c.SourceDigest) {
			s.ServerState = "in_sync"
		} else {
			s.ServerState = "different"
		}
	} else if len(s.ServerCandidates) > 0 {
		s.ServerState = "name_conflict"
		for _, c := range s.ServerCandidates {
			if c.SourceDigest == "" || s.SourceDigest == "" {
				s.ServerState = "unknown"
			}
			if c.SourceDigest != "" && c.SourceDigest == s.SourceDigest {
				s.ServerState = "reusable"
				break
			}
		}
	}
}
