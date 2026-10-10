#!/usr/bin/env python3
"""The tab icons that show the open chat's state in a narrow browser tab.

src/lib/document-title.ts swaps the page icon to foundry-icon-<state>.png
while the open chat runs, has an unseen answer, or still works in the
background; idle restores foundry-icon.png. Each is that icon with a status
dot at the bottom-right in a white ring. Regenerate after changing the icon
or a colour (Pillow 12):

    python3 apps/web/scripts/generate-tab-status-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

public = Path(__file__).resolve().parents[1] / "public"
size = 64

# Told apart by lightness as well as hue, so they stay distinct with
# red-green colour blindness: a light amber, a dark green, a saturated blue.
dots = {
    "running": "#f59e0b",  # amber 500
    "unread": "#15803d",  # green 700
    "background": "#2563eb",  # blue 600
}

# Fractions of the icon's width. Drawn on the 256 px source and reduced to
# `size`, which smooths the edges.
dot_radius = 44 / 256
ring_width = 12 / 256
margin = 4 / 256


def badged(source: Image.Image, colour: str) -> Image.Image:
    image = source.copy()
    width = image.width
    outer = (dot_radius + ring_width) * width
    centre = width - margin * width - outer
    draw = ImageDraw.Draw(image)
    for radius, fill in ((outer, "white"), (dot_radius * width, colour)):
        draw.ellipse(
            (centre - radius, centre - radius, centre + radius, centre + radius),
            fill=fill,
        )
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    with Image.open(public / "foundry-icon.png") as source:
        source.load()
        for state, colour in dots.items():
            target = public / f"foundry-icon-{state}.png"
            badged(source, colour).save(target, optimize=True)
            print(f"wrote {target.relative_to(public.parent)}")


if __name__ == "__main__":
    main()
