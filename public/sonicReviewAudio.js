"use strict";
// One active preview across ordinary Review and the historical blind batches.
document.addEventListener("play", event => {
  if (event.target.tagName === "AUDIO") document.querySelectorAll("audio").forEach(audio => { if (audio !== event.target) audio.pause(); });
}, true);
document.getElementById("sonicReviewApp")?.addEventListener("change", event => {
  if (event.target.matches("[data-sonic-review-blind]")) {
    state.sonicReview.blind = event.target.checked; state.sonicReview.revealed = false; renderSonicReview();
  }
});
new MutationObserver(() => {
  if (!document.getElementById("sonicReviewView")?.classList.contains("isActive")) document.querySelectorAll("#sonicReviewApp audio").forEach(audio => audio.pause());
}).observe(document.getElementById("sonicReviewView"), { attributes: true, attributeFilter: ["class"] });
function sonicReviewAudioHtml(track, label) {
  const key = sonicReviewIdentityKey(track), info = state.sonicReview.audio?.[key];
  if (!key || !state.sonicReview.loaded) return "";
  const blind = state.sonicReview.blind && !state.sonicReview.revealed;
  return '<div class="sonicAnalyzedPreview">' + (info?.status === "ready"
    ? '<audio controls preload="metadata" aria-label="' + escapeHtml(label + ' analyzed audio') + '" src="' + escapeHtml(info.url) + '"></audio><button type="button" data-sonic-audio-replay>Replay ' + escapeHtml(label.toLowerCase()) + '</button><p class="muted">' + Number(info.durationSeconds).toFixed(1) + ' seconds · analyzed source excerpt</p>'
    : '<p role="status">Analyzed audio unavailable. ' + escapeHtml(blind ? 'Reveal identities for source diagnostics.' : info?.reason || 'Preview not prepared.') + '</p><button type="button" data-sonic-audio-retry="' + escapeHtml(key) + '">Retry analyzed audio</button>')
    + (!blind && info ? '<details><summary>Embedding and audio details</summary><pre>' + escapeHtml(JSON.stringify({ ...info, url: undefined, similarity: track.sonicNeighbor?.similarity }, null, 2)) + '</pre></details>' : '') + '</div>';
}

// A file can disappear after preparation; make the failure visible beside its controls.
document.getElementById("sonicReviewApp")?.addEventListener("error", event => {
  if (event.target.tagName !== "AUDIO") return;
  const panel=event.target.closest(".sonicAnalyzedPreview");
  if (!panel || panel.querySelector("[data-preview-error]")) return;
  const message=document.createElement("p");message.dataset.previewError="true";message.setAttribute("role","status");
  message.textContent="Analyzed audio unavailable. Reload this anchor to retry the original source.";panel.append(message);
},true);
