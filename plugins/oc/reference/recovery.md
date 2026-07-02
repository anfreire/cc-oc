# Recovery

Read this when `/oc:spawn` fails to start, or when a session is `running` but silent. cc-oc surfaces opencode's errors verbatim and does not retry — recovery is helping the user pick the right next spawn.

## Recovery is the user's call

Never switch models, re-spawn, resume, fork, or cancel on your own (unless the user already told you to). When a spawn fails or a session stalls: run the read-only diagnostics below to understand what happened, evaluate every reasonable option, then put them to the user as an `AskUserQuestion` prompt — the single-select TUI picker — and act only on their choice. The read-only diagnostics themselves (`opencode models`, `opencode agent list`, grepping opencode's log) need no prompt.

## Decode a startup error

The `error:` line in a "failed to start" is opencode's, not cc-oc's. Match on the gist, not the exact words — opencode forwards each provider's error verbatim, so the wording differs (e.g. OpenAI `insufficient_quota`, Anthropic `credit balance … too low`).

**`Model not found` / `Did you mean: …`** — bad `--model` id.
- the ids opencode suggests after `Did you mean:`, or the closest matches from `opencode models`

**`Insufficient balance` / billing / quota (401)** — out of credit on that provider; waiting won't help.
- a comparable model on a provider that has credit
- top up the provider that failed, then resume
- cancel the spawn

**auth / unauthorized** — opencode has no valid credential for that provider.
- `opencode auth login` for that provider (interactive — the user runs it)
- a comparable model on a provider they're already authed for

## Find a valid model

```bash
opencode models            # every provider/model id you can pass to --model
opencode models anthropic  # filter to one provider
opencode models --refresh  # re-pull the registry from models.dev if an expected id is missing
```

Pass the id exactly as listed: `--model provider/model`. With no `--model`, opencode uses the default from its own config (`~/.config/opencode/opencode.json` or the workspace `.opencode/`).

### Variants

If the user requested a specific `--variant`, ensure you map it to a valid equivalent **when suggesting alternative models**. Unknown variants fail silently instead of erroring, so never guess. Extract valid variants (`N/A` if none):

```bash
opencode models <provider> --verbose | awk '/^[a-z]/{id=$0;v="";next} /"variants": *\{ *\}/{print id": N/A";next} /"variants": *\{$/{f=1;v="";next} f&&/^    "/{k=$0;gsub(/[" :{]/,"",k);v=v (v?", ":"") k;next} f&&/^  \}/{print id": " (v?v:"N/A");f=0}'
```

## Find a valid agent

```bash
opencode agent list        # agent names you can pass to --agent
```

A wrong `--agent` doesn't error either — opencode warns (`! agent "x" not found. Falling back to default agent`) and runs on the *default* agent, so the session succeeds as something you didn't ask for. The warning shows up in `/oc:debug`; check the name here if you expected a custom agent.

## Usage limit — the silent stall

The one failure cc-oc **cannot** see. When the provider returns `429` `usage_limit_reached` (`isRetryable: true`), opencode swallows it and retries internally with exponential backoff (~3s → 256s) until the quota window resets. Nothing is written to the cc-oc event stream, so:

- `/oc:sessions` shows `running` with an `activity` gap that keeps growing.
- `/oc:debug` shows `status: running` with a stale `activity`, and the trace ends without an error.
- There is **no** `error` event and **no** `done` — the session is alive, just waiting.

Confirm it's a usage limit (not a slow tool):

```bash
# opencode's own log — grep the latest for the session id or the marker
log=$(ls -t ~/.local/share/opencode/log/*.log | head -1)
grep -E 'usage_limit_reached|"statusCode":429' "$log"
```

Options to offer (never auto-cancel — work's still queued):

1. **Wait.** It usually self-resumes when the window resets (observed: an ~18 min gap, then the same session continued and finished).
2. **Resume on another model/provider** — the *same* session continued on a model that isn't limited:
   ```
   /oc:spawn --session <id> --model <other-provider/model>
   ```
   (`opencode run --session` continues that session; `--model` changes the model.)
3. **Drop it** if it's no longer wanted: `/oc:cancel <id>`.
