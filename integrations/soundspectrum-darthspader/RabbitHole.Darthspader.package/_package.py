# Original removable Rabbit Hole package. Loaded by SoundSpectrum's host.
def ExportPackage(inPathname):
    pkg = VisPackage(inPathname)
    pkg.DefaultEntryConfigType = 'WaveShape'
    pkg.EntryRegex = r'(.*)\.(txt)$'
    pkg.AddEntryTree('WaveShapes', {'ConfigType': 'WaveShape'})
    pkg.AddEntryTree('ColorMaps', {'ConfigType': 'ColorMap'})
    pkg.AddEntryTree('FlowFields', {'ConfigType': 'FlowField'})
    return pkg
