import sys, types, pathlib, math, unittest, time

class Quad(list):
    def __init__(self, *args):
        super().__init__([[0,0,0,0] for _ in range(4)])
    def SetTexture(self, tex, rgba):
        self.texture, self.rgba = tex, rgba
    def DrawTriangles(self, *args):
        pass

class Tests(unittest.TestCase):
    def setUp(self):
        self.engine = types.SimpleNamespace(PRODUCT_NAME='WhiteCap', HOST_NAME='Standalone')
        sys.modules['SoundSpectrum'] = types.SimpleNamespace(GetEngineInstance=lambda: self.engine)
        self.loaded=[]
        self.env = dict(VertexList=Quad, ss_XY=0, ss_TexXY=1, ss_ChangesEachUse=0, ss_Crop=0,
            Set2DCamera=lambda *a: None, GetViewExtents=lambda: (16/9,1),
            CreateTextureFromImage=lambda p: self.loaded.append(p) or p, GetTextureSize=lambda t: (640,640,0),
            RGBA=lambda *a:a, SetDrawClass=lambda c:None)
        source=pathlib.Path(__file__).with_name('Rabbit Hole - Floating Artwork.py').read_text()
        exec(compile(source,'drawing','exec'),self.env)
        self.reader=types.SimpleNamespace(report=lambda *a:None)
        self.value={'updatedAt':int(time.time()*1000),'session':'owned', 'track':{'key':'a'*64,'artwork':{'file':'artwork-'+'b'*64+'.jpg'}}}
        self.state={'reader':self.reader,'path':'C:/private/now-playing.json','snapshot':self.value}
        setattr(self.engine,'_rh_whitecap_artwork_v1',self.state)

    def test_drift_depth_audio_and_bounds(self):
        draw=self.env['FloatingArtwork']()
        scale=[]; xs=[]; ys=[]
        for i in range(3600):
            draw.Draw(i/60,1/60,[1]*64)
            scale.append(self.env['pose'](i/60,draw.level)[2]); xs.append(draw.quad[0][0]);ys.append(draw.quad[0][1])
            self.assertTrue(all(abs(v[0]) <=16/9 and abs(v[1])<=1 for v in draw.quad))
        self.assertGreater(max(scale)-min(scale),.35)
        self.assertGreater(max(xs)-min(xs),.4)
        self.assertGreater(max(ys)-min(ys),.4)
        self.assertGreater(draw.level,.9)
        self.assertEqual(len(self.loaded),1)
        for i in range(300): draw.Draw(i/60,1/60,[0]*64)
        self.assertLess(draw.level,.001)

    def test_track_change_and_stale_metadata_remove_old_texture(self):
        draw=self.env['FloatingArtwork']();draw.Draw(1,.016,[0]*64)
        self.assertIsNotNone(draw.texture)
        self.assertTrue(self.loaded[0].startswith(b'file:///C:/private/artwork-'))
        self.value['track']['key']='c'*64;self.value['track']['artwork']=None
        draw.Draw(2,.016,[0]*64);self.assertIsNone(draw.texture)
        self.value['track']['artwork']={'file':'artwork-'+'d'*64+'.png'}
        draw.Draw(3,.016,[0]*64);self.assertEqual(len(self.loaded),2)
        self.value['updatedAt']-=9000;draw.Draw(4,.016,[0]*64)
        self.assertIsNone(draw.texture)

    def package_fixture(self):
        import threading
        calls=[]
        class Engine:
            def RenderFrame(self, at): return 'frame'
            def OnShutdown(self): return 'shutdown'
        class Group:
            def RenderGroup(self, audio, color): calls.append('background')
        class Scene:
            def __init__(self, engine): self.frames=0; self.closed=False
            def InitScene(self,*a): pass
            def UpdateTimeIndex(self,*a): pass
            def RenderScene(self,audio): self.frames+=1;calls.append('artwork')
            def OnSceneComplete(self): self.closed=True
        sys.modules['SSEngine']=types.SimpleNamespace(EngineInstance=Engine,RunningConfigGroup=Group,SceneInstance=Scene)
        sys.modules['SoundSpectrumDrawing']=types.SimpleNamespace(**{k:lambda:None for k in ['PushMatrix','PopMatrix','TexPushMatrix','TexPopMatrix']})
        running=['A']
        ss=sys.modules['SoundSpectrum'];ss.Interpreter=types.SimpleNamespace(GetRunningList=lambda k:running[0])
        env={};exec(compile(pathlib.Path(sys.argv[1]).read_text(),'package','exec'),env)
        reader=types.SimpleNamespace(snapshot=lambda:(True,self.value),phase=lambda x:None,lock=threading.Lock(),diagnostic={})
        env['Reader']=lambda:reader
        engine=self.engine;delattr(engine,'_rh_whitecap_artwork_v1')
        engine.mTimeIndex=0
        def start(kind,name,duration): calls.append(('start',name));running[0]=name
        engine.StartConfig=start
        engine.SlideshowEnabled=lambda k:True
        engine.SetSlideshowEnabled=lambda k,v:calls.append(('slideshow',v))
        engine.GetConfigSetList=lambda k:[types.SimpleNamespace(ConfigName=n,ConfigFlags=f) for n,f in [('B',1),('A',1),('Unavailable',0),('Special',3),(env['NAME'],3)]]
        engine.GetConfigSet=lambda k:types.SimpleNamespace(InvokeConfig=lambda name:[])
        group=Group();group.mEngine=engine;group.ConfigTypeName='Background'
        return env,calls,running,reader,group

    def test_external_rotation_keeps_artwork_without_selecting_or_restoring_backgrounds(self):
        env,calls,running,reader,group=self.package_fixture()
        self.engine._rh_whitecap_external_background_rotation=True
        self.engine._rh_whitecap_external_background_names=('Pilot A','Pilot B','Pilot C')
        env['update'](self.engine);state=getattr(self.engine,env['SENTINEL']);scene=state['scene']
        self.assertEqual(state['names'],['Pilot A','Pilot B','Pilot C'])
        for at in (20,40,60):
            self.engine.mTimeIndex=at;running[0]='Pilot B';env['update'](self.engine);env['draw_artwork'](group,[1]*64)
        self.assertEqual(scene.frames,3)
        self.value['updatedAt']-=9000;env['update'](self.engine)
        self.assertTrue(scene.closed);self.assertEqual(running[0],'Pilot B')
        self.assertFalse(any(isinstance(call,tuple) and call[0] in ('start','slideshow') for call in calls))

    def test_all_background_rotation_keeps_one_art_scene_and_restores(self):
        env,calls,running,reader,group=self.package_fixture()
        self.assertRaises(ValueError,env['PrivateJSONReader'],'x'*8193)
        self.assertRaises(ValueError,env['PrivateJSONReader']('{"a":1,"a":2}').read)
        env['update'](self.engine);state=getattr(self.engine,env['SENTINEL']);scene=state['scene']
        self.assertEqual(state['names'],['A','B'])
        for at,expected in [(19,'A'),(20,'B'),(40,'A'),(60,'B')]:
            self.engine.mTimeIndex=at;env['update'](self.engine)
            self.assertEqual(running[0],expected);self.assertIs(state['scene'],scene)
            env['draw_artwork'](group,[1]*64)
        self.assertEqual(scene.frames,4);self.assertFalse(scene.closed)
        self.assertEqual(reader.diagnostic['changes'],3)
        group.ConfigTypeName='WaveShape';env['draw_artwork'](group,[1]*64)
        self.assertEqual(scene.frames,4)
        self.value['updatedAt']-=9000;env['draw_artwork'](group,[1]*64)
        env['update'](self.engine)
        self.assertTrue(scene.closed);self.assertIsNone(state['scene'])
        self.assertEqual(running[0],'A');self.assertIn(('slideshow',True),calls)

    def test_manual_background_selection_and_missing_art_do_not_restart_layer(self):
        env,calls,running,reader,group=self.package_fixture()
        env['update'](self.engine);state=getattr(self.engine,env['SENTINEL']);scene=state['scene']
        self.value['track']['artwork']=None
        self.engine.mTimeIndex=20;env['update'](self.engine)
        self.assertIs(state['scene'],scene);self.assertEqual(running[0],'B')
        running[0]='Manual';self.engine.mTimeIndex=40;env['update'](self.engine)
        self.assertTrue(state['manual']);self.assertIs(state['scene'],scene)
        calls.clear();env['restore'](self.engine,state)
        self.assertEqual(calls,[]);self.assertTrue(scene.closed)

    def test_nasa_entries_are_spread_in_same_cycle_and_keep_art_scene(self):
        env,calls,running,reader,group=self.package_fixture()
        names=['Native%02d'%i for i in range(83)]+['NASA - Image%02d'%i for i in range(20)]
        self.engine.GetConfigSetList=lambda k:[types.SimpleNamespace(ConfigName=n,ConfigFlags=1) for n in names]
        cycle=env['background_names'](self.engine)
        self.assertEqual(set(cycle),set(names));self.assertEqual(len(cycle),103)
        positions=[i for i,n in enumerate(cycle) if n.startswith('NASA - ')]
        self.assertTrue(all(5 <= b-a <= 6 for a,b in zip(positions,positions[1:])))
        env['update'](self.engine);state=getattr(self.engine,env['SENTINEL']);scene=state['scene']
        for i in range(1,104):
            self.engine.mTimeIndex=i*20;env['update'](self.engine)
            env['draw_artwork'](group,[1]*64);self.assertIs(state['scene'],scene)
        self.assertFalse(scene.closed);self.assertEqual(scene.frames,103)

if __name__=='__main__':
    unittest.main(argv=[sys.argv[0]])
