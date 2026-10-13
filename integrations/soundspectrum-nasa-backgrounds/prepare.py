"""Offline-only bounded NASA raster preparation. Never called by WhiteCap."""
import sys, json, hashlib, warnings
from pathlib import Path
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 80_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
src, dst, fit = sys.argv[1:4]
with Image.open(src) as opened:
    if opened.format not in ('JPEG', 'PNG'):
        raise ValueError('Only JPEG/PNG photographs are accepted')
    if opened.width < 3840 or opened.height < 2160:
        raise ValueError('Source is below the minimum 3840 x 2160 dimensions')
    original = [opened.width, opened.height]
    image = ImageOps.exif_transpose(opened).convert('RGB')
    if fit == 'cover':
        image = ImageOps.fit(image, (3840, 2160), Image.Resampling.LANCZOS)
    elif fit == 'contain':
        image.thumbnail((3840, 2160), Image.Resampling.LANCZOS)
        frame = Image.new('RGB', (3840, 2160), 'black')
        frame.paste(image, ((3840-image.width)//2, (2160-image.height)//2))
        image = frame
    else:
        raise ValueError('Unknown fit')
    # Stable perceptual signature also catches duplicate releases/encodings.
    small = image.resize((17, 16)).convert('L')
    pixels = list(small.getdata())
    bits = ''.join('1' if pixels[y*17+x] > pixels[y*17+x+1] else '0'
                   for y in range(16) for x in range(16))
    image.save(dst, 'JPEG', quality=94, subsampling=0, optimize=True)
    print(json.dumps({'sourceDimensions': original, 'width':3840, 'height':2160,
                      'perceptualHash': '%064x' % int(bits, 2)}))
