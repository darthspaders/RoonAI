"use strict";

const SEARCH_ROOT = "https://openapi.tidal.com/v2/searchResults";
const SEARCH_RELATIONS = new Set(["tracks", "artists", "albums", "playlists", "topHits", "videos"]);

// Initial search queries are filters, not resource IDs. Returned relationship
// pagination URLs contain opaque IDs and must be followed without this rewrite.
function createSearchUrl(query, relation, params = {}) {
  if (!SEARCH_RELATIONS.has(relation)) throw new TypeError("Unsupported TIDAL search relationship");
  const url = new URL(SEARCH_ROOT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && key !== "include" && key !== "limit") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("filter[query]", String(query));
  const includes = [relation, ...String(params.include || "").split(",").map(value => value.trim()).filter(Boolean)];
  url.searchParams.set("include", [...new Set(includes)].join(","));
  return url;
}

function searchRelationForUrl(input) {
  let url;
  try { url = new URL(input); } catch { return ""; }
  if (url.origin !== "https://openapi.tidal.com" || url.pathname !== "/v2/searchResults" || !url.searchParams.has("filter[query]")) return "";
  return String(url.searchParams.get("include") || "").split(",").map(value => value.trim().split(".")[0]).find(value => SEARCH_RELATIONS.has(value)) || "";
}

function toLegacySearchShape(json, relation) {
  if (!json || !SEARCH_RELATIONS.has(relation)) return json;
  const resources = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
  const resource = resources.find(item => item?.type === "searchResults");
  // A relationship page already has track/artist linkage in data. Preserve it
  // as well as legacy-shaped fixtures and non-search catalogue responses.
  if (!resource) return json;
  const relationship = resource.relationships?.[relation];
  const refs = Array.isArray(relationship?.data) ? relationship.data : [];
  const included = Array.isArray(json.included) ? json.included : [];
  const byIdentity = new Map(included.map(item => [`${item.type}:${item.id}`, item]));
  const result = {
    ...json,
    data: refs,
    included,
    // Existing track readers accept `items`. Explicitly provide even an empty
    // list so unrelated included tracks cannot replace missing search linkage.
    ...(relation === "tracks" ? { items: refs.map(ref => byIdentity.get(`${ref.type}:${ref.id}`) || ref) } : {})
  };
  // Current search pagination lives on the requested relationship, not on the
  // one-resource search collection. Promote it before flattening the resource.
  if (relationship?.links) result.links = { ...(json.links || {}), ...relationship.links };
  if (relationship?.meta) result.meta = { ...(json.meta || {}), ...relationship.meta };
  return result;
}

module.exports = { createSearchUrl, searchRelationForUrl, toLegacySearchShape };
