"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

async function exerciseSupervisor({ emptyPath = false, closeOutput = false, failSpawn = false } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit supervisor "));
  const app = path.join(fixture, "the-rabbit-hole");
  const wrapper = path.join(fixture, "rabbit-hole-mcp");
  try {
    fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
    for (const directory of [app, wrapper]) {
      fs.mkdirSync(path.join(directory, "src"), { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), "{}");
      // Each real child fails once, then reports that another instance owns
      // the service. This makes the supervisor exit naturally after recovery.
      fs.writeFileSync(path.join(directory, "src", "server.js"), `
        const fs = require('node:fs');
        const count = Number(fs.existsSync('attempts') ? fs.readFileSync('attempts', 'utf8') : 0) + 1;
        fs.writeFileSync('attempts', String(count));
        process.stdout.write('fixture started\\n');
        setTimeout(() => process.exit(count === 1 ? 12 : 75), 40);
      `);
    }
    fs.copyFileSync(process.env.RH_SUPERVISOR_TEST_SOURCE || path.join(projectRoot, "scripts", "start-all.js"), path.join(app, "scripts", "start-all.js"));
    fs.copyFileSync(path.join(projectRoot, "src", "processLock.js"), path.join(app, "src", "processLock.js"));
    const args = failSpawn ? ["-e", `
      const cp = require('node:child_process');
      const originalSpawn = cp.spawn;
      let failed = false;
      cp.spawn = (command, args, options) => {
        if (!failed) { failed = true; return originalSpawn(command, args, { ...options, cwd: 'missing-fixture-directory' }); }
        return originalSpawn(command, args, options);
      };
      require('./scripts/start-all.js');
    `] : ["scripts/start-all.js"];
    const env = { ...process.env };
    if (emptyPath) for (const key of Object.keys(env)) if (key.toLowerCase() === "path") env[key] = "";
    const child = spawn(process.execPath, args, { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (closeOutput) child.stdout.destroy();
    else child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Supervisor did not finish the recovery fixture.")); }, 12000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(code, 0, stderr);
    for (const directory of [app, wrapper]) {
      assert.equal(Number(fs.existsSync(path.join(directory, "attempts")) ? fs.readFileSync(path.join(directory, "attempts"), "utf8") : 0), 2, `${path.basename(directory)} must restart exactly once after its first exit`);
    }
    assert.equal(fs.existsSync(path.join(app, "data", "service-supervisor.pid")), false, "Normal shutdown releases the supervisor PID file");
    const log = fs.readFileSync(path.join(app, "service-supervisor.log"), "utf8");
    if (failSpawn) assert.match(log, /spawn-error/);
  } finally {
    // Only remove the exact, freshly allocated fixture below the temp root.
    const relative = path.relative(os.tmpdir(), fixture);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test("supervisor stays alive to restart both services when both children exit", async () => {
  await exerciseSupervisor();
});

test("background startup uses the current Node executable without relying on PATH", async () => {
  await exerciseSupervisor({ emptyPath: true });
});

test("closing a launcher's output pipe does not kill the supervisor", async () => {
  await exerciseSupervisor({ closeOutput: true });
});

test("a spawn failure is retried even when it emits no exit event", async () => {
  await exerciseSupervisor({ failSpawn: true });
});
