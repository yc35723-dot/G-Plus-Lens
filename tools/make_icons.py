from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

BLUE = (26, 115, 232, 255)
WHITE = (255, 255, 255, 255)


def draw(size: int) -> Image.Image:
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    m = s * 0.10
    d.rounded_rectangle([m, m, s - m, s - m], radius=s * 0.22, fill=BLUE)

    pad = s * 0.26
    d.rectangle([pad, pad, s - pad, s - pad], outline=WHITE, width=max(2, int(s * 0.055)))

    r = s * 0.145
    cx, cy = s * 0.5, s * 0.5
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BLUE, outline=WHITE, width=max(2, int(s * 0.05)))

    handle_w = max(2, int(s * 0.055))
    d.line([cx + r * 0.72, cy + r * 0.72, cx + r * 1.95, cy + r * 1.95], fill=WHITE, width=handle_w)

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(os.path.join(OUT, f"icon{size}.png"))
    print("wrote", f"icon{size}.png")
