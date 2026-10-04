"use strict";

// Small, explicitly curated legacy-catalog mappings. These are not fuzzy
// aliases: they are only used as exact credit-set variants by the resolver.
// User/configured mappings take precedence over these defaults.
const DEFAULT_LEGACY_ARTIST_ALIASES = Object.freeze([
  {
    canonicalArtistIdentity: "Cass & Slide",
    aliases: ["Cass, Slide", "Cass and Slide", "Cass (UK)"],
    source: "built-in-legacy-edm-alias"
  },
  {
    canonicalArtistIdentity: "James Holden",
    aliases: ["Holden", "Holden, THOMPSON", "Holden Thompson"],
    source: "built-in-legacy-edm-alias"
  },
  {
    canonicalArtistIdentity: "Gus Gus",
    aliases: ["GusGus"],
    source: "built-in-legacy-edm-alias"
  }
]);

module.exports = { DEFAULT_LEGACY_ARTIST_ALIASES };
