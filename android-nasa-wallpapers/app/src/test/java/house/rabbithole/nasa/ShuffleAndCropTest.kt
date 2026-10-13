package house.rabbithole.nasa

import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class ShuffleAndCropTest {
    private val images = (0..5).map { "NASA-${it.toString().repeat(64)}.jpg" }
    @Test fun noRepeatsUntilCycleCompletesAndNoImmediateCycleRepeat() {
        val bag = ShuffleBag(); val chosen = mutableListOf<String>()
        repeat(18) { val name = bag.candidates(images, Random(it)).first(); chosen.add(name); bag.markShown(name, images) }
        for (cycle in chosen.chunked(6)) assertEquals(6, cycle.distinct().size)
        assertTrue(chosen.zipWithNext().all { it.first != it.second })
    }
    @Test fun interruptedUncommittedSelectionDoesNotLoseAnImage() {
        val bag = ShuffleBag(); val before = bag.json()
        bag.candidates(images)
        assertEquals(before, bag.json())
        val restored = ShuffleBag.fromJson(before)
        assertEquals(images.toSet(), restored.candidates(images).toSet())
    }
    @Test fun historySurvivesRestartAndNewImagesJoinUnseenSet() {
        val bag = ShuffleBag(); bag.markShown(images[0], images); bag.markShown(images[1], images)
        val restored = ShuffleBag.fromJson(bag.json())
        assertEquals(images.drop(2).toSet(), restored.candidates(images).toSet())
        val added = "NASA-${"a".repeat(64)}.jpg"
        assertTrue(added in restored.candidates(images + added))
    }
    @Test fun deletingImagesDoesNotBreakRotationAndSingleImageIsAllowed() {
        val bag = ShuffleBag(); bag.markShown(images[0], images)
        assertEquals(listOf(images[1]), bag.candidates(listOf(images[1])))
        bag.markShown(images[1], listOf(images[1]))
        assertEquals(listOf(images[1]), bag.candidates(listOf(images[1])))
        assertTrue(bag.candidates(emptyList()).isEmpty())
    }
    @Test fun cropKeepsRatioAndStaysInsideSourceAtEveryFocus() {
        for (x in listOf(-1f, 0f, .5f, 1f, 2f)) for (y in listOf(0f, .5f, 1f)) {
            val box = CropGeometry.crop(3840, 2160, 1440, 3120, x, y)
            assertEquals(1440f / 3120, (box.right - box.left) / (box.bottom - box.top), .00001f)
            assertTrue(box.left >= 0 && box.top >= 0 && box.right <= 3840 && box.bottom <= 2160)
        }
    }
    @Test fun fitNeverStretchesOrCutsSource() {
        val box = CropGeometry.fit(3840, 2160, 1440, 3120)
        assertEquals(3840f / 2160, (box.right - box.left) / (box.bottom - box.top), .00001f)
        assertEquals(0f, box.left, .01f)
        assertTrue(box.top > 0)
    }
    @Test fun darkImageFallsBackToCentreAndBrightDetailMovesFocusConservatively() {
        val pixels = IntArray(160 * 90) { 0xff000000.toInt() }
        assertEquals(.5f, CropGeometry.focus(pixels, 160, 90).first, .01f)
        for (y in 20..70) for (x in 110..145) pixels[y * 160 + x] = 0xffffffff.toInt()
        val focus = CropGeometry.focus(pixels, 160, 90)
        assertTrue(focus.first in .55f.. .8f)
    }
}
