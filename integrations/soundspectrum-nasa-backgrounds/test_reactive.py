"""Geometry, audio isolation, smoothing, headroom and render-state regression tests."""
import array, math, pathlib, unittest
import numpy as np
from prepare_reactive import detect

class Quad(list):
    def __init__(self,formats,usage,count): super().__init__([array.array('f',[0]*(5 if len(formats)==3 else 4)) for _ in range(count)]); self.draws=[]
    def SetTexture(self,t,c): self.texture,self.color=t,c
    def DrawTriangles(self,*a): self.draws.append((self.texture,self.color))

def renderer(lively=False):
    textures=[]; blends=[]
    env=dict(VertexList=Quad,ss_XY=0,ss_TexXY=1,ss_Alpha=2,ss_ChangesEachUse=0,ss_Crop=0,ss_AlphaBlend=1,ss_LightBlend=2,
        CreateTextureFromImage=lambda p:textures.append(p) or p,GetTextureSize=lambda t:(3840,2160),
        GetViewExtents=lambda:(16/9,1),RGBA=lambda *a:a,Set2DCamera=lambda *a:None,
        SetBlendMode=lambda b:blends.append(b),SetDrawClass=lambda c:None,IMAGE_PATH='base.jpg',LIGHT_PATHS=['small','mid','large','cloud'],
        LIVELY_STARS=False,FLARE_PATH=None,FLARE_STARS=[],CLOUD_MOTION=None,CLOUD_PATH=None)
    if lively: env.update(LIVELY_STARS=True,FLARE_PATH='flare.png',FLARE_STARS=[[.4,.6,.025,0,.7,1,.8,.7]]*15)
    exec(compile(pathlib.Path(__file__).with_name('ReactivePhoto.py').read_text(),'ReactivePhoto.py','exec'),env)
    return env,textures,blends

def scene(lively=False):
    env,textures,blends=renderer(lively)
    return env['ReactiveSpaceBackground'](),textures,blends

class Reactive(unittest.TestCase):
    def test_reload_keeps_each_factory_assets_and_motion_settings(self):
        env,textures,blends=renderer(True)
        original=env['ReactiveSpaceBackground']
        first=original()
        env.update(IMAGE_PATH='second.jpg',LIGHT_PATHS=['s2','m2','l2','c2'],
                   LIVELY_STARS=False,FLARE_PATH=None,FLARE_STARS=[])
        exec(compile(pathlib.Path(__file__).with_name('ReactivePhoto.py').read_text(),'second.py','exec'),env)
        second=env['ReactiveSpaceBackground']()
        delayed_first=original()
        self.assertEqual(first.base,b'base.jpg')
        self.assertEqual(delayed_first.base,b'base.jpg')
        self.assertEqual(delayed_first.lights,[b'small',b'mid',b'large',b'cloud'])
        self.assertTrue(delayed_first.lively)
        self.assertEqual(delayed_first.flare_texture,b'flare.png')
        self.assertEqual(len(delayed_first.flares),12)
        self.assertEqual(second.base,b'second.jpg')
        self.assertEqual(second.lights,[b's2',b'm2',b'l2',b'c2'])
        self.assertFalse(second.lively)
        self.assertIsNone(second.flare_texture)
        self.assertEqual(second.flares,[])
        for frame in range(120):
            for s in (first,second,delayed_first): s.Draw(frame/60,1/60,[.15]*64)
        self.assertEqual(len(textures),17)

    def test_every_reactive_scene_responds_quickly_and_flare_centres_stay_fixed(self):
        fast,textures,blends=scene(True);old,_,_=scene()
        fast.Draw(0,1/60,[0]*64);base=[list(v) for v in fast.quad]
        self.assertEqual(len(fast.flares),12);self.assertEqual(len(textures),6)
        fast.envelope(.016,[.15]*64);old.envelope(.016,[.15]*64)
        self.assertGreater(fast.levels[0],.10)
        self.assertAlmostEqual(fast.levels[0],old.levels[0])
        geometries=[]
        for i in range(120):
            fast.Draw(i/60,1/60,[.15]*64)
            vertices=fast.flares[0][1];geometries.append([list(v) for v in vertices])
            self.assertAlmostEqual(sum(v[0] for v in vertices)/4,(.8-1)*16/9,places=5)
            self.assertAlmostEqual(sum(v[1] for v in vertices)/4,1-1.2,places=5)
            self.assertTrue(all(0<=c<=.50 for c in vertices.color[:3]))
        self.assertNotEqual(geometries[0],geometries[-1]);self.assertEqual(base,[list(v) for v in fast.quad])
        self.assertEqual(len(textures),6);self.assertEqual(blends[-1],1)
        for i in range(600):fast.Draw(i/60,1/60,[0]*64)
        self.assertLess(fast.levels[0],1e-10)
        fast.envelope(float('nan'),[float('nan')]*64)
        self.assertTrue(all(math.isfinite(x) and 0<=x<=1 for x in fast.levels))

    def test_stationary_original_and_no_per_frame_texture_creation(self):
        s,textures,blends=scene();s.Draw(1,.016,[0]*64);initial=[list(v) for v in s.quad]
        self.assertEqual(s.quad.draws,[(b'base.jpg',(1,1,1,1))])
        for i in range(600):s.Draw(i/60,1/60,[1]*64)
        self.assertEqual(initial,[list(v) for v in s.quad]);self.assertEqual(len(textures),5)
        self.assertEqual(blends[-1],1)
        self.assertTrue(all(0<=v<=1 for v in s.levels))
        self.assertLessEqual(max(c[0] for t,c in s.quad.draws if t!=b'base.jpg'),.65)

    def test_bands_smoothing_decay_and_invalid_samples(self):
        s,_,_=scene();s.envelope(1/60,[0]*36+[1]*28)
        self.assertGreater(s.levels[0],0);self.assertLess(s.levels[0],.30)
        self.assertEqual(s.levels[1:],[0,0,0])
        old=s.levels[0];s.envelope(1/60,[0]*64);self.assertGreater(s.levels[0],0);self.assertLess(s.levels[0],old)
        self.assertEqual(s.band([float('nan'),float('inf')],0,1),0)
        self.assertEqual(s.band([],0,1),0)
        a,_,_=scene();b,_,_=scene()
        for _ in range(60):a.envelope(1/60,[.3]*64)
        for _ in range(30):b.envelope(1/30,[.3]*64)
        np.testing.assert_allclose(a.levels,b.levels,atol=1e-7)

    def test_quiet_floor_stays_quiet_and_music_is_visible_in_every_reactive_scene(self):
        s,_,_=scene()
        for _ in range(120):s.Draw(0,1/60,[.004]*64)
        self.assertEqual(s.levels,[0]*4)
        for _ in range(30):s.Draw(0,1/60,[.12]*64)
        self.assertGreater(s.levels[0],.45)
        self.assertGreater(s.levels[2],.45)
        # Old non-lively small-star delta at this input was < .026 times texture.
        self.assertGreater(s.gain[0]*s.levels[0],.29)

    def test_cloud_only_changes_masked_sampling_and_fades_out_without_new_textures(self):
        env,textures,blends=renderer()
        weights=[0.0]*(33*19);weights[9*33+16]=.9
        env['CLOUD_MOTION']=[33,19,weights]
        env['CLOUD_PATH']='cloud-flow.png'
        exec(compile(pathlib.Path(__file__).with_name('ReactivePhoto.py').read_text(),'cloud.py','exec'),env)
        factory=env['ReactiveSpaceBackground'];s=factory()
        env['CLOUD_MOTION']=None
        exec(compile(pathlib.Path(__file__).with_name('ReactivePhoto.py').read_text(),'plain.py','exec'),env)
        self.assertIsNone(env['ReactiveSpaceBackground']().cloud_mesh)
        self.assertIsNotNone(factory().cloud_mesh)  # delayed construction after reload
        s.Draw(0,1/60,[0]*64);base=[list(v) for v in s.quad]
        self.assertEqual(s.cloud_mesh.draws,[])
        count=len(textures);moved=False
        for f in range(120):
            s.Draw(f/60,1/60,[.2]*64)
            for i,k in enumerate(s.cloud_vertices):
                x,y,w=s.cloud_points[k];v=s.cloud_mesh[i]
                self.assertAlmostEqual(v[0],(2*x-1)*16/9,places=5)
                self.assertAlmostEqual(v[1],1-2*y,places=5)
                self.assertLessEqual(abs(v[2]-x),.00901)
                self.assertLessEqual(abs(v[3]-y),.01601)
                if not w: self.assertAlmostEqual(v[2],x,places=6);self.assertAlmostEqual(v[3],y,places=6)
                elif abs(v[2]-x)>.001: moved=True
        self.assertTrue(moved);self.assertEqual(base,[list(v) for v in s.quad])
        self.assertEqual(len(textures),count);self.assertEqual(blends[-1],1)
        for f in range(1000):s.Draw(f/60,1/60,[0]*64)
        self.assertLess(s.levels[3],.001)

    def test_offline_point_detection_padding_and_bounded_masks(self):
        rgb=np.zeros((180,320,3),np.float32)
        yy,xx=np.mgrid[:180,:320]
        for x,y,sigma in [(60,60,1.5),(160,100,3),(240,80,5)]:
            rgb+=np.exp(-((xx-x)**2+(yy-y)**2)/(2*sigma*sigma))[:,:,None]*.9
        masks,stars=detect(np.clip(rgb,0,1))
        self.assertEqual(len(stars),3)
        self.assertTrue(all(m.shape==(180,320) for m in masks))
        self.assertLessEqual(float(np.sum(masks,axis=0).max()),1.00001)
        self.assertEqual(float(masks[3][0,0]),0)

    def test_bright_cloud_ridge_is_not_a_star(self):
        yy,xx=np.mgrid[:180,:320]
        ridge=np.exp(-((yy-90)**2)/(2*2.0**2))*.95
        _,stars=detect(np.repeat(ridge[:,:,None],3,axis=2).astype(np.float32))
        self.assertEqual(stars,[])

if __name__=='__main__':unittest.main()
