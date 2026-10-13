# Native WhiteCap background. inAudio is supplied by WhiteCap's existing input.
import math
import time as walltime
import SoundSpectrum as SS

def pose(t, level):
    """Slow bounded drift in x/y/z with a small bass-driven approach/pulse."""
    depth = 0.5 + 0.5 * math.sin(t * 0.19)
    scale = (0.24 + 0.42 * depth) * (1.0 + 0.09 * level)
    x = 0.63 * math.sin(t * 0.13) + 0.11 * math.sin(t * 0.31)
    y = 0.53 * math.sin(t * 0.17 + 0.8)
    angle = 0.06 * math.sin(t * 0.11)
    return x, y, scale, depth, angle

class FloatingArtwork(object):
    def __init__(self):
        self.quad = VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, 4)
        self.texture = None
        self.token = None
        self.level = 0.0
        self.age = 0.0
        self.frames = 0

    def Draw(self, time, dt, inAudio):
        try:
            self.draw(time, dt, inAudio)
        except Exception as error:
            state = getattr(SS.GetEngineInstance(), '_rh_whitecap_artwork_v1', None)
            if state:
                state['reader'].phase('draw:' + type(error).__name__)

    def draw(self, time, dt, inAudio):
        state = getattr(SS.GetEngineInstance(), '_rh_whitecap_artwork_v1', None)
        value = state.get('snapshot') if state else None
        now = walltime.time() * 1000
        art = value['track']['artwork'] if value and -2000 <= now - value['updatedAt'] <= 8000 else None
        token = (value['session'], value['track']['key'], art['file']) if art else None
        if token != self.token:
            self.token = token
            self.texture = None
            self.age = 0.0
            if art:
                # The image loader requires a file:///C:/... URL (unlike G-Force sprites).
                p = state['path'].replace('\\', '/').rsplit('/', 1)[0] + '/' + art['file']
                self.texture = CreateTextureFromImage(('file:///' + p).encode('utf-8'))
        if not art or self.texture is None:
            if state:
                state['reader'].report(False, self.frames, 0, 0)
            return
        dimensions = GetTextureSize(self.texture)
        if not dimensions or dimensions[0] <= 1 or dimensions[1] <= 1:
            state['reader'].phase('texture-loading')
            return
        step = max(0.0, min(float(dt), 0.1))
        # Mean bass energy with attack/release smoothing; no beat flashes.
        bands = [max(0.0, min(2.0, float(v))) for v in inAudio[:12]]
        energy = min(1.0, (sum(bands) / max(1, len(bands))) * 1.6)
        rate = 9.0 if energy > self.level else 2.5
        self.level += (energy - self.level) * (1.0 - math.exp(-step * rate))
        self.age += step
        x, y, scale, depth, angle = pose(time, self.level)
        Set2DCamera(ss_Crop)
        ext = GetViewExtents()
        aspect = float(dimensions[0]) / dimensions[1]
        hy = min(ext[1] * scale, ext[0] * scale / aspect)
        hx = hy * aspect
        # Keep the square inside the viewport throughout its floating orbit.
        radius = math.sqrt(hx * hx + hy * hy)
        cx = x * max(0.0, ext[0] - radius)
        cy = y * max(0.0, ext[1] - radius)
        c, s = math.cos(angle), math.sin(angle)
        for i, (dx, dy, u, v) in enumerate([(-hx, -hy, 0, 1), (hx, -hy, 1, 1), (-hx, hy, 0, 0), (hx, hy, 1, 0)]):
            vertex = self.quad[i]
            vertex[0], vertex[1], vertex[2], vertex[3] = cx + dx*c - dy*s, cy + dx*s + dy*c, u, v
        alpha = min(1.0, self.age / 1.1) * (0.48 + 0.17 * depth + 0.06 * self.level)
        self.quad.SetTexture(self.texture, RGBA(1, 1, 1, alpha))
        self.quad.DrawTriangles(0, 1)
        self.frames += 1
        state['reader'].report(True, self.frames, self.level, depth)

SetDrawClass(FloatingArtwork)
