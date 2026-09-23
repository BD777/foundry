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
