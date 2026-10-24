# Pi extension for the Qwen proxy

This extension sends each user prompt to the Qwen proxy, then sends only
`preparation.prompt` to Pi's selected model. Qwen's prompt includes the relevant
facts it gathered through tools and memory. Pi calls its model and returns the
final answer through its normal interface.

```text
User prompt → Qwen ↔ tools/memory → improved prompt → Pi's selected model → User
```

The Python service still returns JSON handoffs. The extension connects those
handoffs to a model through Pi. There is one Qwen preparation per submitted
prompt, with its internal tool rounds handled by the proxy. Pi's later model/tool
turns do not call Qwen again. There is no Qwen pass after Pi's model answers.

## Use

Start the proxy in one terminal:

```sh
.venv/bin/python serve.py --port 8765
```

From the repository root, start Pi with the extension:

```sh
pi -e ./pi-extension/index.ts
```

Use your usual Pi model selection and login. The extension does not need or manage
your model API keys. You can also load the package directory:

```sh
pi -e ./pi-extension
```

To use it from another project, supply the absolute path:

```sh
pi -e /home/mod/Dev/proofs/delta-model/pi-extension/index.ts
```

For a persistent installation in a chosen project, run `pi install -l` with that
absolute package-directory path. No Pi settings are changed by this repository
automatically. Runtime dependencies come from Node and Pi; no npm install is needed.
The extension was checked with Pi 1.4.0 and Node 24.

## Controls

| Command | Effect |
| --- | --- |
| `/qwen` or `/qwen status` | Show enablement, endpoint and proxy session ID |
| `/qwen off` | Send subsequent prompts directly to Pi's model |
| `/qwen on` | Resume Qwen preparation |
| `/qwen last` | Show the last full JSON response for debugging, including after `/qwen off` |

The footer shows preparation progress. Your original text stays in Pi's transcript.
The extension records the improved prompt and full response in a hidden session
message, then projects only the improved prompt into the user message sent to the
model. This also works on later tool turns and when resuming a saved session.
Hidden proxy messages and legacy JSON handoffs are removed from provider requests.
Pi's system instructions, attachments and tools are preserved.

The model does not receive separate memories, tool traces, status, warnings, or
`missing_information` JSON. Qwen is instructed to put relevant facts and necessary
clarification instructions directly into the improved prompt. `/qwen last` shows
the full JSON in a widget; non-interactive diagnostics go to stderr. Qwen sees
prompt text, while image attachments go directly to Pi's model.

Fact selection is performed by Qwen. A detail omitted from its rewrite will not
reach Pi's model through a separate context payload. Use `/qwen last` to compare
the prepared prompt with the retrieved facts.

## Configuration

| Environment variable | Default |
| --- | --- |
| `QWEN_PROXY_URL` | `http://127.0.0.1:8765/prepare` |
| `QWEN_PROXY_TIMEOUT_MS` | `300000` |
| `QWEN_PROXY_ENABLED` | Enabled; set `0` to start disabled |

The flags `--qwen-proxy-url` and `--qwen-proxy-timeout` override their corresponding
environment variables:

```sh
pi -e ./pi-extension/index.ts --qwen-proxy-timeout 600000
```

The endpoint is the complete `/prepare` URL. Each Pi session gets a proxy session ID
derived from its working directory and session ID. Resuming the same session reuses
its proxy memory; `/new` and forks use separate IDs. Memory remains session-wide
when navigating branches within a session, matching the proxy's storage model.
`/qwen status` prints the ID if you want to seed memories or storage through the
existing curl API. The extension does not automatically turn model output into
durable memories or upload repository files.

If the proxy is down, times out, rejects a large prompt or returns invalid JSON,
Pi receives the original prompt and a warning is shown. The extension does not
retry automatically. For a server fallback, its `preparation.prompt` is used and a
warning is shown. Cancelling Pi or changing sessions aborts the extension's HTTP wait;
the Python server may finish inference already in progress.

## Checks and research

```sh
node --test pi-extension/test/*.test.ts
```

Tests cover HTTP calls, prompt replacement, images, repeated prompts, command
toggles, session separation, input/response limits, timeouts, and cancellation.
If Pi is installed, a CLI test runs against local mock proxy and model endpoints,
checking that only the improved prompt reaches the model alongside Pi's `read`
tool. It also checks that the original prompt and JSON stay in the session log.
It makes no external model calls and uses an isolated Pi configuration directory.

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
