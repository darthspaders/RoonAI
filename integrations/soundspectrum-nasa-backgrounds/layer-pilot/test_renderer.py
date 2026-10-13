"""Dependency-light checks for actual renderer math; no WhiteCap installation."""
import copy, math, pathlib, unittest

HERE=pathlib.Path(__file__).resolve().parent
class Vertices(list):
    def __init__(self,fmt,flags,count): super().__init__([[0.,0.,0.,0.] for _ in range(count)])
    def SetTexture(self,texture,color): self.texture=texture;self.color=color
    def DrawTriangles(self,*args): pass

class RendererTests(unittest.TestCase):
    def setUp(self):
        self.blends=[]
        self.cfg={'imageId':'test','cloud':True,'grid':[3,3,[0,0,0,0,1,0,0,0,0]],'maxMotionPixels':[26,20]}
        env={'PILOT_CONFIG':self.cfg,'PILOT_PATHS':('source','background','cloud','stars'),
             'CreateTextureFromImage':lambda x:x,'GetTextureSize':lambda x:(3840,2160),
             'VertexList':Vertices,'SetBlendMode':self.blends.append,'RGBA':lambda *x:x,
             'Set2DCamera':lambda *x:None,'GetViewExtents':lambda:(16/9,1),
             'SetDrawClass':lambda x:None,'ss_XY':0,'ss_TexXY':1,'ss_ChangesEachUse':0,
             'ss_Crop':0,'ss_AlphaBlend':1,'ss_LightBlend':2}
        exec(compile((HERE/'LayeredPhoto.py').read_text(),str(HERE/'LayeredPhoto.py'),'exec'),env)
        self.env=env;self.cls=env['LayeredNasaPilot'];self.scene=self.cls()

    def test_silence_is_source_exact_and_static(self):
        for i in range(60): self.scene.Draw(i/60,1/60,[0.]*64)
        self.assertEqual(self.scene.quad.texture,b'source')
        self.assertEqual(self.scene.levels,[0.,0.]);self.assertEqual(self.scene.displacement,0)

    def test_signal_drives_real_geometry_and_fixed_stellar_uvs(self):
        neutral=self.scene.coordinates((16/9,1))
        for i in range(180): self.scene.Draw(i/60,1/60,[.18]*64)
        moved=self.scene.coordinates((16/9,1))
        self.assertNotEqual(neutral[4][:2],moved[4][:2]);self.assertGreater(self.scene.displacement,2)
        self.assertEqual([p[2:] for p in neutral],[p[2:] for p in moved])
        self.assertEqual(self.scene.quad.texture,b'stars')
        self.assertEqual([v[2:] for v in self.scene.quad],[[0,1],[1,1],[0,0],[1,0]])
        for i in [0,1,2,3,5,6,7,8]: self.assertEqual(neutral[i],moved[i])
        self.assertEqual(self.blends[-1],1)

    def test_release_returns_to_original(self):
        for i in range(120): self.scene.Draw(i/60,1/60,[.25]*64)
        for i in range(1600): self.scene.Draw(i/60,1/60,[0]*64)
        self.assertLess(max(self.scene.levels),.0001);self.assertEqual(self.scene.quad.texture,b'source')

    def test_invalid_energy_and_time_never_produce_nonfinite_vertices(self):
        for dt in [float('nan'),float('inf'),-10,10]:
            self.scene.Draw(0,dt,[float('nan'),float('inf'),-100,.2])
        self.assertTrue(all(math.isfinite(v) for p in self.scene.mesh for v in p))
        self.assertTrue(all(0<=v<=1 for v in self.scene.levels))

    def test_control_never_deforms_or_loads_derived_textures(self):
        c=copy.deepcopy(self.cfg);c.update(cloud=False,imageId='control')
        scene=self.cls(c)
        for i in range(30): scene.Draw(i,.1,[1]*64)
        self.assertIsNone(scene.mesh);self.assertIsNone(scene.foreground);self.assertEqual(scene.displacement,0)
        self.assertEqual(scene.quad.texture,b'source')

    def test_globals_reloaded_for_another_entry_do_not_change_active_scene(self):
        self.env['PILOT_CONFIG']={'imageId':'unrelated','cloud':False}
        self.env['PILOT_PATHS']=('wrong',)*4
        self.scene.Draw(0,.016,[.2]*64)
        self.assertEqual(self.scene.image_id,'test');self.assertEqual(self.scene.source,b'source')
        self.assertTrue(self.scene.cloud)

    def test_loading_uses_original_and_restores_blend_on_exception(self):
        self.env['GetTextureSize']=lambda x:(3840,2160) if x==b'source' else None
        self.scene.Draw(0,.1,[.2]*64);self.assertEqual(self.scene.quad.texture,b'source')
        self.env['GetTextureSize']=lambda x:(3840,2160)
        def fail(*args): raise RuntimeError('test render failure')
        self.scene.mesh.DrawTriangles=fail
        with self.assertRaises(RuntimeError): self.scene.Draw(0,.1,[.2]*64)
        self.assertEqual(self.blends[-1],1)

if __name__=='__main__': unittest.main()
