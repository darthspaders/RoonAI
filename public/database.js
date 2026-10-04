/* Read-only catalog browsing. No queue, rating or analysis actions live here. */
(() => {
  "use strict";
  const root = document.querySelector("#databaseView");
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const number = value => Number(value || 0).toLocaleString();
  const ratingNames = { love: "Love", like: "Like", good: "Good (legacy)", ok: "Okay", dislike: "Dislike", never: "Never again", skip: "Skip (legacy)", wrong_genre: "Wrong genre", reject_similar: "Reject similar", unrated: "Unrated" };
  const fieldNames = { media: "Collection", availability: "File availability", q: "Search", genre: "Genre", artist: "Artist", label: "Label", rating: "Rating", sonic: "Sonic", tag: "Metadata tag", sonicTag: "Sonic tag", provider: "Provider", source: "Seen in", artwork: "Artwork", yearMin: "Year from", yearMax: "Year to", bpmMin: "BPM from", bpmMax: "BPM to", durationMin: "Minutes from", durationMax: "Minutes to", album: "Album" };
  const valueNames = { local: "Local files only", available: "Available at last scan", unreadable: "Needs attention", embedded: "Embedding stored", missing: "Missing", reviewed: "Reviewed", anchor: "Anchor profile", has: "Available" };
  const groupNames = { genre: "Genre tags", tag: "Metadata tags", sonicTag: "Sonic tags", artist: "Artists", label: "Labels" };
  const allLabels = { genre: "All genres", rating: "All ratings", tag: "All metadata tags", sonicTag: "All Sonic tags", provider: "All providers", source: "All sources" };
  const arrayFields = new Set(["genre", "artist", "label", "rating", "tag", "sonicTag", "provider", "source"]);
  const state = { view: "recordings", group: "genre", sort: "count", direction: "desc", offset: 0, filters: {}, albumName: "", returnView: null };
  let payload = null, pending = false, controller = null, generation = 0, searchTimer = null, saveMode = "", returnFocus = null;
  const storageKey = "rabbit-hole.database.views.v1";
  let saved = [];
  try { const value = JSON.parse(localStorage.getItem(storageKey) || "[]"); if (Array.isArray(value)) saved = value.filter(item => item && typeof item.name === "string" && item.state).slice(0, 30); } catch { /* Browser storage may be disabled. */ }
  const coverIcon = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="7"/><circle cx="24" cy="24" r="1.5"/><path d="M12 24a12 12 0 0 1 12-12M24 36a12 12 0 0 0 12-12"/></svg>';
  const closeIcon = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  function art(url, extra = "") {
    return `<span class="dbArtwork ${extra}">${coverIcon}<span class="dbMissingArt">No artwork</span>${/^https?:\/\//i.test(url || "") ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}</span>`;
  }
  function wireImages(container) {
    container.querySelectorAll("img").forEach(img => {
      const failed = () => { img.hidden = true; img.parentElement.title = "Album artwork unavailable"; };
      img.addEventListener("error", failed, { once: true });
      if (img.complete && !img.naturalWidth) failed();
    });
  }
  function time(ms) { if (!ms) return "—"; const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
  function filterValue(field, value) { return field === "rating" ? ratingNames[value] || value : field === "album" ? state.albumName || "Selected album" : valueNames[value] || value; }
  function hasFilters() { return Object.keys(state.filters).some(field => field !== "media"); }
  function clearFilters() { state.filters = state.filters.media === "local" ? { media: "local" } : {}; state.albumName = ""; state.returnView = null; state.offset = 0; $("#dbSearch").value = ""; syncForm(); load(); }
  function setFilter(field, value) {
    if (value !== "" && value != null) state.filters[field] = arrayFields.has(field) ? (Array.isArray(value) ? value : [value]) : String(value);
    else delete state.filters[field];
    state.offset = 0;
  }
  function syncForm() {
    for (const element of $("#dbFilters").elements) {
      if (!element.name) continue;
      const value = state.filters[element.name];
      element.value = Array.isArray(value) ? value[0] || "" : value || "";
    }
    $("#dbSearch").value = state.filters.q || "";
    $("#dbGroup").value = state.group;
    $("#dbFilterCount").textContent = hasFilters() ? `(${Object.keys(state.filters).length})` : "";
    const loved = (state.filters.rating || []).join(",") === "love,like,good";
    $("[data-db-quick='loved']").setAttribute("aria-pressed", String(loved));
    $("[data-db-quick='missing']").setAttribute("aria-pressed", String(state.filters.sonic === "missing"));
  }
  function syncView() {
    const local = state.filters.media === "local";
    $("[data-db-local]").setAttribute("aria-pressed", String(local));
    $("[data-db-view='tracks']").textContent = local ? "Files" : "Source records";
    $("[data-db-view='recordings']").hidden = local;
    $("#dbAvailabilityLabel").hidden = !local;
    if (local && state.view === "recordings") state.view = "tracks";
    root.querySelectorAll("[data-db-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.dbView === state.view)));
    $("#dbGroupLabel").hidden = state.view !== "tags";
    const options = state.view === "tags" ? [["name", "Name"], ["count", "Track count"], ["recent", "Recently seen"]]
      : state.view === "albums" ? [["name", "Album name"], ["artist", "Artist"], ["year", "Release year"], ["count", "Track count"], ["recent", "Recently seen"]]
      : [["name", "Track name"], ["artist", "Artist"], ["recent", "Recently seen"], ["year", "Release year"], ["bpm", "BPM"], ["duration", "Duration"]];
    if (!options.some(([value]) => value === state.sort)) { state.sort = "name"; state.direction = "asc"; }
    $("#dbSort").innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    $("#dbSort").value = state.sort;
    $("#dbDirection").textContent = state.direction === "asc" ? "Ascending" : "Descending";
    $("#dbDirection").setAttribute("aria-label", state.direction === "asc" ? "Sort descending" : "Sort ascending");
    $("#dbResultsHeading").textContent = state.view === "tags" ? groupNames[state.group] : state.view === "albums" ? "Albums" : state.albumName || (local ? "Local Library" : state.view === "recordings" ? "Recordings" : "Source records");
    const chips = [];
    if (state.returnView) chips.push('<button type="button" data-db-back>Back to collections</button>');
    for (const [field, values] of Object.entries(state.filters)) {
      for (const value of Array.isArray(values) ? values : [values]) chips.push(`<button type="button" data-db-remove="${esc(field)}" data-value="${esc(value)}" aria-label="Remove ${esc(fieldNames[field] || field)} filter: ${esc(filterValue(field, value))}"><span>${esc(fieldNames[field] || field)}: ${esc(filterValue(field, value))}</span>${closeIcon}</button>`);
    }
    $("#dbActiveFilters").innerHTML = chips.join("");
    syncForm();
  }
  function renderFacets(facets) {
    for (const [field, allLabel] of Object.entries(allLabels)) {
      const select = $(`[data-db-facet="${field}"]`);
      const options = [...(facets[field] || [])];
      for (const selected of state.filters[field] || []) if (!options.some(item => item.value === selected)) options.unshift({ value: selected, count: 0 });
      select.innerHTML = `<option value="">${allLabel}</option>` + options.map(item => `<option value="${esc(item.value)}">${esc(filterValue(field, item.value))} (${number(item.count)})</option>`).join("");
      if ((state.filters[field] || []).length > 1) select.insertAdjacentHTML("beforeend", '<option value="__multiple__" disabled>Multiple selections</option>');
    }
    for (const [field, id] of [["artist", "dbArtistOptions"], ["label", "dbLabelOptions"]]) {
      $(`#${id}`).innerHTML = (facets[field] || []).map(item => `<option value="${esc(item.value)}">${number(item.count)} tracks</option>`).join("");
    }
    syncForm();
    for (const field of Object.keys(allLabels)) if ((state.filters[field] || []).length > 1) $(`[data-db-facet="${field}"]`).value = "__multiple__";
  }
  function renderItems() {
    const results = $("#dbResults");
    if (!payload.items.length) {
      const message = !payload.catalogTracks ? (payload.media === "local" ? "No local files have been inventoried yet. Run a library scan to populate this collection." : "Tracks will appear here as Rabbit Hole learns your catalog.")
        : !payload.matchingTracks ? "Try removing a filter or using a broader search."
        : state.view === "albums" ? "These tracks have no stored album title. You can still explore them in Tracks."
        : "No stored tags in this category match. Try another grouping or view these tracks.";
      results.innerHTML = `<div class="dbEmpty"><h3>${!payload.catalogTracks ? "Your database is ready to grow" : "No matching " + (state.view === "tags" ? "collections" : payload.media === "local" && state.view === "tracks" ? "files" : state.view)}</h3><p>${message}</p><button type="button" data-db-empty="${payload.matchingTracks ? "tracks" : "clear"}">${payload.matchingTracks ? "View matching tracks" : hasFilters() ? "Clear filters" : "Refresh database"}</button></div>`;
      return;
    }
    if (payload.media === "local" && state.view === "tracks") {
      results.innerHTML = '<div class="dbTableRegion" tabindex="0" role="region" aria-label="Local files; scroll horizontally for more columns"><table class="dbTable"><caption class="dbVisuallyHidden">Each row is a physical file in your local library.</caption><thead><tr><th scope="col">Track / artist</th><th scope="col">Album</th><th scope="col">File</th><th scope="col">Sonic</th></tr></thead><tbody>' + payload.items.map((track, index) => `<tr><td><button class="dbTrackTitle" type="button" data-db-track="${index}">${esc(track.title)}</button><span class="dbTrackArtist">${esc(track.artist || "Artist not tagged")}</span></td><td>${esc(track.album || "Album not tagged")}<span class="dbSecondary">${track.trackNumber ? "Track " + track.trackNumber : ""}</span></td><td><span class="dbBadge">Local · ${esc(track.fileFormat)}</span><span class="dbSecondary">${esc(track.availability === "available" ? "Available at last scan" : track.availability === "missing" ? "Missing at last scan" : "Needs attention")}</span></td><td>${!payload.sonicAvailable ? "Unknown" : track.sonicEmbedded ? "Analysed" : "Not analysed"}</td></tr>`).join("") + '</tbody></table></div>';
    } else if (!["tracks", "recordings"].includes(state.view)) {
      results.innerHTML = `<ul class="dbGrid">${payload.items.map((item, index) => `<li><button type="button" class="dbCollection" data-db-collection="${index}" aria-label="Explore ${esc(item.name)}, ${number(item.count)} ${payload.media === "local" ? "local files" : "stored tracks"}"><span class="dbMosaic ${state.view === "albums" ? "dbAlbumCover" : ""}">${state.view === "albums" ? art(item.images[0]) : [0, 1, 2, 3].map(index => art(item.images[index])).join("")}</span><span class="dbCollectionName">${esc(item.name)}</span><span class="dbCollectionMeta">${state.view === "albums" ? `${esc(item.artist)}${item.year ? ` · ${item.year}` : ""}<br>` : ""}${number(item.count)} ${payload.media === "local" ? (item.count === 1 ? "file" : "files") : item.count === 1 ? "recording" : "recordings"}${item.sourceReleaseCount > 1 ? `<br>${item.sourceReleaseCount} album sources · editions kept separate` : ""}</span></button></li>`).join("")}</ul>`;
    } else {
      const heading = (label, sort, className = "") => `<th scope="col" class="${className}"${sort && state.sort === sort ? ` aria-sort="${state.direction === "asc" ? "ascending" : "descending"}"` : ""}>${sort ? `<button type="button" data-db-sort="${sort}" aria-label="Sort by ${label.toLowerCase()}">${label}</button>` : label}</th>`;
      results.innerHTML = `<div class="dbTableRegion" tabindex="0" role="region" aria-label="Track results; scroll horizontally for more columns"><table class="dbTable"><caption class="dbVisuallyHidden">Stored tracks matching your filters. Select a track name for details.</caption><thead><tr>${heading("Track / artist", "name")}${heading("Album", "", "dbAlbumCell")}${heading("Genre / label", "", "dbGenreCell")}${heading("BPM", "bpm", "dbBpmCell")}${heading("Time", "duration", "dbDurationCell")}${heading("Rating")}${heading("Sonic")}</tr></thead><tbody>${payload.items.map((track, index) => `<tr><td><div class="dbTrackCell">${art(track.imageUrl, "dbThumbnail")}<div><button class="dbTrackTitle" type="button" data-db-track="${index}">${esc(track.title || "Untitled track")}</button><span class="dbTrackArtist">${esc(track.artist || "Unknown artist")}</span>${track.sourceCount > 1 ? `<span class="dbSecondary">${track.identityStatus === "verified" ? `Verified · ${track.sourceCount} source records` : track.identityStatus === "source-matched" ? `${track.sourceCount} matching source records` : "Single source"}</span>` : ""}</div></div></td><td class="dbAlbumCell">${esc(track.album || "—")}<span class="dbSecondary">${track.year || ""}</span></td><td class="dbGenreCell">${esc(track.genres.join(" · ") || "—")}<span class="dbSecondary">${esc(track.label)}</span></td><td class="dbNumber dbBpmCell">${track.bpm || "—"}</td><td class="dbNumber dbDurationCell">${time(track.durationMs)}</td><td>${track.ratingConflict ? '<span class="dbBadge">Conflicting ratings</span>' : track.rating ? `<span class="dbBadge">${esc(ratingNames[track.rating] || track.rating)}</span>` : '<span class="dbSecondary">Unrated</span>'}</td><td><span class="dbBadge ${track.sonicEmbedded ? "" : "dbSubtle"}">${track.sourceCount > 1 ? "By source" : !payload.sonicAvailable ? "Unavailable" : track.sonicEmbedded ? "Stored" : "Missing"}</span>${track.sourceCount > 1 ? "" : track.sonicReviewed ? '<span class="dbSecondary">Reviewed</span>' : ""}${track.sourceCount > 1 ? "" : track.sonicAnchor ? '<span class="dbSecondary">Anchor</span>' : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }
    wireImages(results);
  }
  async function load({ refresh = false, focus = false } = {}) {
    clearTimeout(searchTimer);
    if (!root.classList.contains("isActive")) return;
    syncView();
    controller?.abort();
    controller = new AbortController();
    const requestController = controller;
    const requestId = ++generation;
    pending = true;
    $("#dbResults").setAttribute("aria-busy", "true");
    $("#dbResultStatus").textContent = "Loading your music…";
    $("#dbPagination").hidden = true;
    const skeletonTimer = setTimeout(() => {
      if (generation === requestId) $("#dbResults").innerHTML = '<p class="dbLoadingText">Reading the stored catalog…</p><div class="dbGrid" aria-hidden="true">' + '<div class="dbSkeleton"></div>'.repeat(6) + "</div>";
    }, 180);
    const timeout = setTimeout(() => requestController.abort("timeout"), 35_000);
    try {
      const params = new URLSearchParams({ view: state.view, group: state.group, sort: state.sort, direction: state.direction, limit: ["tracks", "recordings"].includes(state.view) ? 50 : 36, offset: state.offset });
      for (const [field, values] of Object.entries(state.filters)) for (const value of Array.isArray(values) ? values : [values]) params.append(field, value);
      if (refresh) params.set("refresh", "true");
      const response = await fetch(`/api/database?${params}`, { signal: requestController.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The database could not be loaded.");
      if (requestId !== generation) return;
      payload = data; state.offset = data.offset;
      $("#dbCatalogStatus").textContent = `${number(data.catalogTracks)} stored tracks · Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      const unit = state.view === "tracks" ? "tracks" : state.view === "albums" ? "albums" : "collections";
      $("#dbResultStatus").textContent = state.view === "recordings" ? `${number(data.total)} results · ${number(data.catalogTracks)} original source records preserved` : state.view === "tracks" ? `${number(data.matchingTracks)} of ${number(data.catalogTracks)} tracks` : `${number(data.total)} ${unit} · ${number(data.matchingTracks)} matching tracks`;
      $("#dbViewNote").textContent = state.view === "recordings" ? (data.canonicalUnavailable ? "Recording links are unavailable. All source rows remain visible." : "Matching recordings appear once. Open a track to inspect its original sources, ratings and match evidence. Distinct mixes stay separate.") : state.view === "tracks" ? "Select a track for its stored metadata. Sonic Stored means an embedding exists; it is not a musical judgment."
        : state.view === "albums" ? `Related album sources appear together; release editions remain separately inspectable.${data.missingAlbumCount ? ` ${number(data.missingAlbumCount)} matching tracks have no album title; find them in Tracks.` : ""}`
        : state.group === "sonicTag" ? "Existing Sonic profile tags, without new classifications. Select a tag to explore its tracks."
        : "Select a collection to explore its tracks. Counts follow your current filters.";
      if (data.media === "local") {
        const scans = data.localScans || [];
        $("#dbCatalogStatus").textContent = `${number(data.catalogTracks)} local files · ${number(data.availabilityCounts.available)} available at last scan`;
        $("#dbResultStatus").textContent = state.view === "tracks" ? `${number(data.matchingTracks)} of ${number(data.catalogTracks)} local files` : `${number(data.total)} ${unit} · ${number(data.matchingTracks)} local files`;
        $("#dbViewNote").textContent = (scans.length ? scans.map(scan => `${scan.root_path} · Scan ${scan.status}${scan.completed_at ? " · " + new Date(scan.completed_at).toLocaleString() : " · " + number(scan.files_seen) + " files checked"}${scan.files_failed ? " · " + number(scan.files_failed) + " files need attention" : ""}`).join(". ") : "No completed library scan yet.") + " Each file is kept separately. Album groups use file tags and folders. Sonic status requires analysis of these file bytes; scanning does not run analysis or write tags.";
      }
      let albumSources = $("#dbAlbumSources");
      if (!albumSources) { $("#dbViewNote").insertAdjacentHTML("afterend", '<details id="dbAlbumSources" class="dbDetailSection" hidden><summary>Album sources and editions</summary><div></div></details>'); albumSources = $("#dbAlbumSources"); }
      albumSources.hidden = !(data.albumSources?.length);
      albumSources.querySelector("div").innerHTML = (data.albumCollectionKey && data.query.album !== data.albumCollectionKey ? `<p><button type="button" data-db-album-source="${esc(data.albumCollectionKey)}">All album sources</button></p>` : "") + (data.albumSources || []).map(source => `<p><button type="button" data-db-album-source="${esc(source.key)}">${esc(source.name)} · ${esc(source.key.startsWith("tidal-album:") ? "TIDAL release " + source.key.split(":")[1] : source.key.startsWith("beatport-album:") ? "Beatport release " + source.key.split(":")[1] : "Stored album metadata")} · ${source.years.join(" / ") || "Date unknown"} · ${source.count} known recordings</button></p>`).join("");
      renderFacets(data.facets); renderItems();
      $("#dbPagination").hidden = data.total <= data.limit;
      $("#dbPrevious").disabled = data.offset === 0;
      $("#dbNext").disabled = data.offset + data.limit >= data.total;
      $("#dbPageLabel").textContent = `${number(data.offset + 1)}–${number(Math.min(data.offset + data.limit, data.total))} of ${number(data.total)}`;
      if (focus) $("#dbResultsHeading").focus({ preventScroll: true });
    } catch (error) {
      if (requestId !== generation || requestController.signal.aborted && requestController.signal.reason !== "timeout") return;
      $("#dbResultStatus").textContent = "Database unavailable";
      $("#dbResults").innerHTML = `<div class="dbEmpty"><h3>We couldn't load your database</h3><p>${requestController.signal.reason === "timeout" ? "The request took too long. Your stored music is safe; try again." : esc(error.message)}</p><button type="button" data-db-retry>Try again</button></div>`;
    } finally {
      clearTimeout(skeletonTimer); clearTimeout(timeout);
      if (requestId === generation) { pending = false; $("#dbResults").setAttribute("aria-busy", "false"); }
    }
  }
  function showTrack(track, trigger) {
    if (track.mediaType === "local") {
      const row = (name, value) => `<dt>${esc(name)}</dt><dd>${esc(value == null || value === "" ? "Not stored" : value)}</dd>`;
      $("#dbTrackDetail").innerHTML = `<h3 id="dbTrackTitle">${esc(track.title)}</h3><p>${esc(track.artist || "Artist not tagged")}</p><section class="dbDetailSection"><h4>Local media file</h4><dl class="dbDetailGrid">${row("Path", track.filePath)}${row("Availability at last scan", track.availability)}${row("Format", track.fileFormat)}${row("Size", number(track.fileSize) + " bytes")}${row("Sample rate / bit depth", [track.sampleRate && track.sampleRate + " Hz", track.bitDepth && track.bitDepth + " bit"].filter(Boolean).join(" / "))}${row("Last scanned", new Date(track.lastScannedAt).toLocaleString())}${track.scanError ? row("Scan error", track.scanError) : ""}</dl></section><section class="dbDetailSection"><h4>Embedded metadata</h4><dl class="dbDetailGrid">${row("Album", track.album)}${row("Album artist", track.albumArtist)}${row("Disc / track", [track.discNumber, track.trackNumber].filter(Boolean).join(" / "))}${row("Genre", track.genres.join(" · "))}${row("Label", track.label)}${row("Release date", track.releaseDate)}${row("Duration", time(track.durationMs))}${row("BPM / key", [track.bpm, track.key].filter(Boolean).join(" / "))}${row("ISRC", track.isrc)}</dl></section><section class="dbDetailSection"><h4>Processing</h4><p>${track.scanError ? "Scan needs attention." : "File inventoried."} Sonic: ${!payload.sonicAvailable ? "status unavailable" : track.sonicEmbedded ? "analysis stored for these file bytes" : "not analysed"}. Enrichment and tag writing are separate steps; this scan performs neither.</p></section><details class="dbDetailSection"><summary>All embedded tags</summary><dl class="dbDetailGrid">${Object.entries(track.rawTags).map(([name, value]) => row(name, value)).join("") || "No embedded tags found."}</dl></details>`;
      $("#dbTrackDetail").insertAdjacentHTML("beforeend", `<section class="dbDetailSection"><h4>Metadata proposals</h4><p>${track.metadataGatheredAt ? number(track.metadataCandidates) + " provider candidates checked. These proposals have not been written to this file." : "Metadata has not been gathered for this version of the file yet."}</p>${(track.metadataProposals || []).map(change => `<details class="dbDetailSection"><summary>${esc(change.tag)}: ${esc(change.value)} · ${change.decision === "safe_fill" ? "Proposed safe addition" : "Needs review"}</summary><dl class="dbDetailGrid">${row("Source", change.source)}${row("Review reasons", change.reasons.join("; ") || "Exact artist, title/version and duration checks passed")}${row("Provider evidence", change.evidence.map(e => e.source + ": " + e.value + (e.verified ? " (match checked)" : " (match needs review)")).join("; "))}</dl></details>`).join("") || (track.metadataGatheredAt ? "<p>No missing-tag additions are currently proposed.</p>" : "")}</section>`);
      returnFocus = trigger; $("#dbTrackDialog").showModal(); $("#dbTrackDialog [data-db-close]").focus(); return;
    }
    const detailRow = (name, value) => `<dt>${name}</dt><dd>${esc(value || "Not stored")}</dd>`;
    const safeTidal = /^\d+$/.test(track.tidalId) ? `https://tidal.com/browse/track/${track.tidalId}` : "";
    const safeBeatport = /^\d+$/.test(track.beatportId) ? `https://www.beatport.com/track/-/${track.beatportId}` : "";
    $("#dbTrackDetail").innerHTML = `<div class="dbDetailHero">${art(track.imageUrl)}<div><h3 id="dbTrackTitle">${esc(track.title || "Untitled track")}</h3><p>${esc(track.artist || "Unknown artist")}</p><p class="dbMuted">${esc(track.album || "Album not stored")}</p></div></div>
      <section class="dbDetailSection"><h4>Track metadata</h4><dl class="dbDetailGrid">${detailRow("Version", track.mixVersion)}${detailRow("Genre", track.genres.join(" · "))}${detailRow("Label", track.label)}${detailRow("Released", track.releaseDate)}${detailRow("BPM / key", [track.bpm, track.key].filter(Boolean).join(" · "))}${detailRow("Duration", track.durationMs ? time(track.durationMs) : "")}${detailRow("Latest rating", ratingNames[track.rating] || "Unrated")}</dl></section>
      <section class="dbDetailSection"><h4>Sonic</h4><dl class="dbDetailGrid">${detailRow("Embedding", !payload.sonicAvailable ? "Sonic database unavailable" : track.sonicEmbedded ? "Stored · Discogs-EffNet v1" : "Not stored")}${detailRow("Anchor profile", track.sonicAnchor ? "Stored" : "Not stored")}${detailRow("Neighbor review", track.sonicReviewed ? "A stored review exists" : "No stored review")}${detailRow("Profile tags", track.sonicTags.join(" · "))}${track.sonicNote ? detailRow("Profile note", track.sonicNote) : ""}</dl><p class="dbMuted">Embedding coverage and review judgments are separate. Browsing does not run analysis or assign decisions.</p></section>
      <section class="dbDetailSection"><h4>Stored tags &amp; sources</h4><dl class="dbDetailGrid">${detailRow("Metadata tags", track.tags.join(" · "))}${detailRow("Providers", track.providers.join(" · "))}${detailRow("Seen in", track.sources.join(" · "))}${detailRow("Artwork", track.artworkSource)}${detailRow("First seen", track.firstSeenAt ? new Date(track.firstSeenAt).toLocaleString() : "")}${detailRow("Last seen", track.lastSeenAt ? new Date(track.lastSeenAt).toLocaleString() : "")}</dl></section>
      <details class="dbDetailSection"><summary>Track identifiers</summary><dl class="dbDetailGrid">${detailRow("TIDAL", track.tidalId)}${detailRow("Beatport", track.beatportId)}${detailRow("ISRC", track.isrc)}${detailRow("Database identity", track.identityKey)}</dl></details><div class="dbDetailLinks">${safeTidal ? `<a href="${safeTidal}" target="_blank" rel="noopener noreferrer">Open in TIDAL</a>` : ""}${safeBeatport ? `<a href="${safeBeatport}" target="_blank" rel="noopener noreferrer">Open in Beatport</a>` : ""}</div>`;
    if (track.sourceRecords) {
      const sources = track.sourceRecords.map(source => `<details class="dbDetailSection"><summary>Source ${source.id} · ${esc(source.artist)} · ${esc(ratingNames[source.rating] || source.rating || "Unrated")}</summary><dl class="dbDetailGrid">${detailRow("Canonical link", track.verifiedSourceIds?.includes(source.id) ? "Verified" : "Display match only; original source retained")}${detailRow("Title", source.title)}${source.originalMetadata ? detailRow("Original stored artist / title", `${source.originalMetadata.artist} / ${source.originalMetadata.title}`) : ""}${source.displayCorrection ? detailRow("Display correction", source.displayCorrection) : ""}${detailRow("Version", source.mixVersion)}${detailRow("Album", source.album)}${detailRow("Label", source.label)}${detailRow("Year", source.year)}${detailRow("TIDAL", source.tidalId)}${detailRow("Beatport", source.beatportId)}${detailRow("ISRC", source.isrc)}${detailRow("Duration", time(source.durationMs))}${detailRow("Stored rating", ratingNames[source.rating] || source.rating || "Unrated")}${detailRow("Sonic embedding", source.sonicEmbedded ? "Stored" : "Missing")}${detailRow("Sonic review", source.sonicReviewed ? "Stored" : "No stored review")}${detailRow("Source identity", source.identityKey)}${detailRow("Matches current filters", track.matchingSourceIds.includes(source.id) ? "Yes" : "No")}</dl></details>`).join("");
      $("#dbTrackDetail .dbDetailHero").insertAdjacentHTML("afterend", `<section class="dbDetailSection"><h4>${track.identityStatus === "verified" ? "Verified recording with source matches" : track.identityStatus === "source-matched" ? "Matching source records" : "Source record"}</h4><p>${track.sourceCount} source records. ${esc(track.matchReason || "")} Ratings and Sonic evidence stay with their original sources.</p>${sources}<p class="dbMuted">Display metadata below comes from source ${track.sourceRecords[0].id}. Album editions are not grouped.</p></section>`);
    }
    wireImages($("#dbTrackDetail"));
    returnFocus = trigger; $("#dbTrackDialog").showModal(); $("#dbTrackDialog [data-db-close]").focus();
  }
  function renderSaved() {
    $("#dbSavedViews").innerHTML = '<option value="">Choose a saved view</option>' + saved.map((item, index) => `<option value="${index}">${esc(item.name)}</option>`).join("") + (saved.length ? '<option value="manage">Remove selected saved view…</option>' : "");
  }
  function applySaved(item) {
    const source = item.state || {};
    state.view = ["tags", "albums", "tracks", "recordings"].includes(source.view) ? source.view : "tags";
    state.group = Object.hasOwn(groupNames, source.group) ? source.group : "genre";
    state.sort = String(source.sort || (state.view === "tags" ? "count" : "name"));
    state.direction = ["asc", "desc"].includes(source.direction) ? source.direction : state.sort === "count" ? "desc" : "asc";
    state.filters = Object.fromEntries(Object.entries(source.filters || {}).filter(([field, value]) => Object.hasOwn(fieldNames, field) && (typeof value === "string" || Array.isArray(value))).map(([field, value]) => [field, arrayFields.has(field) ? (Array.isArray(value) ? value : [value]).filter(v => typeof v === "string").slice(0, 24) : String(value).slice(0, 300)]));
    state.albumName = String(source.albumName || ""); state.returnView = null; state.offset = 0;
    load();
  }
  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.dbClose) { $(`#${button.dataset.dbClose}`).close(); return; }
    if (button.dataset.dbAlbumSource) { setFilter("album", button.dataset.dbAlbumSource); load(); return; }
    if (button.hasAttribute("data-db-local")) { state.filters = { media: "local" }; state.albumName = ""; state.returnView = null; state.view = "tracks"; state.sort = "name"; state.direction = "asc"; state.offset = 0; load(); return; }
    if (button.dataset.dbView) { state.view = button.dataset.dbView; state.offset = 0; load(); return; }
    if (button.dataset.dbQuick) {
      const field = button.dataset.dbQuick === "loved" ? "rating" : "sonic";
      setFilter(field, button.getAttribute("aria-pressed") === "true" ? "" : field === "rating" ? ["love", "like", "good"] : "missing"); load(); return;
    }
    if (button.hasAttribute("data-db-collection") && payload) {
      const item = payload.items[Number(button.dataset.dbCollection)]; if (!item) return;
      state.returnView = { view: state.view, group: state.group, sort: state.sort, direction: state.direction, offset: state.offset, filters: structuredClone(state.filters) };
      if (state.view === "albums") { setFilter("album", item.value); state.albumName = item.name; } else setFilter(state.group, item.value);
      state.view = state.filters.media === "local" ? "tracks" : "recordings"; state.sort = "name"; state.direction = "asc"; load({ focus: true }); return;
    }
    if (button.hasAttribute("data-db-back") && state.returnView) { const back = state.returnView; Object.assign(state, back); state.returnView = null; state.albumName = ""; load({ focus: true }); return; }
    if (button.dataset.dbRemove) {
      const field = button.dataset.dbRemove;
      if (Array.isArray(state.filters[field])) { state.filters[field] = state.filters[field].filter(value => value !== button.dataset.value); if (!state.filters[field].length) delete state.filters[field]; }
      else delete state.filters[field];
      if (field === "album") state.albumName = "";
      state.offset = 0; load({ focus: true }); return;
    }
    if (button.hasAttribute("data-db-track") && payload) { const track = payload.items[Number(button.dataset.dbTrack)]; if (track) showTrack(track, button); return; }
    if (button.dataset.dbSort) { state.direction = state.sort === button.dataset.dbSort && state.direction === "asc" ? "desc" : "asc"; state.sort = button.dataset.dbSort; state.offset = 0; load(); return; }
    if (button.hasAttribute("data-db-retry")) { load({ refresh: true }); return; }
    if (button.dataset.dbEmpty) { if (button.dataset.dbEmpty === "tracks") { state.view = "tracks"; load(); } else if (hasFilters()) clearFilters(); else load({ refresh: true }); }
  });
  $("#dbFilters").addEventListener("submit", event => { event.preventDefault(); load(); });
  $("#dbFilters").addEventListener("change", event => { const input = event.target; if (!input.name) return; if (input.name === "media") { delete state.filters.album; delete state.filters.availability; state.albumName = ""; state.returnView = null; } if (!input.checkValidity()) { input.reportValidity(); return; } setFilter(input.name, input.value.trim()); load(); });
  $("#dbSearch").addEventListener("input", event => { setFilter("q", event.target.value.trim()); clearTimeout(searchTimer); searchTimer = setTimeout(() => load(), 280); });
  $("#dbSearch").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); load(); } });
  $("#dbGroup").addEventListener("change", event => { state.group = event.target.value; state.offset = 0; load(); });
  $("#dbSort").addEventListener("change", event => { state.sort = event.target.value; state.offset = 0; state.direction = ["recent", "year", "count"].includes(state.sort) ? "desc" : "asc"; load(); });
  $("#dbDirection").addEventListener("click", () => { state.direction = state.direction === "asc" ? "desc" : "asc"; state.offset = 0; load(); });
  $("#dbRefresh").addEventListener("click", () => load({ refresh: true }));
  $("#dbClearFilters").addEventListener("click", clearFilters);
  for (const [id, step] of [["dbPrevious", -1], ["dbNext", 1]]) $(`#${id}`).addEventListener("click", () => { if (!payload || pending) return; state.offset += step * payload.limit; load({ focus: true }); $("#dbResultsHeading").scrollIntoView({ block: "start" }); });
  let selectedSaved = "";
  $("#dbSavedViews").addEventListener("change", event => {
    const index = event.target.value;
    if (index === "manage") {
      if (selectedSaved !== "" && saved[Number(selectedSaved)]) {
        saved.splice(Number(selectedSaved), 1);
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); $("#dbResultStatus").textContent = "Saved view removed. Your music is unchanged."; } catch { $("#dbResultStatus").textContent = "Browser storage is unavailable."; }
        selectedSaved = ""; renderSaved();
      } else { event.target.value = ""; $("#dbResultStatus").textContent = "Choose a saved view first, then use Remove selected saved view."; }
      return;
    }
    selectedSaved = index;
    if (index !== "" && saved[Number(index)]) applySaved(saved[Number(index)]);
  });
  $("#dbSaveView").addEventListener("click", () => { saveMode = "save"; returnFocus = $("#dbSaveView"); $("#dbViewName").value = state.albumName || (state.filters.genre || [])[0] || ""; $("#dbSaveDialog").showModal(); $("#dbViewName").focus(); });
  $("#dbSaveForm").addEventListener("submit", event => {
    event.preventDefault(); if (saveMode !== "save") return;
    const name = $("#dbViewName").value.trim(); if (!name) return;
    const next = saved.filter(item => item.name.toLowerCase() !== name.toLowerCase());
    next.push({ name, state: { view: state.view, group: state.group, sort: state.sort, direction: state.direction, filters: structuredClone(state.filters), albumName: state.albumName } });
    try { localStorage.setItem(storageKey, JSON.stringify(next.slice(-30))); saved = next.slice(-30); selectedSaved = ""; renderSaved(); $("#dbResultStatus").textContent = `Saved “${name}” on this browser.`; }
    catch { $("#dbResultStatus").textContent = "This browser could not save the view. Your filters are still applied."; }
    $("#dbSaveDialog").close();
  });
  for (const dialog of root.querySelectorAll("dialog")) dialog.addEventListener("close", () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
  new MutationObserver(() => {
    if (root.classList.contains("isActive")) { if (!pending || controller?.signal.aborted) load(); }
    else { clearTimeout(searchTimer); controller?.abort(); }
  }).observe(root, { attributes: true, attributeFilter: ["class"] });
  const initial = new URLSearchParams(window.location.search);
  if (initial.get("view") === "database") {
    applySaved({ state: {
      view: initial.get("browse"), group: initial.get("group"), sort: initial.get("sort"), direction: initial.get("direction"),
      albumName: initial.get("albumName"),
      filters: Object.fromEntries(Object.keys(fieldNames).filter(field => initial.has(field)).map(field => [field, arrayFields.has(field) ? initial.getAll(field) : initial.get(field)]))
    } });
  }
  renderSaved(); syncView();
  if (window.matchMedia("(max-width: 720px)").matches) $(".dbFilterPanel").open = false;
  if (initial.get("view") === "database") document.querySelector('[data-view="database"]')?.click();
  else if (root.classList.contains("isActive")) load();
})();
