import pathlib, sys, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from test_expressive import renderer

def layered():
    env,_,tx,blends,base=renderer()
    env['LAYER_CONFIG']={'grid':[3,3,[0,0,0,0,1,0,0,0,0]],'maxMotionPixels':[64,48]}
    env['LAYER_PATHS']=['background.png','cloud.png','residual.png']
    code=pathlib.Path(__file__).with_name('LayeredPhoto.py').read_text()
    exec(compile(code,'LayeredPhoto.py','exec'),env)
    return env,env['LayeredSpaceBackground'](),tx,blends,base,code

class Layered(unittest.TestCase):
    def test_fixed_background_and_mask_edge_with_strong_local_motion(self):
        _,s,_,b,_,_=layered()
        s.Draw(0,.03,[0]*64);quad=[list(v) for v in s.quad]
        for _ in range(100):s.Draw(0,1/120,[.3]*64)
        self.assertGreater(s.displacement,30);self.assertLessEqual(s.displacement,80)
        self.assertEqual(quad,[list(v) for v in s.quad]);self.assertEqual(s.quad.color,(1,1,1,1))
        self.assertTrue(s.layer_ready);self.assertTrue(s.stars[0][1].draws);self.assertEqual(b[-1],1)
        # All zero-weight vertices stay in original source coordinates.
        for v,k in zip(s.mesh,s.indices):
            x,y,w=s.points[k]
            self.assertAlmostEqual(v[2],x);self.assertAlmostEqual(v[3],y)
            if w==0:self.assertAlmostEqual(v[0],(2*x-1)*16/9,places=6);self.assertAlmostEqual(v[1],1-2*y,places=6)
    def test_silence_and_missing_layer_use_exact_original(self):
        env,s,_,b,_,_=layered();s.Draw(0,.05,[0]*64)
        self.assertEqual(s.quad.texture,b'original.jpg');self.assertFalse(s.mesh.draws)
        env['GetTextureSize']=lambda p: None if p==b'cloud.png' else (3840,2160)
        s.Draw(0,.05,[.5]*64)
        self.assertFalse(s.layer_ready);self.assertEqual(s.quad.texture,b'original.jpg');self.assertEqual(s.displacement,0)
        self.assertTrue(s.stars[0][1].draws);self.assertEqual(b[-1],1)
    def test_base_methods_bound_before_python2_shared_namespace_reloads(self):
        env,s,_,_,base,code=layered();old=env['ExpressiveSpaceBackground'];factory=env['LayeredSpaceBackground']
        env['IMAGE_PATH']='second.jpg';exec(compile(base,'second-base.py','exec'),env);exec(compile(code,'second-layer.py','exec'),env)
        self.assertIs(factory.__init__.__defaults__[-1],old.__init__)
        self.assertIs(factory.draw_photo.__defaults__[-1],old.draw_photo)
        s.Draw(0,.02,[0]*64);self.assertEqual(s.quad.texture,b'original.jpg')

if __name__=='__main__':unittest.main()
