"use strict";
const fs = require("node:fs");
const path = require("node:path");

class LyrionFavorites {
  constructor(file) { this.file = file; }
  list() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(data)) throw new Error("Invalid favorites file");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Unable to read saved SiriusXM favorites. The saved file has been preserved.");
    }
  }
  save(items) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(items, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
    return items;
  }
  add(channel) {
    if (!channel || !/^sxm:[\w-]+$/.test(channel.url)) throw new Error("Choose a SiriusXM channel from Browse or Search to save it.");
    const items = this.list();
    const saved = { id: channel.url, url: channel.url, title: String(channel.title || "SiriusXM channel").slice(0, 300), artwork: String(channel.artwork || "").slice(0, 3000) };
    const index = items.findIndex(item => item.id === saved.id);
    if (index < 0) items.push(saved); else items[index] = saved;
    return this.save(items);
  }
  remove(id) { return this.save(this.list().filter(item => item.id !== id)); }
  get(id) {
    const item = this.list().find(item => item.id === id);
    if (!item || !/^sxm:[\w-]+$/.test(item.url)) throw new Error("This channel is no longer saved.");
    return item;
  }
}
module.exports = { LyrionFavorites };
