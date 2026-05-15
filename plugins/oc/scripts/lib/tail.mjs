// Stream or peek at a session's progress by reading its NDJSON log.

import fs from "node:fs";
import { renderEvent } from "./render.mjs";

function parseLogEvents(buf) {
  const out = [];
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try { out.push(JSON.parse(t)); } catch { out.push({ type: "stderr", text: t }); }
  }
  return out;
}

function isTerminalEvent(event) {
  if (!event) return false;
  const t = event.type;
  if (t === "session_idle" || t === "session.idle") return true;
  if (t === "session_error" || t === "session.error") return true;
  if (t === "error") return true;
  // `opencode run --format json` exits after step_finish — no further events follow.
  if (t === "step_finish") return true;
  if (event.part && event.part.type === "step-finish") return true;
  return false;
}

export function readDigest(logFile, { lines: maxLines = null, since = null, reasoning = false } = {}) {
  if (!fs.existsSync(logFile)) return { digest: "", terminal: false, eventCount: 0 };
  const raw = fs.readFileSync(logFile, "utf8");
  const events = parseLogEvents(raw);
  const filtered = since
    ? events.filter((e) => typeof e.timestamp === "number" && e.timestamp >= since)
    : events;
  const sliced = maxLines === null ? filtered : (maxLines === 0 ? [] : filtered.slice(-maxLines));
  const digestLines = [];
  for (const ev of sliced) {
    const line = renderEvent(ev, { reasoning });
    if (line) digestLines.push(line);
  }
  const terminal = events.length > 0 && isTerminalEvent(events[events.length - 1]);
  return { digest: digestLines.join("\n"), terminal, eventCount: events.length };
}

export async function followLog(logFile, { reasoning = false, onLine = null, timeoutMs = 15 * 60 * 1000, intervalMs = 250 } = {}) {
  // Block until the log ends with a terminal event, or until timeout.
  let lastSize = 0;
  let lastLineFragment = "";
  const start = Date.now();
  while (true) {
    if (!fs.existsSync(logFile)) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (Date.now() - start > timeoutMs) return { terminal: false, timedOut: true };
      continue;
    }
    let stat;
    try { stat = fs.statSync(logFile); } catch { stat = null; }
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
      const events = parseLogEvents(complete);
      let sawTerminal = false;
      for (const ev of events) {
        const line = renderEvent(ev, { reasoning });
        if (line && onLine) onLine(line);
        else if (line) process.stdout.write(line + "\n");
        if (isTerminalEvent(ev)) sawTerminal = true;
      }
      if (sawTerminal) return { terminal: true, timedOut: false };
    }
    if (Date.now() - start > timeoutMs) return { terminal: false, timedOut: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
