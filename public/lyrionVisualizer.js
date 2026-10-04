"use strict";
(() => {
  const $ = id => document.getElementById(id), stage = $("lyrionNow");
  if (!stage || !window.createSoundSpectrumStage) return;
  const controller = window.createSoundSpectrumStage({
    stage, lane: stage.querySelector(".lyrionArtworkLane"), bar: stage.querySelector(".lyrionStageBar"),
    beforeChoices: $("lyrionFullscreen"), prefix: "lyrion", immersiveClass: "lyrionNow--visualFullscreen",
    presentationVisible: () => stage.classList.contains("lyrionNow--fullscreen"),
    selectedTarget: () => $("lyrionPlayer")?.value || "", targetSelect: $("lyrionPlayer"),
    targetEvents: ["lyrion-playback", "lyrion-track"], musicFeedId: "feed:pre-hqplayer",
    observe: [{ target: $("lyrionView"), attributes: ["hidden"] },
      { target: stage.closest(".lyrionTabPanel"), attributes: ["hidden"] }]
  });
  // Shared links select the view; starting visuals always takes an explicit tap.
  const linkedView = new URLSearchParams(location.search).get("lyrion-stage");
  if (controller && ["artwork", "visualizer"].includes(linkedView)) {
    const system = $("playbackSystem");
    if (system.value !== "lyrion") { system.value = "lyrion"; system.dispatchEvent(new Event("change")); }
    $("lyrionTab-now").click(); if (!stage.classList.contains("lyrionNow--fullscreen")) $("lyrionFullscreen").click();
    controller.setView(linkedView);
  }
})();
