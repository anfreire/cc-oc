import fs from "node:fs";

import { isTerminalEvent } from "./events.mjs";

/** @import { OpenCodeError, OpenCodeEvent } from "./events.mjs" */

/**
 * @typedef {Object} LogState
 * @property {boolean} exists - whether the log file exists and is readable
 * @property {number} eventCount - the number of events in the log file, or 0 if it cannot be read
 * @property {string|null} terminalKind - "error" if an error event is found, "done" if a completion event is found, or null if neither is found
 * @property {string|null} errorMessage - a human-readable error message extracted from the events, or null if no error is found
 * @property {string|null} finalText - the concatenated text output from all "text" events, or null if no text events are found
 * @property {string|null} observedSessionId - the session ID observed in the events, or null if no session ID is found
 */

/**
 * Render a timestamp (in ms since epoch) as a human-readable string. If the input is falsy, returns a string of spaces to preserve alignment in logs.
 * @param {number|string|Date} ms - the timestamp to render, in milliseconds since epoch, or a value that can be passed to `new Date()`. If falsy, the function returns a string of spaces.
 * @returns {string} the rendered timestamp in "HH:MM:SS" format, or spaces if the input is falsy
 */
function tsString(ms) {
  if (!ms) return "         ";
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

/**
 * Renders an `OpenCodeEvent` into a one-line human-readable summary for the
 * tail digest. Unknown event types fall through to `[ts] <type>` so the
 * stream stays informative when opencode adds event kinds we haven't typed.
 * @param {OpenCodeEvent | null | undefined} event - the event to render
 * @returns {string | null} the rendered line, or null when the event carries no displayable content
 */
export function renderEvent(event) {
  if (!event || typeof event !== "object") return null;
  const ts = tsString(event.timestamp);

  switch (event.type) {
    case "step_start":
      return `[${ts}] step start`;

    case "step_finish":
      return `[${ts}] step finish`;

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
      const text = event.part?.text ?? "";
      return text ? `[${ts}] model: ${clip(text)}` : null;
    }

    case "reasoning": {
      const text = event.part?.text ?? event.part?.summary ?? "";
      return text ? `[${ts}] thinking: ${clip(text)}` : null;
    }

    case "tool_use": {
      const name = event.part?.tool ?? "tool";
      const status = event.part?.state?.status;
      if (status === "error") {
        const err = event.part?.state?.error ?? "(no detail)";
        return `[${ts}] tool: ${name} (error: ${clip(err, 200)})`;
      }
      return `[${ts}] tool: ${name}${status ? ` (${status})` : ""}`;
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
 * Reads the log file for a session and returns an object containing the log's existence, event count, terminal kind (e.g. "error" or "done"), any error message found in the events, the final text output from the model, and the observed session ID. This function is used to determine the current state of a session's log, which can inform how to display it in a UI or whether to continue following it for new events.
 * @param {string} logFile - the file path to the session's log file
 * @returns {LogState} an object containing the log's existence, event count, terminal kind, error message, final text, and observed session ID
 */
export function readLogState(logFile) {
  const empty = {
    exists: false,
    eventCount: 0,
    terminalKind: null,
    errorMessage: null,
    finalText: null,
    observedSessionId: null,
  };

  if (!fs.existsSync(logFile)) return empty;

  let raw;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch {
    return { ...empty, exists: true };
  }
  const events = parseAll(raw);

  let terminalKind = null;
  let errorMessage = null;
  let observedSessionId = null;
  let textBuf = [];
  for (const ev of events) {
    if (typeof ev.sessionID === "string") observedSessionId = ev.sessionID;
    else if (typeof ev.sessionId === "string") observedSessionId = ev.sessionId;
    else if (ev.part && typeof ev.part.sessionID === "string")
      observedSessionId = ev.part.sessionID;

    const t = ev.type;
    const partType = ev.part?.type;

    if (t === "step_start" || partType === "step-start") textBuf = [];
    else if (t === "text" && typeof ev.text === "string") textBuf.push(ev.text);
    else if (partType === "text" && typeof ev.part?.text === "string")
      textBuf.push(ev.part.text);

    if (t === "session_error" || t === "session.error" || t === "error") {
      terminalKind = "error";
      if (errorMessage === null) errorMessage = extractErrorMessage(ev);
    } else if (t === "session_idle" || t === "session.idle") {
      if (terminalKind !== "error") terminalKind = "done";
    } else if (t === "step_finish" || partType === "step-finish") {
      if (terminalKind === null) terminalKind = "done";
    }
  }
  return {
    exists: true,
    eventCount: events.length,
    terminalKind,
    errorMessage,
    finalText: textBuf.length > 0 ? textBuf.join("") : null,
    observedSessionId,
  };
}

/**
 * Reads the last few lines of a session log file and returns a digest string that can be displayed in a UI. The function also returns whether the last event in the log is a terminal event (indicating the session has completed or errored) and the file size of the log. This is useful for showing a quick summary of the session's progress without having to read the entire log.
 * @param {string} logFile - the file path to the session's log file
 * @param {Object} [options] - optional parameters
 * @param {number|null} [options.lines=10] - the number of lines (events) from the end of the log to include in the digest; if null, includes all lines; if 0, includes no lines
 * @returns {{ digest: string, terminal: boolean, fileSize: number }} an object containing the digest string, whether the last event is terminal, and the file size of the log
 */
export function readDigest(logFile, { lines = 10 } = {}) {
  if (!fs.existsSync(logFile))
    return { digest: "", terminal: false, fileSize: 0 };
  const stat = fs.statSync(logFile);
  const raw = fs.readFileSync(logFile, "utf8");
  const events = parseAll(raw);
  const sliced =
    lines === null ? events : lines === 0 ? [] : events.slice(-lines);
  const rendered = [];
  for (const ev of sliced) {
    const line = renderEvent(ev);
    if (line) rendered.push(line);
  }
  const terminal =
    events.length > 0 && isTerminalEvent(events[events.length - 1]);
  return { digest: rendered.join("\n"), terminal, fileSize: stat.size };
}

/**
 * Follows a log file in real-time, starting from a given byte offset. The function continuously checks for new content in the log file, parsing any new lines as `OpenCodeEvent` objects and rendering them to the console. The function returns when it encounters an event that indicates the session has completed (a terminal event) or when a specified timeout is reached without seeing a terminal event. If the log file does not exist at the start, the function will wait for it to be created, up until the timeout.
 * @param {string} logFile - the path to the log file to follow
 * @param {Object} [options] - optional parameters
 * @param {number} [options.startOffset=0] - the byte offset in the log file from which to start reading; defaults to 0 (the beginning of the file)
 * @param {number} [options.timeoutMs=900000] - the maximum time in milliseconds to wait for a terminal event before giving up; defaults to 15 minutes (900,000 ms)
 * @param {number} [options.intervalMs=250] - the interval in milliseconds at which to check for new content in the log file; defaults to 250 ms
 * @returns {Promise<{ terminal: boolean, timedOut: boolean }>} an object indicating whether a terminal event was seen and whether the function timed out
 */
export async function followLog(
  logFile,
  { startOffset = 0, timeoutMs = 15 * 60 * 1000, intervalMs = 250 } = {},
) {
  let lastSize = startOffset;
  let lastLineFragment = "";
  const start = Date.now();

  while (true) {
    if (!fs.existsSync(logFile)) {
      if (Date.now() - start > timeoutMs)
        return { terminal: false, timedOut: true };

      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(logFile);
    } catch {
      stat = null;
    }
    if (stat && stat.size > lastSize) {
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      const text = lastLineFragment + buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      const complete = lastNl >= 0 ? text.slice(0, lastNl) : "";
      lastLineFragment = lastNl >= 0 ? text.slice(lastNl + 1) : text;
      let sawTerminal = false;
      for (const ev of parseAll(complete)) {
        const line = renderEvent(ev);
        if (line) process.stdout.write(line + "\n");
        if (isTerminalEvent(ev)) sawTerminal = true;
      }

      if (sawTerminal) return { terminal: true, timedOut: false };
    }

    if (Date.now() - start > timeoutMs)
      return { terminal: false, timedOut: true };

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
