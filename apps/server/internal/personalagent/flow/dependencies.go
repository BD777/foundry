package flow

import "fmt"

// CheckItemDependencies checks the component affected by one edit. Unrelated
// historical items must not exhaust the bounded dependency budget.
func CheckItemDependencies(id string, graph map[string][]string) error {
	component := map[string][]string{}
	queue := []string{id}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if _, seen := component[current]; seen {
			continue
		}
		dependencies, found := graph[current]
		if !found {
			return fmt.Errorf("dependency %q is not on this person's list", current)
		}
		component[current] = dependencies
		if len(component) > 256 {
			return fmt.Errorf("a dependency component may contain at most 256 items")
		}
		queue = append(queue, dependencies...)
	}
	return CheckDependencies(component)
}

// CheckDependencies validates a bounded graph of items in one person's list.
// An edge points from an item to something that must finish before it starts.
// Missing dependencies are rejected rather than silently counted as completed.
func CheckDependencies(graph map[string][]string) error {
	if len(graph) > 256 {
		return fmt.Errorf("a dependency graph may contain at most 256 items")
	}
	state := make(map[string]byte, len(graph))
	var visit func(string) error
	visit = func(id string) error {
		switch state[id] {
		case 1:
			return fmt.Errorf("dependency cycle at %s", id)
		case 2:
			return nil
		}
		deps, found := graph[id]
		if !found || id == "" {
			return fmt.Errorf("dependency %q is not on this person's list", id)
		}
		if len(deps) > 32 {
			return fmt.Errorf("an item may have at most 32 dependencies")
		}
		state[id] = 1
		seen := make(map[string]bool, len(deps))
		for _, dependency := range deps {
			if seen[dependency] {
				return fmt.Errorf("duplicate dependency %s", dependency)
			}
			seen[dependency] = true
			if err := visit(dependency); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for id := range graph {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}
