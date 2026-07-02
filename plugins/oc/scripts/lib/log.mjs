import fs from "node:fs";

import { isErrorEvent } from "./events.mjs";

/** @import { OpenCodeError, OpenCodeEvent } from "./events.mjs" */

/**
 * @typedef {Object} LogState
 * @property {boolean} exists - whether the log file exists and is readable
 * @property {number} eventCount - the number of events in the log file, or 0 if it cannot be read
 * @property {boolean} errorSeen - true if the log ends in an unrecovered error: an error event with no model work after it. Errors opencode recovered from (e.g. by retrying on a fallback model) don't count — they stay visible in the rendered trace but don't decide the session's verdict.
 * @property {string|null} errorMessage - a human-readable message for the last unrecovered error, or null if the log doesn't end in one
 * @property {string|null} finalText - the model's final answer: text emitted since the most recent step boundary (concatenated), or null if the last step produced no text
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
function extractErrorMessage(event) {
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
 * Indents every line of a body after the first by two spaces, leaving blank
 * lines blank. Continuation lines can then never be mistaken for event
 * headers — in the rendered trace, flush-left always means "new event",
 * whatever the body contains. Two spaces rather than a tab or four so a
 * markdown re-render doesn't read continuations as code blocks.
 *
 * @param {string} body - the (trailing-trimmed) event body
 * @returns {string} the body with continuation lines indented
 */
function indentContinuation(body) {
  return body
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : "  " + line))
    .join("\n");
}

/**
 * Renders an `OpenCodeEvent` into a human-readable block for the event trace.
 * Most events render to a single line; `text` and `reasoning` bodies start on
 * the header line (`[ts] model: <first line>`) with continuation lines
 * indented two spaces below — otherwise verbatim (no clipping). Tool events
 * render as `tool: <name> <input>` so the trace stays informative for any
 * tool; the model's subsequent `text` event carries any output worth
 * surfacing. Unknown event types fall through to `[ts] <type>` so the trace
 * stays informative when opencode adds event kinds we haven't typed.
 * @param {OpenCodeEvent | null | undefined} event - the event to render
 * @param {number} [baseTimestamp] - the first event's timestamp; when present, renders session-relative offsets instead of wall-clock
 * @returns {string | null} the rendered block (may span multiple lines), or null when the event carries no displayable content
 */
function renderEvent(event, baseTimestamp) {
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
      return `[${ts}] model: ${indentContinuation(body)}`;
    }

    case "reasoning": {
      const body = String(event.part?.text ?? event.part?.summary ?? "").replace(/\s+$/, "");
      if (!body) return null;
      return `[${ts}] thinking: ${indentContinuation(body)}`;
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

// Event kinds that prove the model moved on after an error — the session
// recovered (e.g. opencode retried on a fallback model), so the error was
// transient, not the verdict. `step_finish` is deliberately absent (opencode
// could emit it while unwinding a failed step), as are `stderr` noise and
// unknown kinds — none of those may fake a recovery.
const PROGRESS_TYPES = new Set(["step_start", "text", "tool_use", "reasoning"]);
const PROGRESS_PART_TYPES = new Set(["step-start", "text", "tool", "reasoning"]);

/**
 * Reads the log file for a session and returns an object containing the log's
 * existence, event count, whether the log ends in an unrecovered error, the
 * associated error message, the final text output from the model, and the
 * observed session ID. An error event followed by model work is treated as
 * recovered (opencode owns retries and model fallbacks), so only an error
 * that stands as the log's last word marks failure. Session termination
 * itself is not inferred from log events — the caller resolves that from the
 * opencode process pid.
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
      errorMessage = extractErrorMessage(ev);
    } else if (PROGRESS_TYPES.has(t) || PROGRESS_PART_TYPES.has(partType)) {
      errorSeen = false;
      errorMessage = null;
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
 * Renders a session log into its full event trace: every event in order
 * through `renderEvent`, with timestamps relative to the first event and the
 * null-rendering structural events (`step_start`, `step_finish`, empty text)
 * dropped. Returns "" when the log is missing, unreadable, or holds no
 * renderable events, so callers emit one output shape regardless of session
 * state.
 *
 * @param {string} logFile - the file path to the session's log file
 * @returns {string} the rendered trace, or "" when there is nothing to show
 */
export function renderLog(logFile) {
  let raw;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
  const events = parseAll(raw);
  const baseTimestamp =
    events.length > 0 && typeof events[0].timestamp === "number"
      ? events[0].timestamp
      : null;
  const rendered = [];
  for (const ev of events) {
    const line = renderEvent(ev, baseTimestamp);
    if (line) rendered.push(line);
  }
  return rendered.join("\n");
}
