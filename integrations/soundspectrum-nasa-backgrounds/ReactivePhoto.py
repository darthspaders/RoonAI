# Native photo effects. Source-bound preparation is offline; audio is WhiteCap's FFT.
import math

class ReactiveSpaceBackground(object):
    def __init__(self, image_path=IMAGE_PATH, light_paths=tuple(LIGHT_PATHS),
                 lively=LIVELY_STARS, flare_path=FLARE_PATH, flare_stars=tuple(FLARE_STARS),
                 cloud_motion=CLOUD_MOTION, cloud_path=CLOUD_PATH):
        # Bind this entry's assets/settings before another scene reloads globals.
        self.base = CreateTextureFromImage(image_path.encode('utf-8'))
        self.lights = [CreateTextureFromImage(p.encode('utf-8')) for p in light_paths]
        self.quad = VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, 4)
        self.extents = None
        self.levels = [0.0, 0.0, 0.0, 0.0]
        # small/high, medium/mid, large/low, diffuse/low. Seconds, not frames.
        self.attack = [0.055, 0.09, 0.12, 0.45]
        self.release = [0.24, 0.38, 0.55, 1.6]
        self.gain = [0.65, 0.52, 0.40, 0.18]
        # Ordinary photos are separate. Every admitted reactive scene gets a
        # visible response, not just the original small reviewed flare pool.
        self.lively = lively
        self.flare_texture = None
        self.flares = []
        self.phase = 0.0
        if self.lively:
            if flare_path:
                self.flare_texture = CreateTextureFromImage(flare_path.encode('utf-8'))
                for star in flare_stars[:12]:
                    self.flares.append((star, VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, 4)))
        self.cloud_points = []
        self.cloud_vertices = []
        self.cloud_mesh = None
        self.cloud_texture = None
        # A small mesh moves diffuse illumination, never photograph pixels.
        # Source-bound emission is prepared from existing reviewed cloud masks.
        if cloud_motion and cloud_path:
            self.cloud_texture = CreateTextureFromImage(cloud_path.encode('utf-8'))
            cols, rows, weights = cloud_motion
            for y in range(rows):
                for x in range(cols):
                    self.cloud_points.append((float(x)/(cols-1), float(y)/(rows-1), weights[y*cols+x]))
            for y in range(rows-1):
                for x in range(cols-1):
                    a = y*cols+x
                    corners = (a,a+1,a+cols,a+1,a+cols,a+cols+1)
                    if max(weights[k] for k in corners) > 0:
                        self.cloud_vertices.extend(corners)
            if self.cloud_vertices:
                self.cloud_mesh = VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, len(self.cloud_vertices))

    def band(self, audio, lo, hi):
        count = len(audio)
        if not count:
            return 0.0
        first, last = int(count * lo), max(int(count * lo) + 1, int(count * hi))
        total = 0.0
        for i in range(first, min(count, last)):
            v = float(audio[i])
            # NaN/inf or malformed energy must never produce a bright flash.
            if not math.isnan(v) and not math.isinf(v):
                v = max(0.0, min(1.0, v))
                total += v*v
        energy = total / max(1, min(count, last) - first)
        # Fixed soft knee: quiet floors stay quiet; sparse musical peaks are
        # retained. No per-track AGC that turns background noise into a beat.
        return 1.0-math.exp(-6.0*max(0.0, math.sqrt(energy)-0.008))

    def envelope(self, dt, audio):
        step = float(dt)
        if math.isnan(step) or math.isinf(step): step = 0.0
        step = max(0.0, min(step, 0.1))
        high = self.band(audio, 0.55, 1.0)
        mid = self.band(audio, 0.18, 0.55)
        low = self.band(audio, 0.0, 0.18)
        for i, target in enumerate((high, mid, low, low)):
            tau = self.attack[i] if target > self.levels[i] else self.release[i]
            self.levels[i] += (target - self.levels[i]) * (1.0 - math.exp(-step / tau))
        # Unbounded seconds avoid a visible phase wrap during long scenes.
        self.phase += step * min(1.0, max(self.levels)*3.0)

    def draw_cloud(self, ext):
        if self.cloud_mesh is None or self.levels[3] < .001 or not GetTextureSize(self.cloud_texture): return
        u = min(1.0, (float(ext[0])/ext[1])/(16.0/9.0))
        v = min(1.0, (16.0/9.0)/(float(ext[0])/ext[1]))
        amount = self.levels[3]
        p = self.phase
        points = []
        for x,y,weight in self.cloud_points:
            # Smooth local light flow, at most 0.9% width / 1.6% height.
            # Base photograph, stars and destination geometry never move.
            dx = .009*amount*weight*math.sin(y*9.0+x*4.0+p*.75)
            dy = .016*amount*weight*math.sin(x*8.0-y*3.0-p*.57)
            points.append(((2*x-1)*ext[0]/u, (1-2*y)*ext[1]/v,
                           x+dx, y+dy))
        for i,k in enumerate(self.cloud_vertices):
            vertex = self.cloud_mesh[i]
            for c in range(4): vertex[c] = points[k][c]
        gain = .90*amount
        self.cloud_mesh.SetTexture(self.cloud_texture, RGBA(gain,gain,gain,1))
        self.cloud_mesh.DrawTriangles(0,-1,3)

    def draw_flares(self, ext):
        if not self.flare_texture or not GetTextureSize(self.flare_texture): return
        u = min(1.0, (float(ext[0])/ext[1])/(16.0/9.0))
        v = min(1.0, (16.0/9.0)/(float(ext[0])/ext[1]))
        for star, quad in self.flares:
            x, y, radius, channel, phase, red, green, blue = star
            level = self.levels[int(channel)]
            if level < .001: continue
            # Each flare expands around its own stellar core. No image motion
            # or displaced star centres. Local sparkle never blanks the photo.
            beat = self.levels[2]
            wave = math.sin(self.phase*3.1+phase)
            scale = 1.0 + .60*beat + .18*wave*level
            angle = .32*math.sin(self.phase*.85+phase)*level
            c, s = math.cos(angle), math.sin(angle)
            cx, cy = (2*x-1)*ext[0]/u, (1-2*y)*ext[1]/v
            rx, ry = radius*scale*2*ext[0]/u, radius*scale*2*(16.0/9.0)*ext[1]/v
            for i, (dx,dy,tx,ty) in enumerate(((-1,-1,0,1),(1,-1,1,1),(-1,1,0,0),(1,1,1,0))):
                vertex = quad[i]
                vertex[0], vertex[1] = cx+dx*rx*c-dy*ry*s, cy+dx*rx*s+dy*ry*c
                vertex[2], vertex[3] = tx, ty
            sparkle = .72+.28*(.5+.5*math.sin(self.phase*5.0+phase))
            gain = min(.50, .50*level*sparkle)
            quad.SetTexture(self.flare_texture, RGBA(red*gain,green*gain,blue*gain,1))
            quad.DrawTriangles(0,1)

    def Draw(self, time, dt, inAudio):
        Set2DCamera(ss_Crop)
        ext = GetViewExtents()
        # Geometry and UVs NEVER depend on time/audio. Same aspect fit for all layers.
        if self.extents != tuple(ext):
            self.extents = tuple(ext)
            u = min(1.0, (float(ext[0]) / ext[1]) / (16.0 / 9.0))
            v = min(1.0, (16.0 / 9.0) / (float(ext[0]) / ext[1]))
            for i, (x, y, tx, ty) in enumerate(((-1,-1,0,1),(1,-1,1,1),(-1,1,0,0),(1,1,1,0))):
                vertex = self.quad[i]
                vertex[0], vertex[1] = x*ext[0], y*ext[1]
                vertex[2], vertex[3] = (1-u)*0.5+tx*u, (1-v)*0.5+ty*v
        if not GetTextureSize(self.base):
            return
        SetBlendMode(ss_AlphaBlend)
        self.quad.SetTexture(self.base, RGBA(1,1,1,1))
        self.quad.DrawTriangles(0,1)
        self.envelope(dt, inAudio)
        # Offline RGB contains only a bounded emission delta; black is no change.
        # RGB gain, with alpha=1, avoids blend-mode-dependent alpha squaring.
        try:
            SetBlendMode(ss_LightBlend)
            self.draw_cloud(ext)
            for i, texture in enumerate(self.lights):
                if i==3 and self.cloud_mesh is not None: continue
                if self.levels[i] > 0.0001 and GetTextureSize(texture):
                    g = self.gain[i] * self.levels[i]
                    self.quad.SetTexture(texture, RGBA(g,g,g,1))
                    self.quad.DrawTriangles(0,1)
            self.draw_flares(ext)
        finally:
            # Do not leak additive blending into track artwork or foreground.
            SetBlendMode(ss_AlphaBlend)

SetDrawClass(ReactiveSpaceBackground)
