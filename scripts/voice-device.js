"use strict";
const { VoiceDeviceStore } = require("../src/voiceDeviceStore");
const store = new VoiceDeviceStore();
const [action, ...args] = process.argv.slice(2);
if (action === "create") {
  console.log("Paste this Rabbit Hole device token into Synapse Voice settings. It is shown only here.");
  console.log(JSON.stringify(store.issue(args.join(" ")), null, 2));
} else if (action === "list") {
  console.table(store.read().map(({ id, label, createdAt, revokedAt }) => ({ id, label, createdAt, revokedAt })));
} else if (action === "revoke") {
  store.revoke(args[0]); console.log("Device revoked.");
} else { console.log('Usage: node scripts/voice-device.js create "Galaxy Tab S10 Ultra" | list | revoke DEVICE_ID'); process.exitCode = 1; }
