use strict;
use warnings;
use JSON::PP ();
use Scalar::Util qw(refaddr);

# Offline only: the production module's framework calls are replaced by stubs.
package Slim::Utils::Timers;
sub killTimers { }
sub setTimer { }
package Slim::Control::Request;
sub addDispatch { }
package Slim::Web::HTTP;
our $closed = 0;
sub forgetClient { $closed++ }
package main;
sub INFOLOG { 0 }

package RhTrack;
sub new { bless {}, shift }
sub samplerate { 44100 }
sub channels { 2 }
sub samplesize { 16 }
package RhSong;
sub new { bless {}, shift }
sub streamformat { 'flc' }
sub currentTrack { RhTrack->new }
package RhController;
sub new { bless {}, shift }
sub songStreamController { $_[0] }
sub song { RhSong->new }
package RhBase;
our ($ref, $calls);
sub nextChunk { $calls++; return $ref }
package Plugins::HQPlayerBridge::Player;
our @ISA = ('RhBase');
our $RABBIT_HOLE_AUDIO_TAP;
sub new { bless {chunks => ['queued']}, shift }
sub id { 'aa:bb:cc:dd:ee:ff' }
sub hqTier { 4 }
sub controller { RhController->new }
sub name { 'Offline fixture' }
sub chunks { $_[0]->{chunks} }
my $log;

package main;
my ($mode, $snippet_path, $fixture_path, $demand_path) = @ARGV;
local $/;

my $saved_demand;
if ($mode eq 'midstream') {
    open(my $df, '<:raw', $demand_path) or die 'Missing fixture demand';
    $saved_demand = <$df>;
    close($df);
    open($df, '>:raw', $demand_path) or die 'Cannot hide fixture demand';
    print {$df} '{}'; close($df);
}
my $loaded = do $snippet_path;
die $@ if $@;
die 'Missing snippet' unless defined $loaded;
my $player = Plugins::HQPlayerBridge::Player->new;
my $result = { mode => $mode, sameRef => JSON::PP::true, unchanged => JSON::PP::true, calls => 0 };

if ($mode eq 'throw') {
    no warnings 'redefine';
    *Plugins::HQPlayerBridge::RabbitHoleAudioTap::copy_chunk = sub { die 'fixture helper failure' };
    *Plugins::HQPlayerBridge::RabbitHoleAudioTap::end = sub { die 'fixture close failure' };
}
if ($mode eq 'udp-fail') {
    no warnings 'redefine';
    *Plugins::HQPlayerBridge::RabbitHoleAudioTap::_packet = sub { return undef };
}

if ($mode eq 'udp' || $mode eq 'midstream' || $mode eq 'udp-fail') {
    Plugins::HQPlayerBridge::RabbitHoleAudioTap::begin($player, '');
    open(my $af, '<:raw', $fixture_path) or die 'Missing encoded fixture';
    my $audio = <$af>; close($af);
    my $offset = 0;
    my $join_at = $mode eq 'midstream' ? int(length($audio) / 2) : 0;
    while ($offset < length($audio)) {
        if ($join_at && $offset == $join_at) {
            open(my $df, '>:raw', $demand_path) or die 'Cannot restore fixture demand';
            print {$df} $saved_demand; close($df);
            Plugins::HQPlayerBridge::RabbitHoleAudioTap::_poll_demand();
        }
        my $length = length($audio) - $offset;
        $length = 32768 if $length > 32768;
        $length = $join_at - $offset if $join_at && $offset < $join_at && $offset + $length > $join_at;
        my $bytes = substr($audio, $offset, $length);
        $RhBase::ref = \$bytes;
        my $returned = $player->nextChunk;
        $result->{sameRef} = JSON::PP::false if refaddr($returned) != refaddr($RhBase::ref);
        $result->{unchanged} = JSON::PP::false if $$returned ne substr($audio, $offset, $length);
        $offset += $length;
    }
    $result->{joinOffset} = $join_at;
    $result->{fixtureBytes} = length($audio);
} else {
    my $bytes = "fLaC\0\1fixture\xff";
    $RhBase::ref = \$bytes;
    my $returned = $player->nextChunk;
    $result->{sameRef} = refaddr($returned) == refaddr($RhBase::ref) ? JSON::PP::true : JSON::PP::false;
    $result->{unchanged} = $$returned eq "fLaC\0\1fixture\xff" ? JSON::PP::true : JSON::PP::false;
}
my $empty = '';
$RhBase::ref = \$empty;
my $returned = $player->nextChunk;
$result->{sameRef} = JSON::PP::false if refaddr($returned) != refaddr($RhBase::ref);
$player->closeStream;
$result->{closed} = $Slim::Web::HTTP::closed;
$result->{calls} = $RhBase::calls;
$result->{loaded} = $Plugins::HQPlayerBridge::Player::RABBIT_HOLE_AUDIO_TAP ? JSON::PP::true : JSON::PP::false;
$result->{status} = Plugins::HQPlayerBridge::RabbitHoleAudioTap::status() if $result->{loaded} && $mode ne 'throw';
print JSON::PP->new->canonical->encode($result);
