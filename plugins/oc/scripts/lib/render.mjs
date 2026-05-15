// Format `opencode run --format json` NDJSON events into a compact, Claude-friendly digest.
//
// The schema we observe (probed against opencode 1.14.x):
//   { type, timestamp, sessionID, part: { type, ... } }
//
// Top-level `type` values observed in practice: step_start, text, tool, tool_use,
// tool_result, reasoning, error. We pass through unknown types without crashing.
//
// Output line shape (default):
//   [HH:MM:SS] <kind>: <one-line summary>

function tsString(ms) {
  if (!ms) return "         ";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function clip(s, max = 120) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  if (str.length <= max) return str;
  if (max <= 3) return str.slice(0, max);
  return str.slice(0, max - 3) + "...";
}

function summarizeJson(value, max = 120) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return clip(value, max);
  try { return clip(JSON.stringify(value), max); } catch { return ""; }
}

// Extract a human-readable error message from any of the shapes opencode emits.
// Examples seen in the wild:
//   { error: { name: "UnknownError", data: { message: "Model not found: ..." } } }
//   { error: "string" }
//   { message: "..." }
function extractErrorMessage(event) {
  if (!event) return "(no detail)";
  const e = event.error;
  if (typeof e === "string" && e) return clip(e, 200);
  if (e && typeof e === "object") {
    if (e.data && typeof e.data.message === "string") return clip(`${e.name ? `${e.name}: ` : ""}${e.data.message}`, 200);
    if (typeof e.message === "string") return clip(e.message, 200);
    if (typeof e.name === "string") return clip(e.name, 200);
    try { return clip(JSON.stringify(e), 200); } catch { /* fall through */ }
  }
  if (typeof event.message === "string" && event.message) return clip(event.message, 200);
  try { return clip(JSON.stringify(event), 200); } catch { return "(unreadable)"; }
}

export function renderEvent(event, { reasoning = false } = {}) {
  if (!event || typeof event !== "object") return null;
  const ts = tsString(event.timestamp);
  const partType = event.part?.type;
  const topType = event.type;

  // Common envelopes.
  if (topType === "step_start" || partType === "step-start") {
    return `[${ts}] step start`;
  }
  if (topType === "step_finish" || partType === "step-finish") {
    return `[${ts}] step finish`;
  }
  if (topType === "session_idle" || topType === "session.idle") {
    return `[${ts}] session idle`;
  }
  if (topType === "session_error" || topType === "session.error") {
    return `[${ts}] session error: ${extractErrorMessage(event)}`;
  }
  if (topType === "error") {
    return `[${ts}] error: ${extractErrorMessage(event)}`;
  }
  if (topType === "stderr") {
    const text = event.text ?? event.message ?? "";
    if (!text) return null;
    return `[${ts}] stderr: ${clip(text, 200)}`;
  }

  if (topType === "text" || partType === "text") {
    const text = event.part?.text ?? event.text ?? "";
    if (!text) return null;
    return `[${ts}] assistant: ${clip(text)}`;
  }

  if (partType === "reasoning" || topType === "reasoning") {
    if (!reasoning) return null;
    const text = event.part?.text ?? event.part?.summary ?? "";
    if (!text) return null;
    return `[${ts}] thinking: ${clip(text)}`;
  }

  if (topType === "tool_use" || partType === "tool-invocation" || partType === "tool_use") {
    const name = event.part?.toolName ?? event.part?.tool ?? event.toolName ?? "tool";
    const args = event.part?.input ?? event.part?.args ?? event.args ?? null;
    return `[${ts}] tool: ${name}(${summarizeJson(args, 96)})`;
  }

  if (topType === "tool_result" || partType === "tool-result") {
    const name = event.part?.toolName ?? event.part?.tool ?? event.toolName ?? "tool";
    const hasError = Boolean(event.part?.error || event.error);
    const explicit = event.part?.status;
    const failed = hasError || (typeof explicit === "string" && /error|fail/i.test(explicit));
    const status = failed ? "error" : (explicit && typeof explicit === "string" ? explicit : "ok");
    return `[${ts}] tool-result: ${name} (${status})`;
  }

  // Unknown event — preserve a brief breadcrumb but stay quiet by default.
  return null;
}

export function shortPrompt(prompt, max = 72) {
  return clip(prompt, max);
}
