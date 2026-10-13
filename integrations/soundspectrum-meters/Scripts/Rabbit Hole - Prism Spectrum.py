# Optional manually invoked preset: native spectrum and matching shared palette.
# Does not change theme membership, slideshow timings, particles or artwork.
@_time('0:00')
def meter_preset():
    vis.StartConfig('WaveShape', 'Rabbit Hole - Prism Spectrum', 0)
    vis.StartConfig('ColorMap', 'Rabbit Hole - Prism Spectrum', 0)
