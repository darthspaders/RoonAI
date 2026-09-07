package house.rabbithole.synapse

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI

object ServerAddress {
    fun validate(value: String, allowHttp: Boolean): URI {
        val uri = URI(value)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.query == null && uri.fragment == null && uri.path in listOf("", "/")) { "Enter a server origin, such as https://rabbit-hole.example.ts.net" }
        require(uri.scheme == "https" || allowHttp) { "Enable trusted LAN HTTP or use HTTPS." }
        // HTTPS works on any trusted host. HTTP is limited to numeric private LAN/Tailscale addresses, avoiding DNS rebinding.
        if (uri.scheme == "http") {
            val p = uri.host.split('.').mapNotNull { it.toIntOrNull() }
            require(p.size == 4 && p.all { it in 0..255 } && (p[0] == 10 || p[0] == 192 && p[1] == 168 || p[0] == 172 && p[1] in 16..31 || p[0] == 100 && p[1] in 64..127 || p[0] == 127)) { "HTTP requires a numeric private LAN or Tailscale IPv4 address." }
        }
        return uri
    }
}
class ApiException(val code: Int, message: String) : Exception(message)
class RabbitHoleClient(private val settings: Settings) {
    fun request(path: String, body: JSONObject? = null): JSONObject {
        val origin = ServerAddress.validate(settings.url, settings.allowHttp).toString().trimEnd('/')
        require(settings.token.isNotBlank()) { "Enter a Rabbit Hole device token in Settings." }
        val connection = URI(origin + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 7000; connection.readTimeout = 20000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${settings.token}")
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw ApiException(status, when (status) { 401 -> "Device token rejected. Check Settings."; 404 -> "Voice endpoint unavailable. Update Rabbit Hole."; 429 -> "Rabbit Hole is busy."; else -> "Rabbit Hole returned HTTP $status." })
            return connection.inputStream.bufferedReader().use { reader ->
                val result = StringBuilder(); val block = CharArray(4096)
                while (true) { val n = reader.read(block); if (n < 0) break; result.append(block, 0, n); require(result.length <= 65536) { "Response too large." } }
                JSONObject(result.toString())
            }
        } finally { connection.disconnect() }
    }
}
