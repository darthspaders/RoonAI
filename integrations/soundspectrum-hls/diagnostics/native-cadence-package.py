# Temporary, process-opt-in Python 2.7 SoundSpectrum diagnostic.
# Counts engine RenderFrame callbacks, not GPU presentation or unique pixels.
import os
import time
from SSEngine import EngineInstance
from SoundSpectrum import GetPref

# The bundled Python omits json. Values here are fixed ASCII diagnostic fields.
def encode(value):
    if value is True: return 'true'
    if value is False: return 'false'
    if isinstance(value, dict):
        return '{' + ','.join(encode(k) + ':' + encode(v) for k, v in value.items()) + '}'
    if isinstance(value, basestring):
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return str(value)

def ExportPackage(inPathname):
    pkg = VisPackage(inPathname)
    output = os.environ.get('RH_NATIVE_CADENCE_OUTPUT', '')
    token = os.environ.get('RH_NATIVE_CADENCE_TOKEN', '')
    if not output or len(token) != 36 or hasattr(EngineInstance, '_rh_cadence_probe'):
        return pkg
    info = {'event': 'loaded', 'pid': os.getpid(), 'token': token, 'utc': time.time()}
    try:
        import ctypes
        info['ctypes'] = True
    except ImportError:
        info['ctypes'] = False
    with open(output, 'ab') as stream:
        stream.write(encode(info) + '\n')
    original = EngineInstance.RenderFrame
    start = time.clock()
    state = {'last': None, 'since': start, 'frames': 0, 'work': 0.0, 'gaps': {}, 'sleepProbed': False}
    def render(engine, at):
        now = time.clock()
        if now - start > 15 and not state['sleepProbed']:
            state['sleepProbed'] = True
            # One bounded three-millisecond requested wait, separately labelled.
            # This sample is a diagnostic perturbation, not a normal render cost.
            waits = {}
            for i in range(3):
                begin = time.clock()
                time.sleep(0.001)
                waits[str(i)] = (time.clock() - begin) * 1000
            with open(output, 'ab') as stream:
                stream.write(encode({'event': 'sleep-probe', 'pid': os.getpid(), 'token': token,
                                     'utc': time.time(), 'requestedMs': 1, 'observedMs': waits}) + '\n')
        if now - start > 90:
            EngineInstance.RenderFrame = original
            return original(engine, at)
        if state['last'] is not None:
            gap = str(int(round((now - state['last']) * 1000)))
            state['gaps'][gap] = state['gaps'].get(gap, 0) + 1
        state['last'] = now
        try:
            return original(engine, at)
        finally:
            state['frames'] += 1
            state['work'] += time.clock() - now
            elapsed = now - state['since']
            if elapsed >= 1:
                record = {'event': 'render', 'pid': os.getpid(), 'token': token,
                          'utc': time.time(), 'seconds': elapsed,
                          'fps': state['frames'] / elapsed, 'frames': state['frames'],
                          'targetFps': GetPref('Graphics.TargetFrameRate'),
                          'syncFrames': GetPref('Graphics.SyncFramesWithRefresh'),
                          'meanRenderCallbackMs': state['work'] * 1000 / state['frames'],
                          'gapHistogramMs': state['gaps']}
                with open(output, 'ab') as stream:
                    stream.write(encode(record) + '\n')
                state['since'] = now
                state['frames'] = 0
                state['work'] = 0.0
                state['gaps'] = {}
    EngineInstance._rh_cadence_probe = True
    EngineInstance.RenderFrame = render
    return pkg
