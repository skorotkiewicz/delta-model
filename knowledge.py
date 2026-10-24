"""Scoped facts, FTS5 retrieval and outcome history. No model dependencies."""

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import tomllib

from protocol import RequestError


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fact_key(value):
    return hashlib.sha256(value.casefold().strip().encode()).hexdigest()[:24]


def search_query(value):
    stop = {"the", "and", "for", "with", "this", "that", "please", "from", "what", "how", "can", "you", "read", "saved", "details"}
    terms = [term for term in re.findall(r"\w{3,}", value.casefold()) if term not in stop]
    return " OR ".join(f'"{term}"' for term in dict.fromkeys(terms[:40]))


class KnowledgeStore:
    """Mixin using Store.connect so legacy storage and requests stay compatible."""

    def init_knowledge(self):
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS identities(session TEXT PRIMARY KEY, project_id TEXT, user_id TEXT);
                CREATE TABLE IF NOT EXISTS facts(
                    scope TEXT, owner TEXT, key TEXT, fact TEXT, source TEXT, kind TEXT,
                    created_at TEXT, updated_at TEXT, expires_at TEXT,
                    UNIQUE(scope, owner, key));
                CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(fact, content='facts', content_rowid='rowid');
                CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
                    INSERT INTO facts_fts(rowid,fact) VALUES(new.rowid,new.fact); END;
                CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
                    INSERT INTO facts_fts(facts_fts,rowid,fact) VALUES('delete',old.rowid,old.fact); END;
                CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
                    INSERT INTO facts_fts(facts_fts,rowid,fact) VALUES('delete',old.rowid,old.fact);
                    INSERT INTO facts_fts(rowid,fact) VALUES(new.rowid,new.fact); END;
                CREATE TABLE IF NOT EXISTS documents(
                    collection TEXT, path TEXT, body TEXT, stamp TEXT, UNIQUE(collection,path));
                CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(body, content='documents', content_rowid='rowid');
                CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
                    INSERT INTO documents_fts(rowid,body) VALUES(new.rowid,new.body); END;
                CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
                    INSERT INTO documents_fts(documents_fts,rowid,body) VALUES('delete',old.rowid,old.body); END;
                CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
                    INSERT INTO documents_fts(documents_fts,rowid,body) VALUES('delete',old.rowid,old.body);
                    INSERT INTO documents_fts(rowid,body) VALUES(new.rowid,new.body); END;
                CREATE TABLE IF NOT EXISTS feedback(
                    request_id TEXT PRIMARY KEY, session TEXT, summary TEXT, status TEXT,
                    files TEXT, checks TEXT, updated_at TEXT);
                CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);
            """)
            if "request_key" not in {row[1] for row in db.execute("PRAGMA table_info(requests)")}:
                db.execute("ALTER TABLE requests ADD COLUMN request_key TEXT")
            for row_id, raw in db.execute("SELECT id,response FROM requests WHERE request_key IS NULL").fetchall():
                try:
                    key = json.loads(raw).get("request_id")
                except (ValueError, AttributeError):
                    continue
                db.execute("UPDATE requests SET request_key=? WHERE id=?", (key, row_id))
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS requests_key ON requests(request_key)")
            if not db.execute("SELECT 1 FROM migrations WHERE name='legacy-memories'").fetchone():
                for session, fact in db.execute("SELECT session,fact FROM memories").fetchall():
                    self._put(db, "session", session, fact_key(fact), fact, "user", "fact", None)
                db.execute("INSERT INTO migrations VALUES('legacy-memories')")

    def bind(self, data):
        session = data["session_id"]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT project_id,user_id FROM identities WHERE session=?", (session,)).fetchone()
            project, user = row or (None, None)
            for name, previous in (("project_id", project), ("user_id", user)):
                if previous and data.get(name, previous) != previous:
                    raise RequestError(f"Session already belongs to a different {name}.", 409)
            project, user = data.get("project_id", project), data.get("user_id", user)
            db.execute("INSERT INTO identities VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id",
                       (session, project, user))
        return {"session_id": session, "project_id": project, "user_id": user}

    def owners(self, session):
        with self.connect() as db:
            row = db.execute("SELECT project_id,user_id FROM identities WHERE session=?", (session,)).fetchone()
        project, user = row or (None, None)
        return {"session": session, "project": project, "user": user}

    def _put(self, db, scope, owner, key, fact, source, kind, ttl):
        stamp = now()
        expiry = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat(timespec="seconds") if ttl else None
        db.execute("""INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,owner,key)
                    DO UPDATE SET fact=excluded.fact,source=excluded.source,kind=excluded.kind,
                    updated_at=excluded.updated_at,expires_at=excluded.expires_at""",
                   (scope, owner, key, fact, source, kind, stamp, stamp, expiry))

    def put_fact(self, session, scope, key, fact, source="user", kind="fact", ttl=None):
        owner = self.owners(session)[scope]
        if not owner:
            raise RequestError(f"{scope}_id is required for {scope} memory.")
        with self.connect() as db:
            self._put(db, scope, owner, key, fact, source, kind, ttl)

    def memory_records(self, session, query, scope=None):
        owners = self.owners(session)
        selected = [(name, owner) for name, owner in owners.items() if owner and (not scope or scope == name)]
        clause = " OR ".join("(f.scope=? AND f.owner=?)" for _ in selected)
        if not clause:
            return []
        args = [part for pair in selected for part in pair] + [now()]
        base = f"({clause}) AND (f.expires_at IS NULL OR f.expires_at>?)"
        with self.connect() as db:
            rows = []
            match = search_query(query)
            if match:
                rows = db.execute(f"SELECT f.rowid,f.* FROM facts_fts JOIN facts f ON f.rowid=facts_fts.rowid WHERE {base} AND facts_fts MATCH ? ORDER BY bm25(facts_fts),f.updated_at DESC LIMIT 8", args + [match]).fetchall()
            profiles = db.execute(f"SELECT f.rowid,f.* FROM facts f WHERE {base} ORDER BY (f.kind='preference') DESC,f.updated_at DESC,f.rowid DESC LIMIT 8", args).fetchall()
        combined = {row[0]: row for row in rows}
        for row in profiles:
            if len(combined) >= 8:
                break
            combined.setdefault(row[0], row)
        columns = ["id", "scope", "owner", "key", "fact", "source", "kind", "created_at", "updated_at", "expires_at"]
        return [dict(zip(columns, row)) for row in combined.values()]

    def memory_action(self, data):
        self.bind(data)
        if data["operation"] == "capture":
            return {"status": "ok", "saved_preferences": self.capture_explicit_preferences(data),
                    "memories": self.memory_records(data["session_id"], "")}
        scope = data["scope"]
        if data["operation"] == "search" and scope == "all":
            return {"status": "ok", "memories": self.memory_records(data["session_id"], data["query"])}
        owner = self.owners(data["session_id"])[scope]
        if not owner:
            raise RequestError(f"{scope}_id is required for {scope} memory.")
        if data["operation"] == "put":
            self.put_fact(data["session_id"], scope, data["key"], data["fact"],
                          kind="preference" if scope == "user" else "fact", ttl=data["ttl_seconds"])
        elif data["operation"] == "forget":
            with self.connect() as db:
                db.execute("DELETE FROM facts WHERE scope=? AND owner=? AND key=?", (scope, owner, data["key"]))
        return {"status": "ok", "memories": self.memory_records(data["session_id"], data.get("query", ""), scope)}

    def capture_explicit_preferences(self, request):
        owners = self.owners(request["session_id"])
        saved = []
        prose = re.sub(r"```.*?```|`[^`]*`", "", request["message"], flags=re.S)
        first_line = next((line for line in prose.splitlines() if line.strip()), "")
        for sentence in re.split(r"(?<=[.!?])\s+", first_line):
            if re.match(r"(?:I prefer\b|I always\b|I never\b|Remember(?: that)?\b)", sentence.strip(), re.I):
                fact = sentence.strip()[:1000]
                scope = "user" if owners["user"] and not fact.lower().startswith("remember") else "session"
                key = "explicit:" + fact_key(fact)
                self.put_fact(request["session_id"], scope, key, fact, "user", "preference" if scope == "user" else "fact")
                saved.append(key)
        return saved

    def index_document(self, collection, path, body, stamp=None):
        stamp = stamp or now()
        with self.connect() as db:
            row = db.execute("SELECT stamp FROM documents WHERE collection=? AND path=?", (collection, path)).fetchone()
            if row and row[0] == stamp:
                return
            db.execute("INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(collection,path) DO UPDATE SET body=excluded.body,stamp=excluded.stamp", (collection, path, body, stamp))

    def search_documents(self, collection, query):
        match = search_query(query)
        if not match:
            return []
        with self.connect() as db:
            rows = db.execute("SELECT d.path,d.body,d.stamp FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid WHERE collection=? AND documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 4", (collection, match)).fetchall()
        terms = set(re.findall(r"\w{3,}", query.casefold()))
        hits = []
        for path, body, stamp in rows:
            lines = body.splitlines()
            if not lines:
                continue
            best = max(range(len(lines)), key=lambda i: len(set(re.findall(r"\w{3,}", lines[i].casefold())) & terms))
            hits.append({"path": path, "excerpt_line" if collection.startswith("project:") else "line": max(0, best - 1) + 1,
                         "text": "\n".join(lines[max(0, best - 1):best + 3])[:700], "updated_at": stamp})
        return hits

    def observe_context(self, request):
        project = self.owners(request["session_id"])["project"]
        observed = []
        if not project:
            return observed
        for item in request["context"]["files"]:
            self.index_document("project:" + project, item["path"], item["content"])
            facts = []
            try:
                name = Path(item["path"]).name
                if name == "package.json":
                    package = json.loads(item["content"])
                    if not isinstance(package, dict):
                        continue
                    if isinstance(package.get("name"), str):
                        facts.append(("package-name", f"package.json names the project {package['name']}"))
                    command = package.get("scripts", {}).get("test") if isinstance(package.get("scripts"), dict) else None
                    if isinstance(command, str):
                        facts.append(("test-command", f"package.json test script: {command}"))
                elif name == "pyproject.toml":
                    config = tomllib.loads(item["content"]).get("project", {})
                    if isinstance(config.get("name"), str):
                        facts.append(("project-name", f"pyproject.toml names the project {config['name']}"))
                    if isinstance(config.get("requires-python"), str):
                        facts.append(("python-version", f"pyproject.toml requires Python {config['requires-python']}"))
                elif name == "requirements.txt":
                    for line in item["content"].splitlines():
                        if re.fullmatch(r"[A-Za-z0-9_.-]+(?:==[A-Za-z0-9_.+-]+)?", line.strip()):
                            facts.append(("dependency:" + fact_key(line), f"requirements.txt declares dependency {line.strip()}"))
            except (ValueError, TypeError, AttributeError):
                pass
            if Path(item["path"]).name in {"package.json", "pyproject.toml", "requirements.txt"}:
                with self.connect() as db:
                    db.execute("DELETE FROM facts WHERE scope='project' AND owner=? AND source=?", (project, "file:" + item["path"]))
            for key, fact in facts[:6]:
                fact = fact[:1000]
                self.put_fact(request["session_id"], "project", "file:" + item["path"] + ":" + key, fact, "file:" + item["path"], "observation", 604800)
                observed.append({"fact": fact, "source": "file:" + item["path"]})
        return observed

    def feedback_action(self, data):
        with self.connect() as db:
            row = db.execute("SELECT session FROM requests WHERE request_key=?", (data["request_id"],)).fetchone()
            if not row or row[0] != data["session_id"]:
                raise RequestError("Feedback request does not belong to this session.", 404)
            existing = db.execute("SELECT summary,status,files,checks FROM feedback WHERE request_id=?", (data["request_id"],)).fetchone()
            values = (data["summary"], data["status"], json.dumps(data["files"]), json.dumps(data["checks"]))
            if existing:
                if existing != values:
                    raise RequestError("Feedback already recorded for this request.", 409)
                return {"status": "ok", "duplicate": True}
            db.execute("INSERT INTO feedback VALUES(?,?,?,?,?,?,?)", (data["request_id"], data["session_id"], *values[:2], *values[2:], now()))
            owners = db.execute("SELECT project_id FROM identities WHERE session=?", (data["session_id"],)).fetchone()
            for check in data["checks"]:
                scope, owner = ("project", owners[0]) if owners and owners[0] else ("session", data["session_id"])
                fact = f"Observed command {'succeeded' if check['success'] else 'failed'}: {check['command']}"[:1000]
                self._put(db, scope, owner, "check:" + fact_key(check["command"]), fact, "tool", "observation", 86400)
        return {"status": "ok", "duplicate": False}

    def outcomes(self, session):
        with self.connect() as db:
            rows = db.execute("SELECT request_id,summary,status,files,checks,updated_at FROM feedback WHERE session=? ORDER BY updated_at DESC,rowid DESC LIMIT 2", (session,)).fetchall()
        return [{"request_id": r[0], "assistant_excerpt": r[1], "status": r[2], "files": json.loads(r[3]),
                 "checks": json.loads(r[4]), "updated_at": r[5], "source": "model_output_not_verified_fact"} for r in reversed(rows)]
