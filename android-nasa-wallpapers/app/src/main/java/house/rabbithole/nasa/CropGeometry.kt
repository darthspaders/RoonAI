package house.rabbithole.nasa

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class CropBox(val left: Float, val top: Float, val right: Float, val bottom: Float)

object CropGeometry {
    /** Aspect-preserving crop around image detail, with a centre bias to avoid chasing one bright star. */
    fun crop(width: Int, height: Int, outputWidth: Int, outputHeight: Int, focusX: Float = .5f, focusY: Float = .5f): CropBox {
        require(width > 0 && height > 0 && outputWidth > 0 && outputHeight > 0)
        val ratio = outputWidth.toFloat() / outputHeight
        val w = min(width.toFloat(), height * ratio)
        val h = w / ratio
        val x = (focusX.coerceIn(0f, 1f) * width - w / 2).coerceIn(0f, width - w)
        val y = (focusY.coerceIn(0f, 1f) * height - h / 2).coerceIn(0f, height - h)
        return CropBox(x, y, x + w, y + h)
    }
    fun focus(pixels: IntArray, width: Int, height: Int): Pair<Float, Float> {
        require(pixels.size == width * height && width > 0 && height > 0)
        fun luma(index: Int): Float {
            val p = pixels[index]
            return (((p shr 16) and 255) * .2126f + ((p shr 8) and 255) * .7152f + (p and 255) * .0722f) / 255
        }
        var total = 0.0; var sx = 0.0; var sy = 0.0
        for (y in 1 until height - 1) for (x in 1 until width - 1) {
            val i = y * width + x
            val contrast = abs(luma(i + 1) - luma(i - 1)) + abs(luma(i + width) - luma(i - width))
            val weight = .015 + min(.5f, luma(i)) + contrast * .8
            sx += weight * (x + .5) / width; sy += weight * (y + .5) / height; total += weight
        }
        if (total == 0.0) return .5f to .5f
        return (.5 + (sx / total - .5) * .65).toFloat() to (.5 + (sy / total - .5) * .65).toFloat()
    }
    fun fit(width: Int, height: Int, outputWidth: Int, outputHeight: Int): CropBox {
        require(width > 0 && height > 0 && outputWidth > 0 && outputHeight > 0)
        val scale = min(outputWidth.toFloat() / width, outputHeight.toFloat() / height)
        val w = width * scale; val h = height * scale
        return CropBox((outputWidth - w) / 2, (outputHeight - h) / 2, (outputWidth + w) / 2, (outputHeight + h) / 2)
    }
}
