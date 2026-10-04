"use strict";

// Read-only companion to the recording audit. Uses the production browser's
// grouping to explain visible cards; it does not propose executable merges.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { readSnapshot, buildReport, renderMarkdown: renderTrackMarkdown } = require("./audit-recording-duplicates");
const { readCatalog, browseCatalog, artwork } = require("../src/databaseBrowserCatalog");
const { normalizeCatalogText, artistCreditSetKey, normalizeAlbumFamily } = require("../src/catalogIdentityNormalization");

const text = value => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const parse = value => { try { return JSON.parse(value || "{}") || {}; } catch { return {}; } };
const uniq = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ""))];
const intersect = (a, b) => a.filter(value => b.includes(value));
const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value));
const read = (db, table, sql) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? db.prepare(sql).all() : [];
const keyKind = key => key.startsWith("album:") ? "text-fallback" : key.split(":")[0];

function releaseFamily(value) {
  // Retrieval only: an EP, deluxe edition or remaster remains a separate
  // edition assertion. Never use this stripped key as a canonical identity.
  return normalizeAlbumFamily(value).replace(/\s+(?:(?:19|20)\d{2}\s+)?(?:deluxe(?: edition| version)?|expanded(?: edition| version)?|special edition|remaster(?:ed)?(?: edition)?|reissue|ep)$/i, "").trim();
}

function editionMarkers(value) {
  const normalized = normalizeCatalogText(value);
  return uniq(normalized.match(/\b(?:deluxe|expanded|special edition|remaster(?:ed)?|reissue|anniversary|bonus|unmixed|mixed|live|instrumental|acoustic|remixes|remix|ep)\b/g) || []).sort();
}

function titleQuality(title, artists = []) {
  const normalized = normalizeCatalogText(title);
  if (!normalized) return "missing-or-punctuation-only";
  if (/^album title goes here(?: deluxe)?$/.test(normalized) && artists.some(artist => artistCreditSetKey(artist).split("|").includes("deadmau5"))) return "verified-intentional-title";
  if (/^(?:unknown(?: album)?|untitled(?: album)?|album|album title|title goes here|album title goes here|your album(?: title)?|undefined|null|none|n a|object object|various|various artists)$/.test(normalized)) return "suspect-placeholder-needs-review";
  if (/\{\{?|\}\}?|&(?:lt|gt|amp);|\ufffd/.test(title)) return "suspect-formatting-needs-review";
  return "ordinary";
}

function releaseEvidence(row, provider, slot) {
  const raw = parse(row.raw_json);
  const release = provider === "discogs" ? raw : raw.release && typeof raw.release === "object" ? raw.release : {};
  const album = raw.album && typeof raw.album === "object" ? raw.album : {};
  const releaseId = text(row.release_id || (provider === "tidal" ? album.id || raw.albumId : release.id));
  const releaseTitle = text(row.release_title || release.name || release.title || album.title || raw.album);
  const explicitCredits = raw.albumArtist || release.albumArtist || release.artists_sort || (Array.isArray(release.artists) ? release.artists.map(artist => artist.name).join(", ") : "") || (provider === "tidal" && Array.isArray(album.artists) ? album.artists.map(artist => artist.name).join(", ") : "");
  const list = Array.isArray(release.tracklist) ? release.tracklist.filter(track => !track.type_ || track.type_ === "track") : [];
  const tracklist = list.map(track => ({ position: text(track.position), title: text(track.title), artist: Array.isArray(track.artists) ? track.artists.map(artist => artist.name).join(", ") : "", duration: text(track.duration) }));
  const formats = Array.isArray(release.formats) ? release.formats.flatMap(format => [format.name, ...(format.descriptions || [])]).filter(Boolean) : [];
  const barcodes = uniq([raw.upc, release.barcode, ...(Array.isArray(release.identifiers) ? release.identifiers.filter(identifier => /^barcode$/i.test(identifier.type)).map(identifier => text(identifier.value).replace(/[^0-9]/g, "")) : [])].map(text));
  const groupId = text(raw.releaseGroupId || raw.releaseGroup?.id || release["release-group"]?.id || (provider === "discogs" ? raw.master_id : ""));
  return {
    rowId: Number(row.track_identity_id), provider, slot,
    providerTrackId: text(row.beatport_track_id || row.provider_track_id),
    releaseKey: releaseId ? `${provider}-album:${releaseId}` : "", releaseId,
    title: releaseTitle, normalizedTitle: normalizeCatalogText(releaseTitle), family: releaseFamily(releaseTitle), editionMarkers: editionMarkers(releaseTitle),
    primaryArtistCredits: text(explicitCredits), normalizedPrimaryArtists: artistCreditSetKey(explicitCredits),
    releaseDate: text(row.release_date), rawReleaseDate: text(release.released || release.release_date), year: Number(release.year) || null,
    label: text(row.label), genre: text(row.genre), subgenre: text(row.subgenre),
    catalogNumbers: uniq([raw.catalog_number, raw.catalogNumber, ...(Array.isArray(release.labels) ? release.labels.map(label => label.catno) : [])].map(text)),
    barcodes, formats, releaseType: text(raw.releaseType || release.type || album.type),
    releaseFamilyId: groupId ? `${provider === "discogs" ? "discogs-master" : provider + "-release-group"}:${groupId}` : "",
    artworkUrl: artwork(raw, provider), rawArtworkUrl: text(release.image?.uri || raw.sourceImageUrl || album.cover),
    artworkVariants: uniq([artwork(raw, provider), release.image?.uri, raw.sourceImageUrl, album.coverUrl, ...(Array.isArray(release.images) ? release.images.flatMap(image => [image.uri, image.uri150]) : [])].map(text)),
    declaredTrackCount: Number(album.numberOfTracks || release.track_count || release.numberOfTracks) || null,
    cachedReleaseTracklistAvailable: tracklist.length > 0, tracklist,
    sourceConfidence: row.confidence, fetchedAt: row.fetched_at
  };
}

function readReleaseEvidence(db) {
  // null skips every Sonic/vector read. Grouping/metadata are otherwise the
  // exact production implementation, not an approximate reimplementation.
  const catalog = readCatalog(db, null);
  const albumView = browseCatalog(catalog, { view: "albums", limit: 100 });
  const providerRows = read(db, "provider_enrichment", "SELECT * FROM provider_enrichment ORDER BY fetched_at DESC,id DESC");
  const latest = new Map();
  const history = {};
  for (const row of providerRows) {
    const key = `${row.track_identity_id}:${row.provider}`;
    if (!latest.has(key)) latest.set(key, row);
    const stats = history[row.provider] ||= { storedRows: 0, withReleaseId: 0 };
    stats.storedRows++;
    if (row.release_id) stats.withReleaseId++;
  }
  const evidence = read(db, "beatport_enrichment", "SELECT * FROM beatport_enrichment").map(row => releaseEvidence(row, "beatport", "beatport_enrichment"));
  for (const row of latest.values()) evidence.push(releaseEvidence(row, row.provider, "provider_enrichment"));
  return {
    browserRecords: catalog.records.map(row => ({ id: row.id, identityKey: row.identityKey, artist: row.artist, title: row.title, album: row.album, albumKey: row.albumKey, label: row.label, genres: row.genres, releaseDate: row.releaseDate, year: row.year, imageUrl: row.imageUrl, artworkSource: row.artworkSource })),
    evidence, providerHistoryCounts: history,
    browserAlbumCount: albumView.total, missingAlbumCount: albumView.missingAlbumCount,
    existingAlbumReleaseTables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%album%' OR name LIKE '%release%')").all().map(row => row.name)
  };
}

function summarizeCard(key, rows, evidenceByRow, tracksById) {
  const claims = rows.flatMap(row => evidenceByRow.get(row.id) || []);
  const names = uniq(rows.map(row => row.album));
  const normalizedNames = uniq(names.map(normalizeCatalogText));
  const compatible = claims.filter(claim => claim.releaseKey && (claim.releaseKey === key || normalizedNames.includes(claim.normalizedTitle)));
  const families = uniq(names.map(releaseFamily));
  const rowIssues = rows.flatMap(row => {
    const candidates = (evidenceByRow.get(row.id) || []).filter(claim => claim.provider === row.artworkSource && claim.artworkUrl === row.imageUrl);
    const source = candidates[0];
    const issues = [];
    if (source?.normalizedTitle && source.normalizedTitle !== normalizeCatalogText(row.album)) issues.push({ rowId: row.id, issue: "artwork-source-release-differs", displayedAlbum: row.album, sourceRelease: source.title, sourceReleaseKey: source.releaseKey, displayedImage: row.imageUrl });
    const dateSource = (evidenceByRow.get(row.id) || []).find(claim => claim.slot === "beatport_enrichment" && claim.releaseDate === row.releaseDate);
    if (dateSource?.normalizedTitle && dateSource.normalizedTitle !== normalizeCatalogText(row.album)) issues.push({ rowId: row.id, issue: "year-label-source-release-differs", displayedAlbum: row.album, sourceRelease: dateSource.title, sourceReleaseKey: dateSource.releaseKey, displayedYear: row.year, sourceDate: dateSource.releaseDate });
    return issues;
  });
  const safeIsrcRows = {};
  for (const row of rows) {
    const track = tracksById.get(row.id);
    const isrcs = uniq(track?.facts.map(fact => fact.validIsrc) || []);
    if (track && !track.conflicts.length && isrcs.length === 1) (safeIsrcRows[isrcs[0]] ||= []).push(row.id);
  }
  const artistStrings = uniq(rows.map(row => row.artist));
  return {
    key, keyKind: keyKind(key), titles: names, normalizedTitles: normalizedNames, families,
    artistStrings, normalizedTrackArtistCredits: uniq(artistStrings.map(artistCreditSetKey)),
    explicitAlbumArtistCredits: uniq(compatible.map(claim => claim.primaryArtistCredits)),
    displayArtist: artistStrings.length > 1 ? "Various artists" : artistStrings[0],
    displayedYear: Math.max(...rows.map(row => row.year || 0)) || null,
    memberRows: rows.map(row => row.id), storedRowCount: rows.length,
    labels: uniq(rows.map(row => row.label)), genres: uniq(rows.flatMap(row => row.genres)), years: uniq(rows.map(row => row.year)),
    artworkUrls: uniq(rows.map(row => row.imageUrl)),
    compatibleReleaseKeys: uniq(compatible.map(claim => claim.releaseKey)),
    allSourceReleaseKeys: uniq(claims.map(claim => claim.releaseKey)),
    compatibleSourceLabels: uniq(compatible.map(claim => normalizeCatalogText(claim.label))),
    compatibleSourceDates: uniq(compatible.map(claim => claim.releaseDate)),
    cachedTracklistReleaseKeys: uniq(compatible.filter(claim => claim.cachedReleaseTracklistAvailable).map(claim => claim.releaseKey)),
    editionMarkers: uniq(names.flatMap(editionMarkers)).sort(),
    sourceFamilyEditionMarkers: uniq(claims.filter(claim => families.includes(claim.family)).flatMap(claim => claim.editionMarkers || [])).sort(),
    titleQuality: titleQuality(names[0], artistStrings),
    trackConflictRows: rows.filter(row => tracksById.get(row.id)?.conflicts.length).map(row => row.id),
    safeIsrcRows, sourceDisplayIssues: rowIssues
  };
}

function compareCards(a, b, trackPairs) {
  const sameTitle = intersect(a.normalizedTitles, b.normalizedTitles).length > 0;
  const sameFamily = intersect(a.families, b.families).length > 0;
  const sharedReleaseKeys = intersect(a.compatibleReleaseKeys, b.compatibleReleaseKeys);
  const contextReleaseKeys = intersect(a.allSourceReleaseKeys, b.allSourceReleaseKeys);
  const aIsrcs = Object.keys(a.safeIsrcRows), bIsrcs = Object.keys(b.safeIsrcRows);
  const sharedIsrcs = intersect(aIsrcs, bIsrcs).filter(isrc => a.safeIsrcRows[isrc].some(left => b.safeIsrcRows[isrc].some(right => {
    const pair = trackPairs.get(`${Math.min(left, right)}:${Math.max(left, right)}`);
    return pair && (["exact_duplicate", "different_release"].includes(pair.category) || pair.category === "needs_review" && pair.reasons?.[0]?.startsWith("Same-recording evidence is strong"));
  })));
  const artistTokens = card => uniq(card.normalizedTrackArtistCredits.flatMap(credit => credit.split("|")));
  const artistOverlap = intersect(artistTokens(a), artistTokens(b));
  const sharedDates = intersect(a.compatibleSourceDates, b.compatibleSourceDates);
  const sharedLabels = intersect(a.compatibleSourceLabels, b.compatibleSourceLabels);
  const denominator = Math.min(aIsrcs.length, bIsrcs.length);
  const containment = denominator ? sharedIsrcs.length / denominator : null;
  const overlap = { verifiedSharedIsrcs: sharedIsrcs, observedNonconflictingIsrcsA: aIsrcs.length, observedNonconflictingIsrcsB: bIsrcs.length, containmentOfSmallerObservedSubset: containment, jaccard: aIsrcs.length + bIsrcs.length - sharedIsrcs.length ? sharedIsrcs.length / (aIsrcs.length + bIsrcs.length - sharedIsrcs.length) : null, completeAlbumTracklistsCompared: false };
  const flags = [];
  if (sameTitle && !sameSet(a.artistStrings, b.artistStrings)) flags.push("same-title-different-track-artist-strings");
  if (sameFamily && !sameSet(a.titles, b.titles)) flags.push("title-format-or-edition-variation");
  if (a.artworkUrls.length && b.artworkUrls.length && !sameSet(a.artworkUrls, b.artworkUrls)) flags.push("different-artwork-urls-not-image-hashes");
  if (!sameSet(a.labels, b.labels) || !sameSet(a.years, b.years) || !sameSet(a.genres, b.genres)) flags.push("metadata-differences");
  if (sharedIsrcs.length && (sharedIsrcs.length < aIsrcs.length || sharedIsrcs.length < bIsrcs.length)) flags.push("overlapping-different-known-track-subsets");
  if (sameTitle && !sharedIsrcs.length) flags.push("disjoint-or-unverified-known-track-subsets");
  const sourceEditionDifference = !sameSet(a.sourceFamilyEditionMarkers || [], b.sourceFamilyEditionMarkers || []);
  if (sameFamily && sourceEditionDifference) flags.push("source-edition-claims-differ");
  const conflictingEditions = !sameSet(a.editionMarkers, b.editionMarkers) || sourceEditionDifference;
  let classification, reason;
  if (sharedReleaseKeys.length && !conflictingEditions) {
    classification = "same-provider-release-fragments";
    reason = "Both visible cards have a title-compatible claim to the same namespaced release ID. Verify each membership before linking; this proves fragmentation of source identity, not correctness of every attached track.";
  } else if (sameFamily && conflictingEditions) {
    classification = "edition-variant-keep-separate";
    reason = "Explicit edition/type descriptors differ. Related family only; preserve separate releases pending edition verification.";
  } else if (!sameTitle && !sameFamily && (sharedIsrcs.length || contextReleaseKeys.length)) {
    classification = "different-release-or-cross-release-enrichment";
    reason = "A shared recording or enrichment release does not equate the displayed albums. Preserve original, compilation, single and other appearances; inspect source provenance.";
  } else if (sameTitle && sharedIsrcs.length >= 2 && containment >= 0.8 && artistOverlap.length && sharedDates.length && sharedLabels.length && !a.trackConflictRows.length && !b.trackConflictRows.length && !a.sourceDisplayIssues.length && !b.sourceDisplayIssues.length && a.compatibleReleaseKeys.length && b.compatibleReleaseKeys.length) {
    classification = "different-provider-ids-duplicate-candidate";
    reason = "Multiple checked recording matches, compatible artist/date/label and edition text support a duplicate-release candidate. Full ordered tracklists/barcodes are still needed; no equivalence was committed.";
  } else {
    classification = "unresolved-release-relationship";
    reason = "Sparse or conflicting source evidence cannot establish the same edition. Title, track-artist strings, partial overlap, artwork URLs and observed years alone are insufficient.";
  }
  return { a: a.key, b: b.key, classification, reason, sameTitle, sameFamily, sharedReleaseKeys, contextReleaseKeys, artistOverlap, sharedSourceDates: sharedDates, sharedSourceLabels: sharedLabels, overlap, flags };
}

function buildSourceInventory(evidence) {
  const grouped = new Map();
  for (const claim of evidence) if (claim.releaseKey) {
    if (!grouped.has(claim.releaseKey)) grouped.set(claim.releaseKey, []);
    grouped.get(claim.releaseKey).push(claim);
  }
  const releases = [...grouped].map(([key, claims]) => ({
    key, provider: claims[0].provider, providerReleaseId: claims[0].releaseId,
    titles: uniq(claims.map(claim => claim.title)), families: uniq(claims.map(claim => claim.family)),
    primaryArtistCredits: uniq(claims.map(claim => claim.primaryArtistCredits)),
    releaseDates: uniq(claims.flatMap(claim => [claim.releaseDate, claim.rawReleaseDate])),
    labels: uniq(claims.map(claim => claim.label)), catalogNumbers: uniq(claims.flatMap(claim => claim.catalogNumbers)),
    barcodes: uniq(claims.flatMap(claim => claim.barcodes)), formats: uniq(claims.flatMap(claim => claim.formats)),
    releaseTypes: uniq(claims.map(claim => claim.releaseType)), editionMarkers: uniq(claims.flatMap(claim => claim.editionMarkers)),
    releaseFamilyIds: uniq(claims.map(claim => claim.releaseFamilyId)), artworkVariants: uniq(claims.flatMap(claim => claim.artworkVariants)),
    memberRows: uniq(claims.map(claim => claim.rowId)).sort((a, b) => a - b),
    membershipAssertions: claims.map(claim => ({ rowId: claim.rowId, providerTrackId: claim.providerTrackId, slot: claim.slot, fetchedAt: claim.fetchedAt })),
    declaredTrackCounts: uniq(claims.map(claim => claim.declaredTrackCount)),
    cachedTracklists: claims.filter(claim => claim.cachedReleaseTracklistAvailable).map(claim => ({ rowId: claim.rowId, slot: claim.slot, fetchedAt: claim.fetchedAt, tracks: claim.tracklist })),
    // These are asserted source memberships, not verified recording links or
    // complete album coverage. A shared row can itself be contaminated.
    membershipVerified: false
  }));
  const families = new Map();
  for (const release of releases) for (const family of release.families) if (family) {
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(release);
  }
  const groups = [...families].filter(([, values]) => values.length > 1).map(([family, values]) => ({
    retrievalFamily: family, sourceReleaseKeys: values.map(release => release.key), providers: uniq(values.map(release => release.provider)),
    candidateOnly: true,
    warning: "Title-family retrieval only: different artists, editions and compilations may share this key. Inspect source facts; this is not an equivalence group."
  }));
  return { releases, groups };
}

function buildReleaseReport(trackReport, extra) {
  const tracksById = new Map(trackReport.records.map(row => [row.id, row]));
  const evidenceByRow = new Map();
  for (const evidence of extra.evidence) { if (!evidenceByRow.has(evidence.rowId)) evidenceByRow.set(evidence.rowId, []); evidenceByRow.get(evidence.rowId).push(evidence); }
  const grouped = new Map();
  for (const row of extra.browserRecords) if (row.albumKey) { if (!grouped.has(row.albumKey)) grouped.set(row.albumKey, []); grouped.get(row.albumKey).push(row); }
  const cards = [...grouped].map(([key, rows]) => summarizeCard(key, rows, evidenceByRow, tracksById));
  const byKey = new Map(cards.map(card => [card.key, card]));
  const trackPairs = new Map(trackReport.pairs.map(pair => [`${pair.a}:${pair.b}`, pair]));
  const blocks = new Map();
  for (const card of cards) for (const block of uniq([...card.families.map(value => `family:${value}`), ...card.allSourceReleaseKeys.map(value => `release:${value}`), ...Object.keys(card.safeIsrcRows).map(value => `recording:${value}`)])) {
    if (!blocks.has(block)) blocks.set(block, []); blocks.get(block).push(card.key);
  }
  const candidates = new Map();
  for (const [block, keys] of blocks) for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const [a, b] = [keys[i], keys[j]].sort(); const key = JSON.stringify([a, b]);
    if (!candidates.has(key)) candidates.set(key, { a, b, blocks: [] }); candidates.get(key).blocks.push(block);
  }
  const pairs = [...candidates.values()].map(pair => ({ ...compareCards(byKey.get(pair.a), byKey.get(pair.b), trackPairs), candidateReasons: pair.blocks }));
  const tally = values => values.reduce((result, key) => { result[key] = (result[key] || 0) + 1; return result; }, {});
  const missingIdentityAlbums = trackReport.records.filter(record => !record.primary.album).map(record => record.id);
  const sourceInventory = buildSourceInventory(extra.evidence);
  return {
    ruleset: "release-identity-audit-2026-09-18-v1", generatedAt: trackReport.generatedAt, readOnly: trackReport.readOnly, connectionChanges: trackReport.connectionChanges,
    sourceHashes: { ...trackReport.sourceHashes, "audit-release-identities.js": createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"), "databaseBrowserCatalog.js": createHash("sha256").update(fs.readFileSync(require.resolve("../src/databaseBrowserCatalog"))).digest("hex") },
    counts: { identityRows: extra.browserRecords.length, browserAlbumCards: cards.length, productionBrowserAlbumCards: extra.browserAlbumCount, missingDisplayedAlbumRows: extra.missingAlbumCount, missingIdentityAlbumRows: missingIdentityAlbums.length, keyKinds: tally(cards.map(card => card.keyKind)), candidatePairs: pairs.length, classifications: tally(pairs.map(pair => pair.classification)), diagnosticFlags: tally(pairs.flatMap(pair => pair.flags)), cardsWithSourceDisplayIssues: cards.filter(card => card.sourceDisplayIssues.length).length, rowsWithArtworkSourceReleaseMismatch: new Set(cards.flatMap(card => card.sourceDisplayIssues.filter(issue => issue.issue === "artwork-source-release-differs").map(issue => issue.rowId))).size, cardsWithMultipleYears: cards.filter(card => card.years.length > 1).length, cardsLabeledVariousArtists: cards.filter(card => card.displayArtist === "Various artists").length, sourceReleasesWithCachedTracklists: sourceInventory.releases.filter(release => release.cachedTracklists.length).length, sourceReleasesByProvider: tally(sourceInventory.releases.map(release => release.provider)), sourceReleaseFamilyCandidateGroups: sourceInventory.groups.length, crossProviderFamilyCandidateGroups: sourceInventory.groups.filter(group => group.providers.length > 1).length },
    trackCounts: trackReport.counts, cards, pairs, sourceEvidence: extra.evidence, browserRecords: extra.browserRecords,
    sourceReleases: sourceInventory.releases, sourceReleaseFamilyCandidates: sourceInventory.groups,
    titleQualityFindings: cards.filter(card => card.titleQuality !== "ordinary").map(card => ({ key: card.key, title: card.titles[0], quality: card.titleQuality, rowIds: card.memberRows, artists: card.artistStrings })),
    missingIdentityAlbumRows: missingIdentityAlbums, missingDisplayedAlbumRows: extra.browserRecords.filter(row => !row.albumKey).map(row => row.id), providerHistoryCounts: extra.providerHistoryCounts, existingAlbumReleaseTables: extra.existingAlbumReleaseTables
  };
}

const cell = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
function renderMarkdown(report) {
  const byKey = new Map(report.cards.map(card => [card.key, card]));
  const describe = card => `${card.key}; ${card.titles.join(" / ")}; track credits: ${card.artistStrings.join(" / ")}; rows ${card.memberRows.join(", ")}; years ${card.years.join(", ")}; labels ${card.labels.join(", ")}; ${card.artworkUrls.length} image URLs`;
  const lines = ["# Release identity diagnostic evidence", "", `Snapshot ${report.generatedAt}; ${report.ruleset}. Read-only connection changes: ${report.connectionChanges}. No music data was changed.`, "", "The report reproduces production album grouping, without Sonic reads. Candidate pairs and flags overlap; they are not release counts or merge instructions. Tracklist overlap is a lower bound from checked recordings in known subsets, not a comparison of complete album tracklists. Distinct URLs do not prove different images. Source release titles different from the displayed album identify provenance problems to inspect; some are benign naming variants.", "", "```json", JSON.stringify(report.counts, null, 2), "```", "", "## Placeholder / unusual title checks", "", "| Current key | Title | Finding | Rows |", "| --- | --- | --- | --- |"];
  for (const finding of report.titleQualityFindings) lines.push(`| ${cell(finding.key)} | ${cell(finding.title)} | ${finding.quality} | ${finding.rowIds.join(", ")} |`);
  lines.push("", "## Source release IDs across title families", "", "These retrieval groups include unrelated artists and distinct editions. They are not proposed canonical groups. Full source records, artwork variants, known membership assertions, catalog numbers, dates and cached provider tracklists are in releases.json → sourceReleases.", "", "| Retrieval family | Providers | Distinct source release IDs |", "| --- | --- | --- |");
  for (const group of report.sourceReleaseFamilyCandidates) lines.push(`| ${cell(group.retrievalFamily)} | ${cell(group.providers.join(", "))} | ${cell(group.sourceReleaseKeys.join(", "))} |`);
  for (const category of Object.keys(report.counts.classifications)) {
    lines.push("", `## ${category}`, "", "| Card A | Card B | Evidence and interpretation |", "| --- | --- | --- |");
    for (const pair of report.pairs.filter(item => item.classification === category)) lines.push(`| ${cell(describe(byKey.get(pair.a)))} | ${cell(describe(byKey.get(pair.b)))} | ${cell([pair.reason, `Shared title-compatible release IDs: ${pair.sharedReleaseKeys.join(", ") || "none"}`, `Checked shared ISRCs: ${pair.overlap.verifiedSharedIsrcs.join(", ") || "none"}`, `Known ISRC subsets ${pair.overlap.observedNonconflictingIsrcsA}/${pair.overlap.observedNonconflictingIsrcsB}`, ...pair.flags].join("; "))} |`);
  }
  lines.push("", "## Artwork and year/label provenance findings", "", "| Current card | Row | Displayed album | Source release | Issue |", "| --- | --- | --- | --- | --- |");
  for (const card of report.cards) for (const issue of card.sourceDisplayIssues) lines.push(`| ${cell(card.key)} | ${issue.rowId} | ${cell(issue.displayedAlbum)} | ${cell(issue.sourceRelease)} (${cell(issue.sourceReleaseKey)}) | ${issue.issue} |`);
  return lines.join("\n") + "\n";
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (["--out", "--db"].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith("--")) args[argv[i].slice(2)] = path.resolve(argv[++i]);
    else if (["--help", "-h"].includes(argv[i])) { console.log("node scripts/audit-release-identities.js [--db path] --out NEW_DIRECTORY\nRead-only track + release report; refuses to overwrite previous output."); return; }
    else throw new Error(`Unknown or incomplete argument ${argv[i]}`);
  }
  if (!args.out || fs.existsSync(args.out)) throw new Error("--out must name a new directory");
  const { extra, ...snapshot } = readSnapshot(args.db || require("../src/config").musicMemory.dbFile, { extraRead: readReleaseEvidence });
  const tracks = buildReport(snapshot);
  const releases = buildReleaseReport(tracks, extra);
  fs.mkdirSync(path.dirname(args.out), { recursive: true }); fs.mkdirSync(args.out);
  for (const [name, content] of [["tracks.json", JSON.stringify(tracks, null, 2)], ["tracks.md", renderTrackMarkdown(tracks)], ["releases.json", JSON.stringify(releases, null, 2)], ["releases.md", renderMarkdown(releases)]]) fs.writeFileSync(path.join(args.out, name), content, { flag: "wx" });
  console.log(JSON.stringify({ generatedAt: releases.generatedAt, counts: releases.counts, trackCounts: tracks.counts, readOnly: releases.readOnly, connectionChanges: releases.connectionChanges, out: args.out }, null, 2));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { releaseFamily, editionMarkers, titleQuality, releaseEvidence, readReleaseEvidence, summarizeCard, compareCards, buildSourceInventory, buildReleaseReport, renderMarkdown };
