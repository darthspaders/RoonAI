"use strict";
(() => {
  // Live playback updates stay small. Hydrate saved discovery results once per
  // file version, independently of the player/video's update path.
  window.createRabbitStatusLive = function ({ getJson, onStatus, onSession, onError, onSessionError }) {
    let statusRequest = null, sessionRequest = null, revision = 0;
    let wantedVersion, appliedVersion;

    function hydrateSession() {
      if (sessionRequest || wantedVersion === undefined || wantedVersion === appliedVersion) return sessionRequest || Promise.resolve();
      const requestedVersion = wantedVersion;
      const pending = Promise.resolve().then(() => getJson("/api/session"))
        .then(session => {
          if (wantedVersion !== requestedVersion) return;
          // A file may change between the small update and the session read.
          // Await another live version rather than apply a body under the wrong key.
          if (typeof session.sessionVersion === "string" && session.sessionVersion !== requestedVersion) return;
          onSession(session);
          appliedVersion = requestedVersion;
        })
        .catch(error => { onSessionError?.(error); })
        .finally(() => {
          if (sessionRequest !== pending) return;
          sessionRequest = null;
          if (wantedVersion !== requestedVersion && wantedVersion !== appliedVersion) return hydrateSession();
        });
      sessionRequest = pending;
      return pending;
    }

    function receive(payload) {
      ++revision;
      onStatus(payload);
      const app = payload?.app;
      if (app?.session) {
        // Legacy/full callers already supply the session to onStatus.
        if (typeof app.sessionVersion === "string") wantedVersion = appliedVersion = app.sessionVersion;
        return Promise.resolve();
      }
      if (typeof app?.sessionVersion !== "string") return Promise.resolve();
      wantedVersion = app.sessionVersion;
      return hydrateSession();
    }

    function refresh() {
      if (statusRequest) return statusRequest;
      const requestedRevision = revision;
      const pending = Promise.resolve().then(() => getJson("/api/status/live"))
        .then(payload => { if (revision === requestedRevision) void receive(payload); })
        .catch(error => {
          if (revision === requestedRevision) onError?.(error);
          throw error;
        })
        .finally(() => { if (statusRequest === pending) statusRequest = null; });
      statusRequest = pending;
      return pending;
    }
    return { refresh, receive };
  };
})();
