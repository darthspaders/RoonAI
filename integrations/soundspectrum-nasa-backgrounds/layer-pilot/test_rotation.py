import os,pathlib,sys,types,unittest
from unittest.mock import patch

class RotationTests(unittest.TestCase):
    def fixture(self,selection):
        calls=[]
        class Engine:
            PRODUCT_NAME='WhiteCap';HOST_NAME='Standalone';mTimeIndex=0
            def RenderFrame(self,at): calls.append(('render',at));return 'frame'
            def GetConfigSetList(self,kind): return [types.SimpleNamespace(ConfigName=n,ConfigFlags=1) for n in ['A','B','C','Existing']]
            def SetSlideshowEnabled(self,kind,value): calls.append(('slideshow',value))
            def StartConfig(self,kind,name,seconds): calls.append(('background',name))
        class Package:
            def __init__(self,path):self.entries=[]
            def AddEntry(self,name,script):self.entries.append((name,script))
        source=pathlib.Path(__file__).with_name('rotation.py').read_text().replace('__TARGETS__',repr(['A','B','C'])).replace('__ENTRIES__',repr([['A','a.py'],['B','b.py'],['C','c.py']])).replace('__DIAGNOSTIC__',repr('missing-parent/ignored.json'))
        env={'VisPackage':Package}
        with patch.dict(sys.modules,{'SSEngine':types.SimpleNamespace(EngineInstance=Engine)}),patch.dict(os.environ,{'RABBIT_HOLE_WHITECAP_THEME':selection}):
            exec(compile(source,'rotation.py','exec'),env)
        package=env['ExportPackage']('test')
        return Engine,package,calls

    def test_current_theme_has_no_entries_hooks_or_preference_access(self):
        Engine,pkg,calls=self.fixture('current')
        self.assertEqual(pkg.entries,[])
        self.assertFalse(hasattr(Engine,'_rh_whitecap_external_background_rotation'))
        self.assertEqual(Engine().RenderFrame(0),'frame')
        self.assertEqual(calls,[('render',0)])

    def test_three_entries_rotate_once_each_then_wrap(self):
        Engine,pkg,calls=self.fixture('nasa-layers');engine=Engine()
        self.assertEqual(len(pkg.entries),3)
        self.assertTrue(engine._rh_whitecap_external_background_rotation)
        for at in [0,1,19,20,39,40,59,60,61]:
            engine.mTimeIndex=at;engine.RenderFrame(at)
        self.assertEqual([v for kind,v in calls if kind=='background'],['A','B','C','A'])
        self.assertEqual(engine._rh_nasa_layers_rotation_v1['changes'],4)
        self.assertNotIn(('background','Existing'),calls)

    def test_incomplete_collection_fails_instead_of_falling_back(self):
        Engine,pkg,calls=self.fixture('nasa-layers');engine=Engine()
        engine.GetConfigSetList=lambda kind:[]
        with self.assertRaisesRegex(RuntimeError,'three NASA'):engine.RenderFrame(0)
        self.assertEqual(calls,[])

if __name__=='__main__':unittest.main()
