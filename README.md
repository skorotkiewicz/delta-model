# Qwen request proxy

A local HTTP service that uses `resources/data-3-0.6b` to prepare requests for a
larger model. It returns JSON containing a short instruction, missing information,
retrieved context, tool results, and ready-to-send `handoff.messages`.
This version stops at the handoff. It does not call a larger model.

## Run

The existing `.venv` has the model dependencies. For a new environment, install
`requirements.txt` first. HTTP, SQLite, and tests use the Python standard library.

```sh
.venv/bin/python serve.py --port 8765
```

The weights load once at startup, entirely from local files. CPU inference uses
two threads and float32 by default. CUDA is selected automatically when available.
Qwen's thinking mode is disabled to keep preparation short, following the
[Qwen quickstart](https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html).

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
last three user requests. If omitted, the server creates a new session and returns
its ID. Only explicitly supplied `memories` become durable facts. Qwen cannot
silently write memories or storage. Reusing a storage key replaces its value.
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
| `preparation.prompt` | Short instruction written by Qwen |
| `preparation.missing_information` | Questions the larger model may need to resolve |
| `handoff.messages` | System and user messages for the future larger-model adapter |
| `tool_calls` | Executed calls and results, labelled `automatic` or `qwen` |
| `memories` | Up to eight retrieved facts for this session |
| `storage` | Available keys and keys saved by this request |
| `warnings` | Parse retries, tool limits, or fallback details |

The handoff preserves the original request verbatim alongside Qwen's preparation,
saved context, and any extra tool results. It keeps the larger model from relying
only on a small model's interpretation.

## Tools and storage

Every request automatically retrieves session memories and relevant text excerpts
from `resources/`. Qwen sees the available storage keys and can request these tools
before producing its instruction:

| Tool | Arguments | Result |
| --- | --- | --- |
| `memory_search` | `{"query":"..."}` | Saved facts from the current session |
| `storage_get` | `{"key":"project"}` | Stored JSON value or `found: false` |
| `resource_search` | `{"query":"..."}` | Text excerpts with relative paths and line numbers |

When storage keys exist, a separate planning step asks Qwen to select tools first.
If Qwen skips storage retrieval, the service retrieves up to three saved values
and asks Qwen to prepare again. This intervention appears in `warnings`.
The tool loop uses explicit JSON decisions, validates names and arguments, executes
the calls, and supplies results to Qwen. It permits two tool rounds and three model
generations total, including retries. Model-selected calls have `source: "qwen"`.
The tools have no shell execution or network access.

Add project notes as `.md`, `.txt`, `.py`, or `.json` files under `resources/`.
Resource search uses word overlap, reads files up to 128 KB, skips hidden paths
and symlinks, excludes model configuration and tokenizer files, and returns up to
four excerpts. Memory search ranks the latest 200
facts by word overlap and returns up to eight. These are simple local retrieval
methods, not embeddings or a guarantee that every relevant fact will be found.

SQLite stores facts, JSON values, original requests, and prepared responses in
`.artifacts/proxy.sqlite3`. `--db` selects a different file. This is a localhost
prototype with no authentication. Session IDs separate data but are not credentials.

Requests are limited to 32 KB. Model input is limited to 4096 tokens and generation
to 256 tokens per turn. Oversized context returns HTTP 413 instead of silently
truncating the request. Competing preparations return HTTP 503 with `Retry-After`.
Invalid input returns JSON with an `error` field. If Qwen's output stays invalid,
the service returns `status: "fallback"` with the original request and context.

## Check

```sh
python -m unittest -v test_serve
```

Tests use a scripted model to check the tool loop, context forwarding, persistence,
session separation, input validation, fallbacks, resource boundaries, and HTTP
responses. Test real model quality separately with the curl requests above.

Other options are listed by `python serve.py --help`, including `--model`,
`--resources`, `--device`, `--threads`, and `--max-new-tokens`.
