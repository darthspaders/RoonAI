"""Offline native add-on tests: in-memory files, clocks, threads and renderer."""

import builtins
import hashlib
import io
import json
import posixpath
import stat
from pathlib import Path
from types import SimpleNamespace
import unittest

SOURCE_PATH = Path(__file__).parent / 'RabbitHole.NowPlaying.package' / '_package.py'
SOURCE = SOURCE_PATH.read_text(encoding='utf-8')
STATE = 'C:/stub/now-playing/now-playing.json'
DIAGNOSTIC = 'C:/stub/now-playing/native-status.json'
BOOTSTRAP = 'C:/stub/now-playing/native-bootstrap.json'
LAST_DISPLAY = 'C:/stub/now-playing/native-last-display.json'


class MemoryFile(io.BytesIO):
    def __init__(self, filesystem, pathname, mode):
        self.filesystem, self.pathname, self.mode = filesystem, pathname, mode
        if 'r' in mode and pathname not in filesystem.files:
            raise IOError('Missing stub file')
        super().__init__(filesystem.files[pathname] if 'r' in mode else b'')

    def close(self):
        if not self.closed and 'w' in self.mode:
            self.filesystem.files[self.pathname] = self.getvalue()
            callback = self.filesystem.on_write.pop(self.pathname, None)
            if callback is not None:
                callback()
        super().close()


class FakeLock:
    def __init__(self):
        self.held = False

    def acquire(self, blocking=True):
        if self.held:
            if blocking:
                raise AssertionError('Stub would block')
            return False
        self.held = True
        return True

    def release(self):
        self.held = False

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


class FakeEvent:
    def __init__(self):
        self.value = False

    def set(self):
        self.value = True

    def is_set(self):
        return self.value

    def wait(self, duration):
        return self.value


class FakeOS:
    name = 'nt'

    def __init__(self, fixture):
        self.fixture = fixture
        self.files, self.links, self.redirects = {}, set(), {}
        self.write_error = False
        self.denied_paths = set()
        self.on_write = {}
        self.io_calls, self.replacements = [], []
        self.path = SimpleNamespace(
            join=posixpath.join, dirname=posixpath.dirname, normcase=lambda value: value,
            realpath=lambda value: self.redirects.get(value, posixpath.normpath(value)),
            islink=lambda value: value in self.links)

    def assert_worker(self):
        if self.fixture.phase != 'worker':
            raise AssertionError('Filesystem used outside worker')

    def getpid(self):
        return 4242

    def lstat(self, pathname):
        self.assert_worker()
        self.io_calls.append(('stat', pathname))
        if pathname not in self.files:
            raise IOError('Missing stub file')
        return SimpleNamespace(st_mode=stat.S_IFREG, st_size=len(self.files[pathname]))

    def open(self, pathname, mode):
        bootstrap = posixpath.join(posixpath.dirname(self.fixture.state_path), 'native-bootstrap.json')
        if not (self.fixture.phase in ('setup', 'startup') and pathname == bootstrap and mode == 'wb'):
            self.assert_worker()
        self.io_calls.append((mode, pathname))
        if 'w' in mode and (self.write_error or pathname in self.denied_paths):
            raise IOError('Stub write denied')
        return MemoryFile(self, pathname, mode)

    def replace(self, old, new):
        self.assert_worker()
        self.replacements.append((old, new))
        self.files[new] = self.files.pop(old)

    def remove(self, pathname):
        self.assert_worker()
        self.files.pop(pathname, None)


class Fixture:
    def __init__(self, rendered=True, product='G-Force', host='Standalone', missing_modules=(), thread_failure='', state_path=STATE):
        self.phase = 'setup'
        self.state_path = state_path
        self.now = 1000.0
        self.native, self.threads, self.vendor = [], [], []
        self.fail = None
        self.original_error = False
        self.startup_error = False
        self.imports = []
        self.missing_modules = set(missing_modules)
        self.thread_failure = thread_failure
        self.thread_attempts = 0
        self.printed = []
        self.native_unavailable = False
        self.registry_paths = []
        self.native_paths = []
        self.resolved_path = None
        self.component_tamper = None
        self.os = FakeOS(self)
        self.packages = {}
        fixture = self

        class Package:
            def __init__(self, pathname):
                self.PkgPathname = pathname
                self.PackageName = posixpath.basename(pathname.rstrip('/'))
                self.EntryList = []
                self.entries = []

            def AddEntry(self, name, relative, args, flags):
                fixture.native_call('AddEntry', name, relative, args, flags)
                self.EntryList.append((name, relative, args, flags))
                component = SimpleNamespace(mPathname=self.PkgPathname + relative)
                entry = SimpleNamespace(ConfigFlags=1 | flags, EntryComponentList=[component])
                self.entries.append(entry)
                return entry

        def create_sprite_package(pathname):
            fixture.native_call('CreateSpritePackage', pathname)
            return Package(pathname)

        class Manager:
            def GetPackageByName(self, name):
                return fixture.packages.get(name)

            def RegisterPackage(self, package):
                fixture.native_call('RegisterPackage', package.PackageName)
                fixture.packages[package.PackageName] = package
                for entry in package.entries:
                    # Model the vendor FinalizeEntry native lookup, rather than
                    # accepting the private Python worker's path as native.
                    pathname = entry.EntryComponentList[0].mPathname
                    fixture.registry_paths.append(pathname)
                    # Static native handler strips file://, then accepts a
                    # slash-prefixed volume path; real registration still needs QA.
                    volume = pathname[len('file://'):] if pathname.startswith('file:///Volumes/') else ''
                    local = volume[9] + ':/' + volume[11:] if volume else ''
                    exists = any(filename.casefold() == local.casefold() for filename in fixture.os.files)
                    if fixture.native_unavailable or not exists:
                        entry.ConfigFlags &= ~1
                    if fixture.component_tamper:
                        fixture.component_tamper(entry)

            def UnregisterPackage(self, name):
                fixture.native_call('UnregisterPackage', name)
                fixture.packages.pop(name, None)

        class Engine:
            PRODUCT_NAME, HOST_NAME = product, host

            def RenderFrame(self, value):
                fixture.vendor.append(('frame', value))
                if fixture.original_error:
                    raise ValueError('Vendor render failure')
                return 'vendor-render'

            def OnShutdown(self):
                fixture.vendor.append(('shutdown',))
                return 'vendor-shutdown'

            def OnStartup(self):
                fixture.vendor.append(('startup',))
                if fixture.startup_error:
                    raise ValueError('Vendor startup failure')
                return 'vendor-startup'

            def RebuildConfigList(self, kind):
                fixture.native_call('RebuildConfigList', kind)
                for package in fixture.packages.values():
                    for entry in getattr(package, 'entries', []):
                        fixture.native_paths.append(entry.EntryComponentList[0].mPathname)

            def StartSprite(self, *args):
                fixture.native_call('StartSprite', *args)

            def KillSprites(self, *args):
                fixture.native_call('KillSprites', *args)

            def StartTextOverlay(self, *args):
                fixture.native_call('StartTextOverlay', *args)

            def ExecuteCmdStr(self, command):
                fixture.native_call('ExecuteCmdStr', command)

        class Thread:
            def __init__(self, target, name):
                fixture.thread_attempts += 1
                if fixture.thread_failure == 'construct':
                    raise RuntimeError('Private thread construction failure')
                self.target, self.name, self.daemon, self.started = target, name, False, False
                fixture.threads.append(self)

            def start(self):
                if fixture.thread_failure == 'start':
                    raise RuntimeError('Private thread start failure')
                self.started = True

        self.Engine = Engine
        self.engine = Engine()
        self.original_render = Engine.RenderFrame
        self.manager = Manager()
        def resolve_path(pathname):
            self.native_call('ResolvePathname', pathname)
            return pathname[len('file://'):] if self.resolved_path is None else self.resolved_path
        self.ss = SimpleNamespace(
            Interpreter=SimpleNamespace(KillOverlay=lambda *args: self.native_call('KillOverlay', *args)),
            GetPackageMgr=lambda name: self.manager, ResolvePathname=resolve_path)
        mapping = {'os': self.os, 'SoundSpectrum': self.ss,
                   'SSEngine': SimpleNamespace(EngineInstance=Engine),
                   'GForce': SimpleNamespace(CreateGForceSpritePackage=create_sprite_package),
                   'threading': SimpleNamespace(Event=FakeEvent, Lock=FakeLock, Thread=Thread),
                   'time': SimpleNamespace(time=lambda: self.now)}
        real_import = builtins.__import__

        def import_stub(name, *args, **kwargs):
            self.imports.append((name, self.phase))
            if name in ('json', 'ctypes') or name in self.missing_modules:
                raise ImportError('Stub unavailable dependency')
            return mapping[name] if name in mapping else real_import(name, *args, **kwargs)

        fake_builtins = dict(vars(builtins), open=self.os.open, __import__=import_stub,
                             print=lambda message: self.printed.append(message))
        self.namespace = {'__builtins__': fake_builtins, 'VisPackage': Package}
        source = SOURCE.replace('__RH_NOWPLAYING_STATE_PATH__', repr(self.state_path)) if rendered else SOURCE
        exec(compile(source, str(SOURCE_PATH), 'exec'), self.namespace)
        self.package = self.namespace['ExportPackage']('C:/stub/RabbitHole.NowPlaying.package/')

    def native_call(self, name, *args):
        if self.phase != 'render':
            raise AssertionError('Native graphics call outside render thread')
        self.native.append((name,) + args)
        if name == self.fail:
            raise ValueError('Native stub failure')

    def calls(self, name):
        return [call for call in self.native if call[0] == name]

    @property
    def state(self):
        return getattr(self.engine, self.namespace['SENTINEL'])

    def frame(self):
        self.phase = 'render'
        try:
            return self.engine.RenderFrame(0.0)
        finally:
            self.phase = 'setup'

    def startup(self):
        self.phase = 'startup'
        try:
            return self.engine.OnStartup()
        finally:
            self.phase = 'setup'

    def read(self):
        self.phase = 'worker'
        try:
            self.state['reader']._read_once()
        finally:
            self.phase = 'setup'

    def publish_diagnostic(self):
        self.phase = 'worker'
        try:
            self.state['reader']._publish_diagnostic()
        finally:
            self.phase = 'setup'

    def artwork(self, suffix=b'first', extension='png'):
        contents = (b'\x89PNG\r\n\x1a\n' if extension == 'png' else b'\xff\xd8\xff') + suffix
        filename = 'artwork-%s.%s' % (hashlib.sha256(contents).hexdigest(), extension)
        self.os.files[posixpath.join(posixpath.dirname(self.state_path), filename)] = contents
        return {'file': filename, 'width': 600, 'height': 600}

    def payload(self, **kwargs):
        value = {'version': 1, 'updatedAt': int(self.now * 1000), 'active': True,
                 'nativePid': 4242, 'session': 'owned-session',
                 'track': {'key': 'a' * 64, 'title': 'Björk', 'artist': 'Artist',
                           'album': 'Album', 'artwork': self.artwork()}}
        value.update(kwargs)
        return value

    def put(self, value):
        self.os.files[self.state_path] = json.dumps(value, ensure_ascii=False).encode('utf-8')

    def activate(self, value=None):
        self.frame()
        self.put(self.payload() if value is None else value)
        self.read()
        self.frame()


class PackageTests(unittest.TestCase):
    def test_template_and_export_are_inert_until_owned_gforce_render(self):
        self.assertEqual(SOURCE.count('__RH_NOWPLAYING_STATE_PATH__'), 1)
        inert = Fixture(rendered=False)
        self.assertIs(inert.Engine.RenderFrame, inert.original_render)
        for product, host in [('WhiteCap', 'Standalone'), ('G-Force', 'Screen Saver')]:
            fixture = Fixture(product=product, host=host)
            self.assertEqual(fixture.frame(), 'vendor-render')
            self.assertEqual(fixture.threads, [])
        fixture = Fixture()
        self.assertEqual(fixture.package.EntryList, [])
        self.assertEqual(fixture.threads, [])
        self.assertEqual(json.loads(fixture.os.files[BOOTSTRAP])['stage'], 'hooks-installed')
        setup_io = list(fixture.os.io_calls)
        fixture.frame()
        self.assertEqual(len(fixture.threads), 1)
        self.assertTrue(fixture.threads[0].daemon)
        self.assertTrue(fixture.threads[0].started)
        self.assertEqual(fixture.os.io_calls, setup_io)

    def test_native_sprite_and_unicode_text_use_verified_vendor_arguments(self):
        fixture = Fixture()
        fixture.activate()
        sprite = fixture.calls('StartSprite')[0]
        self.assertEqual(sprite, ('StartSprite', fixture.namespace['SPRITE_NAME'], 31536000.0, 16397))
        overlay = fixture.calls('StartTextOverlay')[0]
        self.assertEqual(overlay[1], 'Björk\rArtist'.encode('utf-8'))
        self.assertEqual(overlay[2:], ('', 18, 1.0, 6.0, 2.0, 0.5, 0.86, -1.0, fixture.namespace['OVERLAY_ID']))
        self.assertEqual(set(fixture.packages), {fixture.namespace['ART_PACKAGE']})
        self.assertEqual(len(fixture.state['package'].EntryList), 1)
        self.assertEqual(fixture.state['package'].EntryList[0][3], 2)

    def test_sprite_forwards_available_canonical_vfs_unchanged_preserving_spaces_unicode(self):
        state_path = 'C:/stub/now playing/Björk/now-playing.json'
        fixture = Fixture(state_path=state_path)
        fixture.activate()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertEqual(fixture.registry_paths,
            ['file:///Volumes/C/stub/now playing/Björk/' + fixture.state['art'][0]])
        self.assertEqual(fixture.native_paths,
            ['file:///Volumes/C/stub/now playing/Björk/' + fixture.state['art'][0]])
        self.assertEqual(fixture.native_paths, fixture.registry_paths)
        self.assertEqual(fixture.calls('ResolvePathname'), [])
        self.assertLess(fixture.native.index(fixture.calls('RegisterPackage')[0]),
                        fixture.native.index(fixture.calls('RebuildConfigList')[0]))
        convert = fixture.namespace['_sprite_directory']
        self.assertEqual(convert('d:\\Music Folder\\Björk\\now-playing.json'), 'file:///Volumes/D/Music Folder/Björk/')
        self.assertEqual(convert('C:/now-playing.json'), 'file:///Volumes/C/')
        for invalid in ['//server/share/now-playing.json', '\\\\server\\share\\now-playing.json',
                        '/tmp/now-playing.json', 'C:relative/now-playing.json',
                        'C:/folder/../now-playing.json', 'file://C:/folder/now-playing.json']:
            with self.assertRaises(ValueError):
                convert(invalid)

    def test_unavailable_registered_sprite_is_cleaned_before_native_start(self):
        fixture = Fixture()
        fixture.native_unavailable = True
        fixture.activate()
        self.assertEqual(fixture.calls('StartSprite'), [])
        self.assertFalse(fixture.state['sprite_owned'])
        self.assertEqual(fixture.state['error'], 'art-availability')
        self.assertTrue(fixture.state['text_owned'])
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        self.assertEqual(fixture.calls('ResolvePathname'), [])
        self.assertEqual(fixture.packages, {})
        self.assertEqual(fixture.calls('UnregisterPackage'), [('UnregisterPackage', fixture.namespace['ART_PACKAGE'])])
        for _ in range(5):
            fixture.frame()
        self.assertEqual(len(fixture.calls('RegisterPackage')), 1)

    def test_sprite_never_uses_resolver_even_if_missing_failing_or_foreign(self):
        for form in ('missing', 'failing', 'foreign'):
            fixture = Fixture(state_path='C:/stub/now playing/Björk/now-playing.json')
            value = fixture.payload()
            relative = 'stub/now playing/Björk/' + value['track']['artwork']['file']
            if form == 'missing':
                del fixture.ss.ResolvePathname
            elif form == 'failing':
                fixture.fail = 'ResolvePathname'
            else:
                fixture.resolved_path = 'file:///Volumes/C/foreign.png'
            fixture.activate(value)
            self.assertTrue(fixture.state['sprite_owned'], form)
            self.assertEqual(fixture.native_paths, ['file:///Volumes/C/' + relative], form)
            self.assertEqual(fixture.calls('ResolvePathname'), [])
            self.assertEqual(fixture.state['error'], '', form)

    def test_foreign_component_rejections_cleanup_only_art_and_announce_title_once(self):
        for invalid in ('file://remotehost/Volumes/C/stub/now-playing/{file}', '\\\\server\\share\\{file}',
                        'C:/outside/{file}', 'C:stub/{file}', 'C:/stub/now-playing/../{file}',
                        '/Volumes/X/stub/now-playing/{file}', '/relative/{file}',
                        'C:/stub/now-playing/artwork-' + 'b' * 64 + '.png', '', 1, b'\xff'):
            fixture = Fixture()
            value = fixture.payload()
            pathname = invalid.format(file=value['track']['artwork']['file']) if isinstance(invalid, str) else invalid
            fixture.component_tamper = lambda entry: setattr(entry.EntryComponentList[0], 'mPathname', pathname)
            foreign = object()
            fixture.packages['User.Other.package'] = foreign
            fixture.activate(value)
            self.assertEqual(fixture.calls('StartSprite'), [], repr(invalid))
            self.assertEqual(fixture.state['error'], 'art-component', repr(invalid))
            self.assertTrue(fixture.state['text_owned'], repr(invalid))
            self.assertEqual(fixture.state['active_track'], ('owned-session', 'a' * 64))
            self.assertIs(fixture.packages['User.Other.package'], foreign)
            self.assertNotIn(fixture.namespace['ART_PACKAGE'], fixture.packages)
            for _ in range(5):
                fixture.frame()
            self.assertEqual(fixture.calls('ResolvePathname'), [])
            self.assertEqual(len(fixture.calls('RegisterPackage')), 1)
            self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
            fixture.now += 1
            fixture.publish_diagnostic()
            diagnostic = json.loads(fixture.os.files[DIAGNOSTIC])
            self.assertEqual(diagnostic['session'], 'owned-session')
            self.assertEqual(diagnostic['trackKey'], 'a' * 64)
            self.assertEqual(diagnostic['error'], 'art-component')
            self.assertFalse(diagnostic['spriteApplied'])
            self.assertTrue(diagnostic['trackOverlayApplied'])
            self.assertNotIn(b'file://', fixture.os.files[DIAGNOSTIC])

    def test_component_guard_rejects_tampered_or_multiple_components_before_native_start(self):
        for tamper in (lambda entry: setattr(entry.EntryComponentList[0], 'mPathname', 'file://C:/other.png'),
                       lambda entry: entry.EntryComponentList.append(SimpleNamespace(mPathname='file://C:/other.png'))):
            fixture = Fixture()
            fixture.component_tamper = tamper
            fixture.activate()
            self.assertEqual(fixture.calls('ResolvePathname'), [])
            self.assertEqual(fixture.calls('StartSprite'), [])
            self.assertEqual(fixture.state['error'], 'art-component')
            self.assertTrue(fixture.state['text_owned'])
            self.assertEqual(fixture.packages, {})

    def test_art_failure_heartbeats_remain_fresh_and_stale_or_stop_resets_suppression(self):
        fixture = Fixture()
        fixture.fail = 'StartSprite'
        value = fixture.payload()
        fixture.activate(value)
        fixture.now += 7
        value['updatedAt'] = int(fixture.now * 1000)
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertEqual(fixture.state['updatedAt'], value['updatedAt'])
        self.assertEqual(len(fixture.calls('StartSprite')), 1)
        fixture.state['reader'].lock.held = True
        fixture.now += 7
        fixture.frame()
        self.assertTrue(fixture.state['text_owned'])
        fixture.now += 2
        fixture.frame()
        self.assertFalse(fixture.state['text_owned'])
        self.assertIsNone(fixture.state['art_blocked'])
        fixture.state['reader'].lock.held = False
        fixture.fail = None
        fixture.put(fixture.payload())
        fixture.read()
        fixture.frame()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertEqual(len(fixture.calls('StartSprite')), 2)
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        fixture.put(fixture.payload(active=False))
        fixture.read()
        fixture.frame()
        self.assertIsNone(fixture.state['art_blocked'])
        self.assertEqual(fixture.state['error'], '')

    def test_art_failure_retries_new_art_or_session_without_replaying_existing_text(self):
        fixture = Fixture()
        fixture.fail = 'StartSprite'
        value = fixture.payload()
        fixture.activate(value)
        fixture.fail = None
        value['track']['artwork'] = fixture.artwork(b'new art')
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertEqual(fixture.state['error'], '')
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        value['session'] = 'next-session'
        value['track']['key'] = 'b' * 64
        value['track']['artwork'] = None
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertFalse(fixture.state['sprite_owned'])
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 2)
        self.assertEqual(fixture.state['error'], '')

    def test_text_native_failure_remains_blocked_until_inactive_or_stale_cleanup(self):
        fixture = Fixture()
        fixture.fail = 'StartTextOverlay'
        value = fixture.payload()
        fixture.activate(value)
        self.assertEqual(fixture.state['error'], 'native-display')
        self.assertIsNotNone(fixture.state['blocked'])
        self.assertFalse(fixture.state['sprite_owned'])
        self.assertFalse(fixture.state['text_owned'])
        for _ in range(10):
            fixture.frame()
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        self.assertEqual(len(fixture.calls('StartSprite')), 1)
        self.assertEqual(fixture.state['error'], 'native-display')
        fixture.now += 7
        value['updatedAt'] = int(fixture.now * 1000)
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertEqual(fixture.state['updatedAt'], value['updatedAt'])
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        fixture.put(fixture.payload(active=False))
        fixture.read()
        fixture.frame()
        self.assertIsNone(fixture.state['blocked'])
        self.assertEqual(fixture.state['error'], '')
        fixture.fail = None
        fixture.put(fixture.payload())
        fixture.read()
        fixture.frame()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertTrue(fixture.state['text_owned'])
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 2)

    def test_last_display_retains_attempt_identity_time_and_form_through_idle_and_heartbeat(self):
        fixture = Fixture()
        fixture.activate()
        self.assertNotIn(LAST_DISPLAY, fixture.os.files)
        fixture.now += 1
        fixture.publish_diagnostic()
        retained = json.loads(fixture.os.files[LAST_DISPLAY])
        self.assertEqual(retained, {'version': 1, 'pid': 4242, 'updatedAt': 1000000,
            'session': 'owned-session', 'trackKey': 'a' * 64, 'outcome': 'start-invoked',
            'form': 'local-uri', 'stage': 'display-attempt', 'artworkRequested': True,
            'spriteApplied': True, 'trackOverlayApplied': True})
        self.assertLess(len(fixture.os.files[LAST_DISPLAY]), 512)
        self.assertNotIn(b'artwork-', fixture.os.files[LAST_DISPLAY])
        self.assertNotIn(b'/Volumes/', fixture.os.files[LAST_DISPLAY])
        writes = lambda: len([item for item in fixture.os.io_calls if item == ('wb', LAST_DISPLAY)])
        for _ in range(3):
            fixture.now += 1
            fixture.put(fixture.payload())
            fixture.read()
            fixture.frame()
            fixture.publish_diagnostic()
        self.assertEqual(writes(), 1)
        self.assertEqual(json.loads(fixture.os.files[LAST_DISPLAY]), retained)
        fixture.now += 1
        fixture.put(fixture.payload(active=False))
        fixture.read()
        fixture.frame()
        fixture.now += 1
        fixture.publish_diagnostic()
        self.assertEqual(json.loads(fixture.os.files[DIAGNOSTIC])['stage'], 'render-ready')
        self.assertEqual(json.loads(fixture.os.files[LAST_DISPLAY]), retained)
        self.assertEqual(writes(), 1)

    def test_retained_display_distinguishes_availability_component_art_and_text_failure(self):
        for failure, outcome, form, overlay in (
                ('availability', 'art-availability', 'not-registered', True),
                ('component', 'art-component', 'rejected', True),
                ('StartSprite', 'art-display', 'local-uri', True),
                ('StartTextOverlay', 'native-display', 'local-uri', False)):
            fixture = Fixture()
            if failure == 'availability':
                fixture.native_unavailable = True
            elif failure == 'component':
                fixture.component_tamper = lambda entry: setattr(entry.EntryComponentList[0], 'mPathname', 'file:///Volumes/C/other.png')
            else:
                fixture.fail = failure
            fixture.activate()
            fixture.now += 1
            fixture.publish_diagnostic()
            retained = json.loads(fixture.os.files[LAST_DISPLAY])
            self.assertEqual(retained['outcome'], outcome)
            self.assertEqual(retained['form'], form)
            self.assertEqual(retained['session'], 'owned-session')
            self.assertEqual(retained['trackKey'], 'a' * 64)
            self.assertEqual(retained['stage'], 'native-error')
            self.assertFalse(retained['spriteApplied'])
            self.assertEqual(retained['trackOverlayApplied'], overlay)
            fixture.now += 1
            fixture.put(fixture.payload(active=False))
            fixture.read()
            fixture.frame()
            fixture.now += 1
            fixture.publish_diagnostic()
            self.assertEqual(json.loads(fixture.os.files[LAST_DISPLAY]), retained)

    def test_retained_display_coalesces_newer_failure_and_never_rewrites_old_success(self):
        fixture = Fixture()
        fixture.activate()
        def newer_attempt():
            fixture.fail = 'StartSprite'
            value = fixture.payload()
            value['track']['key'] = 'b' * 64
            value['track']['artwork'] = fixture.artwork(b'next art')
            fixture.put(value)
            fixture.read()
            fixture.frame()
            fixture.phase = 'worker'
        fixture.os.on_write[LAST_DISPLAY] = newer_attempt
        fixture.now += 1
        fixture.publish_diagnostic()
        self.assertIsNotNone(fixture.state['reader'].pending_display)
        self.assertEqual(json.loads(fixture.os.files[LAST_DISPLAY])['outcome'], 'start-invoked')
        fixture.now += 1
        fixture.publish_diagnostic()
        retained = json.loads(fixture.os.files[LAST_DISPLAY])
        self.assertEqual(retained['trackKey'], 'b' * 64)
        self.assertEqual(retained['outcome'], 'art-display')
        self.assertIsNone(fixture.state['reader'].pending_display)
        for _ in range(3):
            fixture.now += 1
            fixture.publish_diagnostic()
        self.assertEqual(json.loads(fixture.os.files[LAST_DISPLAY]), retained)

    def test_retained_display_permission_failure_isolated_and_worker_stop_flushes_pending(self):
        fixture = Fixture()
        fixture.os.denied_paths.add(LAST_DISPLAY)
        fixture.activate()
        fixture.now += 1
        fixture.publish_diagnostic()
        self.assertNotIn(LAST_DISPLAY, fixture.os.files)
        self.assertIn(DIAGNOSTIC, fixture.os.files)
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertTrue(fixture.state['text_owned'])
        self.assertIsNotNone(fixture.state['reader'].pending_display)
        fixture.phase = 'render'
        fixture.engine.OnShutdown()
        fixture.phase = 'setup'
        self.assertNotIn(LAST_DISPLAY, fixture.os.files)
        fixture.os.denied_paths.clear()
        fixture.phase = 'worker'
        fixture.state['reader']._run()
        fixture.phase = 'setup'
        retained = json.loads(fixture.os.files[LAST_DISPLAY])
        self.assertEqual(retained['outcome'], 'start-invoked')
        self.assertEqual(retained['updatedAt'], 1000000)
        self.assertIsNone(fixture.state['reader'].pending_display)

    def test_heartbeats_and_art_only_replacements_do_not_replay_text(self):
        fixture = Fixture()
        fixture.activate()
        value = fixture.payload()
        for _ in range(3):
            fixture.now += 1
            value['updatedAt'] = int(fixture.now * 1000)
            fixture.put(value)
            fixture.read()
            fixture.frame()
        self.assertEqual(len(fixture.calls('StartSprite')), 1)
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        value['track']['artwork'] = fixture.artwork(b'replacement', 'jpg')
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertEqual(len(fixture.calls('StartSprite')), 2)
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        self.assertEqual(fixture.calls('KillSprites'), [('KillSprites', fixture.namespace['SPRITE_NAME'], True, 0.0)])
        self.assertEqual(len(fixture.state['package'].EntryList), 1)

    def test_new_track_and_session_replay_text_once_and_missing_art_clears_previous(self):
        fixture = Fixture()
        fixture.activate()
        value = fixture.payload()
        value['track']['key'] = 'b' * 64
        value['track']['artwork'] = None
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertFalse(fixture.state['sprite_owned'])
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 2)
        fixture.frame()
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 2)
        value['session'] = 'next-session'
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 3)

    def test_empty_title_or_artist_still_displays_available_text(self):
        for title, artist, expected in [('', 'Artist', b'Artist'), ('Title', '', b'Title'), ('', '', None)]:
            fixture = Fixture()
            value = fixture.payload()
            value['track'].update({'title': title, 'artist': artist})
            fixture.activate(value)
            overlays = fixture.calls('StartTextOverlay')
            self.assertEqual(overlays[0][1] if overlays else None, expected)
            self.assertTrue(fixture.state['sprite_owned'])

    def test_art_between_one_and_two_mebibytes_remains_eligible(self):
        fixture = Fixture()
        value = fixture.payload()
        value['track']['artwork'] = fixture.artwork(b'x' * (1536 * 1024))
        fixture.activate(value)
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertTrue(fixture.state['text_owned'])

    def test_inactive_wrong_pid_and_stale_state_clear_only_owned_objects(self):
        for change in [{'active': False}, {'nativePid': 5555}, {'nativePid': None},
                       {'updatedAt': 991999}, {'updatedAt': 1002001}, {'track': None}]:
            with self.subTest(change=change):
                fixture = Fixture()
                foreign = object()
                fixture.packages['User.Other.package'] = foreign
                fixture.activate()
                fixture.put(fixture.payload(**change))
                fixture.read()
                fixture.frame()
                self.assertFalse(fixture.state['sprite_owned'])
                self.assertFalse(fixture.state['text_owned'])
                self.assertEqual(fixture.calls('KillSprites'), [('KillSprites', fixture.namespace['SPRITE_NAME'], True, 0.0)])
                self.assertEqual(fixture.calls('KillOverlay'), [('KillOverlay', fixture.namespace['OVERLAY_ID'])])
                self.assertIs(fixture.packages['User.Other.package'], foreign)
                counts = len(fixture.native)
                fixture.frame()
                self.assertEqual(len(fixture.native), counts)

    def test_invalid_metadata_and_art_never_reach_native_graphics(self):
        def cases(value):
            return [dict(value, version=True), dict(value, active=1), dict(value, nativePid=True),
                    dict(value, session='../outside'), dict(value, session='x' * 161)]

        for index in range(13):
            fixture = Fixture()
            value = fixture.payload()
            if index < 5:
                value = cases(value)[index]
            elif index == 5:
                value['track']['title'] = 'x' * 257
            elif index == 6:
                value['track']['artist'] = 'bad\ntext'
            elif index == 7:
                value['track']['key'] = 'not-a-hash'
            elif index == 8:
                value['track']['artwork']['file'] = '../outside.png'
            elif index == 9:
                value['track']['artwork']['width'] = True
            elif index == 10:
                filename = value['track']['artwork']['file']
                fixture.os.files[posixpath.join(posixpath.dirname(STATE), filename)] += b'changed'
            elif index == 11:
                fixture.os.links.add(posixpath.join(posixpath.dirname(STATE), value['track']['artwork']['file']))
            else:
                fixture.os.links.add(posixpath.dirname(STATE))
            fixture.activate(value)
            self.assertEqual(fixture.calls('StartSprite'), [], index)
            self.assertEqual(fixture.calls('StartTextOverlay'), [], index)

    def test_state_and_art_byte_bounds_and_magic_are_checked_in_worker(self):
        for kind in ['state-size', 'art-size', 'art-magic', 'art-redirect']:
            fixture = Fixture()
            fixture.frame()
            value = fixture.payload()
            artpath = posixpath.join(posixpath.dirname(STATE), value['track']['artwork']['file'])
            if kind == 'art-size':
                fixture.os.files[artpath] = b'x' * (2 * 1024 * 1024 + 1)
            elif kind == 'art-magic':
                contents = b'not-an-image'
                filename = 'artwork-%s.png' % hashlib.sha256(contents).hexdigest()
                value['track']['artwork']['file'] = filename
                fixture.os.files[posixpath.join(posixpath.dirname(STATE), filename)] = contents
            elif kind == 'art-redirect':
                fixture.os.redirects[artpath] = 'C:/other/' + value['track']['artwork']['file']
            fixture.put(value)
            if kind == 'state-size':
                fixture.os.files[STATE] = b' ' * 8193
            fixture.read()
            fixture.frame()
            self.assertEqual(fixture.calls('StartSprite'), [], kind)
            self.assertEqual(fixture.calls('StartTextOverlay'), [], kind)

    def test_lock_contention_keeps_visuals_then_expires_without_file_io(self):
        fixture = Fixture()
        fixture.activate()
        fixture.state['reader'].lock.held = True
        fixture.now += 7
        fixture.frame()
        self.assertTrue(fixture.state['sprite_owned'])
        fixture.now += 2
        fixture.frame()
        self.assertFalse(fixture.state['sprite_owned'])
        fixture.state['reader'].lock.held = False

    def test_stale_recovery_restores_art_without_replaying_same_track_text(self):
        fixture = Fixture()
        fixture.activate()
        fixture.now += 9
        fixture.frame()
        fixture.put(fixture.payload())
        fixture.read()
        fixture.frame()
        self.assertEqual(len(fixture.calls('StartSprite')), 2)
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)

    def test_failed_native_start_is_cleaned_and_not_retried_each_frame(self):
        fixture = Fixture()
        fixture.fail = 'StartSprite'
        fixture.activate()
        self.assertFalse(fixture.state['sprite_owned'])
        self.assertEqual(fixture.packages, {})
        self.assertEqual(fixture.state['error'], 'art-display')
        self.assertTrue(fixture.state['text_owned'])
        for _ in range(10):
            fixture.frame()
        self.assertEqual(len(fixture.calls('StartSprite')), 1)
        self.assertEqual(len(fixture.calls('StartTextOverlay')), 1)
        fixture.fail = None
        value = fixture.payload(session='new-session')
        fixture.put(value)
        fixture.read()
        fixture.frame()
        self.assertEqual(len(fixture.calls('StartSprite')), 2)

    def test_foreign_same_name_package_is_not_modified_or_unregistered(self):
        fixture = Fixture()
        foreign = object()
        fixture.packages[fixture.namespace['ART_PACKAGE']] = foreign
        fixture.activate()
        self.assertIs(fixture.packages[fixture.namespace['ART_PACKAGE']], foreign)
        self.assertEqual(fixture.calls('UnregisterPackage'), [])
        self.assertEqual(fixture.calls('StartSprite'), [])

    def test_fixed_overlay_command_fallback_never_contains_metadata(self):
        fixture = Fixture()
        fixture.activate()
        del fixture.ss.Interpreter.KillOverlay
        fixture.put(fixture.payload(active=False))
        fixture.read()
        fixture.frame()
        self.assertEqual(fixture.calls('ExecuteCmdStr'), [('ExecuteCmdStr', 'KillOverlay(%d);' % fixture.namespace['OVERLAY_ID'])])

    def test_wrappers_are_idempotent_chain_instance_render_and_preserve_vendor_errors(self):
        fixture = Fixture()
        installed = fixture.Engine.RenderFrame
        fixture.namespace['ExportPackage']('C:/stub/RabbitHole.NowPlaying.package/')
        self.assertIs(fixture.Engine.RenderFrame, installed)
        bound = fixture.engine.RenderFrame
        fixture.engine.RenderFrame = lambda value: ('outer', bound(value))
        self.assertEqual(fixture.frame(), ('outer', 'vendor-render'))
        fixture.frame()
        self.assertEqual(len(fixture.threads), 1)
        fixture.original_error = True
        with self.assertRaisesRegex(ValueError, 'Vendor render failure'):
            fixture.frame()

    def test_shutdown_is_nonblocking_cleans_owned_objects_and_keeps_vendor_shutdown(self):
        fixture = Fixture()
        fixture.activate()
        fixture.phase = 'render'
        self.assertEqual(fixture.engine.OnShutdown(), 'vendor-shutdown')
        fixture.phase = 'setup'
        self.assertTrue(fixture.state['closed'])
        self.assertTrue(fixture.state['reader'].stopping.is_set())
        self.assertFalse(fixture.state['sprite_owned'])
        count = len(fixture.native)
        fixture.frame()
        self.assertEqual(len(fixture.native), count)
        fixture.phase = 'render'
        fixture.engine.OnShutdown()
        self.assertEqual(len(fixture.calls('KillSprites')), 1)

    def test_worker_diagnostics_are_bounded_scalar_only_and_rate_limited(self):
        fixture = Fixture()
        fixture.activate()
        writes = lambda: len([item for item in fixture.os.io_calls if item == ('wb', DIAGNOSTIC)])
        first = writes()
        fixture.now += .5
        fixture.publish_diagnostic()
        self.assertEqual(writes(), first)
        fixture.now += .5
        fixture.publish_diagnostic()
        diagnostic = json.loads(fixture.os.files[DIAGNOSTIC])
        self.assertEqual(set(diagnostic), {'version', 'pid', 'updatedAt', 'session', 'trackKey',
                                         'spriteApplied', 'trackOverlayApplied', 'error', 'stage', 'dependency'})
        self.assertTrue(diagnostic['spriteApplied'])
        self.assertTrue(diagnostic['trackOverlayApplied'])
        self.assertEqual(diagnostic['pid'], 4242)
        self.assertEqual(diagnostic['stage'], 'native-applied')
        self.assertEqual(diagnostic['dependency'], '')
        self.assertLess(len(fixture.os.files[DIAGNOSTIC]), 512)
        self.assertNotIn(b'B', fixture.os.files[DIAGNOSTIC])
        self.assertNotIn(b'artwork-', fixture.os.files[DIAGNOSTIC])
        fixture.phase = 'render'
        with self.assertRaisesRegex(AssertionError, 'Filesystem'):
            fixture.namespace['_read_state'](STATE, 1000000, 4242)

    def test_diagnostic_failure_does_not_stop_metadata_or_native_visuals(self):
        fixture = Fixture()
        fixture.os.write_error = True
        fixture.activate()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertNotIn(DIAGNOSTIC, fixture.os.files)
        self.assertTrue(fixture.state['text_owned'])

    def test_native_package_never_imports_json_or_ctypes(self):
        fixture = Fixture()
        fixture.activate()
        self.assertTrue(fixture.state['sprite_owned'])
        self.assertIn(DIAGNOSTIC, fixture.os.files)
        self.assertFalse(any(name in ('json', 'ctypes') for name, phase in fixture.imports))
        self.assertTrue(all(phase == 'worker' for name, phase in fixture.imports if name in ('hashlib', 're', 'stat')))

    def test_bootstrap_reports_missing_startup_modules_without_native_calls(self):
        for module, expected in [('threading', 'threading'), ('time', 'time'),
                                 ('SSEngine', 'engine'), ('GForce', 'sprite-api')]:
            fixture = Fixture(missing_modules=[module])
            self.assertEqual(json.loads(fixture.os.files[BOOTSTRAP]),
                {'version': 1, 'pid': 4242, 'stage': 'dependency-error', 'dependency': expected})
            self.assertIs(fixture.Engine.RenderFrame, fixture.original_render)
            self.assertEqual(fixture.native, [])

    def test_bootstrap_hook_errors_are_isolated(self):
        fixture = Fixture()
        def fail():
            raise RuntimeError('Private failure must not be published')
        fixture.namespace['_install'] = fail
        fixture.namespace['ExportPackage']('C:/stub/RabbitHole.NowPlaying.package/')
        self.assertEqual(json.loads(fixture.os.files[BOOTSTRAP])['stage'], 'hook-error')
        self.assertNotIn(b'Private', fixture.os.files[BOOTSTRAP])

    def test_missing_worker_dependency_is_reported_and_can_recover(self):
        for module in ('hashlib', 're', 'stat'):
            fixture = Fixture(missing_modules=[module])
            fixture.activate()
            diagnostic = json.loads(fixture.os.files[DIAGNOSTIC])
            self.assertEqual(diagnostic['error'], 'dependency-error')
            self.assertEqual(diagnostic['stage'], 'dependency-error')
            self.assertEqual(diagnostic['dependency'], module)
            self.assertEqual(fixture.calls('StartSprite'), [])
            fixture.missing_modules.clear()
            fixture.now += 1
            fixture.put(fixture.payload())
            fixture.read()
            fixture.frame()
            self.assertTrue(fixture.state['sprite_owned'])

    def test_unexpected_worker_error_reports_fixed_enum_without_native_calls(self):
        fixture = Fixture()
        fixture.frame()
        reader = fixture.state['reader']
        def fail():
            raise RuntimeError('Secret URL or path must never escape')
        reader._read_once = fail
        reader.stopping.wait = lambda seconds: reader.stopping.set()
        fixture.phase = 'worker'
        reader._run()
        fixture.phase = 'setup'
        diagnostic = json.loads(fixture.os.files[DIAGNOSTIC])
        self.assertEqual(diagnostic['error'], 'worker-error')
        self.assertEqual(diagnostic['stage'], 'worker-error')
        self.assertNotIn(b'Secret', fixture.os.files[DIAGNOSTIC])
        self.assertEqual(fixture.native, [])

    def test_thread_construction_and_start_fail_once_preserving_vendor_render(self):
        for failure in ('construct', 'start'):
            fixture = Fixture(thread_failure=failure)
            initial_io = list(fixture.os.io_calls)
            for _ in range(10):
                self.assertEqual(fixture.frame(), 'vendor-render')
            self.assertTrue(fixture.state['closed'])
            self.assertEqual(fixture.state['error'], 'worker-error')
            self.assertEqual(fixture.thread_attempts, 1)
            self.assertEqual(fixture.printed, ['Rabbit Hole now-playing: worker-start-error'])
            self.assertEqual(fixture.os.io_calls, initial_io)
            self.assertNotIn(DIAGNOSTIC, fixture.os.files)
            self.assertEqual(fixture.native, [])

    def test_startup_starts_one_eligible_reader_before_frames_without_native_effects(self):
        fixture = Fixture()
        self.assertEqual(fixture.startup(), 'vendor-startup')
        self.assertEqual(json.loads(fixture.os.files[BOOTSTRAP])['stage'], 'worker-started')
        self.assertEqual(fixture.thread_attempts, 1)
        self.assertEqual(fixture.native, [])
        fixture.put(fixture.payload())
        fixture.read()
        self.assertEqual(fixture.native, [])
        fixture.frame()
        fixture.startup()
        self.assertEqual(fixture.thread_attempts, 1)
        self.assertTrue(fixture.state['sprite_owned'])

    def test_startup_preserves_vendor_errors_other_hosts_and_thread_failure_proof(self):
        fixture = Fixture()
        fixture.startup_error = True
        with self.assertRaisesRegex(ValueError, 'Vendor startup failure'):
            fixture.startup()
        self.assertEqual(fixture.threads, [])
        other = Fixture(host='Windows Media Player')
        self.assertEqual(other.startup(), 'vendor-startup')
        self.assertEqual(other.threads, [])
        for reason in ('construct', 'start'):
            failed = Fixture(thread_failure=reason)
            self.assertEqual(failed.startup(), 'vendor-startup')
            self.assertEqual(json.loads(failed.os.files[BOOTSTRAP])['stage'], 'worker-error')
            for _ in range(3):
                failed.frame()
            self.assertEqual(failed.thread_attempts, 1)
            self.assertEqual(failed.native, [])

    def test_embedded_json_reader_handles_utf8_escapes_and_surrogate_pairs(self):
        fixture = Fixture()
        parse = lambda text: fixture.namespace['PrivateJSONReader'](text).read()
        self.assertEqual(parse('{"v":"Björk 😀","q":"\\\"\\\\\\/","n":42,"b":true,"f":false,"none":null}'),
                         {'v': 'Björk 😀', 'q': '"\\/', 'n': 42, 'b': True, 'f': False, 'none': None})
        self.assertEqual(parse('{"v":"\\u00f6 \\ud83d\\ude00"}')['v'], 'ö 😀')
        value = fixture.payload()
        value['track']['title'] = 'Quoted "title" \\ slash / — 😀'
        fixture.frame()
        fixture.os.files[STATE] = json.dumps(value, ensure_ascii=True).encode('ascii')
        fixture.read()
        fixture.frame()
        self.assertEqual(fixture.calls('StartTextOverlay')[0][1],
                         (value['track']['title'] + '\rArtist').encode('utf-8'))

    def test_embedded_json_reader_rejects_malformed_and_unsupported_values(self):
        fixture = Fixture()
        parse = lambda text: fixture.namespace['PrivateJSONReader'](text).read()
        invalid = ['{"a":1,"a":2}', '{"a":1} trailing', '{"a":1,}', '{"a":01}',
                   '{"a":1.5}', '{"a":1e2}', '{"a":NaN}', '{"a":Infinity}',
                   '{"a":[]}', '{"a":"\\x41"}', '{"a":"\\ud800"}',
                   '{"a":"\\udc00"}', '{"a":"\\ud800\\u0041"}',
                   '{"a":"\ud800"}', '{"a":"\udc00"}',
                   '{"a":"raw\ncontrol"}', '{"a":-}', '{"a":+1}',
                   '{"a":10000000000000000}', '{"a":truefalse}', '{', '']
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    parse(value)

    def test_embedded_json_reader_enforces_byte_depth_and_node_limits(self):
        fixture = Fixture()
        parse = lambda text: fixture.namespace['PrivateJSONReader'](text).read()
        self.assertEqual(parse('{"a":' * 6 + '1' + '}' * 6), {'a': {'a': {'a': {'a': {'a': {'a': 1}}}}}})
        for value in [' ' * 8193, '{"a":' * 8 + '1' + '}' * 8,
                      '{' + ','.join('"k%d":0' % index for index in range(65)) + '}']:
            with self.assertRaises(ValueError):
                parse(value)


if __name__ == '__main__':
    unittest.main()
