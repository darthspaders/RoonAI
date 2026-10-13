"""Universal response: real geometry, audio timing, silence, bounds and reload isolation."""
import math, pathlib, unittest, array

class Vertices(list):
    def __init__(self,formats,usage,count): super().__init__([array.array('f',[0]*4) for _ in range(count)]);self.draws=[]
    def SetTexture(self,t,c): self.texture,self.color=t,c
    def DrawTriangles(self,*a): self.draws.append((self.texture,self.color))

def renderer(stars=True):
    textures=[];blends=[];weights=[0 if i<25 or i>=350 or i%25 in (0,24) else 1 for i in range(375)]
    env=dict(VertexList=Vertices,ss_XY=0,ss_TexXY=1,ss_ChangesEachUse=0,ss_Crop=0,ss_AlphaBlend=1,ss_LightBlend=2,
        CreateTextureFromImage=lambda p:textures.append(p) or p,GetTextureSize=lambda t:(3840,2160),GetViewExtents=lambda:(16/9,1),
        RGBA=lambda *a:a,Set2DCamera=lambda *a:None,SetBlendMode=lambda b:blends.append(b),SetDrawClass=lambda c:None,
        IMAGE_PATH='original.jpg',EXPRESSIVE_FLARE='flare.png',EXPRESSIVE_CONFIG=dict(imageId='first',grid=[25,15,weights],stars=[[.4,.6,.02,.7]] if stars else []))
    source=pathlib.Path(__file__).with_name('ExpressivePhoto.py').read_text()
    exec(compile(source,'ExpressivePhoto.py','exec'),env)
    return env,env['ExpressiveSpaceBackground'](),textures,blends,source

class Expressive(unittest.TestCase):
    def test_silence_is_source_exact_and_has_no_synthetic_beat(self):
        _,s,tx,b,_=renderer()
        for _ in range(120): s.Draw(0,1/120,[0]*64)
        self.assertEqual(s.levels,[0,0,0]);self.assertEqual(s.kick,0);self.assertEqual(s.displacement,0)
        self.assertEqual(s.quad.color,(1,1,1,1));self.assertEqual(len(tx),2);self.assertFalse(hasattr(s,"mesh"));self.assertEqual(b[-1],1)
    def test_all_audio_keeps_source_geometry_uvs_and_color_unchanged(self):
        _,s,_,_,_=renderer(False);s.Draw(0,1/120,[0]*64)
        original=[list(v) for v in s.quad]
        for audio in ([.3]*10+[0]*54,[.9]*64,[0]*35+[.5]*29):
            for _ in range(30): s.Draw(0,1/120,audio)
            self.assertEqual(s.displacement,0)
            self.assertEqual(original,[list(v) for v in s.quad])
            self.assertEqual(s.quad.color,(1,1,1,1))
            self.assertFalse(hasattr(s,'mesh'))
        self.assertEqual(len(s.stars),0)
    def test_stars_dance_spin_twinkle_and_change_color_without_allocating_textures(self):
        _,s,tx,b,_=renderer();s.Draw(0,.05,[.2]*64);q=s.stars[0][1];before=[list(v) for v in q];color=q.color
        for _ in range(80):s.Draw(0,1/120,[.2]*64)
        self.assertNotEqual(before,[list(v) for v in q]);self.assertNotEqual(color,q.color)
        self.assertNotEqual(sum(v[0] for v in before),sum(v[0] for v in q));self.assertEqual(len(tx),2);self.assertEqual(b[-1],1)
        self.assertTrue(all(0<=c<=1 for c in q.color))
    def test_attack_release_is_frame_rate_independent_and_decays(self):
        values=[]
        for fps in [30,60,120]:
            _,s,_,_,_=renderer()
            for _ in range(fps):s.Draw(0,1/fps,[.18]*64)
            values.append(s.levels[:])
            for _ in range(fps*4):s.Draw(0,1/fps,[0]*64)
            self.assertLess(max(s.levels+[s.kick]),.0001);self.assertEqual(s.displacement,0)
        for a in values[1:]:
            for x,y in zip(a,values[0]):self.assertAlmostEqual(x,y,places=6)
    def test_invalid_audio_and_dt_stay_finite(self):
        _,s,_,b,_=renderer()
        for dt in [float('nan'),float('inf'),-.1,.02]:s.Draw(0,dt,[float('nan'),float('inf'),-1,'bad']*16)
        self.assertEqual(s.levels,[0,0,0]);self.assertEqual(b[-1],1)
    def test_scene_factory_survives_shared_namespace_reload(self):
        env,s,_,_,source=renderer();factory=env['ExpressiveSpaceBackground'];env['IMAGE_PATH']='second.jpg';env['EXPRESSIVE_CONFIG']=dict(imageId='second',grid=env['EXPRESSIVE_CONFIG']['grid'],stars=[])
        exec(compile(source,'second.py','exec'),env)
        self.assertEqual(factory().image_id,'first');self.assertEqual(env['ExpressiveSpaceBackground']().image_id,'second');self.assertEqual(s.base,b'original.jpg')

if __name__=='__main__':unittest.main()
