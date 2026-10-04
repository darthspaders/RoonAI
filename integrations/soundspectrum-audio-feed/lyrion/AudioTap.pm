package Plugins::HQPlayerBridge::RabbitHoleAudioTap;

# Optional side-copy of bytes that HQPlayer already requested. This module must
# never read the playback queue, wait for a receiver, or alter a returned chunk.
use strict;
use warnings;
use JSON::PP ();
use IO::Socket::INET;
use Socket qw(inet_aton pack_sockaddr_in);
use Time::HiRes ();

our $BUILD = 1;
my ($initialized, $demand_path, $demand, $socket, $poll_error);
my (%contexts, $counter);
my $json = JSON::PP->new->utf8->canonical;
my $peer_ip = inet_aton('127.0.0.1');
my $timer_owner = 'RabbitHoleAudioTap';

sub init {
    return if $initialized;
    $initialized = 1;
    my $config_path = __FILE__;
    $config_path =~ s{[^\\/]+$}{RabbitHoleAudioTap.config.json};
    my $config = _read_json($config_path);
    if ($config && ($config->{version} || 0) == 1 &&
        !ref($config->{demandFile}) && ($config->{demandFile} || '') =~ m{^(?:[A-Za-z]:[\\/]|/)}) {
        $demand_path = $config->{demandFile};
    }
    eval {
        Slim::Control::Request::addDispatch(
            ['rhaudiofeed', 'status'], [0, 1, 0, \&_status_query]);
    };
    _poll_demand();
    return;
}

sub _read_json {
    my $path = shift;
    return unless defined $path && -f $path && -s $path <= 4096;
    open(my $fh, '<:raw', $path) or return;
    my $text = '';
    my $read = read($fh, $text, 4097);
    close($fh);
    return unless defined $read && $read > 0 && $read <= 4096;
    my $value = eval { $json->decode($text) };
    return ref($value) eq 'HASH' ? $value : undef;
}

sub _valid_demand {
    my $value = shift;
    my $now = Time::HiRes::time() * 1000;
    return unless $value && ($value->{version} || 0) == 1;
    return unless !ref($value->{port}) && ($value->{port} || '') =~ /^\d{1,5}$/ &&
        $value->{port} > 0 && $value->{port} <= 65535;
    return unless !ref($value->{token}) && ($value->{token} || '') =~ /^[a-f0-9]{64}$/;
    return unless !ref($value->{playerId}) && ($value->{playerId} || '') =~ /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i;
    return unless !ref($value->{expiresAt}) && ($value->{expiresAt} || '') =~ /^\d{10,16}$/ &&
        $value->{expiresAt} > $now && $value->{expiresAt} <= $now + 30000;
    return { %$value, playerId => lc($value->{playerId}) };
}

sub _poll_demand {
    $demand = eval { _valid_demand(_read_json($demand_path)) };
    $poll_error = $@ ? 1 : 0;
    eval {
        Slim::Utils::Timers::killTimers($timer_owner, \&_poll_demand);
        Slim::Utils::Timers::setTimer($timer_owner, Time::HiRes::time() + 1, \&_poll_demand);
    };
    # Keep only short-lived byte-format context, never a client or audio buffer.
    my $now = Time::HiRes::time();
    for my $id (keys %contexts) {
        delete $contexts{$id} if $now - ($contexts{$id}->{seenAt} || 0) > 60;
    }
    return;
}

sub _id {
    my $client = shift;
    my $id = eval { $client->id } || '';
    return $id =~ /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i ? lc($id) : '';
}

sub _live_demand {
    my $id = shift;
    return unless $demand && $demand->{playerId} eq $id &&
        $demand->{expiresAt} > Time::HiRes::time() * 1000;
    return $demand;
}

# Streaming FLAC header with no total-sample count or MD5. The decoder can
# resynchronize at the next frame after a partial initial frame. Preserve an
# actual source STREAMINFO when it becomes available, including block sizes.
sub _flac_join_header {
    my ($rate, $channels, $bits, $min, $max) = @_;
    return '' unless defined($rate) && $rate =~ /^\d+$/ && $rate > 0 && $rate <= 1048575 &&
        defined($channels) && $channels =~ /^\d+$/ && $channels >= 1 && $channels <= 8 &&
        defined($bits) && $bits =~ /^\d+$/ && $bits >= 4 && $bits <= 32;
    $min ||= 4096;
    $max ||= $min;
    my $hi = ($rate << 12) | (($channels - 1) << 9) | (($bits - 1) << 4);
    return 'fLaC' . pack('C4', 128, 0, 0, 34) . pack('n2', $min, $max) .
        pack('C6', 0, 0, 0, 0, 0, 0) . pack('N2', $hi, 0) . ("\0" x 16);
}

sub _actual_header {
    my $bytes = shift;
    return '' unless length($bytes) >= 42 && substr($bytes, 0, 4) eq 'fLaC' &&
        (ord(substr($bytes, 4, 1)) & 127) == 0 && substr($bytes, 5, 3) eq "\0\0\x22";
    my ($min, $max) = unpack('n2', substr($bytes, 8, 4));
    my $hi = unpack('N', substr($bytes, 18, 4));
    return _flac_join_header($hi >> 12, (($hi >> 9) & 7) + 1, (($hi >> 4) & 31) + 1, $min, $max);
}

sub begin {
    my ($client, $prelude) = @_;
    my $id = _id($client) or return;
    end($client);
    # This hook is only the LMS-owned tier-4 byte stream. Other tiers bypass it.
    my $tier = eval { $client->hqTier } || 0;
    my $song = eval { $client->controller->songStreamController->song };
    my $format = eval { $song->streamformat } || '';
    my $reason = $tier != 4 ? 'unsupported-tier' : $format ne 'flc' ? 'unsupported-format' : '';
    my $track = eval { $song->currentTrack };
    my $join = eval { _flac_join_header($track->samplerate, $track->channels, $track->samplesize) } || '';
    $join = _actual_header($prelude || '') || $join;
    if (scalar(keys %contexts) >= 16) {
        my ($oldest) = sort { $contexts{$a}->{seenAt} <=> $contexts{$b}->{seenAt} } keys %contexts;
        delete $contexts{$oldest};
    }
    $contexts{$id} = { reason => $reason, joinPrelude => $join,
        initialPrelude => $prelude || '', bytesSeen => 0, seenAt => Time::HiRes::time() };
    return;
}

sub _socket {
    return $socket if $socket;
    $socket = IO::Socket::INET->new(Proto => 'udp') or return;
    if (!defined($socket->blocking(0))) { close($socket); undef $socket; return; }
    return $socket;
}

sub _packet {
    my ($ctx, $target, $type, $payload) = @_;
    my $header = $json->encode({v => 1, token => $target->{token},
        playerId => $target->{playerId}, generation => $ctx->{generation},
        sequence => $ctx->{sequence}, type => $type, format => 'flac'});
    return unless length($header) <= 1024 && length($payload) <= 32768;
    my $packet = $header . "\n" . $payload;
    my $sock = _socket() or return;
    my $sent = send($sock, $packet, 0, pack_sockaddr_in($target->{port}, $peer_ip));
    return unless defined($sent) && $sent == length($packet);
    $ctx->{sequence}++;
    return 1;
}

sub copy_chunk {
    my ($client, $ref) = @_;
    return unless ref($ref) eq 'SCALAR';
    my $id = _id($client) or return;
    my $ctx = $contexts{$id} or return;
    if (!length($$ref)) { end($client); return; }
    $ctx->{seenAt} = Time::HiRes::time();
    if (!$ctx->{bytesSeen}) { $ctx->{joinPrelude} = _actual_header($$ref) || $ctx->{joinPrelude}; }
    my $before = $ctx->{bytesSeen};
    $ctx->{bytesSeen} += length($$ref);
    my $target = _live_demand($id) or return;
    return if $ctx->{reason} || ($ctx->{retryAfter} || 0) > Time::HiRes::time();
    if (length($$ref) > 32768) {
        delete $ctx->{active}; $ctx->{retryAfter} = Time::HiRes::time() + 1; return;
    }
    my $active = $ctx->{active};
    if (!$active || $active->{token} ne $target->{token} || $active->{port} != $target->{port}) {
        # A late join needs a validated streaming header; otherwise wait for
        # the next stream rather than decoding unidentified bytes.
        return if $before && !$ctx->{joinPrelude};
        $active = { generation => $$ . '-' . (++$counter), sequence => 0,
            token => $target->{token}, port => $target->{port} };
        my $prelude = $before ? $ctx->{joinPrelude} : $ctx->{initialPrelude};
        unless (eval { _packet($active, $target, 'begin', $prelude) }) {
            $ctx->{retryAfter} = Time::HiRes::time() + 1; delete $ctx->{active}; return;
        }
        $ctx->{active} = $active;
    }
    unless (eval { _packet($active, $target, 'data', $$ref) }) {
        delete $ctx->{active}; $ctx->{retryAfter} = Time::HiRes::time() + 1;
    }
    return;
}

sub end {
    my $client = shift;
    my $id = _id($client) or return;
    my $ctx = delete $contexts{$id} or return;
    my $target = _live_demand($id);
    eval { _packet($ctx->{active}, $target, 'end', '') }
        if $target && $ctx->{active} && $ctx->{active}->{token} eq $target->{token};
    return;
}

sub status {
    my $ctx = $demand ? $contexts{$demand->{playerId}} : undef;
    return {version => 1, build => $BUILD, loaded => 1, demand => $demand ? 1 : 0,
        state => !$demand ? 'idle' : !$ctx ? 'waiting' : $ctx->{reason} ? 'unsupported' : $ctx->{active} ? 'streaming' : 'waiting',
        reason => !$demand ? '' : !$ctx ? 'no-context' : $ctx->{reason} || '',
        configured => $demand_path ? 1 : 0};
}

sub _status_query {
    my $request = shift;
    if (!$request->isQuery([['rhaudiofeed'], ['status']])) { $request->setStatusBadDispatch(); return; }
    my $result = status();
    $request->addResult($_, $result->{$_}) for keys %$result;
    $request->setStatusDone();
    return;
}

1;
