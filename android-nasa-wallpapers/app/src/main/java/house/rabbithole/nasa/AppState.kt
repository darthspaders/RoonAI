package house.rabbithole.nasa

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AppState(context: Context) {
    private val prefs = context.getSharedPreferences("wallpaper_state", Context.MODE_PRIVATE)
    private val secrets = context.getSharedPreferences("connection_encrypted", Context.MODE_PRIVATE)
    val configured get() = secrets.contains("ciphertext")
    var includeLockScreen: Boolean
        get() = prefs.getBoolean("includeLockScreen", false)
        set(value) { prefs.edit().putBoolean("includeLockScreen", value).commit() }
    var operationInProgress: Boolean
        get() = prefs.getBoolean("operationInProgress", false)
        set(value) { prefs.edit().putBoolean("operationInProgress", value).commit() }
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(value) { prefs.edit().putBoolean("enabled", value).commit() }
    var status: String
        get() = prefs.getString("status", "Connect your existing NASA wallpaper collection to begin.")!!
        set(value) { prefs.edit().putString("status", value).commit() }
    var preview: String
        get() = prefs.getString("preview", "")!!
        set(value) { prefs.edit().putString("preview", value).commit() }
    val current get() = prefs.getString("current", "")!!
    val currentWallpaperId get() = prefs.getInt("systemId", 0)
    val currentIncludesLockScreen get() = prefs.getBoolean("currentIncludesLockScreen", false)
    val currentLockWallpaperId get() = prefs.getInt("lockId", -1)
    val currentFitWhole get() = prefs.getBoolean("currentFitWhole", false)
    val lastChanged get() = prefs.getLong("changed", 0)
    var libraryCount: Int
        get() = prefs.getInt("count", 0)
        set(value) { prefs.edit().putInt("count", value).commit() }
    var bag: ShuffleBag
        get() = ShuffleBag.fromJson(prefs.getString("shuffle", "{}")!!)
        set(value) { prefs.edit().putString("shuffle", value.json()).commit() }
    fun shown(image: CachedImage, wallpaperId: Int, bag: ShuffleBag, fitWhole: Boolean, includesLockScreen: Boolean, lockId: Int) {
        check(prefs.edit().putString("current", image.published.filename).putString("preview", image.published.filename)
            .putInt("systemId", wallpaperId).putLong("changed", System.currentTimeMillis())
            .putBoolean("currentFitWhole", fitWhole)
            .putBoolean("currentIncludesLockScreen", includesLockScreen).putInt("lockId", lockId)
            .putString("shuffle", bag.json()).commit())
    }
    fun resetLibrary() {
        prefs.edit().remove("current").remove("preview").remove("shuffle").remove("systemId").remove("lockId")
            .remove("currentIncludesLockScreen").remove("currentFitWhole").remove("changed").remove("count").commit()
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey("rabbit_hole_nasa_smb", null) as? SecretKey
        if (existing != null) return existing
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("rabbit_hole_nasa_smb", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun settings(): ConnectionSettings {
        if (!configured) throw UserProblem("Set up your SMB folders first.")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(secrets.getString("iv", ""), Base64.NO_WRAP)))
            return ConnectionSettings.fromJson(String(cipher.doFinal(Base64.decode(secrets.getString("ciphertext", ""), Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (_: Exception) { throw UserProblem("The saved connection could not be unlocked. Re-enter its settings and password.") }
    }
    fun save(settings: ConnectionSettings) {
        settings.validate()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val plain = settings.json().toByteArray()
        try {
            val encoded = Base64.encodeToString(cipher.doFinal(plain), Base64.NO_WRAP)
            if (!secrets.edit().putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).putString("ciphertext", encoded).commit())
                throw UserProblem("The connection could not be saved.")
        } finally { plain.fill(0) }
    }
    fun forget() { secrets.edit().clear().commit(); prefs.edit().clear().commit() }
}
