import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from protocol import RequestError, render_prompt, validate_feedback, validate_memory
from serve import Preparer, Resources, Store
from test_serve import FINAL, ScriptedModel


class InfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.resources = self.root / "resources"
        self.resources.mkdir()
        self.store = Store(self.root / "state.sqlite3")

    def tearDown(self):
        self.temp.cleanup()

    def agent(self, *outputs):
        return Preparer(ScriptedModel(*outputs), self.store, Resources(self.resources))

    def memory(self, **data):
        return self.store.memory_action(validate_memory(data))

    def test_compiler_preserves_questions_constraints_paths_negation_and_saved_preferences(self):
        brief = {"prompt": "Deploy with Docker for 120 EUR.", "missing_information": ["Which service?", "Which service?"]}
        rendered = render_prompt(brief, "Use src/app.py. Budget under 12 EUR. Do not use Docker.",
                                 {"memories": ["Prefer Python."], "project_context": {}}, [])
        self.assertIn("src/app.py", rendered["prompt"])
        self.assertIn("Budget under 12 EUR", rendered["prompt"])
        self.assertIn("Do not use Docker", rendered["prompt"])
        self.assertIn("Prefer Python", rendered["prompt"])
        self.assertEqual(rendered["prompt"].count("Which service?"), 1)
        self.assertEqual(rendered["missing_information"], ["Which service?"])
        self.assertIn("taking precedence", rendered["prompt"])

    def test_real_prepare_includes_missing_information_in_the_only_model_facing_prompt(self):
        output = json.dumps({"prompt": "Fix the bug.", "missing_information": ["What is the error?"]})
        result = self.agent(output).prepare({"message": "Fix src/app.py without Docker.", "memories": ["Use Python."]})
        self.assertIn("What is the error?", result["preparation"]["prompt"])
        self.assertIn("without Docker", result["preparation"]["prompt"])
        self.assertIn("Use Python", result["preparation"]["prompt"])
        self.assertEqual(result["draft_prompt"], "Fix the bug.")

    def test_optional_context_budgeting_preserves_original_request_and_full_debug_context(self):
        class BudgetModel(ScriptedModel):
            max_input_tokens = 700

            def input_tokens(self, messages):
                return len(json.dumps(messages)) // 10
        model = BudgetModel(FINAL)
        agent = Preparer(model, self.store, Resources(self.resources))
        message = "Fix src/app.py without Docker."
        result = agent.prepare({"message": message, "context": {"files": [
            {"path": "src/app.py", "content": "x" * 2400}, {"path": "src/utils.py", "content": "y" * 2400},
            {"path": "src/tests.py", "content": "z" * 2400}]}})
        self.assertLessEqual(model.input_tokens(model.messages[0]), model.max_input_tokens)
        self.assertEqual(json.loads(model.messages[0][1]["content"])["original_request"], message)
        self.assertTrue(result["warnings"])
        full = json.loads(result["handoff"]["messages"][1]["content"])["context"]["project_context"]
        self.assertEqual(len(full["files"]), 3)
        self.assertEqual(len(full["files"][0]["content"]), 2400)

    def test_project_and_user_memories_survive_new_sessions_without_crossing_other_scopes(self):
        common = {"session_id": "s1", "project_id": "alpha", "user_id": "alice", "operation": "put"}
        self.memory(**common, scope="project", key="database", fact="Use SQLite.")
        self.memory(**common, scope="user", key="language", fact="Prefer Python.")
        self.memory(**common, scope="session", key="task", fact="Fix the red button.")
        self.store.bind({"session_id": "s2", "project_id": "alpha", "user_id": "alice"})
        self.store.bind({"session_id": "s3", "project_id": "beta", "user_id": "bob"})
        self.store.bind({"session_id": "s4", "project_id": "beta", "user_id": "alice"})
        self.assertEqual(set(self.store.memory_search("s2", "")), {"Use SQLite.", "Prefer Python."})
        self.assertEqual(self.store.memory_search("s3", ""), [])
        self.assertEqual(self.store.memory_search("s4", ""), ["Prefer Python."])
        reopened = Store(self.store.path)
        self.assertEqual(set(reopened.memory_search("s2", "")), {"Use SQLite.", "Prefer Python."})
        with self.assertRaises(RequestError):
            self.store.bind({"session_id": "s1", "project_id": "beta"})

    def test_memory_update_forget_expiration_and_provenance(self):
        request = {"session_id": "s", "project_id": "alpha", "operation": "put", "scope": "project", "key": "database"}
        self.memory(**request, fact="Use MySQL.")
        result = self.memory(**request, fact="Use SQLite.", ttl_seconds=3600)
        self.assertEqual(len(result["memories"]), 1)
        memory = result["memories"][0]
        self.assertEqual(memory["fact"], "Use SQLite.")
        self.assertEqual(memory["source"], "user")
        self.assertTrue(memory["created_at"] and memory["updated_at"] and memory["expires_at"])
        with self.store.connect() as db:
            db.execute("UPDATE facts SET expires_at='2000-01-01T00:00:00+00:00'")
        self.assertEqual(self.store.memory_search("s", "SQLite"), [])
        self.memory(**request, fact="Use SQLite.")
        self.memory(session_id="s", operation="forget", scope="project", key="database")
        self.assertEqual(self.store.memory_search("s", "SQLite"), [])

    def test_concurrent_identity_binding_cannot_reassign_an_existing_session(self):
        barrier = threading.Barrier(2)

        def bind(project):
            barrier.wait(timeout=5)
            try:
                self.store.bind({"session_id": "race", "project_id": project})
                return 200
            except RequestError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(bind, ["alpha", "beta"]))
        self.assertEqual(sorted(results), [200, 409])

    def test_explicit_preferences_saved_before_generation_but_model_answers_are_not_facts(self):
        result = self.agent(FINAL).prepare({"session_id": "s", "project_id": "alpha", "user_id": "alice",
                                           "message": "I prefer Python. Fix the bug."})
        self.assertTrue(result["saved_preferences"])
        self.assertEqual(self.store.memory_search("s", "Python"), ["I prefer Python."])
        records = self.store.memory_records("s", "Python")
        self.assertEqual(records[0]["scope"], "user")
        self.assertEqual(records[0]["source"], "user")
        self.assertNotIn("Write the requested deployment plan using the saved project facts.", self.store.memory_search("s", ""))

    def test_preference_capture_uses_user_text_and_ignores_expanded_or_quoted_content(self):
        result = self.agent(FINAL).prepare({"session_id": "s", "user_id": "alice", "learn_preferences": False,
            "message": "File notes.md contains:\nI prefer Rust.\nFix that file."})
        self.assertEqual(result["saved_preferences"], [])
        self.assertEqual(self.store.memory_search("s", ""), [])
        data = validate_memory({"session_id": "s", "operation": "capture", "message":
                               "I prefer Python.\n```\nI prefer Rust.\n```\n> I prefer Go."})
        captured = self.store.memory_action(data)
        self.assertEqual(len(captured["saved_preferences"]), 1)
        self.assertEqual(self.store.memory_search("s", ""), ["I prefer Python."])
        quoted = validate_memory({"session_id": "s", "operation": "capture", "message": "Translate this:\nI prefer Rust."})
        self.assertEqual(self.store.memory_action(quoted)["saved_preferences"], [])

    def test_fts_retrieval_and_observed_manifest_facts(self):
        result = self.agent(FINAL).prepare({"session_id": "s", "project_id": "alpha", "message": "Inspect frontend test configuration.",
            "context": {"files": [{"path": "package.json", "content": '{"name":"atlas","scripts":{"test":"vitest run"}}'}],
                        "errors": ["TypeError in src/app.ts"], "active_tools": ["read", "bash"]}})
        prompt = result["preparation"]["prompt"]
        self.assertIn("vitest run", prompt)
        self.assertIn("package.json", prompt)
        self.assertIn("TypeError", prompt)
        self.assertEqual(self.store.search_documents("project:alpha", "vitest")[0]["path"], "package.json")
        self.assertEqual(self.store.search_documents("project:beta", "vitest"), [])
        records = self.store.memory_records("s", "vitest")
        self.assertTrue(any(record["source"] == "file:package.json" for record in records))
        with self.store.connect() as db:
            self.assertTrue(db.execute("SELECT count(*) FROM facts_fts WHERE facts_fts MATCH 'vitest'").fetchone()[0])

    def test_resource_index_updates_and_removes_deleted_files(self):
        file = self.resources / "notes.md"
        file.write_text("Use SQLite for Atlas.\n", encoding="utf8")
        resources = self.agent(FINAL).resources
        self.assertTrue(resources.search("SQLite"))
        file.write_text("Use PostgreSQL for Atlas instead.\n", encoding="utf8")
        self.assertEqual(resources.search("SQLite"), [])
        self.assertTrue(resources.search("PostgreSQL"))
        file.unlink()
        self.assertEqual(resources.search("PostgreSQL"), [])

    def test_feedback_is_idempotent_scoped_and_visible_to_follow_up_requests(self):
        result = self.agent(FINAL).prepare({"session_id": "s", "project_id": "alpha", "message": "Write a deployment plan. Budget under 12 EUR."})
        feedback = validate_feedback({"session_id": "s", "request_id": result["request_id"],
            "summary": "The plan uses a single server with nightly backups.",
            "files": ["deploy.py"], "checks": [{"command": "python -m unittest", "success": True, "output": "OK"}]})
        self.assertFalse(self.store.feedback_action(feedback)["duplicate"])
        self.assertTrue(self.store.feedback_action(feedback)["duplicate"])
        with self.assertRaises(RequestError):
            self.store.feedback_action({**feedback, "session_id": "someone-else"})
        with self.assertRaises(RequestError):
            self.store.feedback_action({**feedback, "summary": "Changed payload"})
        agent = self.agent(FINAL)
        followup = agent.prepare({"session_id": "s", "message": "Adapt that plan."})
        self.assertIn("nightly backups", agent.model.messages[0][1]["content"])
        self.assertIn("nightly backups", followup["preparation"]["prompt"])
        self.assertIn("not verified evidence", followup["preparation"]["prompt"])
        self.assertIn("Budget under 12 EUR", followup["preparation"]["prompt"])
        self.assertIn("current request takes precedence", followup["preparation"]["prompt"])
        context = json.loads(followup["handoff"]["messages"][1]["content"])["context"]
        self.assertEqual(context["recent_outcomes"][0]["source"], "model_output_not_verified_fact")
        facts = self.store.memory_records("s", "")
        self.assertFalse(any("nightly backups" in fact["fact"] for fact in facts))
        self.assertTrue(any(fact["source"] == "tool" and fact["expires_at"] for fact in facts))

    def test_legacy_migration_does_not_resurrect_forgotten_facts(self):
        path = self.root / "legacy.sqlite3"
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript("CREATE TABLE memories(session TEXT,fact TEXT,PRIMARY KEY(session,fact));"
                             "CREATE TABLE requests(id INTEGER PRIMARY KEY,session TEXT,message TEXT,response TEXT);")
            db.execute("INSERT INTO memories VALUES('legacy','Prefer Python.')")
        migrated = Store(path)
        fact = migrated.memory_records("legacy", "")[0]
        self.assertEqual(fact["source"], "user")
        migrated.memory_action(validate_memory({"session_id": "legacy", "operation": "forget", "scope": "session", "key": fact["key"]}))
        self.assertEqual(Store(path).memory_search("legacy", ""), [])

    def test_new_http_routes_validate_and_handle_memory_and_feedback(self):
        from serve import handler_for
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.agent(FINAL)))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def post(path, data):
            try:
                response = urlopen(Request(base + path, json.dumps(data).encode(), {"Content-Type": "application/json"}), timeout=5)
            except HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)
        try:
            self.assertEqual(post("/memory", {"session_id": "s", "operation": "put", "key": "x", "fact": "A fact"})[0], 200)
            self.assertEqual(post("/memory", {"session_id": "s", "operation": "put", "scope": "user", "key": "x", "fact": "A fact"})[0], 400)
            self.assertEqual(post("/feedback", {"session_id": "s", "request_id": "unknown"})[0], 404)
            self.assertEqual(post("/prepare", {"message": "Hello", "context": {"files": [{"path": "../secret.py", "content": "secret"}]}})[0], 400)
            self.assertEqual(post("/prepare", {"message": "Hello", "context": {"checks": [{"command": "test", "success": "yes"}]}})[0], 400)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
