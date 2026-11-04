package httpapi

import (
	"bytes"
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

// deriveAttachmentImage reduces an image a device sent whole, because it has
// no image tool, to a JPEG within the variant's budget: the largest side that
// fits, transparency on white.
func deriveAttachmentImage(data []byte, variant string) ([]byte, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width*config.Height > maxDerivedImagePixels {
		return nil, errImageNotDerivable
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errImageNotDerivable
	}
	budget, quality, side := imageVariantBudget(variant), 70, 1000
	if variant == "placeholder" {
		quality, side = 40, 96
	}
	side = min(side, max(config.Width, config.Height))
	for attempt := 0; attempt < 6; attempt++ {
		scale := float64(side) / float64(max(config.Width, config.Height))
		width, height := max(1, int(math.Round(float64(config.Width)*scale))), max(1, int(math.Round(float64(config.Height)*scale)))
		canvas := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
		draw.CatmullRom.Scale(canvas, canvas.Bounds(), source, source.Bounds(), draw.Over, nil)
		var out bytes.Buffer
		if err := jpeg.Encode(&out, canvas, &jpeg.Options{Quality: quality}); err != nil {
			return nil, err
		}
		if out.Len() <= budget {
			return out.Bytes(), nil
		}
		// Encoded size predicts the next scale, so a few encodes reach the budget.
		side = max(16, int(float64(side)*math.Sqrt(float64(budget)/float64(out.Len()))*0.9))
	}
	return nil, errImageNotDerivable
}
