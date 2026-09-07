const test = require('node:test');
const assert = require('node:assert/strict');
const { ExternalTrackQueue } = require('../src/externalTrackQueue');

test('strict supplied queue passes verified TIDAL rows through the bridge', async () => {
  let bridgeCalls = 0;
  const queue = new ExternalTrackQueue({
    roon: {
      canQueueTrack: async () => ({ success: false, failureType: 'not_found', reason: 'direct miss' }),
      queueTracks: async (tracks, zoneId) => {
        assert.equal(zoneId, 'zone-1');
        assert.equal(tracks[0].verifiedQueueToken, 'bridge-token');
        return { queued: [{ index: 0, action: 'Queue' }], failed: [] };
      }
    },
    verify: async () => ({
      tracks: [{
        index: 0,
        tidal: { verified: true },
        track: { artist: 'ZatroMinic', title: 'Pikaboo (Original Mix)', id: '123' },
        usable: true,
        status: 'TIDAL_VERIFIED_ROON_PENDING',
        tidalTrackId: '123',
        matchedArtist: 'ZatroMinic',
        matchedTitle: 'Pikaboo (Original Mix)',
        roon: { zoneId: 'zone-1' }
      }]
    }),
    bridge: {
      resolve: async (row, input) => {
        bridgeCalls++;
        assert.equal(row.tidalTrackId, '123');
        assert.equal(input.allowBridge, true);
        return {
          queueToken: 'bridge-token',
          playlistId: 'permanent',
          match: { title: row.track.title, subtitle: row.track.artist }
        };
      }
    }
  });

  const result = await queue.queue({
    zoneId: 'zone-1',
    tracks: [{ artist: 'ZatroMinic', title: 'Pikaboo (Original Mix)' }],
    verifyBeforeQueue: true,
    allowBridge: true
  });

  assert.equal(bridgeCalls, 1);
  assert.equal(result.queuePolicy, 'strict');
  assert.equal(result.queuedCount, 1);
  assert.equal(result.failedCount, 0);
});
