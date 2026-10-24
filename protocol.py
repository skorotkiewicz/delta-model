"""Validation and deterministic rendering for the proxy's JSON API."""

import copy
import json
import re
from uuid import uuid4


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def identifier(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value):
        raise RequestError(f"{name} must contain 1 to 80 letters, numbers, _ or -.")
    return value


def text(value, name, limit, allow_empty=False):
    if not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip()):
        raise RequestError(f"{name} must be a string of {'0' if allow_empty else '1'} to {limit} characters.")
    return value


def object_body(value, allowed):
    if not isinstance(value, dict):
        raise RequestError("Body must be a JSON object.")
    extra = value.keys() - set(allowed)
    if extra:
        raise RequestError(f"Unknown fields: {', '.join(sorted(extra))}")
    return value


def strings(value, name, count, length):
    if not isinstance(value, list) or len(value) > count:
        raise RequestError(f"{name} must be a list with at most {count} entries.")
    return [text(item, name, length) for item in value]


def identity(data, create_session=False):
    result = {"session_id": identifier(data.get("session_id", str(uuid4()) if create_session else None), "session_id")}
    for key in ("project_id", "user_id"):
        if key in data:
            result[key] = identifier(data[key], key)
    return result


def project_context(value):
    value = object_body(value, {"files", "errors", "checks", "active_tools"})
    files = value.get("files", [])
    if not isinstance(files, list) or len(files) > 3:
        raise RequestError("context.files must contain at most 3 files.")
    clean = []
    for item in files:
        object_body(item, {"path", "content"})
        path = text(item.get("path"), "file path", 240)
        if path.startswith(("/", "\\")) or any(p in {"..", ""} or p.startswith(".") for p in path.replace("\\", "/").split("/")):
            raise RequestError("File paths must be relative project paths without hidden components.")
        clean.append({"path": path, "content": text(item.get("content"), "file content", 2400, True)})
    checks = value.get("checks", [])
    if not isinstance(checks, list) or len(checks) > 3:
        raise RequestError("context.checks must contain at most 3 checks.")
    parsed_checks = []
    for item in checks:
        object_body(item, {"command", "success", "output"})
        if not isinstance(item.get("success"), bool):
            raise RequestError("check.success must be boolean.")
        parsed_checks.append({"command": text(item.get("command"), "check command", 500),
                              "success": item["success"], "output": text(item.get("output", ""), "check output", 1000, True)})
    return {"files": clean, "errors": strings(value.get("errors", []), "context.errors", 3, 1000),
            "checks": parsed_checks, "active_tools": strings(value.get("active_tools", []), "active_tools", 64, 80)}


def validate_memory(data):
    object_body(data, {"session_id", "project_id", "user_id", "operation", "scope", "key", "fact", "query", "ttl_seconds", "message"})
    result = identity(data)
    operation = data.get("operation", "search")
    if not isinstance(operation, str) or operation not in {"put", "forget", "search", "capture"}:
        raise RequestError("operation must be put, forget, search or capture.")
    scope = data.get("scope", "all" if operation == "search" else "session")
    if not isinstance(scope, str) or (scope not in {"session", "project", "user"} and not (scope == "all" and operation == "search")):
        raise RequestError("scope must be session, project or user; searches also accept all.")
    result.update(operation=operation, scope=scope)
    if operation == "capture":
        result["message"] = text(data.get("message"), "message", 8000)
    if operation in {"put", "forget"}:
        result["key"] = text(data.get("key"), "memory key", 120)
    if operation == "put":
        result["fact"] = text(data.get("fact"), "fact", 1000)
        ttl = data.get("ttl_seconds")
        if ttl is not None and (type(ttl) is not int or not 1 <= ttl <= 31_536_000):
            raise RequestError("ttl_seconds must be between 1 and 31536000.")
        result["ttl_seconds"] = ttl
    if operation == "search":
        result["query"] = text(data.get("query", ""), "query", 1000, True)
    return result


def validate_feedback(data):
    object_body(data, {"session_id", "request_id", "summary", "status", "files", "checks"})
    result = identity(data)
    result["request_id"] = identifier(data.get("request_id"), "request_id")
    status = data.get("status", "completed")
    if not isinstance(status, str) or status not in {"completed", "error", "aborted"}:
        raise RequestError("status must be completed, error or aborted.")
    result.update(status=status, summary=text(data.get("summary", ""), "summary", 4000, True),
                  files=strings(data.get("files", []), "files", 12, 240),
                  checks=project_context({"checks": data.get("checks", [])})["checks"])
    return result


def _covered(fact, prompt):
    # Only omit a copied fact when its phrase is present, preserving word order,
    # negation and numeric boundaries rather than trusting a bag-of-words match.
    normalize = lambda value: " ".join(re.findall(r"\w+", value.casefold()))
    phrase = normalize(fact)
    return bool(phrase) and f" {phrase} " in f" {normalize(prompt)} "


def preparation_messages(model, system, message, context):
    view = copy.deepcopy(context)
    # Provenance remains in the response. Avoid repeating it beside the same facts
    # in the small model's limited input window.
    view.pop("memory_records", None)
    view.pop("observed_facts", None)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": ""}]

    def serialize():
        messages[1]["content"] = json.dumps({"original_request": message, "context": view}, ensure_ascii=False)
    serialize()
    counter = getattr(model, "input_tokens", None)
    if not callable(counter):
        return messages, []
    limit = model.max_input_tokens
    target = limit - min(1024, limit // 3)
    omitted = False
    # Remove low-priority optional context first; never shorten the user message.
    for key in ("project_resources", "resources", "recent_user_requests"):
        while view.get(key) and counter(messages) > target:
            view[key].pop(0 if key == "recent_user_requests" else -1)
            omitted = True
            serialize()
    project = view.get("project_context", {})
    for item in project.get("files", []):
        if counter(messages) > target and len(item["content"]) > 800:
            item["content"] = item["content"][:800] + "\n[excerpt shortened for model input budget]"
            omitted = True
            serialize()
    for values, oldest_first in ((project.get("active_tools", []), False), (project.get("files", []), False),
                                 (project.get("errors", []), True), (project.get("checks", []), True),
                                 (view.get("memories", []), False), (view.get("recent_outcomes", []), True)):
        while values and counter(messages) > target:
            values.pop(0 if oldest_first else -1)
            omitted = True
            serialize()
    return messages, (["Optional context was shortened for Qwen's input budget; full retrieved facts remain in the response and compiled prompt."] if omitted else [])


def render_prompt(brief, original, context, traces):
    """Keep model prose, but never rely on it to copy constraints or questions."""
    sections = [brief["prompt"].strip()]
    def constraints_in(value):
        return [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+|\n+|;\s*", value)
                if re.search(r"\b(?:avoid|never|must|only|without|budget|under|at most|do not|don't|keep|preserve|single|one|no|not|prefer)\b|\d|[\w-]+\.(?:py|tsx?|jsx?|rs|go|sql|toml|json)\b|[\w.-]+/[\w./-]+", sentence, re.I)]
    constraints = constraints_in(original)
    constraints = [item for item in constraints if item and not _covered(item, sections[0])]
    if constraints:
        sections.append("Required user constraints, taking precedence over the rewrite:\n" + "\n".join(f"- {item}" for item in constraints))
    facts = list(context.get("memories", []))
    facts.extend(item["fact"] for item in context.get("observed_facts", []))
    for trace in traces:
        result = trace.get("result")
        if isinstance(result, dict) and result.get("found"):
            def flatten(value, prefix):
                if isinstance(value, dict):
                    for key, child in value.items():
                        yield from flatten(child, f"{prefix}.{key}")
                elif isinstance(value, (str, int, float, bool)):
                    yield f"{prefix}: {value}"
            facts.extend(list(flatten(result.get("value"), result.get("key", "storage")))[:12])
    facts = list(dict.fromkeys(fact for fact in facts if not _covered(fact, "\n".join(sections))))
    if facts:
        sections.append("Relevant saved or observed facts:\n" + "\n".join(f"- {fact}" for fact in facts[:12]))
    files = context.get("project_context", {}).get("files", [])
    if files:
        sections.append("Active project files: " + ", ".join(item["path"] for item in files))
    errors = context.get("project_context", {}).get("errors", [])
    if errors:
        sections.append("Recent tool errors:\n" + "\n".join(errors[-2:]))
    checks = context.get("project_context", {}).get("checks", [])
    if checks:
        sections.append("Recent observed command results:\n" + "\n".join(
            f"- {'Succeeded' if check['success'] else 'Failed'}: {check['command']}" for check in checks))
    outcomes = context.get("recent_outcomes", [])
    followup = bool(re.search(r"\b(?:that|same|previous|earlier|above|continue|adapt|again|it)\b", original, re.I))
    if followup:
        earlier = list(dict.fromkeys(sentence for prior in context.get("recent_user_requests", [])
                                     for sentence in constraints_in(prior) if sentence and not _covered(sentence, "\n".join(sections))))
        if earlier:
            sections.append("Earlier user constraints for this follow-up; the current request takes precedence:\n" +
                            "\n".join(f"- {sentence}" for sentence in earlier))
    if outcomes and followup:
        outcome = outcomes[-1]
        if outcome.get("assistant_excerpt"):
            sections.append(f"Previous response excerpt for this follow-up, status {outcome['status']}. "
                            "This is conversational context, not verified evidence:\n" + outcome["assistant_excerpt"])
    questions = list(dict.fromkeys(question.strip() for question in brief["missing_information"] if question.strip()))
    if questions:
        sections.append("Resolve these gaps using available tools and context; ask the user if still essential:\n" +
                        "\n".join(f"- {question}" for question in questions))
    return {"prompt": "\n\n".join(sections), "missing_information": questions}
