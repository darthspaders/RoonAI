import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
import masks
import worker

def field():
    yy,xx=np.mgrid[:512,:512]
    lum=np.full((512,512),.035,np.float32)
    rng=np.random.default_rng(48)
    for j,y in enumerate(range(60,470,80)):
        for i,x in enumerate(range(60,470,80)):
            px=x+int(rng.integers(-14,15));py=y+int(rng.integers(-14,15))
            kind=(i+j)%3
            sigma=(1.5,2.8,5.5)[kind]
            amplitude=(.85,.96,.96)[kind]
            lum+=amplitude*np.exp(-((xx-px)**2+(yy-py)**2)/(2*sigma*sigma))
    return np.repeat(np.clip(lum,0,1)[:,:,None],3,axis=2)

class MasksTests(unittest.TestCase):
    def test_clean_stars_are_measured_without_rank_quotas(self):
        image=field();before=image.copy();layers,stars,q=masks.detect(image)
        self.assertEqual(q['status'],'candidate');self.assertGreaterEqual(len(stars),20)
        self.assertLessEqual(len(stars),36)
        self.assertGreater(len({p['group'] for p in stars}),1)
        self.assertTrue(all(p['diameter']>0 and p['contrast']>.26 for p in stars))
        np.testing.assert_array_equal(image,before)
        self.assertLessEqual(float(np.sum(layers,axis=0).max()),1.00001)
        delta=sum(image*(1-image)*a[:,:,None]*g for a,g in zip(layers,masks.GAINS))
        self.assertLessEqual(float(delta.max()),.03001)
        self.assertTrue(all(np.isfinite(a).all() for a in layers))

    def test_ridges_and_diffraction_lines_are_not_star_cores(self):
        yy,xx=np.mgrid[:256,:256]
        ridge=(.03+.95*np.exp(-((yy-128-.2*(xx-128))**2)/(2*2**2))).astype(np.float32)
        p,_=masks.measure(ridge,masks.blur(ridge,.65),128,128)
        self.assertIsNone(p)
        fragment=(.03+.95*np.exp(-((xx-128)**2/50**2+(yy-128)**2/1.2**2)/2)).astype(np.float32)
        p,_=masks.measure(fragment,masks.blur(fragment,.65),128,128)
        self.assertIsNone(p)

    def test_noise_and_blank_fall_back_to_static(self):
        rng=np.random.default_rng(12)
        for rgb in [np.zeros((512,512,3),np.float32),np.clip(rng.normal(.1,.007,(512,512,3)),0,1).astype(np.float32)]:
            layers,_,q=masks.detect(rgb)
            self.assertEqual(q['status'],'static');self.assertEqual(sum(a.sum() for a in layers),0)

    def test_too_few_stars_cannot_enable_cloud_mask(self):
        rgb=field();rgb[:400]=.035;rgb[:,200:]=.035
        layers,_,q=masks.detect(rgb)
        self.assertEqual(q['status'],'static');self.assertTrue(all(not a.any() for a in layers))

    def test_invalid_pixels_fail_closed(self):
        bad=field();bad[0,0,0]=np.nan
        with self.assertRaises(ValueError):masks.detect(bad)

    def test_colorful_knots_are_conservatively_rejected(self):
        rgb=field();rgb[:,:,2]*=.2
        _,stars,q=masks.detect(rgb)
        self.assertEqual(q['status'],'static');self.assertFalse(stars)

    def test_scene_admission_does_not_treat_galaxies_as_nebulae(self):
        self.assertFalse(worker.eligible({'title':'Webb First Deep Field'})[0])
        self.assertFalse(worker.eligible({'title':'Cartwheel Galaxy'})[0])
        self.assertTrue(worker.eligible({'title':'Cosmic Cliffs in the Carina Nebula'})[0])

    def test_cache_source_integrity_and_static_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);lib=root/'library';out=root/'candidates';lib.mkdir()
            source=lib/'input.jpg';Image.new('RGB',(3840,2160),(3,3,3)).save(source)
            sha=worker.digest(source);source.rename(lib/(sha+'.jpg'))
            entry=dict(id='nasa-science-1',file=sha+'.jpg',sha256=sha,title='Nebula',target='Nebula')
            manifest=lib/'library.json';manifest.write_text(json.dumps({'entries':[entry]}))
            with patch.object(worker,'LIB',lib),patch.object(worker,'OUTPUT',out):
                report,cached=worker.build(entry['id'])
                self.assertFalse(cached);self.assertEqual(report['status'],'static')
                self.assertFalse(report['enabled']);self.assertTrue(report['reviewRequired'])
                self.assertFalse(any(n.startswith('reactive-') for n in report['files']))
                self.assertEqual(worker.digest(lib/(sha+'.jpg')),sha)
                self.assertTrue(worker.build(entry['id'])[1])
                folder=next(out.iterdir());(folder/'detections.jpg').write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError,'cache hash'):worker.build(entry['id'])
                entry['sha256']='0'*64;manifest.write_text(json.dumps({'entries':[entry]}))
                with self.assertRaisesRegex(ValueError,'source hash'):worker.build(entry['id'])

if __name__=='__main__':unittest.main()
