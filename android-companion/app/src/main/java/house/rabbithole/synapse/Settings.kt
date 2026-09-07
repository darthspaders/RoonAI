package house.rabbithole.synapse

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("synapse", Context.MODE_PRIVATE)
    var url: String get() = prefs.getString("url", "")!!; set(v) { prefs.edit().putString("url", v.trim().trimEnd('/')).apply() }
    var driving: Boolean get() = prefs.getBoolean("driving", false); set(v) { prefs.edit().putBoolean("driving", v).apply() }
    var noisy: Boolean get() = prefs.getBoolean("noisy", false); set(v) { prefs.edit().putBoolean("noisy", v).apply() }
    var allowHttp: Boolean get() = prefs.getBoolean("allowHttp", false); set(v) { prefs.edit().putBoolean("allowHttp", v).apply() }
    var maxSeconds: Int get() = prefs.getInt("maxSeconds", 15).coerceIn(5, 30); set(v) { prefs.edit().putInt("maxSeconds", v.coerceIn(5, 30)).apply() }
    var voice: String get() = prefs.getString("voice", "")!!; set(v) { prefs.edit().putString("voice", v).apply() }
    var token: String get() = decrypt("token"); set(v) { encrypt("token", v.trim()) }
    var pending: String get() = decrypt("pending"); set(v) { encrypt("pending", v) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("synapse-device", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("synapse-device", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(name: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        check(prefs.edit().putString(name, encoded).commit()) { "Could not save encrypted settings." }
    }
    private fun decrypt(name: String): String {
        val raw = prefs.getString(name, null) ?: return ""
        return try {
            val bytes = Base64.decode(raw, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
        } catch (_: Exception) { "" }
    }
}
