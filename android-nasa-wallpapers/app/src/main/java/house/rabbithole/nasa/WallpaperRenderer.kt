package house.rabbithole.nasa

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import java.io.File

object WallpaperRenderer {
    fun render(file: File, width: Int, height: Int, fit: Boolean): Bitmap {
        require(width in 1..4096 && height in 1..4096 && width.toLong() * height <= 16_000_000)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth != 3840 || bounds.outHeight != 2160 || bounds.outMimeType != "image/jpeg")
            throw UserProblem("This file is not a finished 3840 × 2160 NASA JPEG.")
        val original = BitmapFactory.decodeFile(file.absolutePath) ?: throw UserProblem("The wallpaper could not be decoded.")
        try {
            val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            canvas.drawColor(Color.BLACK)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            if (fit) {
                val dst = CropGeometry.fit(original.width, original.height, width, height)
                canvas.drawBitmap(original, null, RectF(dst.left, dst.top, dst.right, dst.bottom), paint)
            } else {
                val thumb = Bitmap.createScaledBitmap(original, 160, 90, true)
                val pixels = IntArray(160 * 90)
                thumb.getPixels(pixels, 0, 160, 0, 0, 160, 90)
                val focus = CropGeometry.focus(pixels, 160, 90)
                thumb.recycle()
                val crop = CropGeometry.crop(original.width, original.height, width, height, focus.first, focus.second)
                // Canvas scaling is uniform; this presentation crop is never written back to the library.
                val scale = width / (crop.right - crop.left)
                canvas.save()
                canvas.scale(scale, scale)
                canvas.translate(-crop.left, -crop.top)
                canvas.drawBitmap(original, 0f, 0f, paint)
                canvas.restore()
            }
            return output
        } finally { original.recycle() }
    }
}
