# Qwen request proxy

A local HTTP service that uses `resources/data-3-0.6b` to prepare requests for a
larger model. It returns JSON containing a short instruction, missing information,
retrieved context, tool results, and ready-to-send `handoff.messages`.
This version stops at the handoff. It does not call a larger model.

The [Pi extension](pi-extension/README.md) sends only `preparation.prompt` to Pi's
selected model. The server combines Qwen's draft with explicit constraints,
saved facts, recent errors and clarification questions. Load the
extension with `pi -e ./pi-extension/index.ts` after starting the server.

## Run

Use Python 3.11 or newer with SQLite FTS5 support. On a fresh clone:

```sh
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python download_model.py
.venv/bin/python serve.py --port 8765
```

The downloader fetches the [Qwen3-0.6B model](https://huggingface.co/Qwen/Qwen3-0.6B)

```sh
# Optional: select a destination or pin a model revision.
.venv/bin/python download_model.py --output /path/to/qwen --revision COMMIT_HASH
.venv/bin/python serve.py --model /path/to/qwen --port 8765
```

The weights load once at startup, entirely from local files. CPU inference uses
two threads and float32 by default. CUDA is selected automatically when available.
Qwen's thinking mode is enabled by default. Use `--thinking off` to disable it:

```sh
.venv/bin/python serve.py --port 8765 --thinking off
```

Use `--thinking on` to enable it explicitly. When enabled, each model turn has up to 1024 thinking tokens,
followed by a separate budget for the final JSON. `--thinking-budget` adjusts this
limit. The service closes the thinking phase when the budget is reached, following
the [Qwen thinking budget example](https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html#thinking-budget).
Thinking uses sampling at temperature 0.6, top-p 0.95, and top-k 20.
Only final JSON enters tool history and HTTP responses. `/health` reports the
thinking setting and budget. CPU requests take longer with thinking enabled.

```sh
curl --silent http://127.0.0.1:8765/health

curl --max-time 300 --silent --show-error \
  http://127.0.0.1:8765/prepare \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id": "demo",
    "message": "Prepare a deployment plan for my project. Read the saved project details first. Keep the plan under 200 words.",
    "memories": ["I prefer Python and simple deployments."],
    "storage": {
      "project": {"name": "Atlas", "database": "PostgreSQL", "budget_eur_month": 50}
    }
  }'
```

Reuse `session_id` on later requests to access saved facts, JSON values, and the
last three user requests and recent answer excerpts. If omitted, the server creates
a new session and returns its ID. Explicit `memories` are saved for that session.
User preferences and observed project facts can also be saved automatically, as
described below. Qwen's model output does not become durable facts. Reusing a storage
key replaces its value.
Context is saved before generation, including when generation later fails.

```sh
curl --max-time 300 --silent --show-error \
  http://127.0.0.1:8765/prepare \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","message":"Adapt that plan for a single server. Read the project details."}'
```

## JSON response

The main fields are:

| Field | Meaning |
| --- | --- |
| `status` | `prepared`, or `fallback` if Qwen could not produce a valid preparation |
| `preparation.prompt` | Plain-text prompt assembled from Qwen's draft, constraints, facts and questions |
| `draft_prompt` | Qwen's original draft before deterministic assembly |
| `preparation.missing_information` | Questions the larger model may need to resolve |
| `handoff.messages` | System and user messages for the future larger-model adapter |
| `tool_calls` | Executed calls and results, labelled `automatic` or `qwen` |
| `memories` | Up to eight retrieved session, project and user facts |
| `storage` | Available keys and keys saved by this request |
| `warnings` | Parse retries, tool limits, or fallback details |

The JSON handoff preserves the original request, full context and tool results for
inspection. Pi sends only `preparation.prompt` to its model. The compiler preserves
matching explicit constraints such as amounts, paths, negation and single-server
requirements, appends retrieved facts and embeds nonempty `missing_information`
questions as plain text. Follow-ups such as "adapt that plan" include the last
answer excerpt and earlier user constraints, with the current request taking
precedence. Answer excerpts are labelled conversational context rather than
verified evidence.

## Tools and storage

Every request automatically retrieves session memories and relevant text excerpts
from `resources/`. Qwen sees the available storage keys and can request these tools
before producing its instruction:

| Tool | Arguments | Result |
| --- | --- | --- |
| `memory_search` | `{"query":"..."}` | Visible session, project and user facts |
| `storage_get` | `{"key":"project"}` | Stored JSON value or `found: false` |
| `resource_search` | `{"query":"..."}` | Text excerpts with relative paths and line numbers |
| `project_search` | `{"query":"..."}` | Indexed file excerpts sent by Pi for this project |

When storage keys exist, a separate planning step asks Qwen to select tools first.
If Qwen skips storage retrieval, the service retrieves up to three saved values
and asks Qwen to prepare again. This intervention appears in `warnings`.
The tool loop uses explicit JSON decisions, validates names and arguments, executes
the calls, and supplies results to Qwen. It permits two tool rounds and three model
generations total, including retries. Model-selected calls have `source: "qwen"`.
The tools have no shell execution or network access.

Add project notes as `.md`, `.txt`, `.py`, or `.json` files under `resources/`.
Resource search uses SQLite FTS5, reads files up to 128 KB, skips hidden paths
and symlinks, excludes model configuration and tokenizer files, and returns up to
four excerpts. Files are reindexed when changed and removed from the index when
deleted. Memory retrieval uses FTS5 ranking and fills remaining slots with recent
facts, prioritizing preferences. It returns up to eight records. Project search
only covers excerpts actually supplied by Pi. FTS5 is lexical search, not embeddings.

## Scoped memory and project context

`POST /prepare` also accepts `project_id`, `user_id` and `context`. Session facts
remain private to that session. Project facts are shared between sessions with
the same `project_id`; user preferences follow `user_id` across projects. A session
cannot be rebound to different nonempty project or user IDs.

The optional `context` contains up to three `{path, content}` file excerpts,
three error strings, three `{command, success, output}` check observations and
64 active tool names. Paths are relative to the client project. Pi supplies these
within documented size limits. The server indexes file excerpts by project.

By default, `/prepare` saves explicit statements beginning "I prefer", "I always",
"I never" or "Remember that" from the first prose line. Fenced/inline code and
quoted lines are excluded from extraction. Preferences use user scope when a `user_id` exists;
"Remember" statements use session scope. These rules do not infer preferences
from general requests or from model answers. Auto-extracted statements use content
keys; use a named key through `/memory` to replace a preference deliberately.
Pi captures preferences from its raw `input` event through `/memory` with
`operation: "capture"` before skill/template expansion. It then sends
`learn_preferences: false` on `/prepare`, preventing expanded repository text from
being treated as a user's stated preference. Other clients can use the same flag.
Raw JSON `storage` values remain session-scoped.

The server also records literal manifest observations from `package.json`,
`pyproject.toml` and `requirements.txt`, with a file source and seven-day expiry.
Observed command results from feedback expire after one day. Every fact has a
key, scope, source, creation/update time and optional expiry.

Manage facts without running Qwen through `POST /memory`:

```sh
curl --silent http://127.0.0.1:8765/memory \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","project_id":"atlas","user_id":"me","operation":"put","scope":"project","key":"database","fact":"Use SQLite.","ttl_seconds":604800}'

curl --silent http://127.0.0.1:8765/memory \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","operation":"search","scope":"all","query":"SQLite"}'

curl --silent http://127.0.0.1:8765/memory \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","operation":"forget","scope":"project","key":"database"}'
```

`put` replaces the same scope/key. `forget` removes it from retrieval. `search`
supports `session`, `project`, `user` or `all`. Legacy session facts are migrated
once, preserving the original table. Restarting does not restore forgotten facts.
Back up the SQLite file before upgrading an existing installation.

## Outcome feedback

Pi sends `POST /feedback` after answering, or before preparing a queued follow-up:

```json
{
  "session_id": "demo",
  "request_id": "REQUEST_ID_FROM_PREPARE",
  "summary": "The answer proposed a single-server deployment with nightly backups.",
  "status": "completed",
  "files": ["deploy.py"],
  "checks": [{"command":"python -m unittest","success":true,"output":"OK"}]
}
```

The summary is a bounded assistant excerpt, not a new model-generated summary.
It remains session dialogue, explicitly labelled unverified, and is never promoted
to durable facts. Actual tool outcomes are recorded separately with a tool source.
The request must belong to the session. Identical repeats are idempotent; changed
payloads for an already recorded request return 409. `error` and `aborted` statuses
are supported. The final answer reaches the user before this feedback step; there
is no second Qwen inference pass.

SQLite stores facts, JSON values, original requests, and prepared responses in
`.artifacts/proxy.sqlite3`. `--db` selects a different file. This is a localhost
prototype with no authentication. Scope IDs separate data but are not credentials;
source labels record provenance, not authenticated proof of caller identity.

Requests are limited to 32 KB. Model input is limited to 4096 tokens. Each model
turn has up to 1024 thinking tokens plus 256 final output tokens by default.
Optional context is reduced, with a warning, when it exceeds Qwen's input budget;
the original message is never shortened. Full context remains in the debug handoff.
An original message or later tool conversation exceeding the budget still returns
HTTP 413. Competing preparations return HTTP 503 with `Retry-After`.
Invalid input returns JSON with an `error` field. If Qwen's output stays invalid,
the service returns `status: "fallback"` with the original request and context.

## Check

```sh
python -m unittest -v test_serve test_infrastructure
```

Tests use a scripted model to check the tool loop, context forwarding, persistence,
session separation, input validation, fallbacks, resource boundaries, and HTTP
responses. Test real model quality separately with the curl requests above.
SQLite must have FTS5 enabled. `protocol.py` contains validation and prompt
assembly; `knowledge.py` contains scoped memory, indexes and feedback persistence.

Other options are listed by `python serve.py --help`, including `--model`,
`--resources`, `--device`, `--threads`, `--max-new-tokens`, `--thinking`, and `--thinking-budget`.
