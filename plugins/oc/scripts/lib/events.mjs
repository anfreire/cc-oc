/**
 * Error payload shape. Opencode emits any of these variants depending on
 * the failure path.
 *
 * @typedef {string | {
 *   name?: string,
 *   message?: string,
 *   data?: { message?: string }
 * }} OpenCodeError
 */

/**
 * Beginning of a model step.
 *
 * @typedef {object} StepStartEvent
 * @property {"step_start"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {object} part
 * @property {"step-start"} part.type
 * @property {string} part.id
 * @property {string} part.messageID
 * @property {string} part.sessionID
 * @property {string} [part.snapshot]
 */

/**
 * End of a model step. Carries token usage + cost for the step.
 *
 * @typedef {object} StepFinishEvent
 * @property {"step_finish"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {object} part
 * @property {"step-finish"} part.type
 * @property {string} part.id
 * @property {string} part.messageID
 * @property {string} part.sessionID
 * @property {string} part.reason
 * @property {string} [part.snapshot]
 * @property {{
 *   total: number,
 *   input: number,
 *   output: number,
 *   reasoning: number,
 *   cache: { write: number, read: number }
 * }} [part.tokens]
 * @property {number} [part.cost]
 */

/**
 * Assistant text chunk. The actual text lives in `part.text`.
 *
 * @typedef {object} TextEvent
 * @property {"text"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {object} part
 * @property {"text"} part.type
 * @property {string} part.text
 * @property {string} part.id
 * @property {string} part.messageID
 * @property {string} part.sessionID
 * @property {{ start: number, end: number }} [part.time]
 */

/**
 * Tool call from the model. Tool-specific `input` lives under `part.state.input`;
 * the result (if completed) lives under `part.state.output`. Failures land in
 * `part.state.error` with `part.state.status === "error"`.
 *
 * @typedef {object} ToolUseEvent
 * @property {"tool_use"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {object} part
 * @property {"tool"} part.type
 * @property {string} part.tool
 * @property {string} part.callID
 * @property {string} part.id
 * @property {string} part.messageID
 * @property {string} part.sessionID
 * @property {{
 *   status: "completed" | "error" | string,
 *   input: Record<string, unknown>,
 *   output?: string,
 *   error?: string,
 *   time?: { start: number, end: number }
 * }} part.state
 */

/**
 * Reasoning / thinking text. Only emitted when `--thinking` was passed to
 * `/oc:spawn`.
 *
 * @typedef {object} ReasoningEvent
 * @property {"reasoning"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {object} part
 * @property {"reasoning"} part.type
 * @property {string} [part.text]
 * @property {string} [part.summary]
 */

/**
 * Session ended cleanly (model returned its final answer with no further
 * steps queued).
 *
 * @typedef {object} SessionIdleEvent
 * @property {"session_idle" | "session.idle"} type
 * @property {number} timestamp
 * @property {string} sessionID
 */

/**
 * Session ended in error. Opencode's `error` field carries the root cause
 * (typically a model / provider / auth failure).
 *
 * @typedef {object} SessionErrorEvent
 * @property {"session_error" | "session.error"} type
 * @property {number} timestamp
 * @property {string} sessionID
 * @property {OpenCodeError} error
 */

/**
 * Generic error event. Emitted for failures that aren't tied to a specific
 * session lifecycle stage. `sessionID` may be absent if the failure happened
 * before the session was created.
 *
 * @typedef {object} ErrorEvent
 * @property {"error"} type
 * @property {number} timestamp
 * @property {string} [sessionID]
 * @property {OpenCodeError} error
 */

/**
 * cc-oc's synthetic event for unparseable log lines. Not emitted by opencode
 * itself — `parseAll` produces one whenever `JSON.parse` throws on a line,
 * treating the raw text as bare stderr from opencode's process.
 *
 * @typedef {object} StderrEvent
 * @property {"stderr"} type
 * @property {string} text
 */

/**
 * Discriminated union of every event kind that can appear in a session log:
 * the eight `OpenCode*` events opencode emits, plus cc-oc's synthesised
 * `StderrEvent`.
 *
 * @typedef {StepStartEvent
 *   | StepFinishEvent
 *   | TextEvent
 *   | ToolUseEvent
 *   | ReasoningEvent
 *   | SessionIdleEvent
 *   | SessionErrorEvent
 *   | ErrorEvent
 *   | StderrEvent
 * } OpenCodeEvent
 */

/**
 * Returns true if the event reports an error. Whether it *fails* the session
 * is decided by what follows: `readLogState` counts an error only when no
 * model work comes after it (opencode recovers transient errors itself, e.g.
 * by retrying on a fallback model). Session end is detected by the opencode
 * process dying, not by events.
 *
 * @param {OpenCodeEvent | null | undefined} event
 * @returns {boolean}
 */
export function isErrorEvent(event) {
  if (!event) return false;

  return ["session_error", "session.error", "error"].includes(event.type);
}
