#!/usr/bin/env python3
"""The tab icons that show the open chat's state in a narrow browser tab.

src/lib/document-title.ts swaps the page icon to foundry-icon-<state>.png
while the open chat runs, has an unseen answer, or still works in the
background, or while the assistant has an unseen answer on a page that is not
a chat; idle restores foundry-icon.png. Each is that icon with a status dot at
the bottom-right in a white ring; the assistant's is a speech bubble in the
same place. Regenerate after changing the icon or a colour (Pillow 12):

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
# The assistant's speech bubble. Blue like the background dot, but never in
# the same tab: the assistant's mark shows only off a chat page, where a
# chat's background work cannot show.
bubble_colour = "#2563eb"  # blue 600

# Fractions of the icon's width. Drawn on the 256 px source and reduced to
# `size`, which smooths the edges.
dot_radius = 44 / 256
ring_width = 12 / 256
margin = 4 / 256
# Bubble body (left, top, right, bottom), corner radius and tail tip, bottom-right.
bubble_box = (148 / 256, 136 / 256, 248 / 256, 214 / 256)
bubble_corner = 26 / 256
bubble_tail = (
    (162 / 256, 206 / 256),
    (162 / 256, 238 / 256),
    (190 / 256, 206 / 256),
)


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


def bubbled(source: Image.Image, colour: str) -> Image.Image:
    image = source.copy()
    width = image.width
    ring = ring_width * width
    left, top, right, bottom = (v * width for v in bubble_box)
    corner = bubble_corner * width
    tail = [(x * width, y * width) for x, y in bubble_tail]
    draw = ImageDraw.Draw(image)
    # The white ring: the body and tail grown by the ring width.
    draw.rounded_rectangle(
        (left - ring, top - ring, right + ring, bottom + ring),
        radius=corner + ring,
        fill="white",
    )
    draw.polygon(tail, fill="white")
    draw.line(tail + [tail[0]], fill="white", width=round(2 * ring), joint="curve")
    draw.rounded_rectangle((left, top, right, bottom), radius=corner, fill=colour)
    draw.polygon(tail, fill=colour)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    with Image.open(public / "foundry-icon.png") as source:
        source.load()
        renders = {state: badged(source, colour) for state, colour in dots.items()}
        renders["assistant"] = bubbled(source, bubble_colour)
        for state, image in renders.items():
            target = public / f"foundry-icon-{state}.png"
            image.save(target, optimize=True)
            print(f"wrote {target.relative_to(public.parent)}")


if __name__ == "__main__":
    main()
