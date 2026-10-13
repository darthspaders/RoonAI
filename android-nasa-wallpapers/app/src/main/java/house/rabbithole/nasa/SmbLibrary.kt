package house.rabbithole.nasa

import android.net.Network
import com.hierynomus.msdtyp.AccessMask
import com.hierynomus.msfscc.FileAttributes
import com.hierynomus.mssmb2.SMB2CreateDisposition
import com.hierynomus.mssmb2.SMB2CreateOptions
import com.hierynomus.mssmb2.SMB2Dialect
import com.hierynomus.mssmb2.SMB2ShareAccess
import com.hierynomus.smbj.SMBClient
import com.hierynomus.smbj.SmbConfig
import com.hierynomus.smbj.auth.AuthenticationContext
import com.hierynomus.smbj.connection.Connection
import com.hierynomus.smbj.session.Session
import com.hierynomus.smbj.share.DiskShare
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.EnumSet
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

class WorkToken {
    @Volatile var cancelled = false
    private val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
    @Volatile var closeNetwork: (() -> Unit)? = null
    fun check() {
        if (cancelled || Thread.currentThread().isInterrupted) throw CancellationException()
        if (System.nanoTime() > deadline) throw UserProblem("The share took too long to respond. Try again when the PC is reachable.")
    }
    fun cancel() { cancelled = true; closeNetwork?.invoke() }
}

/** A new, bounded, read-only SMB3 connection for each operation. No background socket survives a job. */
class SmbLibrary(private val settings: ConnectionSettings, network: Network, private val token: WorkToken) : Closeable {
    private val client = SMBClient(SmbConfig.builder()
        .withDialects(SMB2Dialect.SMB_3_1_1, SMB2Dialect.SMB_3_0_2, SMB2Dialect.SMB_3_0)
        .withSigningRequired(true).withEncryptData(true).withDfsEnabled(false)
        .withTimeout(12, TimeUnit.SECONDS).withSoTimeout(12, TimeUnit.SECONDS)
        .withReadBufferSize(256 * 1024).withSocketFactory(BoundedNetworkSocketFactory(network)).build())
    private var connection: Connection? = null
    private var session: Session? = null
    private val shares = mutableMapOf<String, DiskShare>()
    init {
        token.closeNetwork = { runCatching { client.close() } }
        try {
            token.check()
            connection = client.connect(settings.wallpapers.host)
            val password = settings.password.toCharArray()
            try { session = connection!!.authenticate(AuthenticationContext(settings.username, password, settings.domain)) }
            finally { password.fill('\u0000') }
        } catch (e: Exception) { close(); throw e }
    }

    private fun read(folder: ShareFolder, relative: String, output: OutputStream, limit: Int) {
        token.check()
        val share = shares.getOrPut(folder.share.lowercase()) { session!!.connectShare(folder.share) as DiskShare }
        share.openFile(folder.child(relative).replace('/', '\\'),
            EnumSet.of(AccessMask.FILE_READ_DATA, AccessMask.FILE_READ_ATTRIBUTES),
            EnumSet.noneOf(FileAttributes::class.java), EnumSet.allOf(SMB2ShareAccess::class.java),
            SMB2CreateDisposition.FILE_OPEN, EnumSet.of(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE)).use { remote ->
            remote.inputStream.use { copyLimited(it, output, limit, token::check) }
        }
    }
    private fun text(folder: ShareFolder, relative: String, limit: Int): String = ByteArrayOutputStream().use {
        read(folder, relative, it, limit); it.toString("UTF-8")
    }
    fun manifest(): String = text(settings.catalog, "nasa-wallpaper/manifest.json", MANIFEST_LIMIT)
    fun sourceDecisions(): String = text(settings.catalog, "nasa-wallpaper/source-links.json", MANIFEST_LIMIT)
    fun metadata(image: PublishedImage): String {
        // Multiple IDs can intentionally publish the same bytes. Accept only a verified exact match.
        for (id in image.ids.take(8)) {
            token.check()
            try {
                val raw = text(settings.catalog, "nasa-whitecap/pipeline/assets/$id/metadata.json", METADATA_LIMIT)
                Catalog.metadata(raw, image, id)
                return raw
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { token.check() }
        }
        throw UserProblem("No matching verified JSON record was readable for this image. Check the catalog folder and read permissions.")
    }
    fun download(image: PublishedImage, file: File) {
        require(Catalog.validFilename(image.filename))
        file.outputStream().use { read(settings.wallpapers, image.filename, it, IMAGE_LIMIT); it.fd.sync() }
    }
    override fun close() {
        token.closeNetwork = null
        shares.values.forEach { runCatching { it.close() } }
        runCatching { session?.close() }; runCatching { connection?.close() }; runCatching { client.close() }
    }
}

/** Binding sockets to the selected network prevents Wi-Fi-only work falling back to mobile data. */
private class BoundedNetworkSocketFactory(private val network: Network) : SocketFactory() {
    override fun createSocket(): Socket = network.socketFactory.createSocket()
    private fun connect(host: String?, address: InetAddress?, port: Int, local: InetAddress? = null, localPort: Int = 0): Socket {
        val socket = createSocket()
        try {
            if (local != null) socket.bind(InetSocketAddress(local, localPort))
            val target = address ?: network.getAllByName(host!!).first()
            socket.connect(InetSocketAddress(target, port), 10000)
            return socket
        } catch (e: Exception) { runCatching { socket.close() }; throw e }
    }
    override fun createSocket(host: String, port: Int): Socket = connect(host, null, port)
    override fun createSocket(host: InetAddress, port: Int): Socket = connect(null, host, port)
    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = connect(host, null, port, local, localPort)
    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = connect(null, host, port, local, localPort)
}
