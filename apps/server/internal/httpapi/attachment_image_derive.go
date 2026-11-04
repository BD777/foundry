package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// imageVariantBudget is the byte limit of an image derivative, whether the
// device or the server made it.
func imageVariantBudget(variant string) int {
	if variant == "placeholder" {
		return 2048
	}
	return 40 * 1024
}

// Larger images are not decoded here: their pixels alone would take
// hundreds of megabytes.
const maxDerivedImagePixels = 40_000_000

var errImageNotDerivable = errors.New("the image cannot be reduced")

// One derivation at a time: a full-size decode takes up to a few hundred MB
// and a core, and the server is shared.
var deriveSlot = make(chan struct{}, 1)

// deriveAttachmentImage reduces an image a device sent whole, because it has
// no image tool, to a JPEG within the variant's budget: the largest side that
// fits, upright as its EXIF orientation says, transparency on white. The
// full-size image is scaled once; smaller attempts scale that copy.
func deriveAttachmentImage(ctx context.Context, data []byte, variant string) ([]byte, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width*config.Height > maxDerivedImagePixels {
		return nil, errImageNotDerivable
	}
	select {
	case deriveSlot <- struct{}{}:
		defer func() { <-deriveSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errImageNotDerivable
	}
	budget, quality, side := imageVariantBudget(variant), 70, 1000
	if variant == "placeholder" {
		quality, side = 40, 96
	}
	scaled := scaleOnto(source, min(side, max(config.Width, config.Height)))
	scaled = orient(scaled, jpegOrientation(data))
	for attempt := 0; attempt < 6; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var out bytes.Buffer
		if err := jpeg.Encode(&out, scaled, &jpeg.Options{Quality: quality}); err != nil {
			return nil, err
		}
		if out.Len() <= budget {
			return out.Bytes(), nil
		}
		// Encoded size predicts the next scale, so a few encodes reach the budget.
		bounds := scaled.Bounds()
		next := max(16, int(float64(max(bounds.Dx(), bounds.Dy()))*math.Sqrt(float64(budget)/float64(out.Len()))*0.9))
		scaled = scaleOnto(scaled, next)
	}
	return nil, errImageNotDerivable
}

// scaleOnto draws an image, its longest side side pixels, on white.
func scaleOnto(source image.Image, side int) *image.RGBA {
	bounds := source.Bounds()
	scale := float64(side) / float64(max(bounds.Dx(), bounds.Dy()))
	width, height := max(1, int(math.Round(float64(bounds.Dx())*scale))), max(1, int(math.Round(float64(bounds.Dy())*scale)))
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(canvas, canvas.Bounds(), source, bounds, draw.Over, nil)
	return canvas
}

// jpegOrientation reads the EXIF Orientation tag (1-8) of a JPEG; 1 for
// anything else or when it is missing. Browsers apply it when they show the
// original, so a preview must too.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for at := 2; at+4 <= len(data) && data[at] == 0xFF; {
		marker, size := data[at+1], int(binary.BigEndian.Uint16(data[at+2:]))
		if marker == 0xDA || size < 2 || at+2+size > len(data) {
			return 1
		}
		segment := data[at+4 : at+2+size]
		if marker == 0xE1 && len(segment) > 14 && string(segment[:6]) == "Exif\x00\x00" {
			return exifOrientation(segment[6:])
		}
		at += 2 + size
	}
	return 1
}

func exifOrientation(tiff []byte) int {
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	directory := int(order.Uint32(tiff[4:8]))
	if directory+2 > len(tiff) {
		return 1
	}
	entries := int(order.Uint16(tiff[directory:]))
	for i := 0; i < entries; i++ {
		entry := directory + 2 + i*12
		if entry+12 > len(tiff) {
			return 1
		}
		if order.Uint16(tiff[entry:]) == 0x0112 {
			if value := int(order.Uint16(tiff[entry+8:])); value >= 1 && value <= 8 {
				return value
			}
			return 1
		}
	}
	return 1
}

// orient turns an image upright for its EXIF orientation (2-8 mirror and
// rotate; 1 and anything else leave it as it is).
func orient(src *image.RGBA, orientation int) *image.RGBA {
	if orientation < 2 || orientation > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch orientation {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.SetRGBA(dx, dy, src.RGBAAt(x, y))
		}
	}
	return dst
}
