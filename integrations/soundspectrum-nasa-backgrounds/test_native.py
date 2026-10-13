"""Exercise the real installed WhiteCap image renderer with drawing API stubs."""
import pathlib, sys, random, unittest

class Quad(list):
    def __init__(self, *args): super().__init__([[0,0,0,0] for _ in range(4)])
    def SetTexture(self, texture, color): self.texture, self.color = texture, color
    def DrawTriangles(self,*args): pass

class Native(unittest.TestCase):
    def renderer(self):
        textures=[]
        env=dict(VertexList=Quad,ss_XY=0,ss_TexXY=1,ss_ChangesEachUse=0,ss_Crop=0,
            uniform=random.uniform,random=random.random,shuffle=random.shuffle,
            CreateTextureFromImage=lambda p:textures.append(p) or p,
            GetTextureSize=lambda p:(3840,2160,0),GetViewExtents=lambda:(16/9,1),
            RGBA=lambda *a:a,Set2DCamera=lambda *a:None,SetDrawClass=lambda c:None,
            IMAGE_PATH='/Packages/RabbitHole.SpaceImages.package/nasa-science-123.jpg')
        def include(p):
            self.assertEqual(p,'/Packages/WhiteCap.Background.package/Slideshow.lib.py')
            exec(compile(pathlib.Path(sys.argv[1]).read_text(),p,'exec'),env)
            # WhiteCap embeds Python 2, which checks the declaring class of an
            # unbound method. Reproduce that check on the Python 3 test runner.
            owner=env['SlideshowImage']
            compute=owner.ComputeTextureCoordinates
            def checked(instance,time,t):
                if not isinstance(instance,owner):
                    raise TypeError('unbound method ComputeTextureCoordinates: wrong SlideshowImage class')
                return compute(instance,time,t)
            owner.ComputeTextureCoordinates=checked
        env['Include']=include
        exec(compile(pathlib.Path(__file__).with_name('Photo.py').read_text(),'Photo.py','exec'),env)
        return env,textures

    def test_existing_renderer_one_texture_bounded_motion_and_opaque_photo(self):
        env,textures=self.renderer()
        scene=env['SpaceBackground']()
        self.assertEqual(len(textures),1)
        for t in range(1,61):
            scene.Draw(t,.016,[])
            self.assertEqual(scene.image.vb.color,(1,1,1,1.0))
            self.assertTrue(all(0 <= v[2] <= 1 and 0 <= v[3] <= 1 for v in scene.image.vb))
        self.assertEqual(len(textures),1)
        self.assertEqual(scene.image.endscale,.975)

    def test_library_reload_does_not_change_the_parent_of_a_live_scene(self):
        env,textures=self.renderer()
        scene=env['SpaceBackground']()
        original_parent=env['SlideshowImage']
        scene.Draw(1,.016,[])
        for time in (2,10,20,40,60):
            env['Include']('/Packages/WhiteCap.Background.package/Slideshow.lib.py')
            self.assertIsNot(env['SlideshowImage'],original_parent)
            self.assertFalse(isinstance(scene.image,env['SlideshowImage']))
            self.assertTrue(isinstance(scene.image,original_parent))
            scene.Draw(time,.016,[])
            self.assertEqual(scene.image.vb.color,(1,1,1,1.0))
            self.assertTrue(all(0<=v[2]<=1 and 0<=v[3]<=1 for v in scene.image.vb))
        self.assertEqual(len(textures),1)

    def test_multiple_generated_scenes_retain_their_class_and_image_after_reload(self):
        env,textures=self.renderer()
        old_factory=env['SpaceBackground']
        original_class=env['SpaceImage']
        first=old_factory()
        env['IMAGE_PATH']='/Packages/RabbitHole.SpaceImages.package/nasa-science-456.jpg'
        exec(compile(pathlib.Path(__file__).with_name('Photo.py').read_text(),'second.py','exec'),env)
        second=env['SpaceBackground']()
        delayed_first=old_factory()
        self.assertIs(type(first.image),original_class)
        self.assertIs(type(delayed_first.image),original_class)
        self.assertIsNot(type(second.image),original_class)
        self.assertEqual(textures,[b'/Packages/RabbitHole.SpaceImages.package/nasa-science-123.jpg',
            b'/Packages/RabbitHole.SpaceImages.package/nasa-science-456.jpg',
            b'/Packages/RabbitHole.SpaceImages.package/nasa-science-123.jpg'])
        for time in (1,10,21,60):
            for scene in (first,second,delayed_first): scene.Draw(time,.016,[])

if __name__=='__main__': unittest.main(argv=[sys.argv[0]])
