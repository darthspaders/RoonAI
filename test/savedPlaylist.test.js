"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SavedPlaylist } = require("../src/savedPlaylist");

function tempSavedFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-saved-"));
  return path.join(dir, "saved-playlist.json");
}

test("legacy saved candidates migrate into the default named list", () => {
  const file = tempSavedFile();
  fs.writeFileSync(file, JSON.stringify({
    tracks: [{
      artist: "Artist",
      title: "Track"
    }]
  }));

  const saved = new SavedPlaylist({ file });
  const snapshot = saved.snapshot();

  assert.equal(snapshot.activeListId, "default");
  assert.equal(snapshot.lists.length, 1);
  assert.equal(snapshot.lists[0].name, "Candidates");
  assert.equal(snapshot.lists[0].count, 1);
  assert.equal(snapshot.tracks[0].title, "Track");
  assert.equal(snapshot.tracks[0].key, "artist|track");
});

test("candidate lists can be created, named, selected, and kept separate", () => {
  const saved = new SavedPlaylist({ file: tempSavedFile() });

  saved.add({ artist: "Default Artist", title: "Default Track" });
  const psy = saved.create("Psytrance queue");
  assert.equal(psy.lists.some((list) => list.name === "Psytrance queue"), true);

  saved.add({ artist: "Psy Artist", title: "Psy Track" });
  assert.deepEqual(saved.list().map((track) => track.title), ["Psy Track"]);

  saved.select("default");
  assert.deepEqual(saved.list().map((track) => track.title), ["Default Track"]);

  const activeListId = saved.activeListId;
  saved.rename(activeListId, "Road trip candidates");
  assert.equal(saved.snapshot().lists.find((list) => list.id === activeListId).name, "Road trip candidates");

  const duplicate = saved.add({ artist: "Default Artist", title: "Default Track" });
  assert.equal(duplicate.added, false);
  assert.equal(saved.list().length, 1);
});

test("candidate lists can be deleted without removing the last list", () => {
  const saved = new SavedPlaylist({ file: tempSavedFile() });
  saved.add({ artist: "Default Artist", title: "Default Track" });
  const created = saved.create("Wrong lane");
  const wrongLaneId = created.activeListId;
  saved.add({ artist: "Wrong Artist", title: "Wrong Track" });

  const afterDelete = saved.delete(wrongLaneId);
  assert.equal(afterDelete.deleted, true);
  assert.equal(afterDelete.lists.some((list) => list.id === wrongLaneId), false);
  assert.equal(afterDelete.activeListId, "default");
  assert.deepEqual(afterDelete.tracks.map((track) => track.title), ["Default Track"]);

  assert.throws(() => saved.delete("default"), /only candidate list/i);
});

test("tracks can move between candidate lists without creating duplicates", () => {
  const saved = new SavedPlaylist({ file: tempSavedFile() });
  saved.add({ artist: "Durante", title: "How Does It Feel" });
  const destination = saved.create("Progressive house");
  const destinationId = destination.activeListId;

  saved.select("default");
  const moved = saved.move("durante|how does it feel", "default", destinationId);
  assert.equal(moved.moved, true);
  assert.equal(moved.activeListId, "default");
  assert.deepEqual(moved.tracks.map((track) => track.title), []);

  saved.select(destinationId);
  assert.deepEqual(saved.list().map((track) => track.title), ["How Does It Feel"]);

  saved.select("default");
  saved.add({ artist: "Durante", title: "How Does It Feel" });
  const duplicateMove = saved.move("durante|how does it feel", "default", destinationId);
  assert.equal(duplicateMove.moved, false);
  assert.equal(duplicateMove.duplicate, true);
  assert.deepEqual(duplicateMove.tracks.map((track) => track.title), []);

  saved.select(destinationId);
  assert.equal(saved.list().filter((track) => track.title === "How Does It Feel").length, 1);
});
