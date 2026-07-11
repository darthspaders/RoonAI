"use strict";

(function registerRabbitHoleWebMcpTools() {
  const bridge = window.RabbitHoleWebMcpBridge;
  const status = {
    supported: Boolean(document.modelContext && typeof document.modelContext.registerTool === "function"),
    registered: [],
    errors: []
  };
  window.RabbitHoleWebMcp = status;

  if (!bridge) {
    status.errors.push("Rabbit Hole WebMCP bridge is not available.");
    return;
  }
  if (!status.supported) return;

  const controller = new AbortController();

  function jsonResult(value) {
    return JSON.stringify(value, null, 2);
  }

  function register(tool) {
    try {
      document.modelContext.registerTool({
        ...tool,
        execute: async (input = {}) => jsonResult(await tool.execute(input || {}))
      }, { signal: controller.signal });
      status.registered.push(tool.name);
    } catch (error) {
      status.errors.push(`${tool.name}: ${error.message}`);
    }
  }

  const trackCountProperty = {
    type: "integer",
    minimum: 1,
    maximum: 40,
    description: "Number of tracks to target. Rabbit Hole may return fewer when strict verification rejects weak matches."
  };
  const standbyCountProperty = {
    type: "integer",
    minimum: 1,
    maximum: 25,
    description: "Number of standby tracks to use from the cached pool."
  };

  register({
    name: "get_rabbit_hole_status",
    description: "Return compact Rabbit Hole status including selected Roon zone, now playing track, displayed discovery results, TIDAL playlist availability, and genre profile state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    execute: () => bridge.getStatus()
  });

  register({
    name: "search_rabbit_hole",
    description: "Generate a Rabbit Hole discovery search using TIDAL catalogue verification, Roon context, taste memory, strict child-genre handling, and the current selected Roon zone.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "Natural-language music discovery request, such as 'acid house with hypnotic 303 lines, long tracks, 2020-2026'."
        },
        genres: {
          type: "string",
          description: "Explicit genre or niche child genre. Use this when the user names a genre directly, for example 'Acid house'."
        },
        years: {
          type: "string",
          description: "Release year filter such as '2026', '2020-2026', or 'last 30 days'."
        },
        mood: {
          type: "string",
          description: "Requested traits or mood, for example 'psychedelic, cosmic, hypnotic, minimal vocals'."
        },
        count: trackCountProperty,
        scoringMode: {
          type: "string",
          enum: ["", "pure", "explore", "similar"],
          description: "Taste Guided is empty string. pure follows the prompt with minimal taste bias, explore avoids familiar artists, similar leans into known taste."
        },
        minScore: {
          type: "string",
          enum: ["", "0", "60", "70", "80", "90"],
          description: "Minimum match floor. Empty uses the UI default; 0 accepts all verified long shots."
        },
        reference: {
          type: "string",
          description: "Optional seed tracks or notes, one per line."
        },
        requireRoonQueueable: {
          type: "boolean",
          description: "When true, require Roon queue verification before returning tracks."
        },
        preferExtendedMixes: {
          type: "boolean",
          description: "When true, explicitly prefer extended, club, or long versions when available."
        }
      },
      required: ["request"],
      additionalProperties: false
    },
    execute: (input) => bridge.searchRabbitHole(input)
  });

  register({
    name: "queue_rabbit_hole_tracks",
    description: "Queue the currently displayed Rabbit Hole result tracks into the selected Roon output zone.",
    inputSchema: {
      type: "object",
      properties: {
        count: trackCountProperty,
        mode: {
          type: "string",
          enum: ["append", "next"],
          description: "append adds to the existing queue. next inserts after the current track."
        },
        preferExtendedMixes: {
          type: "boolean",
          description: "Prefer extended versions during Roon queue resolution."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.queueDisplayedTracks(input)
  });

  register({
    name: "send_rabbit_hole_to_tidal_playlist",
    description: "Create a TIDAL playlist from the currently displayed Rabbit Hole result tracks so TIDAL and Roon can sync the exact tracks.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Playlist title. If omitted, Rabbit Hole creates a timestamped title."
        },
        description: {
          type: "string",
          description: "Optional playlist description."
        },
        count: trackCountProperty
      },
      additionalProperties: false
    },
    execute: (input) => bridge.sendDisplayedTracksToTidal(input)
  });

  register({
    name: "get_standby_pool",
    description: "Return the current 25-track Rabbit Hole standby discovery pool, including refresh status and cached tracks.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    execute: () => bridge.getStandbyPool()
  });

  register({
    name: "refresh_standby_pool",
    description: "Refresh the Rabbit Hole standby discovery pool using the current page prompt fields or supplied search options, without running a normal Generate session.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "Optional discovery request to guide the standby refresh."
        },
        genres: {
          type: "string",
          description: "Optional genre or niche child genre."
        },
        years: {
          type: "string",
          description: "Optional release year range."
        },
        mood: {
          type: "string",
          description: "Optional mood or trait text."
        },
        scoringMode: {
          type: "string",
          enum: ["", "pure", "explore", "similar"],
          description: "Taste Guided is empty string. explore is useful for standby discovery."
        },
        minScore: {
          type: "string",
          enum: ["", "0", "60", "70", "80", "90"],
          description: "Optional match floor."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.refreshStandbyPool(input)
  });

  register({
    name: "queue_standby_tracks",
    description: "Queue tracks from the cached Rabbit Hole standby pool into the selected Roon output zone.",
    inputSchema: {
      type: "object",
      properties: {
        count: standbyCountProperty,
        mode: {
          type: "string",
          enum: ["append", "next"],
          description: "append adds to the existing queue. next inserts after the current track."
        },
        preferExtendedMixes: {
          type: "boolean",
          description: "Prefer extended versions during Roon queue resolution."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.queueStandbyTracks(input)
  });

  register({
    name: "send_standby_to_tidal_playlist",
    description: "Create a TIDAL playlist from the cached Rabbit Hole standby pool.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Playlist title. If omitted, Rabbit Hole creates a timestamped standby title."
        },
        description: {
          type: "string",
          description: "Optional playlist description."
        },
        count: standbyCountProperty
      },
      additionalProperties: false
    },
    execute: (input) => bridge.sendStandbyTracksToTidal(input)
  });

  register({
    name: "create_tidal_playlist",
    description: "Create an empty TIDAL playlist in the connected TIDAL profile and select it for now-playing add actions.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "New TIDAL playlist title."
        },
        description: {
          type: "string",
          description: "Optional playlist description."
        }
      },
      required: ["title"],
      additionalProperties: false
    },
    execute: (input) => bridge.createTidalPlaylist(input)
  });

  register({
    name: "add_now_playing_to_tidal_playlist",
    description: "Resolve the currently playing Roon/radio track against TIDAL and add it to a selected TIDAL playlist.",
    inputSchema: {
      type: "object",
      properties: {
        playlistId: {
          type: "string",
          description: "TIDAL playlist id. If omitted, Rabbit Hole uses playlistTitle or the currently selected playlist."
        },
        playlistTitle: {
          type: "string",
          description: "TIDAL playlist title to match exactly when playlistId is not known."
        },
        refreshPlaylists: {
          type: "boolean",
          description: "Refresh TIDAL playlists before resolving playlistTitle."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.addNowPlayingToTidal(input)
  });

  register({
    name: "rate_now_playing",
    description: "Apply a taste rating to the currently playing track and update Rabbit Hole taste memory and genre profile learning.",
    inputSchema: {
      type: "object",
      properties: {
        rating: {
          type: "string",
          enum: ["love", "good", "ok", "wrong_genre", "skip", "never", "reject_similar"],
          description: "Taste rating to apply to the current track."
        },
        reason: {
          type: "string",
          description: "Optional short reason for the rating."
        }
      },
      required: ["rating"],
      additionalProperties: false
    },
    execute: (input) => bridge.rateNowPlaying(input)
  });

  register({
    name: "explain_last_rejections",
    description: "Return diagnostics and examples from the last Rabbit Hole search rejections, including SEO sludge, genre mismatch, previous suggestions, and weak match reasons.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of rejected examples to include."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.explainLastRejections(input)
  });

  register({
    name: "inspect_genre_profile",
    description: "Inspect learned niche genre profiles, including promoted/pruned artists and labels used by strict child-genre searches.",
    inputSchema: {
      type: "object",
      properties: {
        genre: {
          type: "string",
          description: "Optional genre name to filter, for example 'acid house'."
        }
      },
      additionalProperties: false
    },
    execute: (input) => bridge.inspectGenreProfile(input)
  });

  status.abort = () => controller.abort();
  document.dispatchEvent(new CustomEvent("rabbit-hole-webmcp-ready", { detail: status }));
}());
