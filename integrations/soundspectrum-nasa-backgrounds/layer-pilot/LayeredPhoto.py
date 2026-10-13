# Python 2.7 native WhiteCap scene. AI preparation is strictly offline.
import math

class LayeredNasaPilot(object):
    def __init__(self, config=PILOT_CONFIG, paths=tuple(PILOT_PATHS)):
        # Capture entry state: WhiteCap can reuse a script's global namespace.
        self.image_id = config['imageId']
        self.cloud = config['cloud']
        self.limits = tuple(config['maxMotionPixels'])
        self.source = CreateTextureFromImage(paths[0].encode('utf-8'))
        self.background = CreateTextureFromImage(paths[1].encode('utf-8')) if self.cloud else None
        self.foreground = CreateTextureFromImage(paths[2].encode('utf-8')) if self.cloud else None
        self.stars = CreateTextureFromImage(paths[3].encode('utf-8')) if self.cloud else None
        self.quad = VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, 4)
        self.mesh = None
        self.points = []
        self.indices = []
        self.levels = [0.0, 0.0]
        self.phase = 0.0
        self.displacement = 0.0
        self.ready = False
        self.extents = None
        self.draw_count = 0
        if self.cloud:
            cols, rows, weights = config['grid']
            for y in range(rows):
                for x in range(cols):
                    self.points.append((float(x)/(cols-1),float(y)/(rows-1),weights[y*cols+x]))
            for y in range(rows-1):
                for x in range(cols-1):
                    a=y*cols+x
                    self.indices.extend((a,a+1,a+cols,a+1,a+cols+1,a+cols))
            self.mesh = VertexList([ss_XY, ss_TexXY], ss_ChangesEachUse, len(self.indices))

    def update(self, dt, audio):
        if math.isnan(dt) or math.isinf(dt): dt=0.0
        step=max(0.0,min(float(dt),.1))
        count=len(audio)
        for channel,(lo,hi) in enumerate(((0,.22),(.3,1.0))):
            first=int(count*lo);last=min(count,max(first+1,int(count*hi)))
            total=0.0
            for i in range(first,last):
                value=float(audio[i])
                if not math.isnan(value) and not math.isinf(value): total+=max(0.0,min(1.0,value))**2
            rms=math.sqrt(total/max(1,last-first))
            target=1.0-math.exp(-6.0*max(0.0,rms-.008))
            tau=(.28 if channel==0 else .055) if target>self.levels[channel] else (1.25 if channel==0 else .35)
            self.levels[channel]+=(target-self.levels[channel])*(1.0-math.exp(-step/tau))
        self.phase+=step*min(1.0,self.levels[0]*3.0)

    def coordinates(self, ext):
        u=min(1.0,(float(ext[0])/ext[1])/(16.0/9.0))
        v=min(1.0,(16.0/9.0)/(float(ext[0])/ext[1]))
        amount=self.levels[0]
        phase=self.phase
        points=[]
        displacement=0.0
        for x,y,weight in self.points:
            # Two coherent, low-frequency flows; limit is in source pixels.
            dx=self.limits[0]*amount*weight*math.sin(phase*.70+y*5.0+x*2.0)
            dy=self.limits[1]*amount*weight*math.sin(phase*.53-x*4.0+y*2.0)
            displacement=max(displacement,math.sqrt(dx*dx+dy*dy))
            points.append(((2*(x+dx/3840.0)-1)*ext[0]/u,
                           (1-2*(y+dy/2160.0))*ext[1]/v,x,y))
        self.displacement=displacement
        return points

    def Draw(self, time, dt, inAudio):
        self.update(dt,inAudio)
        Set2DCamera(ss_Crop)
        ext=GetViewExtents()
        if self.extents!=tuple(ext):
            self.extents=tuple(ext)
            u=min(1.0,(float(ext[0])/ext[1])/(16.0/9.0))
            v=min(1.0,(16.0/9.0)/(float(ext[0])/ext[1]))
            for i,(x,y,tx,ty) in enumerate(((-1,-1,0,1),(1,-1,1,1),(-1,1,0,0),(1,1,1,0))):
                vertex=self.quad[i]
                vertex[0],vertex[1]=x*ext[0],y*ext[1]
                vertex[2],vertex[3]=(1-u)*.5+tx*u,(1-v)*.5+ty*v
        if not GetTextureSize(self.source): return
        self.ready=not self.cloud or all(GetTextureSize(t) for t in (self.background,self.foreground,self.stars))
        self.draw_count+=1
        try:
            SetBlendMode(ss_AlphaBlend)
            # Silence/control/loading have a source-exact path. No blank frames.
            if not self.cloud or not self.ready or max(self.levels)<.0001:
                self.displacement=0.0
                self.quad.SetTexture(self.source,RGBA(1,1,1,1))
                self.quad.DrawTriangles(0,1)
                return
            self.quad.SetTexture(self.background,RGBA(1,1,1,1))
            self.quad.DrawTriangles(0,1)
            points=self.coordinates(ext)
            for i,k in enumerate(self.indices):
                vertex=self.mesh[i]
                for c in range(4): vertex[c]=points[k][c]
            self.mesh.SetTexture(self.foreground,RGBA(1,1,1,1))
            self.mesh.DrawTriangles(0,-1,3)
            # Stellar residual stays registered to the original coordinates.
            # A restrained gain responds to treble; no moving galaxy centres.
            SetBlendMode(ss_LightBlend)
            gain=1.0+.20*self.levels[1]
            self.quad.SetTexture(self.stars,RGBA(gain,gain,gain,1))
            self.quad.DrawTriangles(0,1)
        finally:
            SetBlendMode(ss_AlphaBlend)

SetDrawClass(LayeredNasaPilot)
