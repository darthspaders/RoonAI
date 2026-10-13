import unittest
import numpy as np
from cloud_motion import prepare_light

class CloudLight(unittest.TestCase):
    def test_requires_existing_emission_and_keeps_padding_black(self):
        rgb=np.full((1080,1920,3),.4,np.float32);rgb[:,:100]=0
        empty,grid=prepare_light(rgb,np.zeros_like(rgb))
        self.assertEqual(float(empty.max()),0);self.assertEqual(float(grid.max()),0)
        emission=np.zeros_like(rgb);emission[300:800,400:1500]=.10
        light,grid=prepare_light(rgb,emission)
        self.assertEqual(float(light[:,:126].max()),0)
        self.assertEqual(float(light[:26].max()),0)
        self.assertEqual(float(light[-26:].max()),0)
        self.assertGreater(float(light[550,900].mean()),.09)
        self.assertTrue(np.isfinite(light).all());self.assertLessEqual(float(light.max()),.16001)
        self.assertEqual(grid.shape,(19,33));self.assertLessEqual(float(grid.max()),.92001)
        self.assertEqual(float(grid[[0,-1]].max()),0)

    def test_single_sharp_peak_cannot_become_a_moving_star(self):
        rgb=np.full((1080,1920,3),.4,np.float32)
        emission=np.zeros_like(rgb);emission[540,960]=1
        light,grid=prepare_light(rgb,emission)
        self.assertLess(float(light.max()),.001)
        self.assertEqual(float(grid.max()),0)

if __name__=='__main__':unittest.main()
