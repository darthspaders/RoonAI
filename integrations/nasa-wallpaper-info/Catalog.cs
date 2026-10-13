// Read-only view of the existing publisher manifest and NASA catalog.
// No downloader, image processor, metadata cache, or WhiteCap dependency.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;
using System.Xml.Linq;
using System.Runtime.Serialization.Json;

namespace RabbitHole.NasaDesktopInfo
{
    public sealed class ImageInfo
    {
        public string Id, Path, Title, Target, Description, Mission, Credit, Publication, DateKind;
        public string OriginalResolution, DownloadResolution, SourceUrl, SourceKind, Sha256;
    }

    public static class Catalog
    {
        public static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        public static object Value(Dictionary<string, object> row, string key) { object v; return row.TryGetValue(key, out v) ? v : null; }
        public static string Text(Dictionary<string, object> row, string key) { return Convert.ToString(Value(row, key), CultureInfo.InvariantCulture) ?? ""; }
        public static int Number(Dictionary<string, object> row, string key) { int n; return int.TryParse(Text(row, key), out n) ? n : 0; }
        public static IEnumerable<object> Items(object value) { return value as IEnumerable<object> ?? new object[0]; }
        public static Dictionary<string, object> ReadSmall(string file)
        {
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length > 8 * 1024 * 1024) throw new InvalidDataException("Unexpectedly large publisher manifest.");
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    return Map(new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 }.DeserializeObject(reader.ReadToEnd()));
            }
        }
        public static string Clean(string value)
        {
            value = Regex.Replace(value ?? "", @"<\s*(br\s*/?|/p)\s*>", "\n", RegexOptions.IgnoreCase);
            value = Regex.Replace(value, "<[^>]+>", "");
            value = WebUtility.HtmlDecode(value);
            return Regex.Replace(value.Replace("\r", ""), @"[\t ]+", " ").Trim();
        }
        public static string NasaUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.UserInfo != "" || !uri.IsDefaultPort) return null;
            var host = uri.DnsSafeHost;
            return host.Equals("nasa.gov", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".nasa.gov", StringComparison.OrdinalIgnoreCase) ? uri.AbsoluteUri : null;
        }
        public static string ValidatedSource(string root, string id, string digest, out string kind)
        {
            kind = null;
            try
            {
                var cache = ReadSmall(Path.Combine(root, "data", "nasa-wallpaper", "source-links.json"));
                if (Number(cache, "version") != 1) return null;
                var decision = Map(Value(Map(Value(cache, "records")), id));
                DateTime expires;
                if (Text(decision, "state") != "valid" || Text(decision, "id") != id || Text(decision, "presentationSha256") != digest ||
                    !DateTime.TryParse(Text(decision, "validUntil"), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out expires) || expires <= DateTime.UtcNow) return null;
                var selected = Map(Value(decision, "selected"));
                var url = NasaUrl(Text(selected, "url"));
                if (url == null || Number(selected, "status") < 200 || Number(selected, "status") >= 300) return null;
                var checks = Items(Value(decision, "checks")).Select(Map).ToArray();
                if (!checks.Any(c => Text(c, "state") == "valid" && Text(c, "finalUrl") == url) ||
                    checks.Any(c => Text(c, "state") == "missing" && (Text(c, "url") == url || Text(c, "finalUrl") == url))) return null;
                kind = Text(selected, "kind");
                return url;
            }
            catch (IOException) { return null; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }
        public static string Resolution(int width, int height) { return width > 0 && height > 0 ? width.ToString("N0") + " × " + height.ToString("N0") + " px" : ""; }
        public static string Dimensions(object value)
        {
            var a = Items(value).Take(2).ToArray();
            int w, h;
            return a.Length == 2 && int.TryParse(Convert.ToString(a[0]), out w) && int.TryParse(Convert.ToString(a[1]), out h) ? Resolution(w, h) : "";
        }
        public static string Date(string value)
        {
            // Preserve the catalog's calendar date; do not shift a date-only publication by the PC time zone.
            DateTime date;
            return value != null && value.Length >= 10 && DateTime.TryParseExact(value.Substring(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date)
                ? date.ToString("MMMM d, yyyy", CultureInfo.CurrentCulture) : Clean(value);
        }
        public static string Hash(string file)
        {
            using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
        }
        public static string KeyHash(string text)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").Substring(0, 20);
        }
        static object FromXml(XElement element)
        {
            var type = (string)element.Attribute("type");
            if (type == "object") return element.Elements().ToDictionary(e => (string)e.Attribute("item") ?? e.Name.LocalName, FromXml);
            if (type == "array") return element.Elements().Select(FromXml).ToArray();
            if (type == "null") return null;
            return element.Value;
        }
        public static Dictionary<string, Dictionary<string, object>> ReadRecords(string file, HashSet<string> ids)
        {
            var found = new Dictionary<string, Dictionary<string, object>>();
            // Stream past unrelated records. The live catalog is tens of MB and keeps growing;
            // do not deserialize it into a second in-memory catalog every polling interval.
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = JsonReaderWriterFactory.CreateJsonReader(stream, new XmlDictionaryReaderQuotas {
                MaxDepth = 64, MaxStringContentLength = 1024 * 1024, MaxArrayLength = 1024 * 1024,
                MaxBytesPerRead = 16384, MaxNameTableCharCount = 1024 * 1024 }))
            {
                while (reader.Read())
                {
                    if (reader.NodeType != XmlNodeType.Element || reader.Depth != 1 || reader.LocalName != "assets") continue;
                    reader.Read();
                    while (reader.Depth > 1)
                    {
                        if (reader.NodeType == XmlNodeType.Element && reader.Depth == 2)
                        {
                            var id = reader.GetAttribute("item") ?? reader.LocalName;
                            if (ids.Contains(id))
                            {
                                using (var subtree = reader.ReadSubtree()) found[id] = Map(FromXml(XElement.Load(subtree)));
                            }
                            reader.Skip();
                        }
                        else if (!reader.Read()) break;
                    }
                    break;
                }
            }
            return found;
        }
        public static ImageInfo Resolve(string root, string currentPath, out string reason)
        {
            reason = "Wallpaper is outside the isolated NASA library.";
            if (String.IsNullOrWhiteSpace(currentPath)) return null;
            var home = System.IO.Path.Combine(root, "data", "nasa-wallpaper");
            var config = ReadSmall(System.IO.Path.Combine(home, "config.json"));
            var output = System.IO.Path.GetFullPath(Text(config, "output")).TrimEnd('\\');
            var path = System.IO.Path.GetFullPath(currentPath);
            if (!String.Equals(System.IO.Path.GetDirectoryName(path), output, StringComparison.OrdinalIgnoreCase)) return null;
            reason = "Wallpaper does not have a verified publisher/catalog match.";
            var match = Regex.Match(System.IO.Path.GetFileName(path), @"^NASA-([a-f0-9]{64})\.jpg$", RegexOptions.IgnoreCase);
            if (!match.Success || !File.Exists(path)) return null;
            var manifest = ReadSmall(System.IO.Path.Combine(home, "manifest.json"));
            if (Number(manifest, "version") != 1 || !String.Equals(Text(manifest, "output").TrimEnd('\\'), output, StringComparison.OrdinalIgnoreCase)) return null;
            var files = Map(Value(manifest, "files"));
            var pair = files.FirstOrDefault(p => String.Equals(p.Key, System.IO.Path.GetFileName(path), StringComparison.OrdinalIgnoreCase));
            var export = Map(pair.Value);
            var digest = match.Groups[1].Value.ToLowerInvariant();
            if (Text(export, "sha256") != digest || Number(export, "width") != 3840 || Number(export, "height") != 2160) return null;
            // A user-edited JPEG with an old filename must not inherit the old image's identity.
            if (Hash(path) != digest) { reason = "Wallpaper bytes no longer match the published image."; return null; }
            var ids = new HashSet<string>(Items(Value(export, "ids")).Select(Convert.ToString));
            if (ids.Count == 0) return null;
            var records = ReadRecords(System.IO.Path.Combine(root, "data", "nasa-whitecap", "pipeline", "catalog.json"), ids);
            foreach (var id in Items(Value(export, "ids")).Select(Convert.ToString))
            {
                Dictionary<string, object> row;
                if (!records.TryGetValue(id, out row) || Text(row, "stage") != "verified" || Text(row, "presentationSha256") != digest) continue;
                if (String.IsNullOrWhiteSpace(Clean(Text(row, "title")))) continue;
                var prepared = Map(Value(row, "prepared"));
                if (Text(Map(Value(prepared, "files")), "background-4k.jpg") != digest) continue;
                reason = "matched";
                string sourceKind;
                var sourceUrl = ValidatedSource(root, id, digest, out sourceKind);
                return new ImageInfo {
                    Id = id, Path = path, Sha256 = digest, Title = Clean(Text(row, "title")), Target = Clean(Text(row, "target")),
                    Description = Clean(Text(row, "description")), Mission = Clean(Text(row, "mission")), Credit = Clean(Text(row, "credit")),
                    Publication = Date(Text(row, "releaseDate")), DateKind = Clean(Text(row, "dateKind")),
                    OriginalResolution = Resolution(Number(row, "sourceWidth"), Number(row, "sourceHeight")),
                    DownloadResolution = Dimensions(Value(prepared, "sourceDimensions")), SourceUrl = sourceUrl, SourceKind = sourceKind
                };
            }
            return null;
        }
    }
}
