# -*- coding: utf-8 -*-
"""Owned native now-playing sprite/text; no audio or playback operations."""

import os
import SoundSpectrum as SS

try:
    STATE_PATH = __RH_NOWPLAYING_STATE_PATH__
except NameError:
    STATE_PATH = None

BOOTSTRAP_DEPENDENCY = ''
try:
    import threading
except ImportError:
    BOOTSTRAP_DEPENDENCY = 'threading'
try:
    import time
except ImportError:
    BOOTSTRAP_DEPENDENCY = BOOTSTRAP_DEPENDENCY or 'time'
try:
    from SSEngine import EngineInstance
except ImportError:
    BOOTSTRAP_DEPENDENCY = BOOTSTRAP_DEPENDENCY or 'engine'
try:
    from GForce import CreateGForceSpritePackage
except ImportError:
    BOOTSTRAP_DEPENDENCY = BOOTSTRAP_DEPENDENCY or 'sprite-api'
DEPENDENCIES_READY = not BOOTSTRAP_DEPENDENCY

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

SENTINEL = '_rabbit_hole_now_playing_v1'
ART_PACKAGE = 'RabbitHole.NowPlaying.Artwork.package'
SPRITE_NAME = 'Rabbit Hole - Current Album Artwork'
OVERLAY_ID = 0x52484E50
MAX_STATE_BYTES = 8192
MAX_ART_BYTES = 2 * 1024 * 1024
STALE_MS = 8000
FUTURE_MS = 2000
POLL_SECONDS = 0.5
DIAGNOSTIC_SECONDS = 1.0
DIAGNOSTIC_ERRORS = ('', 'metadata-unavailable', 'native-display', 'art-availability', 'art-display', 'art-component', 'text-clear', 'art-clear',
                     'dependency-error', 'worker-error')
DIAGNOSTIC_STAGES = ('worker-started', 'render-ready', 'metadata-read', 'native-applied',
                     'native-error', 'dependency-error', 'worker-error')
DEPENDENCY_NAMES = ('', 'threading', 'time', 'engine', 'sprite-api', 'hashlib', 're', 'stat')
DISPLAY_FORMS = ('none', 'not-registered', 'rejected', 'local-uri')
SPRITE_DURATION = 31536000.0
# Installed GForce.py documents these integer bits; its named constants are
# tuples in this version, so use the documented values rather than tuple ORs.
SPRITE_FLAGS = 1 | 4 | 8 | 16384  # fit, preserve aspect, no crop, alpha blend
NO_UPDATE = object()


class PrivateJSONReader(object):
    """Small strict reader for the private schema; no eval or optional modules."""
    def __init__(self, contents):
        if not isinstance(contents, STRING_TYPES) or len(contents) > MAX_STATE_BYTES:
            raise ValueError('Invalid state size')
        self.contents = contents
        self.index = 0
        self.nodes = 0

    def _node(self):
        self.nodes += 1
        if self.nodes > 128:
            raise ValueError('Excessive state nodes')

    def _space(self):
        while self.index < len(self.contents) and self.contents[self.index] in ' \t\r\n':
            self.index += 1

    def _take(self, character):
        self._space()
        if self.index >= len(self.contents) or self.contents[self.index] != character:
            raise ValueError('Invalid JSON syntax')
        self.index += 1

    def _hex(self):
        value = self.contents[self.index:self.index + 4]
        if len(value) != 4 or any(character not in '0123456789abcdefABCDEF' for character in value):
            raise ValueError('Invalid Unicode escape')
        self.index += 4
        return int(value, 16)

    def _string(self):
        self._take('"')
        result = []
        escapes = {'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f',
                   'n': '\n', 'r': '\r', 't': '\t'}
        while self.index < len(self.contents):
            character = self.contents[self.index]
            self.index += 1
            if character == '"':
                return u''.join(result)
            if ord(character) < 32:
                raise ValueError('Invalid JSON string')
            if character != '\\':
                code = ord(character)
                if 0xd800 <= code <= 0xdbff:
                    if self.index >= len(self.contents) or not 0xdc00 <= ord(self.contents[self.index]) <= 0xdfff:
                        raise ValueError('Unpaired Unicode surrogate')
                    low = self.contents[self.index]
                    self.index += 1
                    try:
                        character = UNICODE_CHARACTER(0x10000 + ((code - 0xd800) << 10) + ord(low) - 0xdc00)
                    except ValueError:
                        character += low
                elif 0xdc00 <= code <= 0xdfff:
                    raise ValueError('Unpaired Unicode surrogate')
                result.append(character)
                continue
            if self.index >= len(self.contents):
                raise ValueError('Invalid JSON escape')
            escaped = self.contents[self.index]
            self.index += 1
            if escaped in escapes:
                result.append(escapes[escaped])
            elif escaped == 'u':
                code = self._hex()
                if 0xd800 <= code <= 0xdbff:
                    if self.contents[self.index:self.index + 2] != '\\u':
                        raise ValueError('Unpaired Unicode surrogate')
                    self.index += 2
                    low = self._hex()
                    if not 0xdc00 <= low <= 0xdfff:
                        raise ValueError('Unpaired Unicode surrogate')
                    combined = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00
                    try:
                        result.append(UNICODE_CHARACTER(combined))
                    except ValueError:  # Python 2 builds with narrow Unicode.
                        result.append(UNICODE_CHARACTER(code) + UNICODE_CHARACTER(low))
                elif 0xdc00 <= code <= 0xdfff:
                    raise ValueError('Unpaired Unicode surrogate')
                else:
                    result.append(UNICODE_CHARACTER(code))
            else:
                raise ValueError('Invalid JSON escape')
        raise ValueError('Unterminated JSON string')

    def _value(self, depth):
        if depth > 6:
            raise ValueError('Excessive state depth')
        self._node()
        self._space()
        if self.index >= len(self.contents):
            raise ValueError('Missing JSON value')
        character = self.contents[self.index]
        if character == '"':
            return self._string()
        if character == '{':
            self.index += 1
            result = {}
            self._space()
            if self.index < len(self.contents) and self.contents[self.index] == '}':
                self.index += 1
                return result
            while True:
                self._node()
                key = self._string()
                if key in result:
                    raise ValueError('Duplicate JSON key')
                self._take(':')
                result[key] = self._value(depth + 1)
                self._space()
                if self.index < len(self.contents) and self.contents[self.index] == '}':
                    self.index += 1
                    return result
                self._take(',')
        for literal, value in (('true', True), ('false', False), ('null', None)):
            if self.contents.startswith(literal, self.index):
                self.index += len(literal)
                return value
        start = self.index
        if character == '-':
            self.index += 1
        digit_start = self.index
        while self.index < len(self.contents) and self.contents[self.index] in '0123456789':
            self.index += 1
        digits = self.contents[digit_start:self.index]
        if not digits or len(digits) > 16 or (len(digits) > 1 and digits[0] == '0'):
            raise ValueError('Invalid JSON integer')
        return int(self.contents[start:self.index])

    def read(self):
        value = self._value(0)
        self._space()
        if self.index != len(self.contents):
            raise ValueError('Trailing JSON data')
        return value


def _quote_scalar(value):
    if not isinstance(value, STRING_TYPES):
        raise ValueError('Invalid diagnostic scalar')
    result = ['"']
    for character in value:
        if character in ('"', '\\'):
            result.append('\\' + character)
        elif ord(character) < 32 or ord(character) > 126:
            raise ValueError('Invalid diagnostic scalar')
        else:
            result.append(character)
    result.append('"')
    return ''.join(result)


def _encode_scalars(value, keys):
    result = []
    for key in keys:
        item = value[key]
        if type(item) is bool:
            encoded = 'true' if item else 'false'
        elif isinstance(item, INTEGER_TYPES):
            encoded = str(item)
        elif isinstance(item, STRING_TYPES):
            encoded = _quote_scalar(item)
        else:
            raise ValueError('Invalid diagnostic scalar')
        result.append(_quote_scalar(key) + ':' + encoded)
    contents = ('{' + ','.join(result) + '}').encode('ascii')
    if len(contents) > 1024:
        raise ValueError('Excessive diagnostic size')
    return contents


def _bootstrap(stage, dependency=''):
    if not STATE_PATH:
        return
    try:
        value = {'version': 1, 'pid': os.getpid(), 'stage': stage,
                 'dependency': dependency if dependency in DEPENDENCY_NAMES else ''}
        contents = _encode_scalars(value, ('version', 'pid', 'stage', 'dependency'))
        # One tiny initialization proof; never called by a frame callback.
        with open(os.path.join(os.path.dirname(STATE_PATH), 'native-bootstrap.json'), 'wb') as stream:
            stream.write(contents)
    except Exception:
        pass


def _integer(value, minimum, maximum):
    return (not isinstance(value, bool) and isinstance(value, INTEGER_TYPES)
            and minimum <= value <= maximum)


def _text(value):
    if not isinstance(value, STRING_TYPES) or len(value) > 256:
        raise ValueError('Invalid display text')
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError('Invalid display text')
    return value


def _fresh(updated, now):
    return (_integer(updated, 1, 9007199254740991)
            and -FUTURE_MS <= now - updated <= STALE_MS)


def _regular_file(pathname, maximum):
    details = os.lstat(pathname)
    if (not stat.S_ISREG(details.st_mode) or os.path.islink(pathname)
            or details.st_size < 1 or details.st_size > maximum):
        raise ValueError('Invalid private file')


def _artwork(value, directory):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('Invalid artwork')
    filename = value.get('file')
    if (not isinstance(filename, STRING_TYPES)
            or not re.match(r'^artwork-[0-9a-f]{64}\.(png|jpg)\Z', filename)
            or not _integer(value.get('width'), 1, 4096)
            or not _integer(value.get('height'), 1, 4096)):
        raise ValueError('Invalid artwork')
    pathname = os.path.join(directory, filename)
    if os.path.normcase(os.path.dirname(os.path.realpath(pathname))) != directory:
        raise ValueError('Invalid artwork location')
    _regular_file(pathname, MAX_ART_BYTES)
    with open(pathname, 'rb') as stream:
        contents = stream.read(MAX_ART_BYTES + 1)
    if len(contents) > MAX_ART_BYTES:
        raise ValueError('Invalid artwork size')
    if hashlib.sha256(contents).hexdigest() != filename[8:72]:
        raise ValueError('Invalid artwork identity')
    valid_format = (contents.startswith(b'\x89PNG\r\n\x1a\n') if filename.endswith('.png')
                    else contents.startswith(b'\xff\xd8\xff'))
    if not valid_format:
        raise ValueError('Invalid artwork format')
    return {'file': filename, 'width': value['width'], 'height': value['height']}


def _read_state(pathname, now, pid):
    directory = os.path.normcase(os.path.dirname(os.path.realpath(pathname)))
    if os.path.islink(os.path.dirname(pathname)):
        raise ValueError('Invalid private directory')
    _regular_file(pathname, MAX_STATE_BYTES)
    with open(pathname, 'rb') as stream:
        contents = stream.read(MAX_STATE_BYTES + 1)
    if len(contents) > MAX_STATE_BYTES:
        raise ValueError('Invalid state size')
    value = PrivateJSONReader(contents.decode('utf-8')).read()
    if (not isinstance(value, dict) or not _integer(value.get('version'), 1, 1)
            or type(value.get('active')) is not bool
            or not _fresh(value.get('updatedAt'), now)):
        raise ValueError('Invalid state')
    if not value['active']:
        return None
    if not _integer(value.get('nativePid'), 1, 2147483647) or value['nativePid'] != pid:
        raise ValueError('Unowned native target')
    session = value.get('session')
    if (not isinstance(session, STRING_TYPES) or len(session) > 160
            or not re.match(r'^[A-Za-z0-9_.:-]{1,160}\Z', session)):
        raise ValueError('Invalid session')
    track = value.get('track')
    if track is None:
        return None
    if (not isinstance(track, dict) or not isinstance(track.get('key'), STRING_TYPES)
            or not re.match(r'^[0-9a-f]{64}\Z', track['key'])):
        raise ValueError('Invalid track')
    return {'updatedAt': value['updatedAt'], 'session': session,
            'track': {'key': track['key'], 'title': _text(track.get('title')),
                      'artist': _text(track.get('artist')), 'album': _text(track.get('album')),
                      'artwork': _artwork(track.get('artwork'), directory)}}


class MetadataReader(object):
    """Only this worker touches state/art files; it never calls native APIs."""
    def __init__(self, pathname, pid):
        self.pathname = pathname
        self.pid = pid
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.metadata_error = ''
        self.status = {'session': '', 'trackKey': '', 'spriteApplied': False,
                       'trackOverlayApplied': False, 'error': '', 'stage': 'worker-started'}
        self.dependencies_loaded = False
        self.dependency = ''
        self.worker_stage = 'worker-started'
        self.last_diagnostic = None
        self.pending_display = None
        self.thread = threading.Thread(target=self._run, name='RabbitHoleNowPlaying')
        self.thread.daemon = True

    def start(self):
        self.thread.start()

    def _read_once(self):
        error = ''
        try:
            if not self.dependencies_loaded:
                for name in ('hashlib', 're', 'stat'):
                    self.dependency = name
                    globals()[name] = __import__(name)
                self.dependency = ''
                self.dependencies_loaded = True
            value = _read_state(self.pathname, int(time.time() * 1000), self.pid)
            self.worker_stage = 'metadata-read'
        except ImportError:
            value = None
            error = 'dependency-error'
            self.worker_stage = 'dependency-error'
        except Exception:
            value = None
            error = 'metadata-unavailable'
            self.worker_stage = 'metadata-read'
        with self.lock:
            self.latest = value
            self.metadata_error = error
        self._publish_diagnostic()

    def set_status(self, session, key, sprite, overlay, error, stage, display=None):
        # The graphics thread only swaps plain data and never waits for the worker.
        if not self.lock.acquire(False):
            return False
        try:
            self.status = {'session': session, 'trackKey': key,
                           'spriteApplied': bool(sprite), 'trackOverlayApplied': bool(overlay),
                           'error': error if error in DIAGNOSTIC_ERRORS else 'native-display',
                           'stage': stage if stage in DIAGNOSTIC_STAGES else 'native-error'}
            if display is not None:
                # One newest accepted attempt, independent of later idle status.
                self.pending_display = dict(display)
        finally:
            self.lock.release()
        return True

    def _publish_diagnostic(self):
        now = time.time()
        if (self.last_diagnostic is not None and now >= self.last_diagnostic
                and now - self.last_diagnostic < DIAGNOSTIC_SECONDS):
            return
        self.last_diagnostic = now
        with self.lock:
            value = dict(self.status)
            if not value['error']:
                value['error'] = self.metadata_error
            if self.metadata_error:
                value['stage'] = self.worker_stage
        value.update({'version': 1, 'pid': self.pid, 'updatedAt': int(now * 1000)})
        value['dependency'] = self.dependency if self.dependency in DEPENDENCY_NAMES else ''
        directory = os.path.dirname(self.pathname)
        destination = os.path.join(directory, 'native-status.json')
        try:
            contents = _encode_scalars(value, ('version', 'pid', 'updatedAt', 'session', 'trackKey',
                'spriteApplied', 'trackOverlayApplied', 'error', 'stage', 'dependency'))
            # Optional diagnostic only. Readers tolerate a transient partial write;
            # this avoids unavailable ctypes/Windows replacement dependencies.
            with open(destination, 'wb') as stream:
                stream.write(contents)
        except Exception:
            pass
        self._flush_display()

    def _flush_display(self):
        with self.lock:
            display = self.pending_display
        if display is not None:
            try:
                retained = dict(display, version=1, pid=self.pid)
                contents = _encode_scalars(retained, ('version', 'pid', 'updatedAt', 'session', 'trackKey',
                    'outcome', 'form', 'stage', 'artworkRequested', 'spriteApplied', 'trackOverlayApplied'))
                with open(os.path.join(os.path.dirname(self.pathname), 'native-last-display.json'), 'wb') as stream:
                    stream.write(contents)
                with self.lock:
                    # A frame may have queued a newer failure during this write.
                    if self.pending_display is display:
                        self.pending_display = None
            except Exception:
                pass

    def _run(self):
        while not self.stopping.is_set():
            try:
                self._read_once()
            except Exception:
                with self.lock:
                    self.latest = None
                    self.metadata_error = 'worker-error'
                    self.worker_stage = 'worker-error'
                try:
                    self._publish_diagnostic()
                except Exception:
                    pass
            self.stopping.wait(POLL_SECONDS)
        # Best effort on orderly worker Stop; never join or write from shutdown.
        try:
            self._flush_display()
        except Exception:
            pass

    def snapshot(self):
        if not self.lock.acquire(False):
            return NO_UPDATE
        try:
            return self.latest
        finally:
            self.lock.release()

    def stop(self):
        # Do not join a blocked file operation on the graphics/shutdown thread.
        self.stopping.set()


def _kill_text(engine, state):
    if not state['text_owned']:
        return
    state['text_owned'] = False
    kill = getattr(SS.Interpreter, 'KillOverlay', None)
    if callable(kill):
        kill(OVERLAY_ID)
    else:
        # Fixed documented native command; no metadata becomes command text.
        engine.ExecuteCmdStr('KillOverlay(%d);' % OVERLAY_ID)


def _clear_art(engine, state):
    sprite_owned = state['sprite_owned']
    package = state['package']
    state['sprite_owned'] = False
    state['package'] = None
    state['art'] = None
    try:
        if sprite_owned:
            engine.KillSprites(SPRITE_NAME, True, 0.0)
    finally:
        if package is not None:
            manager = SS.GetPackageMgr('G-Force')
            if manager.GetPackageByName(ART_PACKAGE) is package:
                manager.UnregisterPackage(ART_PACKAGE)
                engine.RebuildConfigList('Sprite')


def _clear(engine, state):
    state['error'] = ''
    try:
        _kill_text(engine, state)
    except Exception:
        state['error'] = 'text-clear'
    try:
        _clear_art(engine, state)
    except Exception:
        state['error'] = 'art-clear'
    state['updatedAt'] = 0
    state['active_track'] = None
    state['art_blocked'] = None
    state['art_error'] = ''
    state['blocked'] = None
    state['display_attempt'] = None


def _windows_path(value):
    # Pure path identity check: no filesystem lookups on the graphics thread.
    if not isinstance(value, STRING_TYPES + (bytes,)) or len(value) > 4096:
        raise ValueError('Unsupported private artwork path')
    if not isinstance(value, UNICODE_TYPE):
        value = value.decode('utf-8')
    pathname = value.replace('\\', '/')
    if (len(pathname) < 4 or pathname[0] not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
            or pathname[1:3] != ':/'
            or any(ord(character) < 32 or ord(character) == 127 for character in pathname)):
        raise ValueError('Unsupported private artwork path')
    parts = pathname[3:].split('/')
    if any(part in ('', '.', '..') or ':' in part for part in parts):
        raise ValueError('Unsupported private artwork path')
    return pathname[0].upper() + ':/' + '/'.join(parts)


def _sprite_directory(state_path):
    pathname = _windows_path(state_path)
    if pathname.rsplit('/', 1)[-1] != 'now-playing.json':
        raise ValueError('Unsupported private artwork path')
    # Native VFS strips file:// and accepts the slash-prefixed /Volumes path.
    # Raw file://C:/ availability was never established by the earlier QA.
    return 'file://' + _volume_path(pathname.rsplit('/', 1)[0] + '/')


def _volume_path(pathname):
    # Already normalized local drive path; preserve Unicode and spaces.
    return '/Volumes/' + pathname[0].upper() + '/' + pathname[3:]


class ArtworkComponentError(ValueError):
    pass


class ArtworkAvailabilityError(ValueError):
    pass


def _verify_sprite_component(entry, art):
    try:
        expected_vfs = _sprite_directory(STATE_PATH) + art['file']
        components = entry.EntryComponentList
        if len(components) != 1 or components[0].mPathname != expected_vfs:
            raise ValueError('Unowned artwork component')
        # RegisterExternalSprites preserves its VFS URI through RegisterEntries.
        # Keep this verified component unchanged; geometry's resolver is unrelated.
    except Exception:
        # Never include a component path in diagnostics.
        raise ArtworkComponentError('Artwork component rejected')


def _show_art(engine, state, art):
    signature = None if art is None else (art['file'], art['width'], art['height'])
    if signature == state['art']:
        return
    _clear_art(engine, state)
    if art is None:
        return
    manager = SS.GetPackageMgr('G-Force')
    if manager.GetPackageByName(ART_PACKAGE) is not None:
        raise ValueError('Artwork package already owned')
    package = CreateGForceSpritePackage(_sprite_directory(STATE_PATH))
    package.PackageName = ART_PACKAGE
    # Special-use entries stay out of the user's automatic Sprite slideshow.
    entry = package.AddEntry(SPRITE_NAME, art['file'], {}, 2)  # ss_ConfigHasSpecialUse
    state['package'] = package
    manager.RegisterPackage(package)
    # FinalizeEntry already checks native file availability while registering.
    # Reject a silently unavailable entry before invoking the legacy loader.
    if not entry.ConfigFlags & 1:  # ss_ConfigAvailable
        raise ArtworkAvailabilityError('Native artwork entry unavailable')
    _verify_sprite_component(entry, art)
    state['art_form'] = 'local-uri'
    engine.RebuildConfigList('Sprite')
    # Mark before invocation so partial native startup is cleared on errors.
    state['sprite_owned'] = True
    engine.StartSprite(SPRITE_NAME, SPRITE_DURATION, SPRITE_FLAGS)
    state['art'] = signature


def _apply(engine, state, snapshot):
    if snapshot is None:
        _clear(engine, state)
        return
    state['updatedAt'] = snapshot['updatedAt']
    track = snapshot['track']
    token = (snapshot['session'], track['key'])
    art = track['artwork']
    art_signature = (token, None if art is None else (art['file'], art['width'], art['height']))
    if art_signature != state['art_blocked']:
        try:
            if art is None:
                state['art_form'] = 'none'
            elif (art['file'], art['width'], art['height']) != state['art']:
                state['art_form'] = 'not-registered'
            _show_art(engine, state, art)
            state['art_error'] = ''
            state['art_blocked'] = None
        except Exception as error:
            state['art_error'] = ('art-component' if isinstance(error, ArtworkComponentError) else
                                  'art-availability' if isinstance(error, ArtworkAvailabilityError) else 'art-display')
            if isinstance(error, ArtworkComponentError):
                state['art_form'] = 'rejected'
            state['art_blocked'] = art_signature
            try:
                _clear_art(engine, state)
            except Exception:
                state['art_error'] = 'art-clear'
    if token != state['track']:
        _kill_text(engine, state)
        text = '\r'.join(value for value in (track['title'], track['artist']) if value)
        if text:
            state['text_owned'] = True
            engine.StartTextOverlay(text.encode('utf-8'), '', 18, 1.0, 6.0, 2.0,
                                    0.5, 0.86, -1.0, OVERLAY_ID)
        state['track'] = token
    state['active_track'] = token
    state['error'] = state['art_error']


def _ensure_reader(engine):
    if engine.PRODUCT_NAME != 'G-Force' or engine.HOST_NAME != 'Standalone':
        return None
    state = getattr(engine, SENTINEL, None)
    if state is None:
        state = {'reader': None, 'track': None, 'updatedAt': 0, 'art': None,
                 'package': None, 'sprite_owned': False, 'text_owned': False,
                 'closed': False, 'error': '', 'blocked': None, 'active_track': None,
                 'art_blocked': None, 'art_error': '', 'art_form': 'none',
                 'display_attempt': None, 'display_pending': None}
        setattr(engine, SENTINEL, state)
        try:
            reader = MetadataReader(STATE_PATH, os.getpid())
            state['reader'] = reader
            reader.start()
        except Exception:
            state['closed'] = True
            state['error'] = 'worker-error'
            # One fixed vendor-captured line; no frame-time files or retry loop.
            print('Rabbit Hole now-playing: worker-start-error')
    return state


def _render(engine):
    state = _ensure_reader(engine)
    if state is None:
        return
    if state['closed']:
        return
    signature = None
    attempted_snapshot = None
    try:
        snapshot = state['reader'].snapshot()
        if snapshot is not NO_UPDATE:
            if snapshot is not None and not _fresh(snapshot['updatedAt'], int(time.time() * 1000)):
                snapshot = None
            signature = None
            if snapshot is not None:
                # Fresh accepted heartbeats also count during a suppressed failure.
                state['updatedAt'] = snapshot['updatedAt']
                track = snapshot['track']
                art = track['artwork']
                signature = (snapshot['session'], track['key'], None if art is None else
                             (art['file'], art['width'], art['height']))
            if signature is None or signature != state['blocked']:
                if snapshot is not None and signature != state['display_attempt']:
                    attempted_snapshot = snapshot
                _apply(engine, state, snapshot)
        elif state['updatedAt'] and not _fresh(state['updatedAt'], int(time.time() * 1000)):
            _clear(engine, state)
    except Exception:
        _clear(engine, state)
        state['blocked'] = signature
        state['error'] = state['error'] or 'native-display'
    if attempted_snapshot is not None:
        state['display_attempt'] = signature
        state['display_pending'] = {
            'updatedAt': int(time.time() * 1000), 'session': attempted_snapshot['session'],
            'trackKey': attempted_snapshot['track']['key'],
            'outcome': state['error'] if state['error'] in DIAGNOSTIC_ERRORS and state['error'] else
                       'start-invoked' if state['sprite_owned'] else 'text-only' if state['text_owned'] else 'no-display',
            'form': state['art_form'] if state['art_form'] in DISPLAY_FORMS else 'rejected',
            'stage': 'native-error' if state['error'] else 'display-attempt',
            'artworkRequested': attempted_snapshot['track']['artwork'] is not None,
            'spriteApplied': state['sprite_owned'], 'trackOverlayApplied': state['text_owned']}
    token = state['active_track']
    delivered = state['reader'].set_status(token[0] if token else '', token[1] if token else '',
        state['sprite_owned'], state['text_owned'], state['error'],
        'native-error' if state['error'] else 'native-applied' if token else 'render-ready', state['display_pending'])
    if delivered:
        state['display_pending'] = None


def _install():
    hook_sentinel = SENTINEL + '_hooks'
    if not STATE_PATH or not DEPENDENCIES_READY or hasattr(EngineInstance, hook_sentinel):
        return
    original_render = EngineInstance.RenderFrame
    original_startup = EngineInstance.OnStartup
    original_shutdown = EngineInstance.OnShutdown

    def startup(engine):
        result = original_startup(engine)
        try:
            state = _ensure_reader(engine)
            if state is not None:
                # Startup-only proof also distinguishes skipped frame callbacks.
                _bootstrap('worker-error' if state['closed'] else 'worker-started')
        except Exception:
            _bootstrap('worker-error')
        return result

    def render(engine, inTimeIndex):
        result = original_render(engine, inTimeIndex)
        try:
            _render(engine)
        except Exception:
            # Native/vendor failures above this boundary propagate unchanged.
            pass
        return result

    def shutdown(engine):
        state = getattr(engine, SENTINEL, None)
        if isinstance(state, dict) and not state['closed']:
            state['closed'] = True
            try:
                state['reader'].stop()
                _clear(engine, state)
            except Exception:
                pass
        return original_shutdown(engine)

    setattr(EngineInstance, hook_sentinel, {'render': original_render, 'startup': original_startup,
                                          'shutdown': original_shutdown})
    EngineInstance.OnStartup = startup
    EngineInstance.RenderFrame = render
    EngineInstance.OnShutdown = shutdown


def ExportPackage(inPathname):
    _bootstrap('package-loaded')
    if not DEPENDENCIES_READY:
        _bootstrap('dependency-error', BOOTSTRAP_DEPENDENCY)
    else:
        try:
            _install()
            _bootstrap('hooks-installed')
        except Exception:
            _bootstrap('hook-error')
    # No factory config, theme, category, source or preferences are modified.
    return VisPackage(inPathname)
