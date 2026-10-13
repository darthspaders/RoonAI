# -*- coding: utf-8 -*-
"""Removable G-Force Standalone menu integration; no audio opens on startup."""

import os
import SoundSpectrum as SS

# The installer renders these three literals. An unrendered source stays inert.
try:
    REQUEST_PATH = __RH_REQUEST_PATH__
    STATUS_PATH = __RH_STATUS_PATH__
    LAUNCHER_PATH = __RH_LAUNCHER_PATH__
except NameError:
    REQUEST_PATH = STATUS_PATH = LAUNCHER_PATH = None

ALIAS = 'HQPlayer (analysis feed)'
RAW_SOURCE = 'Stereo Out (SoundSpectrum Audio Cable)'
SENTINEL = '_rabbit_hole_hqplayer_native_v1'
STATES = ('idle', 'starting', 'receiving', 'waiting', 'error', 'stopped')


def _notice(message):
    try:
        SS.ShowMessage(message, 4.0)
    except Exception:
        pass


def _standalone():
    try:
        engine = SS.GetEngineInstance()
        return engine.PRODUCT_NAME == 'G-Force' and engine.HOST_NAME == 'Standalone'
    except Exception:
        return False


def _sources():
    sources = []
    for index in range(128):
        source = SS.Interpreter.GetAudioSourceName(index)
        if not source:
            return sources
        sources.append(source)
    return None


def _nonce():
    # os is already used by the vendor library; no JSON/subprocess dependency.
    return ''.join('%02x' % (byte if isinstance(byte, int) else ord(byte))
                   for byte in os.urandom(16))


def _request(state, action):
    nonce = _nonce()
    request = 'action=%s\npid=%d\nnonce=%s\n' % (action, os.getpid(), nonce)
    target = state['request_path']
    temporary = target + '.' + nonce + '.tmp'
    try:
        with open(temporary, 'wb') as stream:
            stream.write(request.encode('ascii'))
        try:
            os.rename(temporary, target)
        except OSError:
            # Python2 lacks os.replace; Windows rename cannot replace a file.
            # Remove only this addon's fixed request file, never arbitrary input.
            if os.path.exists(target):
                os.remove(target)
            os.rename(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    state['nonce'] = nonce
    state['last_notice'] = None
    return nonce


def _launch(state):
    # Windows CPython exposes startfile; the launcher path is installer-owned.
    # Its hidden VBS executes fixed Node/controller paths, with no UI arguments.
    os.startfile(state['launcher_path'])


def _status(state):
    if not state['nonce']:
        return None
    try:
        with open(state['status_path'], 'rb') as stream:
            data = stream.read(2049)
        if len(data) > 2048:
            return None
        fields = {}
        for line in data.decode('utf-8', 'replace').splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in fields:
                return None
            fields[key] = value
        if fields.get('pid') != str(os.getpid()):
            return None
        if fields.get('nonce') != state['nonce']:
            return None
        if fields.get('state') not in STATES:
            return None
        reason = fields.get('reason', '')[:256]
        fields['reason'] = ''.join(character for character in reason
                                   if ord(character) >= 32 and ord(character) != 127)
        return fields
    except (IOError, OSError, ValueError):
        return None


def _show_status(state, status):
    if status is None:
        return
    signature = (status['nonce'], status['state'], status['reason'])
    if state['last_notice'] != signature:
        if status['reason']:
            _notice(status['reason'])
        state['last_notice'] = signature


def _stop_owned(state):
    if not state['owns_request'] or state['pid'] != os.getpid():
        return
    try:
        _request(state, 'stop')
        _launch(state)
        state['owns_request'] = False
    except Exception:
        _notice('HQPlayer feed stop could not be requested. The companion will '
                'also release its feed when this G-Force process exits.')


def _install_source_watch(state):
    # Packages load before gEngineInstance exists, so attach only on selection.
    # The vendor's Python RenderFrame updates mTimeIndexActual from its actual
    # clock even when the visual time is paused. No native timer is introduced.
    engine = SS.GetEngineInstance()
    sentinel = SENTINEL + '_source_watch'
    watch = getattr(engine, sentinel, None)
    if watch is not None:
        if watch['state'] is not state:
            raise ValueError('A different session owns the input watch')
        return
    watch = {'state': state, 'original': engine.RenderFrame,
             'last_check': engine.mTimeIndexActual}

    def render(inTimeIndex):
        result = watch['original'](inTimeIndex)
        try:
            if (not state['desired'] or not state['owns_request'] or
                    state['pid'] != os.getpid() or
                    engine.PRODUCT_NAME != 'G-Force' or
                    engine.HOST_NAME != 'Standalone'):
                return result
            now = engine.mTimeIndexActual
            if now < watch['last_check']:
                watch['last_check'] = now
                return result
            if now - watch['last_check'] < 1.0:
                return result
            watch['last_check'] = now
            current = SS.Interpreter.GetCurrentAudioSourceIndex()
            if (current < 0 or
                    SS.Interpreter.GetAudioSourceName(current) != RAW_SOURCE):
                state['desired'] = False
                _stop_owned(state)
            else:
                # Read only this explicit selection's PID/nonce-matching
                # result, at the same bounded interval as the input watch.
                _show_status(state, _status(state))
        except Exception:
            # A failed input query must not interrupt rendering or cancel a
            # feed whose input could not be identified. Vendor errors above
            # this try still propagate unchanged.
            pass
        return result

    engine.RenderFrame = render
    setattr(engine, sentinel, watch)


def _install():
    if not REQUEST_PATH or not STATUS_PATH or not LAUNCHER_PATH:
        return
    base = SS.SettingsMenuBase
    state = getattr(base, SENTINEL, None)
    if state is not None:
        state['request_path'] = REQUEST_PATH
        state['status_path'] = STATUS_PATH
        state['launcher_path'] = LAUNCHER_PATH
        return
    state = {
        'original_sync': base.SyncAudioDeviceMenu,
        'original_set': base.SetAudioSource,
        'request_path': REQUEST_PATH,
        'status_path': STATUS_PATH,
        'launcher_path': LAUNCHER_PATH,
        'pid': os.getpid(),
        'nonce': '',
        'owns_request': False,
        'desired': False,
        'last_notice': None
    }

    def sync(menu):
        result = state['original_sync'](menu)
        if not _standalone() or not menu.audioSourceMenu:
            return result
        sources = _sources()
        if sources is None:
            return result
        SS.AddPopupMenuOption(menu.audioSourceMenu, ALIAS)
        status = _status(state)
        if status is not None:
            # A raw cable selection at startup is never relabeled as HQPlayer.
            current = SS.Interpreter.GetCurrentAudioSourceIndex()
            if (state['desired'] and state['owns_request'] and
                    status['state'] in ('starting', 'receiving', 'waiting') and
                    0 <= current < len(sources) and sources[current] == RAW_SOURCE):
                SS.SetViewValue(menu.audioSourceMenu, len(sources))
            _show_status(state, status)
        return result

    def select(menu):
        if not _standalone():
            return state['original_set'](menu)
        selected = SS.GetViewValue(menu.audioSourceMenu)
        if selected != ALIAS:
            result = state['original_set'](menu)
            state['desired'] = False
            _stop_owned(state)
            return result
        sources = _sources()
        if sources is None or RAW_SOURCE not in sources:
            _notice('The verified SoundSpectrum Audio Cable input is unavailable.')
            return
        try:
            _install_source_watch(state)
            _request(state, 'start')
            state['owns_request'] = True
            _launch(state)
            SS.Interpreter.SetAudioSource(RAW_SOURCE)
            SS.SetPref('Audio.InputSource', RAW_SOURCE)
            SS.SetPref('Audio.AutoDetect.Enabled', 0)
            state['desired'] = True
            _notice('HQPlayer feed requested. Open this menu again for its status.')
        except Exception:
            state['desired'] = False
            _stop_owned(state)
            _notice('HQPlayer feed could not be selected. Check the companion setup.')

    setattr(base, SENTINEL, state)
    base.SyncAudioDeviceMenu = sync
    base.SetAudioSource = select


def ExportPackage(inPathname):
    _install()
    # Empty packages are supported by the host; no factory config is replaced.
    return VisPackage(inPathname)
