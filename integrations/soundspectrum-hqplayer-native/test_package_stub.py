"""Offline menu/IPC contract tests. Native APIs and filesystem are all stubs."""

import builtins
import io
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE_PATH = Path(__file__).parent / 'RabbitHole.HQPlayerInput.package' / '_package.py'
SOURCE = SOURCE_PATH.read_text(encoding='utf-8')
REQUEST = 'C:/stub/request.txt'
STATUS = 'C:/stub/status.txt'
LAUNCHER = 'C:/stub/launch.vbs'
RAW = 'Stereo Out (SoundSpectrum Audio Cable)'
ALIAS = 'HQPlayer (analysis feed)'


class MemoryFile(io.BytesIO):
    def __init__(self, filesystem, pathname, mode):
        self.filesystem = filesystem
        self.pathname = pathname
        self.mode = mode
        if 'r' in mode and pathname not in filesystem.files:
            raise IOError('Missing stub file')
        super().__init__(filesystem.files[pathname] if 'r' in mode else b'')

    def close(self):
        if not self.closed and 'w' in self.mode:
            self.filesystem.files[self.pathname] = self.getvalue()
        super().close()


class FakeOS:
    def __init__(self):
        self.pid = 4242
        self.files = {}
        self.launches = []
        self.random_index = 0
        self.launch_error = False
        self.write_error = False
        self.path = SimpleNamespace(exists=lambda filename: filename in self.files)

    def getpid(self):
        return self.pid

    def urandom(self, size):
        self.random_index += 1
        return bytes([self.random_index]) * size

    def open(self, pathname, mode):
        if self.write_error and 'w' in mode:
            raise IOError('Stub write denied')
        return MemoryFile(self, pathname, mode)

    def rename(self, old, new):
        if new in self.files:
            raise OSError('Windows target exists')
        self.files[new] = self.files.pop(old)

    def remove(self, pathname):
        del self.files[pathname]

    def startfile(self, pathname):
        self.launches.append(pathname)
        if self.launch_error:
            raise OSError('Stub launch denied')


class Fixture:
    def __init__(self, render=True, host='Standalone', sources=None):
        self.os = FakeOS()
        self.notices = []
        self.prefs = []
        self.native_sets = []
        self.original_sync_calls = 0
        self.original_set_calls = 0
        self.original_set_error = False
        self.original_render_calls = []
        self.original_render_error = False
        self.actual_time = 0.0
        self.input_queries = 0
        self.input_query_error = False
        self.sources = sources if sources is not None else ['Sound Generator (Fluid)', RAW, 'Microphone (Physical Mic)']
        self.current_index = self.sources.index(RAW) if RAW in self.sources else 0
        fixture = self

        class Engine:
            PRODUCT_NAME = 'G-Force'
            HOST_NAME = host
            mTimeIndexActual = 0.0

            def RenderFrame(self, inTimeIndex):
                fixture.original_render_calls.append(inTimeIndex)
                if fixture.original_render_error:
                    raise ValueError('Stub original render error')
                self.mTimeIndexActual = fixture.actual_time
                return 'original-render'

        self.engine = Engine()
        self.original_render = self.engine.RenderFrame

        class Settings:
            def SyncAudioDeviceMenu(self):
                fixture.original_sync_calls += 1
                self.items[:] = fixture.sources
                self.value = fixture.current_index
                return 'original-sync'

            def SetAudioSource(self):
                fixture.original_set_calls += 1
                if fixture.original_set_error:
                    raise ValueError('Stub original callback error')
                source = fixture.get_value(self.audioSourceMenu)
                fixture.set_audio(source)
                fixture.prefs.append(('Audio.InputSource', source))
                return 'original-set'

        self.original_sync = Settings.SyncAudioDeviceMenu
        self.original_set = Settings.SetAudioSource
        self.ss = SimpleNamespace(
            SettingsMenuBase=Settings,
            Interpreter=SimpleNamespace(
                GetAudioSourceName=lambda index: self.sources[index] if index < len(self.sources) else '',
                GetCurrentAudioSourceIndex=self.current_audio,
                SetAudioSource=self.set_audio
            ),
            GetEngineInstance=lambda: self.engine,
            AddPopupMenuOption=lambda menu, label: menu.items.append(label),
            SetViewValue=lambda menu, value: setattr(menu, 'value', value),
            GetViewValue=self.get_value,
            SetPref=lambda key, value: self.prefs.append((key, value)),
            ShowMessage=lambda message, duration: self.notices.append(message)
        )
        self.menu = Settings()
        self.menu.audioSourceMenu = self.menu
        self.menu.items = []
        self.menu.value = self.current_index
        self.namespace = self.load(render)
        self.package = self.namespace['ExportPackage']('C:/stub/RabbitHole.HQPlayerInput.package/')

    def get_value(self, menu):
        return menu.items[menu.value] if isinstance(menu.value, int) else menu.value

    def current_audio(self):
        self.input_queries += 1
        if self.input_query_error:
            raise ValueError('Stub input query failed')
        return self.current_index

    def frame(self, actual_time, visual_time=0.0):
        self.actual_time = actual_time
        return self.engine.RenderFrame(visual_time)

    def set_audio(self, source):
        if source not in self.sources:
            raise ValueError('Native source must be real, never an alias')
        self.native_sets.append(source)
        self.current_index = self.sources.index(source)

    def load(self, render=True):
        source = SOURCE
        if render:
            for token, value in [('__RH_REQUEST_PATH__', REQUEST), ('__RH_STATUS_PATH__', STATUS), ('__RH_LAUNCHER_PATH__', LAUNCHER)]:
                source = source.replace(token, repr(value))
        real_import = builtins.__import__

        def import_stub(name, *args, **kwargs):
            if name == 'os':
                return self.os
            if name == 'SoundSpectrum':
                return self.ss
            return real_import(name, *args, **kwargs)

        fake_builtins = dict(vars(builtins), open=self.os.open, __import__=import_stub)
        namespace = {'__builtins__': fake_builtins, 'VisPackage': lambda pathname: SimpleNamespace(PkgPathname=pathname, EntryList=[])}
        exec(compile(source, str(SOURCE_PATH), 'exec'), namespace)
        return namespace

    @property
    def state(self):
        return getattr(self.ss.SettingsMenuBase, self.namespace['SENTINEL'])

    def sync(self):
        return self.menu.SyncAudioDeviceMenu()

    def select(self, source):
        self.menu.value = source
        return self.menu.SetAudioSource()

    def request(self):
        return dict(line.split('=', 1) for line in self.os.files[REQUEST].decode('ascii').splitlines())

    def status(self, state='receiving', reason='HQPlayer audio is being received.', pid=None, nonce=None):
        text = 'pid=%d\nstate=%s\nreason=%s\nnonce=%s\n' % (self.os.pid if pid is None else pid, state, reason, self.state['nonce'] if nonce is None else nonce)
        self.os.files[STATUS] = text.encode('utf-8')


class PackageTests(unittest.TestCase):
    def test_unrendered_source_is_inert_and_tokens_are_unique(self):
        for token in ['__RH_REQUEST_PATH__', '__RH_STATUS_PATH__', '__RH_LAUNCHER_PATH__']:
            self.assertEqual(SOURCE.count(token), 1)
        fixture = Fixture(render=False)
        self.assertIs(fixture.ss.SettingsMenuBase.SyncAudioDeviceMenu, fixture.original_sync)
        self.assertIs(fixture.ss.SettingsMenuBase.SetAudioSource, fixture.original_set)
        self.assertEqual(fixture.package.EntryList, [])
        self.assertEqual(fixture.os.files, {})
        self.assertEqual(fixture.os.launches, [])

    def test_startup_adds_alias_but_preserves_raw_option_without_any_feed_or_pref_write(self):
        fixture = Fixture()
        self.assertEqual(fixture.sync(), 'original-sync')
        self.assertEqual(fixture.menu.items, fixture.sources + [ALIAS])
        self.assertEqual(fixture.get_value(fixture.menu), RAW)
        self.assertEqual(fixture.os.files, {})
        self.assertEqual(fixture.os.launches, [])
        self.assertEqual(fixture.prefs, [])

    def test_alias_requests_current_pid_with_unique_nonce_and_selects_real_cable(self):
        fixture = Fixture()
        fixture.sync()
        fixture.select(ALIAS)
        first = fixture.request()
        self.assertEqual(set(first), {'action', 'pid', 'nonce'})
        self.assertEqual(first['action'], 'start')
        self.assertEqual(first['pid'], '4242')
        self.assertRegex(first['nonce'], r'^[a-f0-9]{32}$')
        self.assertLess(len(fixture.os.files[REQUEST]), 100)
        self.assertEqual(fixture.os.launches, [LAUNCHER])
        self.assertEqual(fixture.native_sets, [RAW])
        self.assertEqual(fixture.prefs, [('Audio.InputSource', RAW), ('Audio.AutoDetect.Enabled', 0)])
        fixture.select(ALIAS)
        self.assertNotEqual(fixture.request()['nonce'], first['nonce'])
        self.assertFalse(any(filename.endswith('.tmp') for filename in fixture.os.files))

    def test_reexport_preserves_original_handlers_and_does_not_stack_wrappers(self):
        fixture = Fixture()
        wrapper = fixture.ss.SettingsMenuBase.SyncAudioDeviceMenu
        fixture.select(ALIAS)
        render_wrapper = fixture.engine.RenderFrame
        state = fixture.state
        namespace = fixture.load()
        namespace['ExportPackage']('C:/stub/package/')
        self.assertIs(fixture.ss.SettingsMenuBase.SyncAudioDeviceMenu, wrapper)
        self.assertIs(fixture.state, state)
        self.assertIs(fixture.engine.RenderFrame, render_wrapper)
        self.assertIs(state['original_sync'], fixture.original_sync)
        self.assertIs(state['original_set'], fixture.original_set)
        fixture.sync()
        fixture.sync()
        self.assertEqual(fixture.menu.items.count(ALIAS), 1)
        self.assertEqual(fixture.original_sync_calls, 2)
        self.assertEqual(len(fixture.os.launches), 1)

    def test_raw_selection_has_original_behavior_and_cannot_stop_a_feed_it_did_not_start(self):
        fixture = Fixture()
        fixture.sync()
        self.assertEqual(fixture.select(RAW), 'original-set')
        self.assertEqual(fixture.original_set_calls, 1)
        self.assertEqual(fixture.os.files, {})
        self.assertEqual(fixture.os.launches, [])

    def test_switching_after_alias_requests_stop_for_only_this_native_session(self):
        fixture = Fixture()
        fixture.sync()
        fixture.select(ALIAS)
        first_nonce = fixture.request()['nonce']
        self.assertEqual(fixture.select(fixture.sources[2]), 'original-set')
        self.assertEqual(fixture.request()['action'], 'stop')
        self.assertEqual(fixture.request()['pid'], '4242')
        self.assertNotEqual(fixture.request()['nonce'], first_nonce)
        self.assertFalse(fixture.state['owns_request'])
        self.assertFalse(fixture.state['desired'])
        fixture.select(RAW)
        self.assertEqual(len(fixture.os.launches), 2)

    def test_foreign_native_pid_cannot_release_the_original_session(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.os.pid = 9999
        fixture.select(RAW)
        self.assertEqual(fixture.request()['action'], 'start')
        self.assertEqual(len(fixture.os.launches), 1)

    def test_owned_matching_status_selects_logical_option_and_notifies_once(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.status(reason='Receiving HQPlayer audio.')
        fixture.sync()
        self.assertEqual(fixture.get_value(fixture.menu), ALIAS)
        self.assertEqual(fixture.notices[-1], 'Receiving HQPlayer audio.')
        notices = len(fixture.notices)
        fixture.sync()
        self.assertEqual(len(fixture.notices), notices)

    def test_foreign_or_stale_status_cannot_relabel_raw_cable_or_show_reason(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        notices = len(fixture.notices)
        for pid, nonce in [(9999, fixture.state['nonce']), (4242, 'f' * 32)]:
            fixture.status(pid=pid, nonce=nonce, reason='Wrong session')
            fixture.sync()
            self.assertEqual(fixture.get_value(fixture.menu), RAW)
            self.assertEqual(len(fixture.notices), notices)

    def test_error_status_shows_its_reason_without_claiming_a_hqplayer_route(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.status(state='error', reason='The feed is busy.')
        fixture.sync()
        self.assertEqual(fixture.get_value(fixture.menu), RAW)
        self.assertEqual(fixture.notices[-1], 'The feed is busy.')

    def test_malformed_or_oversized_status_is_ignored_and_reason_is_bounded(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        notices = len(fixture.notices)
        for data in [b'x' * 2049, b'pid=4242\npid=4242\n', b'bad-line', b'pid=4242\nstate=unexpected\n']:
            fixture.os.files[STATUS] = data
            fixture.sync()
            self.assertEqual(len(fixture.notices), notices)
            self.assertEqual(fixture.get_value(fixture.menu), RAW)
        fixture.status(reason='A\x00B\tC' + 'd' * 350)
        fixture.sync()
        self.assertLessEqual(len(fixture.notices[-1]), 256)
        self.assertNotIn('\x00', fixture.notices[-1])
        self.assertNotIn('\t', fixture.notices[-1])

    def test_nonstandalone_host_preserves_vendor_handlers_without_alias_or_requests(self):
        fixture = Fixture(host='Music Player')
        fixture.sync()
        self.assertEqual(fixture.menu.items, fixture.sources)
        fixture.select(RAW)
        self.assertEqual(fixture.original_set_calls, 1)
        self.assertEqual(fixture.os.files, {})

    def test_missing_exact_cable_fails_before_request_launch_or_pref_change(self):
        fixture = Fixture(sources=['Sound Generator (Fluid)', 'Microphone (Physical Mic)'])
        fixture.sync()
        fixture.select(ALIAS)
        self.assertEqual(fixture.os.files, {})
        self.assertEqual(fixture.os.launches, [])
        self.assertEqual(fixture.native_sets, [])
        self.assertEqual(fixture.prefs, [])
        self.assertIn('unavailable', fixture.notices[-1])

    def test_write_failure_keeps_original_input_and_cleans_only_own_temporary_request(self):
        fixture = Fixture()
        fixture.os.write_error = True
        fixture.select(ALIAS)
        self.assertEqual(fixture.os.files, {})
        self.assertEqual(fixture.os.launches, [])
        self.assertEqual(fixture.native_sets, [])
        self.assertEqual(fixture.prefs, [])

    def test_launcher_failure_queues_stop_instead_of_selecting_or_persisting_the_alias(self):
        fixture = Fixture()
        fixture.os.launch_error = True
        fixture.select(ALIAS)
        self.assertEqual(fixture.request()['action'], 'stop')
        self.assertEqual(fixture.native_sets, [])
        self.assertEqual(fixture.prefs, [])
        self.assertFalse(fixture.state['desired'])

    def test_original_callback_failure_does_not_cancel_the_requested_feed(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.original_set_error = True
        with self.assertRaises(ValueError):
            fixture.select(RAW)
        self.assertEqual(fixture.request()['action'], 'start')
        self.assertTrue(fixture.state['owns_request'])

    def test_outside_menu_input_change_stops_only_owned_feed_once(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.current_index = 2  # Native right-click/Shift+A bypass menu wrapper.
        self.assertEqual(fixture.frame(1.0, visual_time=12.0), 'original-render')
        self.assertEqual(fixture.request()['action'], 'stop')
        self.assertEqual(fixture.request()['pid'], '4242')
        self.assertFalse(fixture.state['desired'])
        self.assertFalse(fixture.state['owns_request'])
        self.assertEqual(fixture.original_set_calls, 0)
        self.assertEqual(fixture.native_sets, [RAW])
        for time in [2.0, 3.0, 30.0]:
            fixture.frame(time)
        self.assertEqual(len(fixture.os.launches), 2)
        self.assertEqual(fixture.input_queries, 1)

    def test_source_watch_checks_at_most_once_per_actual_second_and_preserves_raw_feed(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        wrapper = fixture.engine.RenderFrame
        fixture.select(ALIAS)
        self.assertIs(fixture.engine.RenderFrame, wrapper)
        for time in [0.0, 0.1, 0.5, 0.99]:
            self.assertEqual(fixture.frame(time), 'original-render')
        self.assertEqual(fixture.input_queries, 0)
        for time in [1.0, 1.1, 1.99, 2.0]:
            fixture.frame(time, visual_time=0.0)  # Visual time can remain paused.
        self.assertEqual(fixture.input_queries, 2)
        self.assertEqual(fixture.request()['action'], 'start')
        self.assertTrue(fixture.state['owns_request'])
        self.assertEqual(len(fixture.os.launches), 2)  # Only explicit Starts.

    def test_no_source_watch_is_installed_on_startup_or_other_hosts(self):
        fixture = Fixture()
        self.assertEqual(fixture.engine.RenderFrame, fixture.original_render)
        fixture.frame(5.0)
        self.assertEqual(fixture.input_queries, 0)
        self.assertEqual(fixture.os.files, {})
        other = Fixture(host='Music Player')
        other.select(RAW)
        self.assertEqual(other.engine.RenderFrame, other.original_render)
        self.assertEqual(other.os.files, {})

    def test_source_watch_preserves_original_render_errors_and_foreign_pid(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.current_index = 2
        fixture.original_render_error = True
        with self.assertRaisesRegex(ValueError, 'original render error'):
            fixture.frame(1.0)
        self.assertEqual(fixture.input_queries, 0)
        self.assertEqual(fixture.request()['action'], 'start')
        fixture.original_render_error = False
        fixture.os.pid = 9999
        fixture.frame(2.0)
        self.assertEqual(fixture.input_queries, 0)
        self.assertEqual(len(fixture.os.launches), 1)

    def test_source_watch_query_failure_and_clock_reset_do_not_interrupt_render(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.input_query_error = True
        self.assertEqual(fixture.frame(1.0), 'original-render')
        self.assertEqual(fixture.input_queries, 1)
        self.assertEqual(fixture.request()['action'], 'start')
        fixture.input_query_error = False
        fixture.current_index = 2
        fixture.frame(0.1)
        fixture.frame(1.0)
        self.assertEqual(fixture.input_queries, 1)
        fixture.frame(1.1)
        self.assertEqual(fixture.input_queries, 2)
        self.assertEqual(fixture.request()['action'], 'stop')

    def test_status_feedback_is_automatic_bounded_and_shared_with_menu_deduplication(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        fixture.status(state='waiting', reason='The exact zone is paused.')
        notices = len(fixture.notices)
        fixture.frame(0.9)
        self.assertEqual(len(fixture.notices), notices)
        self.assertEqual(fixture.frame(1.0), 'original-render')
        self.assertEqual(fixture.notices[-1], 'The exact zone is paused.')
        self.assertEqual(len(fixture.notices), notices + 1)
        fixture.frame(1.5)
        fixture.frame(2.0)
        fixture.sync()
        self.assertEqual(len(fixture.notices), notices + 1)
        fixture.status(reason='HQPlayer analysis active.')
        fixture.frame(3.0)
        self.assertEqual(fixture.notices[-1], 'HQPlayer analysis active.')
        self.assertEqual(len(fixture.notices), notices + 2)
        fixture.sync()
        fixture.frame(4.0)
        self.assertEqual(len(fixture.notices), notices + 2)
        self.assertEqual(fixture.request()['action'], 'start')
        self.assertEqual(fixture.os.launches, [LAUNCHER])

    def test_automatic_feedback_ignores_foreign_stale_and_unowned_status(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        notices = len(fixture.notices)
        fixture.status(pid=9999, reason='Foreign process result')
        fixture.frame(1.0)
        fixture.status(nonce='f' * 32, reason='Old selection result')
        fixture.frame(2.0)
        self.assertEqual(len(fixture.notices), notices)
        fixture.status(reason='Current selection result')
        fixture.state['desired'] = False
        fixture.frame(3.0)
        fixture.state['desired'] = True
        fixture.state['owns_request'] = False
        fixture.frame(4.0)
        self.assertEqual(len(fixture.notices), notices)
        fixture.state['owns_request'] = True
        fixture.current_index = 2
        fixture.frame(5.0)
        self.assertEqual(fixture.request()['action'], 'stop')
        self.assertEqual(len(fixture.notices), notices)

    def test_automatic_feedback_preserves_render_when_status_is_missing_or_malformed(self):
        fixture = Fixture()
        fixture.select(ALIAS)
        notices = len(fixture.notices)
        self.assertEqual(fixture.frame(1.0), 'original-render')
        fixture.os.files[STATUS] = b'x' * 2049
        self.assertEqual(fixture.frame(2.0), 'original-render')
        fixture.os.files[STATUS] = b'bad-status-line'
        self.assertEqual(fixture.frame(3.0), 'original-render')
        self.assertEqual(len(fixture.notices), notices)
        self.assertTrue(fixture.state['owns_request'])
        self.assertEqual(fixture.os.launches, [LAUNCHER])


if __name__ == '__main__':
    unittest.main(verbosity=2)
