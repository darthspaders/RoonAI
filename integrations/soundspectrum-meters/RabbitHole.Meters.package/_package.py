# Original removable meters; only WaveShape and optional matching ColorMap.
def ExportPackage(inPathname):
    pkg = VisPackage(inPathname)
    pkg.DefaultEntryConfigType = 'WaveShape'
    pkg.EntryRegex = r'(.*)\.(txt)$'
    pkg.AddEntryTree('WaveShapes', {'ConfigType': 'WaveShape'})
    pkg.AddEntryTree('ColorMaps', {'ConfigType': 'ColorMap'})
    return pkg
