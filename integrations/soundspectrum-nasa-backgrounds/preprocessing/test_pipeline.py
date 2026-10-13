import unittest, tempfile, json
from pathlib import Path
from PIL import Image
from pipeline import prepare, digest

class Preparation(unittest.TestCase):
    def test_portrait_keeps_subject_and_source_and_does_not_stretch(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);Image.new('RGB',(3000,5000),(120,80,50)).save(p/'download.bin',format='JPEG')
            before=digest(p/'download.bin');r=prepare(p)
            self.assertEqual(before,digest(p/'download.bin'))
            self.assertEqual(r['fit'],'contain-preserve-subject')
            with Image.open(p/'background-4k.jpg') as im:
                self.assertEqual(im.size,(3840,2160));self.assertLess(max(im.getpixel((20,1080))),5)
                self.assertGreater(im.getpixel((1920,1080))[0],110)
            self.assertEqual(r['retainedDimensions'],[3000,5000])
    def test_low_resolution_is_not_upscaled(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);Image.new('RGB',(1920,1080)).save(p/'download.bin',format='JPEG')
            with self.assertRaisesRegex(ValueError,'insufficient_resolution'):prepare(p)
            self.assertFalse((p/'prepared.json').exists())
    def test_near_widescreen_crop_is_bounded_and_receipted(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);Image.new('RGB',(4000,2250),(30,80,100)).save(p/'download.bin',format='PNG')
            r=prepare(p);self.assertEqual(r['fit'],'center-crop-under-4-percent')
            self.assertEqual(r['files']['background-4k.jpg'],digest(p/'background-4k.jpg'))
            self.assertEqual(json.loads((p/'prepared.json').read_text())['version'],r['version'])
            # Signature orientation must match the already-installed legacy library.
            im=Image.open(p/'background-4k.jpg').resize((17,16)).convert('L')
            v=list(im.get_flattened_data())
            legacy='%064x'%int(''.join('1' if v[y*17+x]>v[y*17+x+1] else '0' for y in range(16) for x in range(16)),2)
            self.assertEqual(r['perceptualHash'],legacy)

if __name__=='__main__':unittest.main()
