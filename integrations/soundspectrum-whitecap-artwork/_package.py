# -*- coding: utf-8 -*-
"""Rabbit Hole's owned WhiteCap artwork background; metadata only, no audio IO."""
import os
import time
import threading
import SoundSpectrum as SS
from SSEngine import EngineInstance, RunningConfigGroup, SceneInstance
from SoundSpectrumDrawing import PushMatrix, PopMatrix, TexPushMatrix, TexPopMatrix

STATE_PATH = __RH_WHITE_ART_STATE__
NAME = 'Rabbit Hole - Floating Artwork'
ROTATION_SECONDS = 20.0
TRANSITION_SECONDS = 2.0
SENTINEL = '_rh_whitecap_artwork_v1'
MAX_STATE_BYTES = 8192
MAX_ART_BYTES = 2 * 1024 * 1024
STALE_MS = 8000
FUTURE_MS = 2000
try:
    STRING_TYPES = (basestring,)
    INTEGER_TYPES = (int, long)
    UNICODE_TYPE = unicode
    UNICODE_CHARACTER = unichr
except NameError:
    STRING_TYPES = (str,)
    INTEGER_TYPES = (int,)
    UNICODE_TYPE = str
    UNICODE_CHARACTER = chr

# Installer embeds the existing audited strict JSON/state/artwork validators.
__RH_READER_CODE__

class Reader(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.latest = None
        self.diagnostic = {'loaded': False, 'frames': 0, 'audio': 0, 'depth': 0, 'phase': 'reader', 'backgrounds': 0, 'changes': 0}
        self.thread = threading.Thread(target=self.run, name='RabbitHoleWhiteCapArtwork')
        self.thread.daemon = True
        self.thread.start()

    def run(self):
        global hashlib, re, stat
        try:
            import hashlib, re, stat
            while not self.stopping.is_set():
                try:
                    value = _read_state(STATE_PATH, int(time.time() * 1000), os.getpid())
                except Exception:
                    value = None
                with self.lock:
                    self.latest = value
                    diagnostic = dict(self.diagnostic)
                diagnostic.update({'pid': os.getpid(), 'active': value is not None,
                                   'updatedAt': int(time.time() * 1000)})
                try:
                    with open(os.path.join(os.path.dirname(STATE_PATH), 'native-status.json'), 'wb') as stream:
                        stream.write(_encode_scalars(diagnostic, ('pid', 'active', 'updatedAt', 'loaded', 'frames', 'audio', 'depth', 'phase', 'backgrounds', 'changes')))
                except Exception:
                    pass
                self.stopping.wait(0.5)
        except Exception:
            print('Rabbit Hole WhiteCap artwork reader unavailable')

    def snapshot(self):
        if not self.lock.acquire(False):
            return False, None
        try:
            return True, self.latest
        finally:
            self.lock.release()

    def report(self, loaded, frames, audio, depth):
        if self.lock.acquire(False):
            try:
                self.diagnostic.update({'loaded': bool(loaded), 'frames': int(frames),
                                   'audio': int(audio * 1000), 'depth': int(depth * 1000), 'phase': 'drawing'})
            finally:
                self.lock.release()

    def phase(self, value):
        if self.lock.acquire(False):
            try:
                self.diagnostic['phase'] = value[:160]
            finally:
                self.lock.release()

def release_scene(state):
    scene = state.get('scene')
    state['scene'] = None
    if scene is not None:
        scene.OnSceneComplete()


def restore(engine, state):
    release_scene(state)
    if state['owned'] and not state.get('external_rotation'):
        running = SS.Interpreter.GetRunningList('Background').splitlines()
        # Respect manual native background changes made during the session.
        if state.get('last') in running and not state.get('manual'):
            if state['previous']:
                engine.StartConfig('Background', state['previous'], 1.0)
            engine.SetSlideshowEnabled('Background', state['slideshow'])
    state['owned'] = False
    state['snapshot'] = None


def background_names(engine):
    # Bypass theme categories for this explicitly requested all-background tour.
    # Unavailable/special-use entries (including our art) never enter the cycle.
    names = sorted(set(entry.ConfigName for entry in engine.GetConfigSetList('Background')
                      if entry.ConfigName != NAME and entry.ConfigFlags & 1
                      and not entry.ConfigFlags & 2))
    # NASA photographs are normal Background configs. Distribute them through
    # the same tour instead of clustering their alphabetically adjacent names.
    native = [name for name in names if not name.startswith('NASA - ')]
    space = [name for name in names if name.startswith('NASA - ')]
    if not native or not space:
        return names
    mixed = []
    used = 0
    for index, name in enumerate(native):
        mixed.append(name)
        target = ((index + 1) * len(space)) // len(native)
        while used < target:
            mixed.append(space[used])
            used += 1
    return mixed


def update(engine):
    if engine.PRODUCT_NAME != 'WhiteCap' or engine.HOST_NAME != 'Standalone':
        return
    state = getattr(engine, SENTINEL, None)
    if state is None:
        state = {'reader': Reader(), 'path': STATE_PATH, 'snapshot': None,
                 'owned': False, 'previous': None, 'slideshow': False,
                 'blocked': False, 'scene': None, 'manual': False}
        setattr(engine, SENTINEL, state)
    changed, value = state['reader'].snapshot()
    if changed:
        state['snapshot'] = value
    value = state['snapshot']
    if value is not None and not _fresh(value['updatedAt'], int(time.time() * 1000)):
        value = None
    if value is None:
        restore(engine, state)
        state['blocked'] = False
        return
    if not state['owned'] and not state['blocked']:
        running = SS.Interpreter.GetRunningList('Background').splitlines()
        state['previous'] = next((name for name in running if name != NAME), None)
        state['last'] = state['previous']
        state['slideshow'] = engine.SlideshowEnabled('Background')
        state['manual'] = False
        state['owned'] = True
        state['external_rotation'] = getattr(engine, '_rh_whitecap_external_background_rotation', False) is True
        try:
            state['names'] = list(getattr(engine, '_rh_whitecap_external_background_names', ())) if state['external_rotation'] else background_names(engine)
            state['index'] = state['names'].index(state['last']) if state['last'] in state['names'] else -1
            state['next'] = engine.mTimeIndex + ROTATION_SECONDS
            state['changes'] = 0
            if not state['external_rotation']:
                engine.SetSlideshowEnabled('Background', False)
            # A separate scene survives changes in the ordinary Background group.
            layers = engine.GetConfigSet('Background').InvokeConfig(NAME)
            scene = SceneInstance(engine)
            scene.InitScene(layers, NAME, engine.mTimeIndex, 1.0)
            state['scene'] = scene
            state['reader'].phase('layered')
        except Exception as error:
            state['reader'].phase('start:' + type(error).__name__)
            restore(engine, state)
            state['blocked'] = True
            return
    if state['owned'] and not state.get('external_rotation') and not state['manual'] and engine.mTimeIndex >= state['next']:
        running = SS.Interpreter.GetRunningList('Background').splitlines()
        if state['last'] and state['last'] not in running:
            state['manual'] = True
            engine.SetSlideshowEnabled('Background', state['slideshow'])
            return
        state['next'] = engine.mTimeIndex + ROTATION_SECONDS
        if state['names']:
            state['index'] = (state['index'] + 1) % len(state['names'])
            name = state['names'][state['index']]
            engine.StartConfig('Background', name, TRANSITION_SECONDS)
            state['last'] = name
            state['changes'] += 1
    reader = state['reader']
    if state['owned'] and reader.lock.acquire(False):
        try:
            reader.diagnostic.update({'backgrounds': len(state['names']), 'changes': state['changes']})
        finally:
            reader.lock.release()


def draw_artwork(group, audio):
    engine = group.mEngine
    if group.ConfigTypeName != 'Background' or engine.PRODUCT_NAME != 'WhiteCap' or engine.HOST_NAME != 'Standalone':
        return
    state = getattr(engine, SENTINEL, None)
    if not state or not state.get('scene') or not state.get('snapshot'):
        return
    if not _fresh(state['snapshot']['updatedAt'], int(time.time() * 1000)):
        return
    scene = state['scene']
    scene.UpdateTimeIndex(engine.mTimeIndex, 1.0)
    # RenderScene resets graphics state and working paths for this owned layer.
    # Backgrounds draw first; WhiteCap draws its foreground waveform afterward.
    PushMatrix()
    TexPushMatrix()
    try:
        scene.RenderScene(audio)
    finally:
        TexPopMatrix()
        PopMatrix()


def ExportPackage(inPathname):
    hook = SENTINEL + '_hooks'
    if not hasattr(EngineInstance, hook):
        original_render = EngineInstance.RenderFrame
        original_shutdown = EngineInstance.OnShutdown
        original_group_render = RunningConfigGroup.RenderGroup
        def render_group(group, audio, color):
            result = original_group_render(group, audio, color)
            try:
                draw_artwork(group, audio)
            except Exception as error:
                state = getattr(group.mEngine, SENTINEL, None)
                if state:
                    state['reader'].phase('layer:' + type(error).__name__)
            return result
        def render(engine, at):
            result = original_render(engine, at)
            try:
                update(engine)
            except Exception as error:
                state = getattr(engine, SENTINEL, None)
                if state:
                    state['reader'].phase('update:' + type(error).__name__)
            return result
        def shutdown(engine):
            state = getattr(engine, SENTINEL, None)
            if state is not None:
                state['reader'].stopping.set()
                try:
                    restore(engine, state)
                except Exception:
                    pass
            return original_shutdown(engine)
        setattr(EngineInstance, hook, True)
        EngineInstance.RenderFrame = render
        EngineInstance.OnShutdown = shutdown
        RunningConfigGroup.RenderGroup = render_group
    pkg = VisPackage(inPathname)
    pkg.DefaultEntryConfigType = 'Background'
    pkg.EntryRegex = r'(Rabbit Hole - Floating Artwork)\.py$'
    # Special-use entries must not enter WhiteCap's ordinary random slideshow.
    pkg.AddEntryMatches('.', inAdditionalConfigFlags=2)
    return pkg
