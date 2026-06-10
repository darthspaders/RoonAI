"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";

  for (const char of String(command || "")) {
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (char === " " && !quote) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeOutputFormat(format) {
  const value = String(format || "").trim().toUpperCase();
  if (value === "0" || value === "PCM") return "PCM";
  if (value === "1" || value === "SDM" || value === "DSD") return "SDM";
  return "";
}

function formatRate(rateKhz, outputFormat = "") {
  if (!Number.isFinite(rateKhz) || rateKhz <= 0) return "";
  if (normalizeOutputFormat(outputFormat) === "SDM") return `${(rateKhz / 1000).toFixed(4)}MHz`;

  const rounded = Math.round(rateKhz * 10) / 10;
  return Math.abs(rounded - Math.round(rounded)) < 0.05
    ? `${Math.round(rounded)}kHz`
    : `${rounded.toFixed(1)}kHz`;
}

function formatDsdRate(rateKhz) {
  if (!Number.isFinite(rateKhz) || rateKhz <= 0) return "";
  const multiple = Math.round(rateKhz / 44.1);
  return Number.isFinite(multiple) && multiple > 0 ? `DSD${multiple}` : "";
}

function parseStateOutput(output) {
  const clean = stripAnsi(output);
  const rateMatch = clean.match(/\b(\d+):(\d{5,9})\b/);
  if (!rateMatch) return null;

  const mode = Number(rateMatch[1]);
  const rate = Number(rateMatch[2]);
  if (!Number.isFinite(mode) || !Number.isFinite(rate) || rate <= 0) return null;

  const selectionMatch = clean.match(/\d+:\((\d+),\s*\d+\s*\(\d+,\s*(\d+)\),\s*(\d+)\)/);

  return {
    outputFormat: normalizeOutputFormat(String(mode)),
    outputRateKhz: rate / 1000,
    filterIndex: selectionMatch ? Number(selectionMatch[1]) : null,
    shaperIndex: selectionMatch ? Number(selectionMatch[2]) : null,
    rateIndex: selectionMatch ? Number(selectionMatch[3]) : null
  };
}

function parseTransportRateKhz(output) {
  const match = stripAnsi(output).match(/transport:\s+(\d+)/i);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? (value * 800) / 1000 : null;
}

function parseNamedList(output) {
  const names = new Map();
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const match = line.trim().match(/^\[(\d+)]\s+"([^"]+)"/);
    if (match) names.set(Number(match[1]), match[2]);
  }
  return names;
}

function isFilterName(value) {
  return /(?:sinc|FIR|IIR|ASRC|poly|polynomial|closed-form|none)/i.test(String(value || "").trim());
}

function isShaperName(value) {
  return /^(?:TPDF|RPDF|NS\d+|LNS\d+|Gauss\d+|shaped|ASDM.*)$/i.test(String(value || "").trim());
}

function siblingCommand(command, replacementArg) {
  const parts = splitCommand(command);
  if (!parts.length) return "";

  const index = parts.findIndex((part) => /^--/.test(part));
  if (index === -1) return "";

  parts[index] = replacementArg;
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function defaultPtyWorker() {
  const worker = "C:\\Users\\spade\\Documents\\Codex\\RoonPresence\\src\\hqplayerPtyWorker.js";
  return fs.existsSync(worker) ? worker : "";
}

function runPtyCommand(command, timeoutMs = 4000, workerPath = defaultPtyWorker()) {
  if (!workerPath || !fs.existsSync(workerPath)) return Promise.resolve("");

  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return new Promise((resolve) => {
    execFile(process.execPath, [workerPath, encodedCommand, String(timeoutMs)], {
      cwd: path.dirname(workerPath),
      timeout: timeoutMs + 1000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

async function runCommand(command, timeoutMs = 4000, ptyWorkerPath = "") {
  const [file, ...args] = splitCommand(command);
  if (!file) return "";

  const directOutput = await new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });

  return directOutput || runPtyCommand(command, timeoutMs, ptyWorkerPath);
}

function defaultRateCommand() {
  const file = "C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe";
  return fs.existsSync(file) ? `"${file}" localhost --state` : "";
}

function cleanPart(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

class HQPlayerStatus {
  constructor(options = {}) {
    this.rateCommand = options.rateCommand || defaultRateCommand();
    this.signalPathPrefix = options.signalPathPrefix || "";
    this.staticSignalPath = options.staticSignalPath || "";
    this.ptyWorkerPath = options.ptyWorkerPath || defaultPtyWorker();
    this.pollMs = Math.max(2000, Number(options.pollMs || 60000));
    this.timeoutMs = Math.max(1000, Math.min(10000, Math.floor(this.pollMs * 0.8)));
    this.timer = null;
    this.inFlight = false;
    this.filterNames = new Map();
    this.shaperNames = new Map();
    this.status = this.statusFromSignalPath(this.staticSignalPath || this.signalPathPrefix);
  }

  start() {
    if (this.timer || (!this.rateCommand && !this.staticSignalPath && !this.signalPathPrefix)) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return { ...this.status };
  }

  async poll() {
    if (this.inFlight || !this.rateCommand) return;
    this.inFlight = true;

    try {
      const output = await runCommand(this.rateCommand, this.timeoutMs, this.ptyWorkerPath);
      const state = parseStateOutput(output);
      if (!state) {
        const rate = parseTransportRateKhz(output);
        if (rate) this.status = this.statusFromState({ outputRateKhz: rate });
        return;
      }

      await this.refreshNames(state);
      this.status = this.statusFromState(state);
    } finally {
      this.inFlight = false;
    }
  }

  async refreshNames(state) {
    const filtersCommand = siblingCommand(this.rateCommand, "--get-filters");
    const shapersCommand = siblingCommand(this.rateCommand, "--get-shapers");

    if (filtersCommand && Number.isFinite(state.filterIndex) && !this.filterNames.has(state.filterIndex)) {
      const names = parseNamedList(await runCommand(filtersCommand, this.timeoutMs, this.ptyWorkerPath));
      if (names.size) this.filterNames = names;
    }

    if (shapersCommand && state.outputFormat === "SDM" && Number.isFinite(state.shaperIndex) && !this.shaperNames.has(state.shaperIndex)) {
      const names = parseNamedList(await runCommand(shapersCommand, this.timeoutMs, this.ptyWorkerPath));
      if (names.size) this.shaperNames = names;
    }
  }

  statusFromState(state = {}) {
    const format = state.outputFormat || "";
    const rate = formatRate(state.outputRateKhz, format);
    const dsdRate = format === "SDM" ? formatDsdRate(state.outputRateKhz) : "";
    const filter = cleanPart(this.filterNames.get(state.filterIndex)) || "";
    const shaper = cleanPart(this.shaperNames.get(state.shaperIndex)) || "";
    const baseParts = String(this.signalPathPrefix || "")
      .split(",")
      .map(cleanPart)
      .filter(Boolean)
      .filter((part) => (
        !/^\d+(?:\.\d+)?\s*(?:kHz|MHz)$/i.test(part) &&
        !/^DSD\d+$/i.test(part) &&
        !(format && /^(?:PCM|SDM|DSD)$/i.test(part)) &&
        !(filter && isFilterName(part)) &&
        !(format && isShaperName(part))
      ));
    const parts = [
      ...baseParts,
      filter,
      format === "SDM" ? shaper : "",
      format,
      dsdRate || rate
    ].map(cleanPart).filter(Boolean);

    return {
      active: Boolean(rate || filter || this.signalPathPrefix),
      filter,
      shaper,
      format,
      rate,
      signalPath: Array.from(new Set(parts)).join(", ")
    };
  }

  statusFromSignalPath(signalPath) {
    const parts = String(signalPath || "").split(",").map(cleanPart).filter(Boolean);
    const rate = parts.find((part) => /\d+(?:\.\d+)?\s*(?:kHz|MHz)\b/i.test(part)) || "";
    const format = parts.find((part) => /^(?:PCM|SDM|DSD)$/i.test(part)) || "";
    const filter = parts.find((part) => /(?:sinc|FIR|IIR|ASRC|poly|closed-form)/i.test(part)) || "";
    return {
      active: Boolean(signalPath),
      filter,
      shaper: "",
      format: normalizeOutputFormat(format),
      rate,
      signalPath: cleanPart(signalPath)
    };
  }
}

module.exports = {
  HQPlayerStatus
};
