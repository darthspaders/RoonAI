# Python 2.7. An explicit per-process selection; no saved theme/preference edits.
import os
import time
from SSEngine import EngineInstance

TARGETS = __TARGETS__
ACTIVE = os.environ.get('RABBIT_HOLE_WHITECAP_THEME', 'current') == 'nasa-layers'
SENTINEL = '_rh_nasa_layers_rotation_v1'
DIAGNOSTIC = __DIAGNOSTIC__

def rotate(engine):
    if engine.PRODUCT_NAME != 'WhiteCap' or engine.HOST_NAME != 'Standalone':
        return
    state = getattr(engine, SENTINEL, None)
    if state is None:
        available = set(entry.ConfigName for entry in engine.GetConfigSetList('Background') if entry.ConfigFlags & 1)
        if len(TARGETS) != 3 or any(name not in available for name in TARGETS):
            raise RuntimeError('The three NASA layer backgrounds are unavailable')
        state = {'index': -1, 'next': engine.mTimeIndex, 'changes': 0}
        setattr(engine, SENTINEL, state)
    engine.SetSlideshowEnabled('Background', False)
    if engine.mTimeIndex >= state['next']:
        state['index'] = (state['index'] + 1) % len(TARGETS)
        engine.StartConfig('Background', TARGETS[state['index']], 0.0 if state['index'] == 0 and state['changes'] == 0 else 2.0)
        state['next'] = engine.mTimeIndex + 20.0
        state['changes'] += 1
        try:
            # One bounded receipt on each selection, containing no private metadata.
            with open(DIAGNOSTIC, 'wb') as stream:
                stream.write(('{"pid":%d,"index":%d,"changes":%d,"backgrounds":3,"updatedAt":%d}' %
                              (os.getpid(), state['index'], state['changes'], int(time.time() * 1000))).encode('ascii'))
        except (IOError, OSError):
            pass

def ExportPackage(inPathname):
    pkg = VisPackage(inPathname)
    pkg.DefaultEntryConfigType = 'Background'
    # Normal launches register no entries and install no hooks. The startup theme
    # and Rabbit Hole's all-background tour never discover these pilot scenes.
    if not ACTIVE:
        return pkg
    for name, script in __ENTRIES__:
        pkg.AddEntry(name.encode('utf-8'), script.encode('utf-8'))
    hook = SENTINEL + '_hook'
    if not hasattr(EngineInstance, hook):
        original = EngineInstance.RenderFrame
        def render(engine, at):
            rotate(engine)
            return original(engine, at)
        # Artwork still draws, but its normal background tour yields ownership.
        EngineInstance._rh_whitecap_external_background_rotation = True
        EngineInstance._rh_whitecap_external_background_names = tuple(TARGETS)
        setattr(EngineInstance, hook, True)
        EngineInstance.RenderFrame = render
    return pkg
