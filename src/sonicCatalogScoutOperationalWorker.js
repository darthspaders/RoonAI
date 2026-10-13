"use strict";

// Operational experiments only. The sealed production worker remains unchanged.
// No model request is sent until its Linux PID has an exact nonce/start-tick proof.
const { SonicAnalysisWorker } = require("./sonicAnalysisWorker");
const { randomUUID } = require("node:crypto"), { execFile } = require("node:child_process");
const OWNER_ENV = "RABBIT_HOLE_SCOUT_WORKER_OWNER";
const PYTHON = "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/python";
const OWNERSHIP_SCRIPT = `import os,sys,json,signal,pathlib,re
owner,operation,payload=sys.argv[1:4]
assert re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',owner)
needle=('RABBIT_HOLE_SCOUT_WORKER_OWNER='+owner).encode()
def inspect(pid):
 try:
  directory=pathlib.Path('/proc')/str(pid)
  if needle not in (directory/'environ').read_bytes().split(b'\\0'): return None
  parts=(directory/'stat').read_text().rsplit(')',1)[1].split()
  command=(directory/'cmdline').read_bytes().replace(b'\\0',b' ').decode('utf-8','replace')[:256]
  return dict(pid=pid,startTicks=parts[19],ppid=int(parts[1]),command=command,tagMatched=True)
 except (OSError,ValueError,IndexError): return None
if operation=='list':
 rows=[]
 for directory in pathlib.Path('/proc').iterdir():
  if directory.name.isdigit() and int(directory.name)!=os.getpid():
   row=inspect(int(directory.name))
   if row: rows.append(row)
 assert len(rows)<=64
 print(json.dumps(sorted(rows,key=lambda row:row['pid'])))
elif operation in ('TERM','KILL'):
 assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'), 'PID-bound signalling is unavailable'
 targets=json.loads(payload); assert isinstance(targets,list) and len(targets)<=64
 rows=[]
 for target in targets:
  pid=target['pid']; ticks=target['startTicks']
  assert isinstance(pid,int) and 0<pid<2147483648 and isinstance(ticks,str) and ticks.isdigit()
  sent=False; reason='absent-or-tag-mismatch'; descriptor=None
  try:
   descriptor=os.pidfd_open(pid,0); row=inspect(pid)
   if row and row['startTicks']==ticks and pid!=os.getpid():
    signal.pidfd_send_signal(descriptor,signal.SIGTERM if operation=='TERM' else signal.SIGKILL); sent=True; reason='exact-owned-process'
   elif row: reason='start-ticks-changed'
  except ProcessLookupError: reason='already-exited'
  finally:
   if descriptor is not None: os.close(descriptor)
  rows.append(dict(pid=pid,startTicks=ticks,signal=operation,sent=sent,reason=reason))
 print(json.dumps(rows))
else: raise ValueError('Unsupported owned-process operation')
`;
function bounded(value, fallback, minimum, maximum, label) {
  value = value ?? fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid operational ${label}.`);
  return value;
}
function exactRows(rows) {
  if (!Array.isArray(rows) || rows.length > 64) throw new Error("Invalid owned-process evidence.");
  const seen = new Set();
  return rows.map(row => {
    if (!row || !Number.isInteger(row.pid) || row.pid < 1 || row.pid >= 2147483648 || seen.has(row.pid)
      || typeof row.startTicks !== "string" || !/^[1-9]\d{0,19}$/.test(row.startTicks) || row.tagMatched !== true
      || typeof row.command !== "string" || row.command.length > 256) throw new Error("Owned PID/tag/start-tick evidence is invalid.");
    seen.add(row.pid); return { pid: row.pid, startTicks: row.startTicks, command: row.command, tagMatched: true };
  });
}
function probe(owner, operation, targets = []) {
  return new Promise((resolve, reject) => {
    const args = ["-c", OWNERSHIP_SCRIPT, owner, operation, JSON.stringify(targets)];
    const command = process.platform === "win32" ? "wsl.exe" : PYTHON;
    execFile(command, process.platform === "win32" ? ["-d", "Ubuntu", "--", PYTHON, ...args] : args,
      { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error("Owned Linux process inspection failed."));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Owned Linux process evidence was malformed.")); }
      });
  });
}
class OwnedOperationalWorker extends SonicAnalysisWorker {
  constructor({ timeoutMs = 540000, idleMs = 45000, device = "cuda", readyTimeoutMs = 30000, releaseTimeoutMs = 15000,
    pollMs = 50, termGraceMs = 1000, quietScans = 3, ownership = null, clock = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    super({ timeoutMs: bounded(timeoutMs, 540000, 1, 540000, "request timeout"), idleMs: bounded(idleMs, 45000, 1, 45000, "idle timeout"), device });
    this.owner = randomUUID(); this.readyTimeoutMs = bounded(readyTimeoutMs, 30000, 1, 60000, "ready timeout");
    this.releaseTimeoutMs = bounded(releaseTimeoutMs, 15000, 1, 60000, "release timeout");
    this.pollMs = bounded(pollMs, 50, 1, 1000, "poll interval"); this.termGraceMs = bounded(termGraceMs, 1000, 1, 10000, "TERM grace");
    this.quietScans = bounded(quietScans, 3, 2, 10, "quiet scans");
    if (typeof clock !== "function" || typeof sleep !== "function" || ownership && (typeof ownership.list !== "function" || typeof ownership.signal !== "function")) throw new Error("Invalid operational ownership dependencies.");
    this.ownership = ownership || { list: owner => probe(owner, "list"), signal: (owner, targets, signal) => probe(owner, signal, targets) };
    this.clock = clock; this.sleep = sleep; this.handles = []; this.verifiedChild = null; this.knownOwned = new Map();
    this.tagObserved = false; this.readyEvidence = null; this.running = false; this.releasing = null; this.stopGeneration = 0;
  }
  get ownedChild() { return this.child || this.handles.at(-1)?.child || null; }
  get lastLinuxPID() { return this.readyEvidence?.pid || this.handles.map(row => row.child.linuxPid).findLast(pid => Number.isInteger(pid) && pid > 0) || null; }
  start(runtime) {
    if (this.releasing) throw new Error("Wait for owned worker release before startup.");
    if (this.child && this.runtime === runtime) return;
    if (this.handles.length) throw new Error("Release the prior owned worker before startup or runtime switching.");
    const oldOwner = process.env[OWNER_ENV], oldWsl = process.env.WSLENV;
    process.env[OWNER_ENV] = this.owner;
    const names = (oldWsl || "").split(":").filter(Boolean).filter(item => item.split("/")[0] !== OWNER_ENV);
    process.env.WSLENV = [...names, OWNER_ENV].join(":");
    try { super.start(runtime); }
    finally {
      if (oldOwner === undefined) delete process.env[OWNER_ENV]; else process.env[OWNER_ENV] = oldOwner;
      if (oldWsl === undefined) delete process.env.WSLENV; else process.env.WSLENV = oldWsl;
    }
    const child = this.child;
    if (!child) throw new Error("Owned worker startup did not produce a child handle.");
    const handle = { child, exited: child.exitCode !== null && child.exitCode !== undefined || Boolean(child.signalCode) };
    child.once("exit", () => { handle.exited = true; });
    child.once("error", () => { if (!Number.isInteger(child.pid) || child.pid < 1) handle.exited = true; });
    this.handles.push(handle); this.verifiedChild = null;
  }
  async ownedProcesses() {
    const rows = exactRows(await this.ownership.list(this.owner));
    if (rows.length) this.tagObserved = true;
    for (const row of rows) this.knownOwned.set(`${row.pid}:${row.startTicks}`, row);
    return rows.map(({ pid, startTicks, command }) => ({ pid, startTicks, command }));
  }
  async awaitReady({ timeoutMs = this.readyTimeoutMs } = {}) {
    timeoutMs = bounded(timeoutMs, this.readyTimeoutMs, 1, 60000, "ready timeout");
    const child = this.child, generation = this.stopGeneration, deadline = this.clock() + timeoutMs;
    if (!child || this.releasing) throw new Error("Start an owned worker before awaiting readiness.");
    if (this.verifiedChild === child) return { ...this.readyEvidence, ownerVerified: true };
    while (this.clock() < deadline) {
      if (this.child !== child || this.stopGeneration !== generation || this.handles.find(row => row.child === child)?.exited) throw new Error("Owned worker stopped before verified readiness.");
      if (Number.isInteger(child.linuxPid) && child.linuxPid > 0) {
        const rows = await this.ownedProcesses(), proof = rows.find(row => row.pid === child.linuxPid);
        if (!proof) { this.stop(); throw new Error("Ready worker ownership tag could not be verified; release and investigate before recovery."); }
        if (this.child !== child || this.stopGeneration !== generation) throw new Error("Owned worker was cancelled during readiness verification.");
        this.verifiedChild = child; this.readyEvidence = { pid: proof.pid, startTicks: proof.startTicks };
        return { ...this.readyEvidence, ownerVerified: true };
      }
      await this.sleep(this.pollMs);
    }
    this.stop(); throw new Error("Owned worker readiness timed out; release before recovery.");
  }
  async run(file, spec) {
    if (this.running || this.pending || this.releasing) throw new Error("Owned analysis concurrency is limited to one.");
    this.running = true;
    try { this.start(spec.runtime); await this.awaitReady(); return await super.run(file, spec); }
    finally { this.running = false; }
  }
  stop() {
    this.stopGeneration++; this.verifiedChild = null;
    const child = this.child, pid = child?.linuxPid;
    // Suppress the original worker's unverified numeric-PID signal. release()
    // rechecks nonce and start ticks immediately before every Linux signal.
    if (child) delete child.linuxPid;
    try { super.stop(); } finally { if (child && pid !== undefined) child.linuxPid = pid; }
  }
  async release({ timeoutMs = this.releaseTimeoutMs } = {}) {
    if (this.releasing) return this.releasing;
    timeoutMs = bounded(timeoutMs, this.releaseTimeoutMs, 1, 60000, "release timeout");
    const operation = this.#release(timeoutMs); this.releasing = operation;
    try { return await operation; } finally { this.releasing = null; }
  }
  async #release(timeoutMs) {
    const deadline = this.clock() + timeoutMs, signalled = new Map(), signals = []; let quiet = 0;
    try { await this.ownedProcesses(); } finally { this.stop(); }
    while (this.clock() < deadline) {
      const rows = await this.ownedProcesses();
      for (const row of rows) {
        const key = `${row.pid}:${row.startTicks}`, prior = signalled.get(key), signal = !prior ? "TERM" : prior.signal === "TERM" && this.clock() - prior.at >= this.termGraceMs ? "KILL" : null;
        if (signal) {
          const results = await this.ownership.signal(this.owner, [{ pid: row.pid, startTicks: row.startTicks }], signal);
          if (!Array.isArray(results) || results.length !== 1 || results[0].pid !== row.pid || results[0].startTicks !== row.startTicks
            || results[0].signal !== signal || typeof results[0].sent !== "boolean") throw new Error("Owned signal evidence changed.");
          signals.push(results[0]); signalled.set(key, { signal, at: this.clock() });
        }
      }
      const exited = this.handles.every(handle => handle.exited || handle.child.exitCode !== null && handle.child.exitCode !== undefined || Boolean(handle.child.signalCode));
      quiet = !rows.length && exited ? quiet + 1 : 0;
      if (quiet >= this.quietScans) {
        if (this.handles.length && !this.tagObserved) throw new Error("Ownership tag was never observed; cleanup cannot be confirmed safely.");
        const result = { confirmed: true, tagPropagationVerified: this.tagObserved, ownedLinuxProcessesRemaining: 0, windowsChildrenRemaining: 0,
          ownedProcessesObserved: this.knownOwned.size, quietScans: quiet, signals, readyOwnershipVerified: Boolean(this.readyEvidence) };
        this.handles = []; this.knownOwned.clear(); this.tagObserved = false; this.readyEvidence = null; return result;
      }
      await this.sleep(this.pollMs);
    }
    throw new Error("Owned process release could not be confirmed; recovery is blocked.");
  }
}
module.exports = { OwnedOperationalWorker, OWNER_ENV, OWNERSHIP_SCRIPT };
