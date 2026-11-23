package workspacedigest

import (
	"context"
	"math"
	"path"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

const (
	// TermBytesPerCall bounds how much text one Service (one call: a
	// read's Sync, an observer's Refresh) counts, newest sources first, so
	// a first count of the person's projects spreads over several calls
	// instead of holding up one read.
	TermBytesPerCall = 2 << 20
	// mentionMinCount: a term counted fewer times in a workspace is not
	// ranked for its project file.
	mentionMinCount = 2
	// ProjectMentions is how many terms a project file names.
	ProjectMentions = 10
)

// termSource is one source of a workspace's terms and how to read it.
type termSource struct {
	record store.WorkspaceTermSource
	active bool
	texts  func(ctx context.Context) ([]string, error)
}

// indexTerms brings the workspace's terms up to date with src: it counts
// the sources that changed (a running one once, then again after it
// ended) and forgets those that are gone.
func (s *Service) indexTerms(ctx context.Context, src Source) error {
	workspaceID := src.Workspace.ID
	stored, err := s.store.WorkspaceTermSources(ctx, workspaceID)
	if err != nil {
		return err
	}
	revs := map[string]string{}
	for _, source := range stored {
		revs[source.SourceID] = source.Rev
	}
	wanted := s.termSources(src)
	keep := make([]string, 0, len(wanted))
	changed := []termSource{}
	for _, source := range wanted {
		keep = append(keep, source.record.SourceID)
		rev, counted := revs[source.record.SourceID]
		if rev == source.record.Rev || (counted && source.active) {
			continue
		}
		changed = append(changed, source)
	}
	sort.SliceStable(changed, func(i, j int) bool { return changed[i].record.At > changed[j].record.At })
	for _, source := range changed {
		if s.termBytes >= TermBytesPerCall {
			break
		}
		texts, err := source.texts(ctx)
		if err != nil {
			return err
		}
		for _, text := range texts {
			s.termBytes += min(len(text), maxTermTextBytes)
		}
		if err := s.store.SaveWorkspaceTermSource(ctx, source.record, CountTerms(texts)); err != nil {
			return err
		}
	}
	return s.store.DeleteWorkspaceTermSources(ctx, workspaceID, keep)
}

// termSources are src's chats, sessions (not Foundry's own), file names,
// skills and connectors.
func (s *Service) termSources(src Source) []termSource {
	workspaceID := src.Workspace.ID
	sources := []termSource{}
	seen := map[string]bool{}
	for _, session := range src.Sessions {
		if store.IsUtilitySessionSource(session.Source) || seen[session.ID] {
			continue
		}
		seen[session.ID] = true
		at := formatTimeOrEmpty(sessionActivity(session))
		id, title, prompt := session.ID, session.Title, session.Prompt
		sources = append(sources, termSource{
			record: store.WorkspaceTermSource{WorkspaceID: workspaceID, SourceID: id, Kind: store.WorkspaceTermSession,
				Rev: at + "|" + session.Status, Title: textcut.Excerpt(cleanRequest(sessionTitle(session)), maxTitleRunes), At: at},
			active: store.IsActiveSessionStatus(session.Status),
			texts: func(ctx context.Context) ([]string, error) {
				texts, err := s.store.ChatTermTexts(ctx, "", id)
				return append([]string{title, prompt}, texts...), err
			},
		})
	}
	for _, chat := range src.Chats {
		if seen[chat.ID] || (chat.NativeSessionID != "" && seen[chat.NativeSessionID]) {
			continue
		}
		seen[chat.ID] = true
		id := chat.ID
		at := chat.UpdatedAt
		if parsed, ok := parseTime(at); ok {
			at = formatTime(parsed)
		}
		sources = append(sources, termSource{
			record: store.WorkspaceTermSource{WorkspaceID: workspaceID, SourceID: id, Kind: store.WorkspaceTermChat,
				Rev: at + "|" + chat.Status, Title: textcut.Excerpt(cleanRequest(firstNonBlank(chat.Title, chat.Preview)), maxTitleRunes), At: at},
			active: store.IsActiveSessionStatus(chat.Status),
			texts:  func(ctx context.Context) ([]string, error) { return s.store.ChatTermTexts(ctx, id, "") },
		})
	}
	listed := func(id, kind string, values []string) {
		values = append([]string(nil), values...)
		sort.Strings(values)
		sources = append(sources, termSource{
			record: store.WorkspaceTermSource{WorkspaceID: workspaceID, SourceID: id, Kind: kind, Rev: rev(values)},
			texts:  func(context.Context) ([]string, error) { return values, nil },
		})
	}
	paths := make([]string, 0, len(src.Files))
	for _, file := range src.Files {
		paths = append(paths, file.Path)
	}
	listed(store.WorkspaceTermFiles, store.WorkspaceTermFiles, paths)
	listed(store.WorkspaceTermSkills, store.WorkspaceTermSkills, src.Skills)
	listed(store.WorkspaceTermConnectors, store.WorkspaceTermConnectors, src.Connectors)
	return sources
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// Mention is one term a project file names, with its count there.
type Mention struct {
	Term  string
	Count int
}

// Mentions are, per workspace, the terms that set it apart from the
// person's other workspaces: counted often there, in several sources, and
// in few of the others (tf-idf, the rarity squared), at most
// ProjectMentions each.
func (s *Service) Mentions(ctx context.Context, workspaceIDs []string) (map[string][]Mention, error) {
	totals, err := s.store.WorkspaceTermTotals(ctx, workspaceIDs, mentionMinCount)
	if err != nil {
		return nil, err
	}
	return rankMentions(totals, len(workspaceIDs)), nil
}

func rankMentions(totals []store.WorkspaceTermTotal, workspaces int) map[string][]Mention {
	spread := map[string]int{}
	for _, total := range totals {
		spread[total.Term]++
	}
	type scored struct {
		total store.WorkspaceTermTotal
		score float64
	}
	byWorkspace := map[string][]scored{}
	for _, total := range totals {
		in := spread[total.Term]
		// A name many of the person's projects mention says little of one
		// of them: more than half of a few, a quarter of many.
		if (workspaces >= 4 && in*2 > workspaces) || (workspaces >= 8 && in*4 > workspaces) {
			continue
		}
		idf := math.Log(float64(workspaces+1) / float64(in))
		score := math.Log(1+float64(total.Count)) * math.Log(1+float64(total.Sources)) * idf * idf
		byWorkspace[total.WorkspaceID] = append(byWorkspace[total.WorkspaceID], scored{total, score})
	}
	mentions := map[string][]Mention{}
	for workspaceID, terms := range byWorkspace {
		sort.Slice(terms, func(i, j int) bool {
			if terms[i].score != terms[j].score {
				return terms[i].score > terms[j].score
			}
			return terms[i].total.Term < terms[j].total.Term
		})
		if len(terms) > ProjectMentions {
			terms = terms[:ProjectMentions]
		}
		for _, term := range terms {
			mentions[workspaceID] = append(mentions[workspaceID], Mention{Term: term.total.Term, Count: term.total.Count})
		}
	}
	return mentions
}

// Find limits.
const (
	FindDefaultLimit   = 5
	FindMaxLimit       = 10
	findExamples       = 3
	findMatchedTerms   = 5
	findMaxSkills      = 10
	findHitsPerTerm    = 5000
	findMaxQueryTerms  = 6
	homeSkillRootStart = "~"
)

// FindResult is find_in_projects' answer.
type FindResult struct {
	Query string `json:"query"`
	// Terms are what the query was looked up as.
	Terms    []string     `json:"terms"`
	Projects []ProjectHit `json:"projects"`
	// Total is how many projects match; NextOffset the next page's offset,
	// when there is one.
	Total      int        `json:"total"`
	NextOffset *int       `json:"nextOffset,omitempty"`
	Skills     []SkillHit `json:"skills,omitempty"`
	Note       string     `json:"note,omitempty"`
}

// ProjectHit is one project whose chats, sessions or files mention every
// term of a query.
type ProjectHit struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Device      string `json:"device"`
	// Mentions counts the terms' mentions; Sources the chats, sessions and
	// file lists that mention them all.
	Mentions int    `json:"mentions"`
	Sources  int    `json:"sources"`
	LastAt   string `json:"lastAt,omitempty"`
	// Matched are the stored terms that matched, most mentioned first.
	Matched  []string      `json:"matched"`
	Examples []TermExample `json:"examples"`
}

// TermExample points at one source mentioning the terms: a chat or
// session read_context reads, or the project's file names, skills or
// connectors.
type TermExample struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Title    string `json:"title,omitempty"`
	At       string `json:"at,omitempty"`
	Mentions int    `json:"mentions"`
}

// SkillHit is a skill installed on one of the person's computers whose
// name matches the query: for some of its projects, or for every one.
type SkillHit struct {
	Skill    string       `json:"skill"`
	Device   string       `json:"device"`
	DeviceID string       `json:"deviceId"`
	Scope    string       `json:"scope"`
	Projects []ProjectRef `json:"projects,omitempty"`
}

// ProjectRef names a project.
type ProjectRef struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
}

// The scopes of SkillHit.
const (
	SkillScopeComputer = "every project on the computer"
	SkillScopeProjects = "these projects"
)

// Find lists the projects among projects whose chats, sessions, file
// names, skills or connectors mention every term of query (a term matches
// stored ones it starts), most mentions first, a page of limit from
// offset; and the skills on their computers whose names hold every term.
func (s *Service) Find(ctx context.Context, projects []store.WorkspaceDigest, query string, offset, limit int) (FindResult, error) {
	result := FindResult{Query: query, Terms: QueryTerms(query), Projects: []ProjectHit{}}
	if len(result.Terms) > findMaxQueryTerms {
		result.Terms = result.Terms[:findMaxQueryTerms]
	}
	if len(result.Terms) == 0 {
		result.Note = "The query holds no name to look up: terms are names in Latin letters and digits (hosts, services, code names, files, skills); Chinese words and common words are not indexed."
		return result, nil
	}
	byID := map[string]store.WorkspaceDigest{}
	ids := make([]string, 0, len(projects))
	for _, project := range projects {
		byID[project.WorkspaceID] = project
		ids = append(ids, project.WorkspaceID)
	}
	type sourceKey struct{ workspace, source string }
	type sourceHits struct {
		source   store.WorkspaceTermSource
		matched  map[int]bool
		terms    map[string]int
		mentions int
	}
	sources := map[sourceKey]*sourceHits{}
	for index, term := range result.Terms {
		hits, err := s.store.FindWorkspaceTerms(ctx, ids, term, findHitsPerTerm)
		if err != nil {
			return result, err
		}
		for _, hit := range hits {
			key := sourceKey{hit.Source.WorkspaceID, hit.Source.SourceID}
			entry := sources[key]
			if entry == nil {
				entry = &sourceHits{source: hit.Source, matched: map[int]bool{}, terms: map[string]int{}}
				sources[key] = entry
			}
			entry.matched[index] = true
			entry.terms[hit.Term] += hit.Count
			entry.mentions += hit.Count
		}
	}
	type projectHits struct {
		hit     ProjectHit
		terms   map[string]int
		sources []*sourceHits
	}
	byProject := map[string]*projectHits{}
	for key, entry := range sources {
		if len(entry.matched) < len(result.Terms) {
			continue
		}
		project := byProject[key.workspace]
		if project == nil {
			digest := byID[key.workspace]
			project = &projectHits{hit: ProjectHit{WorkspaceID: key.workspace, Name: digest.Name, Device: firstNonBlank(digest.DeviceLabel, digest.DeviceID)}, terms: map[string]int{}}
			byProject[key.workspace] = project
		}
		project.hit.Mentions += entry.mentions
		project.hit.Sources++
		if entry.source.At > project.hit.LastAt {
			project.hit.LastAt = entry.source.At
		}
		for term, count := range entry.terms {
			project.terms[term] += count
		}
		project.sources = append(project.sources, entry)
	}
	hits := make([]ProjectHit, 0, len(byProject))
	for _, project := range byProject {
		project.hit.Matched = topTerms(project.terms, findMatchedTerms)
		sort.Slice(project.sources, func(i, j int) bool {
			a, b := project.sources[i], project.sources[j]
			if a.mentions != b.mentions {
				return a.mentions > b.mentions
			}
			if a.source.At != b.source.At {
				return a.source.At > b.source.At
			}
			return a.source.SourceID < b.source.SourceID
		})
		project.hit.Examples = []TermExample{}
		for _, entry := range project.sources[:min(len(project.sources), findExamples)] {
			project.hit.Examples = append(project.hit.Examples, TermExample{ID: entry.source.SourceID, Kind: entry.source.Kind,
				Title: entry.source.Title, At: entry.source.At, Mentions: entry.mentions})
		}
		hits = append(hits, project.hit)
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Mentions != hits[j].Mentions {
			return hits[i].Mentions > hits[j].Mentions
		}
		if hits[i].LastAt != hits[j].LastAt {
			return hits[i].LastAt > hits[j].LastAt
		}
		return hits[i].WorkspaceID < hits[j].WorkspaceID
	})
	if limit <= 0 {
		limit = FindDefaultLimit
	}
	limit = min(limit, FindMaxLimit)
	offset = max(offset, 0)
	result.Total = len(hits)
	if offset < len(hits) {
		end := min(offset+limit, len(hits))
		result.Projects = hits[offset:end]
		if end < len(hits) {
			result.NextOffset = &end
		}
	}
	if offset == 0 {
		skills, err := s.findSkills(ctx, projects, result.Terms)
		if err != nil {
			return result, err
		}
		result.Skills = skills
	}
	return result, nil
}

func topTerms(counts map[string]int, n int) []string {
	terms := make([]string, 0, len(counts))
	for term := range counts {
		terms = append(terms, term)
	}
	sort.Slice(terms, func(i, j int) bool {
		if counts[terms[i]] != counts[terms[j]] {
			return counts[terms[i]] > counts[terms[j]]
		}
		return terms[i] < terms[j]
	})
	return terms[:min(len(terms), n)]
}

// findSkills lists the skills on the projects' computers whose name or
// folder holds every term: those in the person's home (~/.claude/skills
// and the like) are there for every project on that computer; those in a
// folder, for the projects in it, above it or below it.
func (s *Service) findSkills(ctx context.Context, projects []store.WorkspaceDigest, terms []string) ([]SkillHit, error) {
	onDevice := map[string][]store.WorkspaceDigest{}
	devices := []string{}
	for _, project := range projects {
		if project.DeviceID == "" {
			continue
		}
		if _, ok := onDevice[project.DeviceID]; !ok {
			devices = append(devices, project.DeviceID)
		}
		onDevice[project.DeviceID] = append(onDevice[project.DeviceID], project)
	}
	sort.Strings(devices)
	paths, err := s.projectPaths(ctx, projects)
	if err != nil {
		return nil, err
	}
	hits := []SkillHit{}
	seen := map[string]bool{}
	for _, deviceID := range devices {
		skills, err := s.store.ListDeviceSkills(ctx, deviceID)
		if err != nil {
			return nil, err
		}
		for _, skill := range skills {
			if len(hits) == findMaxSkills {
				return hits, nil
			}
			name := firstNonBlank(skill.Name, skill.DirName)
			if !holdsAll(strings.ToLower(name+" "+skill.DirName), terms) {
				continue
			}
			hit := SkillHit{Skill: name, Device: firstNonBlank(onDevice[deviceID][0].DeviceLabel, deviceID), DeviceID: deviceID}
			if strings.HasPrefix(skill.Root, homeSkillRootStart) {
				hit.Scope = SkillScopeComputer
			} else {
				base := skillFolder(skill.Root)
				for _, project := range onDevice[deviceID] {
					if within(paths[project.WorkspaceID], base) || within(base, paths[project.WorkspaceID]) {
						hit.Projects = append(hit.Projects, ProjectRef{WorkspaceID: project.WorkspaceID, Name: project.Name})
					}
				}
				if len(hit.Projects) == 0 {
					continue
				}
				hit.Scope = SkillScopeProjects
			}
			key := deviceID + "\x00" + hit.Skill + "\x00" + hit.Scope
			for _, project := range hit.Projects {
				key += "\x00" + project.WorkspaceID
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			hits = append(hits, hit)
		}
	}
	return hits, nil
}

// projectPaths are the projects' folders on their devices.
func (s *Service) projectPaths(ctx context.Context, projects []store.WorkspaceDigest) (map[string]string, error) {
	paths := map[string]string{}
	for _, project := range projects {
		workspace, err := s.store.GetWorkspace(ctx, project.WorkspaceID)
		if err != nil {
			return nil, err
		}
		paths[project.WorkspaceID] = strings.TrimRight(workspace.LocalPath, "/")
	}
	return paths, nil
}

func holdsAll(text string, terms []string) bool {
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}

// skillFolder is the folder a skills root serves: /p for /p/.agents/skills.
func skillFolder(root string) string {
	root = strings.TrimRight(root, "/")
	parent := path.Dir(root)
	if strings.HasPrefix(path.Base(parent), ".") {
		return path.Dir(parent)
	}
	return parent
}

// within: folder is dir or inside it.
func within(folder, dir string) bool {
	return folder != "" && dir != "" && (folder == dir || strings.HasPrefix(folder, dir+"/"))
}
