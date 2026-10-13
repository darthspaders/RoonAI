import unittest
import numpy as np
from curated import layers_for
from masks import GAINS

class CuratedTests(unittest.TestCase):
    def test_partial_layers_do_not_require_a_star_quota(self):
        rgb=np.full((120,200,3),.4,np.float32)
        before=rgb.copy()
        layers=layers_for(rgb,[],[[.5,.5,.3,.3,0,.3]])
        self.assertTrue(all(np.count_nonzero(m)==0 for m in layers[:3]))
        self.assertGreater(layers[3].max(),.1)
        self.assertEqual(layers[3][0,0],0)
        np.testing.assert_array_equal(before,rgb)

    def test_star_only_is_local_and_has_no_diffuse_layer(self):
        rgb=np.full((120,200,3),.3,np.float32)
        p=dict(x=100,y=60,diameter=4,group='medium')
        layers=layers_for(rgb,[p],[])
        self.assertEqual(layers[1][60,100],1)
        self.assertEqual(layers[0].max(),0)
        self.assertEqual(layers[2].max(),0)
        self.assertEqual(layers[3].max(),0)
        self.assertEqual(layers[1][60,150],0)

    def test_dark_padding_overlap_and_gain_bound(self):
        rgb=np.full((120,200,3),.5,np.float32);rgb[:,:25]=0
        stars=[dict(x=100,y=60,diameter=7,group=g) for g in ('small','medium','large')]
        layers=layers_for(rgb,stars,[[.5,.5,.5,.5,0,.4]])
        self.assertLessEqual(np.max(np.sum(layers,axis=0)),1.00001)
        self.assertTrue(all(np.count_nonzero(m[:,:25])==0 for m in layers))
        delta=sum(rgb*(1-rgb)*m[:,:,None]*g for m,g in zip(layers,GAINS))
        self.assertLessEqual(delta.max(),.03001)

    def test_invalid_region_rejected(self):
        with self.assertRaises(ValueError):layers_for(np.ones((50,50,3),np.float32)*.5,[],[[.5,.5,.3,.3,0,1]])

if __name__=='__main__':unittest.main()
