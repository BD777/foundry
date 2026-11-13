package httpapi

import (
	"bytes"
	"encoding/xml"
	"io"
	"path/filepath"
	"strings"
)

var downloadImageTypes = map[string]string{
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".gif":  "image/gif",
	".ico":  "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".svg":  "image/svg+xml",
	".webp": "image/webp",
}

// downloadImageContentType returns an image type only when both the extension
// and the bytes agree. The browser can then render a response safely without
// trusting a filename or a user-supplied media type.
func downloadImageContentType(path string, prefix []byte) string {
	want := downloadImageTypes[strings.ToLower(filepath.Ext(path))]
	if want == "" {
		return ""
	}
	if want == "image/svg+xml" {
		if isSVGDocument(prefix) {
			return want
		}
		return ""
	}
	if sniffDownloadImageType(prefix) == want {
		return want
	}
	return ""
}

func sniffDownloadImageType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(data, []byte("GIF87a")), bytes.HasPrefix(data, []byte("GIF89a")):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	case isAVIF(data):
		return "image/avif"
	case bytes.HasPrefix(data, []byte("BM")):
		return "image/bmp"
	case len(data) >= 4 && bytes.Equal(data[:4], []byte{0, 0, 1, 0}):
		return "image/x-icon"
	default:
		return ""
	}
}

func isAVIF(data []byte) bool {
	if len(data) < 12 || !bytes.Equal(data[4:8], []byte("ftyp")) {
		return false
	}
	for offset := 8; offset+4 <= len(data) && offset < 64; offset += 4 {
		brand := data[offset : offset+4]
		if bytes.Equal(brand, []byte("avif")) || bytes.Equal(brand, []byte("avis")) {
			return true
		}
	}
	return false
}

func isSVGDocument(data []byte) bool {
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return false
			}
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			return strings.EqualFold(start.Name.Local, "svg")
		}
	}
}
