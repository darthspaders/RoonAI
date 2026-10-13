import hashlib, tempfile, unittest
from pathlib import Path
from PIL import Image, ImageDraw
from expressive import prepare

class Preparation(unittest.TestCase):
    def test_source_is_unchanged_and_maps_are_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'image.jpg';out=root/'map.json'
            im=Image.new('RGB',(3840,2160),(40,25,15));draw=ImageDraw.Draw(im)
            for x,y in [(500,500),(1300,1300),(2600,1700)]:draw.ellipse((x-12,y-12,x+12,y+12),fill='white')
            im.save(source);before=source.read_bytes();result=prepare(source,out)
            self.assertEqual(source.read_bytes(),before);self.assertEqual(result['sourceSha256'],hashlib.sha256(before).hexdigest())
            self.assertGreater(len(result['stars']),0);self.assertLessEqual(len(result['stars']),24)
            self.assertEqual(len(result['grid'][2]),375);self.assertTrue(all(0<=w<=1 for w in result['grid'][2]))
            self.assertTrue(all(w==0 for i,w in enumerate(result['grid'][2]) if i<25 or i>=350 or i%25 in (0,24)))
    def test_empty_image_does_not_invent_stars(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'black.jpg';Image.new('RGB',(3840,2160)).save(source)
            result=prepare(source,Path(d)/'map.json');self.assertEqual(result['stars'],[]);self.assertFalse(any(result['grid'][2]))
    def test_requires_exact_prepared_4k(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'small.jpg';Image.new('RGB',(1920,1080)).save(source)
            with self.assertRaisesRegex(ValueError,'requires_prepared_4k'):prepare(source,Path(d)/'map.json')

if __name__=='__main__':unittest.main()
