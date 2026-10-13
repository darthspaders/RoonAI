using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using RabbitHole.NasaDesktopInfo;

class CatalogTests
{
    static string root, output, image, hash, reason;
    static int passed;
    static Dictionary<string, object> row;
    static void Check(string name, bool ok) { if (!ok) throw new Exception(name); passed++; Console.WriteLine("PASS " + name); }
    static void Json(string path, object value) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, new JavaScriptSerializer().Serialize(value)); }
    static string CatalogPath { get { return Path.Combine(root, "data", "nasa-whitecap", "pipeline", "catalog.json"); } }
    static string ManifestPath { get { return Path.Combine(root, "data", "nasa-wallpaper", "manifest.json"); } }
    static void SaveRow() { Json(CatalogPath, new { version = 1, assets = new Dictionary<string, object> { { "nasa-science-fixture", row } } }); }
    static void SaveManifest(string[] ids)
    {
        Json(ManifestPath, new { version = 1, output = output, files = new Dictionary<string, object> {
            { Path.GetFileName(image), new { sha256 = hash, width = 3840, height = 2160, ids = ids } }
        } });
    }
    static int Main()
    {
        root = Path.Combine(Path.GetTempPath(), "nasa-desktop-info-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            output = Path.Combine(root, "wallpapers"); Directory.CreateDirectory(output);
            string original = Path.Combine(output, "fixture"); File.WriteAllText(original, "owned test bytes"); hash = Catalog.Hash(original);
            image = Path.Combine(output, "NASA-" + hash + ".jpg"); File.Move(original, image);
            Json(Path.Combine(root, "data", "nasa-wallpaper", "config.json"), new { output = output });
            SaveManifest(new[] { "nasa-science-fixture" });
            row = new Dictionary<string, object> {
                { "stage", "verified" }, { "presentationSha256", hash }, { "title", "IC 348 (NIRCam Image)" },
                { "target", "IC 348" }, { "description", "<p>NASA&rsquo;s image.</p><p>Second paragraph.</p>" },
                { "mission", "James Webb Space Telescope" }, { "credit", "NASA &amp; ESA" },
                { "releaseDate", "2026-09-15T00:00:00Z" }, { "dateKind", "NASA media record publication" },
                { "sourceWidth", 30866 }, { "sourceHeight", 38204 }, { "sourceUrl", "https://science.nasa.gov/image-detail/example" },
                { "prepared", new { sourceDimensions = new[] { 3878, 4801 }, files = new Dictionary<string, object> { { "background-4k.jpg", hash } } } }
            };
            SaveRow();
            var info = Catalog.Resolve(root, image, out reason);
            Check("exact published bytes map to the catalog title", info != null && info.Title == "IC 348 (NIRCam Image)" && reason == "matched");
            Check("HTML entities are readable plain text", info.Description.Contains("NASA’s") && info.Description.Contains("\n") && info.Credit == "NASA & ESA");
            Check("original and downloaded resolutions stay distinct", info.OriginalResolution.StartsWith("30") && info.DownloadResolution.StartsWith("3") && info.OriginalResolution != info.DownloadResolution);
            Check("date semantics preserved without timezone shift", info.Publication.Contains("15") && info.DateKind == "NASA media record publication");
            Check("official HTTPS source accepted", Catalog.NasaUrl("https://science.nasa.gov/example") != null);
            Check("raw sourceUrl is never exposed without a shared validation receipt", info.SourceUrl == null);
            var decision = new Dictionary<string, object> {
                { "id", "nasa-science-fixture" }, { "presentationSha256", hash }, { "state", "valid" },
                { "validUntil", DateTime.UtcNow.AddDays(1).ToString("o") },
                { "selected", new { url = "https://assets.science.nasa.gov/real.png", kind = "image", status = 200 } },
                { "checks", new[] { new { url = "https://science.nasa.gov/missing", finalUrl = "https://science.nasa.gov/images/", state = "missing", status = 404 },
                    new { url = "https://assets.science.nasa.gov/real.png", finalUrl = "https://assets.science.nasa.gov/real.png", state = "valid", status = 200 } } }
            };
            var sourcePath = Path.Combine(root, "data", "nasa-wallpaper", "source-links.json");
            Action saveSource = delegate { Json(sourcePath, new { version = 1, records = new Dictionary<string, object> { { "nasa-science-fixture", decision } } }); };
            saveSource(); info = Catalog.Resolve(root, image, out reason);
            Check("Windows consumes the shared validated image fallback", info.SourceUrl == "https://assets.science.nasa.gov/real.png" && info.SourceKind == "image");
            decision["validUntil"] = DateTime.UtcNow.AddDays(-1).ToString("o"); saveSource();
            Check("expired decision cannot reopen a stale source", Catalog.Resolve(root, image, out reason).SourceUrl == null);
            decision["validUntil"] = DateTime.UtcNow.AddDays(1).ToString("o");
            decision["selected"] = new { url = "https://science.nasa.gov/images/", kind = "page", status = 404 }; saveSource();
            Check("known 404 cannot be opened", Catalog.Resolve(root, image, out reason).SourceUrl == null);
            Check("lookalike and executable URLs rejected", new[] { "https://nasa.gov.evil.example/x", "https://evilnasa.gov/x", "javascript:alert(1)", "file:///C:/test", "http://nasa.gov/x", "https://user@nasa.gov/x", "https://nasa.gov:444/x" }.All(u => Catalog.NasaUrl(u) == null));
            var outside = Path.Combine(root, Path.GetFileName(image)); File.Copy(image, outside);
            Check("identical filename outside the dedicated folder does not match", Catalog.Resolve(root, outside, out reason) == null);
            File.WriteAllText(image, "modified bytes");
            Check("edited file cannot inherit identity from an old hash filename", Catalog.Resolve(root, image, out reason) == null);
            File.WriteAllText(image, "owned test bytes");
            row["presentationSha256"] = new string('0', 64); SaveRow();
            Check("catalog hash disagreement rejected", Catalog.Resolve(root, image, out reason) == null);
            row["presentationSha256"] = hash;
            row["stage"] = "prepared"; SaveRow();
            Check("unfinished catalog record rejected", Catalog.Resolve(root, image, out reason) == null);
            row["stage"] = "verified"; SaveRow();
            SaveManifest(new[] { "nasa-missing", "nasa-science-fixture" });
            Check("multiple catalog IDs follow an exact verified alias", Catalog.Resolve(root, image, out reason) != null);
            SaveManifest(new[] { "nasa-missing" });
            Check("missing catalog record does not reuse previous metadata", Catalog.Resolve(root, image, out reason) == null);
            SaveManifest(new[] { "nasa-science-fixture" });
            File.WriteAllText(CatalogPath, "{\"assets\":{");
            bool failed = false; try { Catalog.Resolve(root, image, out reason); } catch { failed = true; }
            Check("partial catalog read fails safely", failed);
            SaveRow();
            Check("next read recovers after atomic publisher/catalog recovery", Catalog.Resolve(root, image, out reason) != null);
            row.Remove("sourceWidth"); row.Remove("sourceHeight"); row.Remove("credit"); SaveRow();
            info = Catalog.Resolve(root, image, out reason);
            Check("missing metadata is not fabricated from the 4K export", info.OriginalResolution == "" && info.Credit == "" && info.DownloadResolution != "");
            File.Delete(image);
            Check("withdrawn wallpaper hides rather than retaining its old title", Catalog.Resolve(root, image, out reason) == null);
            Console.WriteLine(passed + " checks passed.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            // Only the unique fixture directory created above is removed.
            var full = Path.GetFullPath(root);
            if (full.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) && Path.GetFileName(full).StartsWith("nasa-desktop-info-tests-")) Directory.Delete(full, true);
        }
    }
}
