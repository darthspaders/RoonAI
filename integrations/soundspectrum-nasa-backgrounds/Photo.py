# Native WhiteCap background: reuse the installed image renderer, not a new
# drawing/animation pipeline. The ordinary Background group owns crossfades.
Include('/Packages/WhiteCap.Background.package/Slideshow.lib.py')

class SpaceImage(SlideshowImage):
    # Include() can redefine SlideshowImage while an older scene is drawing.
    # Keep the method from THIS base class; a fresh global lookup would call
    # another Python 2 class's unbound method with an incompatible instance.
    _native_coordinates = SlideshowImage.ComputeTextureCoordinates

    def ComputeTextureCoordinates(self, time, t):
        # Finish a very small native pan/zoom over the normal 20-second slot.
        return self._native_coordinates(time, min(1.0, t * 180.0))

class SpaceBackground(object):
    def __init__(self, image_class=SpaceImage, image_path=IMAGE_PATH):
        # Capture this generated scene's factory and asset before another load.
        self.image = image_class()
        self.image.SetImage(image_path.encode('utf-8'), 3600.0, 0.0)
        self.image.startscale = 1.0
        self.image.endscale = 0.975
        self.image.startoffset = [0.5, 0.5]
        self.image.endoffset = [0.6, 0.4]

    def Draw(self, time, dt, inAudio):
        Set2DCamera(ss_Crop)
        self.image.Draw(time, dt, inAudio)

SetDrawClass(SpaceBackground)
