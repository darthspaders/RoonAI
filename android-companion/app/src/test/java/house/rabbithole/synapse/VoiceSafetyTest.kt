package house.rabbithole.synapse

import org.junit.Assert.*
import org.junit.Test

class VoiceSafetyTest {
    @Test fun wakePhraseRequiresWholeWordsAndStripsOnlyPrefix() {
        assertTrue(WakePhrase.matches("hey synapse skip this track"))
        assertFalse(WakePhrase.matches("hey synapses"))
        assertEquals("skip this track", WakePhrase.strip("Hey Synapse, skip this track"))
        assertEquals("pause", WakePhrase.strip("pause"))
        assertEquals("find a track called hey synapse", WakePhrase.strip("find a track called hey synapse"))
    }
    @Test fun authenticatedHttpIsRestrictedToExplicitPrivateOrigins() {
        assertEquals("192.168.1.5", ServerAddress.validate("http://192.168.1.5:3777", true).host)
        assertEquals("100.101.12.1", ServerAddress.validate("http://100.101.12.1:3777", true).host)
        listOf("http://192.168.1.5:3777" to false, "http://example.com" to true, "http://8.8.8.8" to true,
            "https://user:password@example.com" to false, "https://example.com/api" to false,
            "https://example.com?token=secret" to false).forEach { (url, flag) ->
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.validate(url, flag) }
        }
    }
}
