# Pi extension for the Qwen proxy

This extension sends each user prompt to the Qwen proxy, then sends only
`preparation.prompt` to Pi's selected model. Qwen's prompt includes the relevant
facts gathered through tools and memory. The server also appends clarification
questions and preserves matching explicit constraints in plain text. Pi calls its
model and returns the final answer through its normal interface.

```text
User prompt → Qwen ↔ tools/memory → improved prompt → Pi's selected model → User
```

The Python service still returns JSON handoffs. The extension connects those
handoffs to a model through Pi. There is one Qwen preparation per submitted
prompt, with its internal tool rounds handled by the proxy. Pi's later model/tool
turns do not call Qwen again. There is no Qwen pass after Pi's model answers.
After the answer, Pi sends a bounded outcome excerpt and observed checks back to
the proxy for future requests. This feedback does not run another Qwen generation.

## Use

First follow the [proxy setup instructions](../README.md#run) to clone the
repository, install Python dependencies and download the model. You also need
Node.js 22.19 or newer and [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
installed and configured with a model provider.

Start the proxy in one terminal, from the cloned repository's root:

```sh
.venv/bin/python serve.py --port 8765
```

In a second terminal, also from the repository root, start Pi with the extension:

```sh
pi -e ./pi-extension/index.ts
```

Use your usual Pi model selection and login. The extension does not need or manage
your model API keys. You can also load the package directory:

```sh
pi -e ./pi-extension
```

To use it in another project, Pi needs the path to your own clone. Start in the
cloned repository's root and save its absolute path before changing directories.
Replace `/path/to/your/project` below with the project you want Pi to work on:

```sh
QWEN_PROXY_REPO="$(pwd -P)"
cd /path/to/your/project
pi -e "$QWEN_PROXY_REPO/pi-extension/index.ts"
```

To keep the extension enabled in that project, run this from the same terminal,
in your project's directory, after exiting Pi:

```sh
pi install -l "$QWEN_PROXY_REPO/pi-extension"
pi
```

The `-l` flag saves the package in that project's Pi settings. Keep the clone at
the same location while using this installation. Runtime dependencies come from
Node and Pi; no npm install is needed in `pi-extension/`.
The extension was checked with Pi 1.4.0 and Node 24.

## Controls

| Command | Effect |
| --- | --- |
| `/qwen` or `/qwen status` | Show enablement, endpoint and proxy session ID |
| `/qwen off` | Send subsequent prompts directly to Pi's model |
| `/qwen on` | Resume Qwen preparation |
| `/qwen last` | Show the last full JSON response for debugging, including after `/qwen off` |
| `/qwen memories [scope] [query]` | List/search visible facts; scope defaults to `all` |
| `/qwen remember <scope> <key> <fact>` | Save or replace an explicit fact without running Qwen |
| `/qwen forget <scope> <key>` | Remove a saved fact |

Scopes are `session`, `project` and `user`. For example:

```text
/qwen remember user deployment Avoid Docker.
/qwen remember project database Use SQLite.
/qwen memories project SQLite
/qwen forget project database
```

The footer shows preparation progress. Your original text stays in Pi's transcript.
The extension records the improved prompt and full response in a hidden session
message, then projects only the improved prompt into the user message sent to the
model. This also works on later tool turns and when resuming a saved session.
Hidden proxy messages and legacy JSON handoffs are removed from provider requests.
Pi's system instructions, attachments and tools are preserved.

The model does not receive separate memories, tool traces, status, warnings, or
`missing_information` JSON. The server renders facts and clarification questions
directly into `preparation.prompt`. `/qwen last` shows
the full JSON in a widget; non-interactive diagnostics go to stderr. Qwen sees
prompt text, while image attachments go directly to Pi's model.

Qwen writes the draft. The server adds retrieved facts, explicit constraints,
observed errors/checks, and clarification questions even when Qwen omits them.
Use `/qwen last` to compare `draft_prompt`, `preparation.prompt` and full context.

## Project context and feedback

The extension sends at most three text excerpts per preparation. It chooses files
mentioned in the prompt, recent files accessed by `read`/`write`/`edit`, then project
manifests. Each excerpt is at most 1800 characters from the first 8 KB of a file,
with lines selected by prompt word overlap. Files over 64 KB, hidden paths,
symlinks, build/dependency directories and paths outside the project are skipped.
It also sends the latest three tool errors/checks and up to 64 active tool names.
Optional file excerpts are dropped first if the HTTP body would exceed 32 KB.

Tool observations are collected from Pi's actual execution events. After an answer
settles, the extension sends up to 4000 characters of its text, paths read/changed,
and command check results to `/feedback`. It also flushes a completed answer before
preparing a queued follow-up. Thinking blocks are excluded. Answer excerpts are
unverified session history; they do not become durable project facts. Feedback
failures show a warning and do not replace the answer. `/qwen off` stops both new
preparations and feedback requests.

Explicit preferences on the first prose line of raw user input are captured
through `/memory` before skill/template expansion. The expanded prompt is sent
with `learn_preferences: false`, so text quoted from repository files is not
automatically learned as a user preference. Fenced/inline code and quoted lines
are excluded. Use `/qwen remember` for preferences expressed in other forms.

## Configuration

The extension reads an optional `.env` beside its `index.ts`. From the repository
root, copy the example and edit the URL to point to your proxy:

```sh
cp pi-extension/.env.example pi-extension/.env
```

If you installed a copy in Pi's extensions directory, create or edit `.env` in
that installed extension directory instead. The file is read when the extension
loads; restart Pi or run `/reload` after changing it. The current project's `.env`
is not loaded. Only `QWEN_PROXY_*` settings are used, without changing the process
environment.

Configuration precedence is CLI flags, exported environment variables, extension
`.env`, then defaults. These settings can be exported or placed in `.env`:

| Environment variable | Default |
| --- | --- |
| `QWEN_PROXY_URL` | `http://127.0.0.1:8765/prepare` |
| `QWEN_PROXY_TIMEOUT_MS` | `300000` |
| `QWEN_PROXY_ENABLED` | Enabled; set `0` to start disabled |
| `QWEN_PROXY_PROJECT_ID` | Hash of the absolute working directory |
| `QWEN_PROXY_USER_ID` | Hash of hostname and OS username |
| `QWEN_PROXY_CONTEXT` | Enabled; set `0` to omit optional project context from preparation |

The flags `--qwen-proxy-url` and `--qwen-proxy-timeout` override their corresponding
environment variables. This example runs from the cloned repository's root:

```sh
pi -e ./pi-extension/index.ts --qwen-proxy-timeout 600000
# or
QWEN_PROXY_URL=http://192.168.0.124:8765/prepare pi -e ./pi-extension/index.ts
```

For a proxy on another machine, set `QWEN_PROXY_URL` to its complete `/prepare`
URL using that machine's hostname or IP address.

The endpoint is the complete `/prepare` URL. Each Pi session gets a proxy session ID
derived from its working directory and session ID. Resuming the same session reuses
its session memory; `/new` and forks use separate session IDs. Project facts remain
shared across sessions with the same project ID, and preferences follow the user
ID across projects. Set explicit IDs to share a project or user across machines or
different checkout paths. `/qwen status` shows all three IDs. Memory remains session-wide
when navigating branches within a session, matching the proxy's storage model.
`/qwen status` prints the ID if you want to seed memories or storage through the
existing curl API. Explicit preferences and literal manifest observations are saved
by the server; model output is never promoted automatically to durable facts.

If the proxy is down, times out, rejects a large prompt or returns invalid JSON,
Pi receives the original prompt and a warning is shown. The extension does not
retry automatically. For a server fallback, its `preparation.prompt` is used and a
warning is shown. Cancelling Pi or changing sessions aborts the extension's HTTP wait;
the Python server may finish inference already in progress.

## Checks and research

Run these checks from the repository root with Node.js 22.19 or newer:

```sh
node --test pi-extension/test/*.test.ts
```

Tests cover HTTP calls, prompt replacement, images, repeated prompts, command
toggles, scoped memory commands, project excerpt selection, outcome feedback,
queued follow-ups, input/response limits, timeouts, and cancellation.
If Pi is installed, a CLI test runs against local mock proxy and model endpoints,
checking that only the improved prompt reaches the model alongside Pi's `read`
tool. It also checks that the original prompt and JSON stay in the session log.
It makes no external model calls and uses an isolated Pi configuration directory.
An additional full-stack test starts the actual Python service with a scripted
Qwen model, then verifies preference retrieval, plain-text question rendering,
Pi's model request, feedback persistence, and answer recall on the next request.

To test the installed Pi CLI with real Qwen and a local mock main model:

```sh
QWEN_PROXY_LIVE_URL=http://127.0.0.1:8765/prepare \
  node --test pi-extension/test/pi.test.ts
```

The implementation uses `before_agent_start` to prepare prompts after expansion,
`context` to project the rewritten user text and omit proxy metadata, and session
lifecycle hooks for cleanup. References used were the installed Pi 1.4.0 docs and
examples, plus the upstream [extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[event types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts),
and [package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
