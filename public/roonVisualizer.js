"use strict";
(() => {
  const stage = document.querySelector("#playerView .player"), view = document.getElementById("playerView");
  const target = document.getElementById("zoneSelect");
  if (!stage || !view || !target || !window.createSoundSpectrumStage) return;
  window.createSoundSpectrumStage({
    stage, lane: stage.querySelector(".artStack"), bar: stage.querySelector(".playerViewControls"),
    prefix: "roon", artworkId: "cover", immersiveClass: "roonVisualFullscreen", stopOnTargetChange: true, restoreNativeFullscreen: true, resetImmersiveScroll: true,
    sourceVisible: () => view.classList.contains("isActive") && document.body.dataset.playbackSystem !== "lyrion",
    selectedTarget: () => target.value || "", targetSelect: target, targetParam: "zoneId",
    targetEvents: ["roon-playback"], musicFeedId: "feed:hqplayer-analysis", feedSource: "roon-hqplayer",
    feedEligible: () => stage.dataset.playbackConnected === "true",
    feedCopy: {
      hint: "HQPlayer’s live spectrum drives the visuals through a separate analysis signal. Experimental; timing may differ from what you hear.",
      start: "Select Start visuals to use HQPlayer analysis from your selected Roon zone.",
      missingTarget: "Choose the connected HQPlayer Roon zone before starting HQPlayer analysis.",
      active: "HQPlayer’s live analysis signal is feeding SoundSpectrum.",
      waiting: "Waiting for HQPlayer analysis from your selected Roon zone.", label: "HQPlayer analysis"
    },
    observe: [{ target: view, attributes: ["class", "hidden"] },
      { target: document.body, attributes: ["data-playback-system"] }]
  });
})();
