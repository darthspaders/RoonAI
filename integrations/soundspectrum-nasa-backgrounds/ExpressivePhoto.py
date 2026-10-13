# Python 2.7-compatible native WhiteCap renderer. Offline feature maps, live FFT.
import math

class ExpressiveSpaceBackground(object):
    def __init__(self, image_path=IMAGE_PATH, config=EXPRESSIVE_CONFIG, flare_path=EXPRESSIVE_FLARE):
        self.image_id=config['imageId']
        self.base=CreateTextureFromImage(image_path.encode('utf-8'))
        self.flare=CreateTextureFromImage(flare_path.encode('utf-8'))
        self.quad=VertexList([ss_XY,ss_TexXY],ss_ChangesEachUse,4)
        self.levels=[0.0,0.0,0.0]
        self.phase=0.0;self.kick=0.0;self.bass_history=0.0;self.cooldown=0.0
        self.displacement=0.0;self.ready=False;self.cloud=True
        self.stars=[(s,VertexList([ss_XY,ss_TexXY],ss_ChangesEachUse,4)) for s in config['stars']]
        self.extents=None

    def finite(self,value):
        try: v=float(value)
        except (TypeError,ValueError): return 0.0
        return 0.0 if math.isnan(v) or math.isinf(v) else v

    def band(self,audio,lo,hi):
        count=len(audio);first=int(count*lo);last=min(count,max(first+1,int(count*hi)))
        energy=sum(min(1.0,max(0.0,self.finite(audio[i])))**2 for i in range(first,last))
        rms=math.sqrt(energy/max(1,last-first))
        return 1.0-math.exp(-12.0*max(0.0,rms-.008))

    def update(self,dt,audio):
        step=max(0.0,min(.1,self.finite(dt)))
        targets=[self.band(audio,0,.16),self.band(audio,.16,.55),self.band(audio,.55,1)]
        self.cooldown=max(0.0,self.cooldown-step)
        # Bass onset rather than a clock-driven fake beat. Native beat is accepted
        # only alongside actual low-band energy; silence cannot trigger motion.
        onset=max(0.0,targets[0]-self.bass_history)
        if self.cooldown==0 and targets[0]>.10 and (onset>.065 or self.finite(getattr(audio,'beat',0))>1):
            self.kick=max(self.kick,min(1.0,.25+onset*3+targets[0]*.55));self.cooldown=.14
        else: self.kick*=math.exp(-step/.20)
        self.bass_history+=(targets[0]-self.bass_history)*(1-math.exp(-step/.22))
        for i,target in enumerate(targets):
            tau=.025 if target>self.levels[i] else (.24 if i==0 else .18)
            self.levels[i]+=(target-self.levels[i])*(1-math.exp(-step/tau))
        self.phase+=step*min(1.0,max(self.levels)*2.5)

    def draw_photo(self,ext,u,v):
        self.displacement=0.0
        self.quad.SetTexture(self.base,RGBA(1,1,1,1));self.quad.DrawTriangles(0,1)

    def Draw(self,time,dt,inAudio):
        self.update(dt,inAudio);Set2DCamera(ss_Crop);ext=GetViewExtents()
        if not GetTextureSize(self.base): return
        self.ready=True
        u=min(1.0,(float(ext[0])/ext[1])/(16.0/9.0));v=min(1.0,(16.0/9.0)/(float(ext[0])/ext[1]))
        if tuple(ext)!=self.extents:
            self.extents=tuple(ext)
            for i,(x,y,tx,ty) in enumerate(((-1,-1,0,1),(1,-1,1,1),(-1,1,0,0),(1,1,1,0))):
                q=self.quad[i];q[0],q[1],q[2],q[3]=x*ext[0],y*ext[1],(1-u)*.5+tx*u,(1-v)*.5+ty*v
        try:
            SetBlendMode(ss_AlphaBlend)
            # The photograph is immutable: only separate overlays may move.
            self.draw_photo(ext,u,v)
            if not GetTextureSize(self.flare): return
            SetBlendMode(ss_LightBlend)
            for star,quad in self.stars:
                x,y,r,seed=star
                level=min(1.0,.45*self.levels[0]+.8*self.levels[2]+.5*self.kick)
                if level<.001: continue
                # Choreographed source-anchored orbits, continuous spin, treble
                # twinkle and bass expansion. There are no invented star positions.
                orbit=.012*level
                cx=(2*(x+orbit*math.sin(self.phase*2.1+seed))-1)*ext[0]/u
                cy=(1-2*(y+orbit*math.cos(self.phase*1.8+seed)))*ext[1]/v
                radius=r*(.65+1.8*level+.8*self.kick)
                rx=radius*2*ext[0]/u;ry=radius*2*(16.0/9.0)*ext[1]/v
                angle=self.phase*(1.4+.15*math.sin(seed))+seed
                c,s=math.cos(angle),math.sin(angle)
                for i,(dx,dy,tx,ty) in enumerate(((-1,-1,0,1),(1,-1,1,1),(-1,1,0,0),(1,1,1,0))):
                    q=quad[i];q[0],q[1],q[2],q[3]=cx+dx*rx*c-dy*ry*s,cy+dx*rx*s+dy*ry*c,tx,ty
                gain=level*(.55+.45*(.5+.5*math.sin(self.phase*8+seed)))
                hue=[.18+.82*(.5+.5*math.sin(self.phase*1.7+seed+a)) for a in (0,2.094,4.189)]
                quad.SetTexture(self.flare,RGBA(gain*hue[0],gain*hue[1],gain*hue[2],1));quad.DrawTriangles(0,1)
        finally: SetBlendMode(ss_AlphaBlend)

SetDrawClass(ExpressiveSpaceBackground)
