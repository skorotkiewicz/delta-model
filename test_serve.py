import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from serve import Preparer, RequestError, Resources, Store, handler_for, validate_request


class ScriptedModel:
    device = "test"

    def __init__(self, *outputs):
        self.outputs = iter(outputs)
        self.messages = []

    def generate(self, messages):
        self.messages.append(list(messages))
        return next(self.outputs)


FINAL = json.dumps({"prompt": "Write the requested deployment plan using the saved project facts.",
                    "missing_information": []})


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.resources = self.root / "resources"
        self.resources.mkdir()
        (self.resources / "project.md").write_text("The atlas project deployment uses PostgreSQL.\n", encoding="utf-8")
        self.store = Store(self.root / "state.sqlite3")

    def tearDown(self):
        self.temp.cleanup()

    def preparer(self, *outputs):
        return Preparer(ScriptedModel(*outputs), self.store, Resources(self.resources))

    def test_model_reads_storage_and_downstream_keeps_original(self):
        tool = json.dumps({"tool_calls": [{"name": "storage_get", "arguments": {"key": "project"}}]})
        agent = self.preparer(tool, FINAL)
        result = agent.prepare({"session_id": "alice", "message": "Plan deployment for atlas, under 50 EUR.",
                                "memories": ["Use a single server."],
                                "storage": {"project": {"database": "PostgreSQL"}}})
        self.assertEqual(result["status"], "prepared")
        tool_trace = result["tool_calls"][-1]
        self.assertEqual(tool_trace["source"], "qwen")
        self.assertEqual(tool_trace["result"]["value"], {"database": "PostgreSQL"})
        self.assertIn("PostgreSQL", agent.model.messages[-1][-1]["content"])
        handoff = json.loads(result["handoff"]["messages"][1]["content"])
        self.assertEqual(handoff["original_request"], "Plan deployment for atlas, under 50 EUR.")
        self.assertEqual(handoff["context"]["resources"][0]["path"], "project.md")

    def test_persistence_history_and_session_isolation(self):
        result = self.preparer(FINAL, FINAL).prepare({"session_id": "alice", "message": "Plan atlas deployment.",
                                     "memories": ["Prefer Python."], "storage": {"budget": 50}})
        self.assertEqual(result["tool_calls"][-1]["result"]["value"], 50)
        self.assertEqual(result["tool_calls"][-1]["source"], "automatic")
        self.assertTrue(result["warnings"])
        reopened = Store(self.store.path)
        self.assertEqual(reopened.memory_search("alice", "Python"), ["Prefer Python."])
        self.assertEqual(reopened.storage_get("alice", "budget")["value"], 50)
        self.assertEqual(reopened.history("alice"), ["Plan atlas deployment."])
        result = self.preparer(FINAL).prepare({"session_id": "bob", "message": "What do you know?"})
        self.assertEqual(result["memories"], [])
        self.assertEqual(result["storage"]["keys"], [])
        self.assertEqual(reopened.storage_get("bob", "budget")["found"], False)
        self.assertEqual(reopened.history("bob"), ["What do you know?"])

    def test_invalid_json_is_retried_and_failure_is_explicit(self):
        result = self.preparer("bad json", FINAL).prepare({"message": "Help with atlas."})
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(len(result["warnings"]), 1)
        result = self.preparer("bad", "[]", "{}").prepare({"message": "Keep exactly this request."})
        self.assertEqual(result["status"], "fallback")
        self.assertEqual(result["preparation"]["prompt"], "Keep exactly this request.")

    def test_tool_limit_and_disallowed_tools(self):
        call = json.dumps({"tool_calls": [{"name": "shell", "arguments": {"query": "touch /tmp/bad"}}]})
        result = self.preparer(call, call, call).prepare({"message": "Run a tool."})
        self.assertEqual(result["status"], "fallback")
        self.assertEqual(len([t for t in result["tool_calls"] if t["source"] == "qwen"]), 2)
        self.assertIn("Unknown tool", result["tool_calls"][-1]["result"]["error"])

    def test_malformed_tool_calls_do_not_crash(self):
        for call in [[], {"name": [], "arguments": {}}, {"name": "storage_get", "arguments": "project"}]:
            with self.subTest(call=call):
                self.assertIn("error", self.preparer().tool("alice", call))

    def test_resources_exclude_large_files_hidden_files_and_symlinks(self):
        (self.root / "secret.md").write_text("atlas secret", encoding="utf-8")
        (self.resources / "link.md").symlink_to(self.root / "secret.md")
        (self.resources / ".hidden.md").write_text("atlas secret", encoding="utf-8")
        (self.resources / "huge.json").write_text("atlas " * 30_000, encoding="utf-8")
        hits = Resources(self.resources).search("atlas")
        self.assertEqual([hit["path"] for hit in hits], ["project.md"])

    def test_request_validation_and_busy(self):
        for data in [[], {}, {"message": " "}, {"message": "hi", "session_id": "../alice"},
                     {"message": "hi", "memories": "bad"}, {"message": "hi", "storage": []},
                     {"message": "hi", "unexpected": True}]:
            with self.subTest(data=data), self.assertRaises(RequestError):
                validate_request(data)
        agent = self.preparer(FINAL)
        agent.lock.acquire()
        try:
            with self.assertRaises(RequestError) as caught:
                agent.prepare({"message": "hi"})
            self.assertEqual(caught.exception.status, 503)
        finally:
            agent.lock.release()

    def test_http_statuses_and_json_response(self):
        agent = self.preparer(FINAL)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(agent))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def send(path, body=None, content_type="application/json", method=None):
            req = Request(base + path, data=body, headers={"Content-Type": content_type}, method=method)
            try:
                response = urlopen(req, timeout=5)
            except HTTPError as exc:
                response = exc
            with response:
                return response.status, json.load(response)

        try:
            self.assertEqual(send("/health")[0], 200)
            status, result = send("/prepare", b'{"message":"Deploy atlas"}')
            self.assertEqual(status, 200)
            self.assertEqual(result["status"], "prepared")
            self.assertEqual(send("/prepare", b"{")[0], 400)
            self.assertEqual(send("/prepare", b'{"message":"hi", "storage":{"x":NaN}}')[0], 400)
            self.assertEqual(send("/prepare", b"{}", "text/plain")[0], 415)
            self.assertEqual(send("/prepare", b"x" * 33_000)[0], 413)
            self.assertEqual(send("/missing")[0], 404)
            self.assertEqual(send("/prepare", method="DELETE")[0], 501)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
