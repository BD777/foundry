package httpapi

import "testing"

func TestFileDownloadImageContentTypeRequiresExtensionAndBytesToAgree(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		path string
		data []byte
		want string
	}{
		{name: "png", path: "snapshot.png", data: []byte("\x89PNG\r\n\x1a\nrest"), want: "image/png"},
		{name: "jpeg", path: "photo.jpeg", data: []byte("\xff\xd8\xff\xe0rest"), want: "image/jpeg"},
		{name: "jpg", path: "photo.JPG", data: []byte("\xff\xd8\xffrest"), want: "image/jpeg"},
		{name: "gif", path: "loop.gif", data: []byte("GIF89arest"), want: "image/gif"},
		{name: "webp", path: "photo.webp", data: []byte("RIFF\x10\x00\x00\x00WEBPrest"), want: "image/webp"},
		{name: "avif", path: "photo.avif", data: []byte("\x00\x00\x00\x1cftypavifrest"), want: "image/avif"},
		{name: "bmp", path: "photo.bmp", data: []byte("BMrest"), want: "image/bmp"},
		{name: "ico", path: "favicon.ico", data: []byte{0, 0, 1, 0, 1, 0}, want: "image/x-icon"},
		{name: "svg", path: "diagram.svg", data: []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`), want: "image/svg+xml"},
		{name: "wrong bytes", path: "snapshot.png", data: []byte("\xff\xd8\xff\xe0rest"), want: ""},
		{name: "wrong extension", path: "snapshot.dat", data: []byte("\x89PNG\r\n\x1a\nrest"), want: ""},
		{name: "xml is not svg", path: "diagram.svg", data: []byte(`<?xml version="1.0"?><html></html>`), want: ""},
		{name: "html in svg name", path: "diagram.svg", data: []byte(`<svg><script>alert(1)</script></svg>`), want: "image/svg+xml"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := downloadImageContentType(test.path, test.data); got != test.want {
				t.Fatalf("downloadImageContentType(%q, %q) = %q, want %q", test.path, test.data, got, test.want)
			}
		})
	}
}
