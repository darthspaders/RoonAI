"use strict";

function isCurrentSearchRequest(url) {
  return url.pathname === "/v2/searchResults" && url.searchParams.has("filter[query]");
}

function currentSearchDocument(legacy, relation = "tracks", query = "fixture query") {
  return {
    ...legacy,
    links: { self: "https://openapi.tidal.com/v2/searchResults?filter%5Bquery%5D=fixture" },
    data: [{
      type: "searchResults", id: "opaque-search-result-id", attributes: { query },
      relationships: { [relation]: { data: legacy.data || [], links: legacy.links || {} } }
    }]
  };
}

module.exports = { isCurrentSearchRequest, currentSearchDocument };
