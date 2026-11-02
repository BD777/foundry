package store

import (
	"slices"
	"strings"
)

// A device's paths follow its own rules, not the server's: a Windows
// device's absolute paths use backslashes.

// DevicePathSeparators are the separators a device's path may use.
const DevicePathSeparators = `/\`

// DevicePathSeparator is the separator a device's absolute path uses.
func DevicePathSeparator(root string) string {
	if !strings.Contains(root, "/") && strings.Contains(root, `\`) {
		return `\`
	}
	return "/"
}

// JoinDevicePath appends elements to a device path with its separator.
func JoinDevicePath(root string, elements ...string) string {
	separator := DevicePathSeparator(root)
	return strings.TrimRight(root, DevicePathSeparators) + separator + strings.Join(elements, separator)
}

// InsideDeviceRoot reports whether path names a folder strictly inside
// root, without any "." or ".." step.
func InsideDeviceRoot(root string, path string) bool {
	prefix := strings.TrimRight(root, DevicePathSeparators) + DevicePathSeparator(root)
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok {
		return false
	}
	steps := strings.FieldsFunc(rest, func(r rune) bool { return strings.ContainsRune(DevicePathSeparators, r) })
	return len(steps) > 0 && !slices.Contains(steps, ".") && !slices.Contains(steps, "..")
}

// LastDevicePathElement is the last element of a device path.
func LastDevicePathElement(path string) string {
	path = strings.TrimRight(path, DevicePathSeparators)
	if index := strings.LastIndexAny(path, DevicePathSeparators); index >= 0 {
		return path[index+1:]
	}
	return path
}

// RelativeFolderPath reports whether path names a file inside a folder:
// relative, "/"-separated, without "." or ".." steps or NUL. The device
// checks the resolved path again.
func RelativeFolderPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	for _, step := range strings.Split(path, "/") {
		if step == "" || step == "." || step == ".." {
			return false
		}
	}
	return true
}
