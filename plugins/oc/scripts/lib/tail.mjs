import fs from "node:fs";

import { isErrorEvent } from "./events.mjs";

/** @import { OpenCodeError, OpenCodeEvent } from "./events.mjs" */

/**
 * @typedef {Object} LogState
 * @property {boolean} exists - whether the log file exists and is readable
 * @property {number} eventCount - the number of events in the log file, or 0 if it cannot be read
 * @property {boolean} errorSeen - true if a session-ending error event has been emitted in the log
 * @property {string|null} errorMessage - a human-readable error message extracted from the events, or null if no error is found
 * @property {string|null} finalText - the concatenated text output from all "text" events, or null if no text events are found
 * @property {string|null} observedSessionId - the session ID observed in the events, or null if no session ID is found
 * @property {number|null} lastEventAt - the timestamp (ms since epoch) of the most recent event in the log, or null if the log has none
 */

/**
 * Checks whether a process with the given pid is still alive by sending signal
 * 0, which performs an existence check without delivering any signal. Returns
 * false for any falsy pid.
 *
 * @param {number} pid - the pid to check
 * @returns {boolean} true if the process exists and is signalable by the caller
 */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a timestamp as a session-relative offset string when `base` is
 * provided (e.g. `+0:00`, `+5:12`, `+1:05:42`), or as wall-clock `HH:MM:SS`
 * when it isn't. Returns padding spaces for falsy input.
 *
 * @param {number} ms - milliseconds since epoch
 * @param {number} [base] - the first event's timestamp; when present, renders relative
 * @returns {string} the formatted timestamp
 */
function tsString(ms, base) {
  if (!ms) return "     ";
  if (base) {
    const delta = Math.max(0, Math.floor((ms - base) / 1000));
    const s = delta % 60;
    const m = Math.floor(delta / 60) % 60;
    const h = Math.floor(delta / 3600);
    if (h > 0)
      return `+${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `+${m}:${String(s).padStart(2, "0")}`;
  }
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * Clips a string to a maximum length, adding "..." if it was clipped. Also collapses all whitespace to single spaces and trims leading/trailing whitespace.
 * @param {string} s - the string to clip
 * @param {number} [max=120] - the maximum length of the returned string, including the "..." if clipping is necessary
 * @returns {string} the clipped and cleaned string
 */
function clip(s, max = 120) {
  const str = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (str.length <= max) return str;
  if (max <= 3) return str.slice(0, max);
  return str.slice(0, max - 3) + "...";
}

/**
 * Extracts a human-readable error message from an `OpenCodeEvent` that represents an error. The function checks various fields in the event and its `error` payload to find a suitable message, including `error.data.message`, `error.message`, `error.name`, and `event.message`. If no suitable message is found, it attempts to stringify the entire event or error object. The resulting message is clipped to a maximum length for logging purposes.
 * @param {OpenCodeError} event - the event from which to extract the error message
 * @returns {string} a human-readable error message extracted from the event
 */
export function extractErrorMessage(event) {
  if (!event) return "(no detail)";

  if (typeof event === "object") {
    const error = event.error;

    if (typeof error === "string" && error) return clip(error, 2000);

    if (error && typeof error === "object") {
      if (error.data && typeof error.data.message === "string")
        return clip(
          `${error.name ? `${error.name}: ` : ""}${error.data.message}`,
          2000,
        );

      if (typeof error.message === "string") return clip(error.message, 2000);

      if (typeof error.name === "string") return clip(error.name, 2000);

      try {
        return clip(JSON.stringify(error), 2000);
      } catch {}
    }

    if (typeof event.message === "string" && event.message)
      return clip(event.message, 2000);
  }

  try {
    return clip(JSON.stringify(event), 2000);
  } catch {
    return "(unreadable)";
  }
}

const PRIMARY_INPUT_FIELDS = [
  "filePath",
  "path",
  "file",
  "command",
  "pattern",
  "url",
  "query",
  "description",
];

/**
 * Picks the most informative string from a tool's `state.input` object: the
 * first present field from a priority list of common opencode/MCP tool fields,
 * falling back to the first string-valued field as `key=value`, and finally to
 * a compact `JSON.stringify`. Result is clipped to ~120 chars with whitespace
 * collapsed so multi-line scripts squash gracefully.
 *
 * @param {unknown} input - the `part.state.input` payload from a tool_use event
 * @returns {string} a short, human-readable summary, or "" if nothing usable was found
 */
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";

  for (const key of PRIMARY_INPUT_FIELDS) {
    const v = input[key];
    if (typeof v === "string" && v) return clip(v, 120);
    if (typeof v === "number" || typeof v === "boolean")
      return clip(String(v), 120);
  }

  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string" && val) return clip(`${key}=${val}`, 120);
  }

  try {
    const json = JSON.stringify(input);
    return json && json !== "{}" ? clip(json, 120) : "";
  } catch {
    return "";
  }
}

/**
 * Renders an `OpenCodeEvent` into a human-readable block for the tail digest.
 * Most events render to a single line; `text` and `reasoning` events fit on
 * the header line when their body is single-line and fall back to a header +
 * body block when multi-line, so the full body is preserved verbatim either
 * way (no clipping). Tool events render as `tool: <name> <input>` so the
 * trace stays informative for any tool; the model's subsequent `text` event
 * carries any output worth surfacing. Unknown event types fall through to
 * `[ts] <type>` so the stream stays informative when opencode adds event
 * kinds we haven't typed.
 * @param {OpenCodeEvent | null | undefined} event - the event to render
 * @param {number} [baseTimestamp] - the first event's timestamp; when present, renders session-relative offsets instead of wall-clock
 * @returns {string | null} the rendered block (may span multiple lines), or null when the event carries no displayable content
 */
export function renderEvent(event, baseTimestamp) {
  if (!event || typeof event !== "object") return null;
  const ts = tsString(event.timestamp, baseTimestamp);

  switch (event.type) {
    case "step_start":
    case "step_finish":
      return null;

    case "session_idle":
    case "session.idle":
      return `[${ts}] session idle`;

    case "session_error":
    case "session.error":
      return `[${ts}] session error: ${extractErrorMessage(event)}`;

    case "error":
      return `[${ts}] error: ${extractErrorMessage(event)}`;

    case "stderr": {
      const text = event.text ?? "";
      return text ? `[${ts}] stderr: ${clip(text, 200)}` : null;
    }

    case "text": {
      const body = String(event.part?.text ?? "").replace(/\s+$/, "");
      if (!body) return null;
      return body.includes("\n")
        ? `[${ts}] model:\n${body}`
        : `[${ts}] model: ${body}`;
    }

    case "reasoning": {
      const body = String(event.part?.text ?? event.part?.summary ?? "").replace(/\s+$/, "");
      if (!body) return null;
      return body.includes("\n")
        ? `[${ts}] thinking:\n${body}`
        : `[${ts}] thinking: ${body}`;
    }

    case "tool_use": {
      const name = event.part?.tool ?? "tool";
      const state = event.part?.state ?? {};
      const inputStr = summarizeToolInput(state.input);
      const inputPart = inputStr ? ` ${inputStr}` : "";

      if (state.status === "error") {
        const err = clip(state.error ?? "(no detail)", 200);
        return `[${ts}] tool: ${name}${inputPart} (error: ${err})`;
      }
      if (state.status === "completed") {
        return `[${ts}] tool: ${name}${inputPart}`;
      }
      return `[${ts}] tool: ${name}${inputPart}${state.status ? ` (${state.status})` : ""}`;
    }

    default:
      return `[${ts}] ${String(event.type ?? "unknown")}`;
  }
}

/**
 * Parses a buffer containing multiple lines of text, where each line is expected to be a JSON string representing an `OpenCodeEvent`. Lines that cannot be parsed as JSON are treated as raw stderr output and wrapped in an event object with type "stderr". Empty lines are ignored. The function returns an array of parsed events and stderr objects.
 * @param {string} buf - the buffer to parse, containing multiple lines of text
 * @returns {(OpenCodeEvent | { type: "stderr", text: string })[]} an array of parsed events and stderr objects
 */
function parseAll(buf) {
  const out = [];
  for (const line of buf.split("\n")) {
    const t = line.trim();

    if (t === "") continue;

    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      ev = { type: "stderr", text: line };
    }
    out.push(ev);
  }
  return out;
}

/**
 * Reads the log file for a session and returns an object containing the log's
 * existence, event count, whether a session-ending error has been observed,
 * the associated error message, the final text output from the model, and the
 * observed session ID. Session termination itself is not inferred from log
 * events — the caller resolves that from the opencode process pid.
 * @param {string} logFile - the file path to the session's log file
 * @returns {LogState} the parsed log state
 */
export function readLogState(logFile) {
  const empty = {
    exists: false,
    eventCount: 0,
    errorSeen: false,
    errorMessage: null,
    finalText: null,
    observedSessionId: null,
    lastEventAt: null,
  };

  if (!fs.existsSync(logFile)) return empty;

  let raw;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch {
    return { ...empty, exists: true };
  }
  const events = parseAll(raw);

  let errorSeen = false;
  let errorMessage = null;
  let observedSessionId = null;
  let lastEventAt = null;
  let textBuf = [];
  for (const ev of events) {
    if (typeof ev.sessionID === "string") observedSessionId = ev.sessionID;
    else if (typeof ev.sessionId === "string") observedSessionId = ev.sessionId;
    else if (ev.part && typeof ev.part.sessionID === "string")
      observedSessionId = ev.part.sessionID;

    if (typeof ev.timestamp === "number") lastEventAt = ev.timestamp;

    const t = ev.type;
    const partType = ev.part?.type;

    if (t === "step_start" || partType === "step-start") textBuf = [];
    else if (t === "text" && typeof ev.text === "string") textBuf.push(ev.text);
    else if (partType === "text" && typeof ev.part?.text === "string")
      textBuf.push(ev.part.text);

    if (isErrorEvent(ev)) {
      errorSeen = true;
      if (errorMessage === null) errorMessage = extractErrorMessage(ev);
    }
  }
  return {
    exists: true,
    eventCount: events.length,
    errorSeen,
    errorMessage,
    finalText: textBuf.length > 0 ? textBuf.join("") : null,
    observedSessionId,
    lastEventAt,
  };
}

/**
 * Reads the last N events from a session log file and returns a digest string
 * that can be displayed in a UI, along with the log's current file size for
 * follow-mode offset bookkeeping. Session-completion status is determined by
 * the caller from the opencode process pid, not from this digest.
 *
 * @param {string} logFile - the file path to the session's log file
 * @param {Object} [options] - optional parameters
 * @param {number|null} [options.count=1] - the number of events from the end of the log to include in the digest; if null, includes all events; if 0, includes none
 * @returns {{ digest: string, fileSize: number, baseTimestamp: number|null }} the rendered digest, current file size in bytes, and the first event's timestamp for follow-mode continuity
 */
export function readDigest(logFile, { count = 1 } = {}) {
  if (!fs.existsSync(logFile))
    return { digest: "", fileSize: 0, baseTimestamp: null };
  const stat = fs.statSync(logFile);
  const raw = fs.readFileSync(logFile, "utf8");
  const events = parseAll(raw);
  const baseTimestamp =
    events.length > 0 && typeof events[0].timestamp === "number"
      ? events[0].timestamp
      : null;
  const sliced =
    count === null ? events : count === 0 ? [] : events.slice(-count);
  const rendered = [];
  for (const ev of sliced) {
    const line = renderEvent(ev, baseTimestamp);
    if (line) rendered.push(line);
  }
  return { digest: rendered.join("\n"), fileSize: stat.size, baseTimestamp };
}

/**
 * Follows a log file in real-time, rendering new events to stdout, until the
 * opencode process identified by `pid` exits or `timeoutMs` elapses. The pid's
 * liveness is the sole signal for session end: after the process dies, one
 * final drain is performed so any trailing events are surfaced before return.
 *
 * @param {number} pid - the pid of the opencode `run` process whose exit signals session end (mandatory)
 * @param {string} logFile - the path to the log file to follow
 * @param {Object} [options] - optional parameters
 * @param {number} [options.startOffset=0] - the byte offset in the log file from which to start reading; defaults to 0
 * @param {number|null} [options.baseTimestamp=null] - the first event's timestamp from the digest phase; used for session-relative rendering continuity
 * @param {number} [options.timeoutMs=900000] - the maximum time in milliseconds to wait before giving up; defaults to 15 minutes
 * @param {number} [options.intervalMs=250] - the interval in milliseconds at which to poll the log and pid; defaults to 250 ms
 * @returns {Promise<{ timedOut: boolean }>} whether the follow timed out before the process exited
 */
export async function followLog(
  pid,
  logFile,
  {
    startOffset = 0,
    baseTimestamp = null,
    timeoutMs = 15 * 60 * 1000,
    intervalMs = 250,
  } = {},
) {
  let lastSize = startOffset;
  let lastLineFragment = "";
  const start = Date.now();

  const drain = () => {
    if (!fs.existsSync(logFile)) return;
    let stat;
    try {
      stat = fs.statSync(logFile);
    } catch {
      return;
    }
    if (stat.size <= lastSize) return;
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(stat.size - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;
    const text = lastLineFragment + buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    const complete = lastNl >= 0 ? text.slice(0, lastNl) : "";
    lastLineFragment = lastNl >= 0 ? text.slice(lastNl + 1) : text;
    for (const ev of parseAll(complete)) {
      const line = renderEvent(ev, baseTimestamp);
      if (line) process.stdout.write(line + "\n");
    }
  };

  while (true) {
    drain();
    if (!isPidAlive(pid)) {
      drain();
      return { timedOut: false };
    }
    if (Date.now() - start > timeoutMs) return { timedOut: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
