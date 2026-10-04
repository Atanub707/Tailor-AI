#!/usr/bin/env python3
"""Unit tests for the local Laya decision runtime (stdlib only).

Run: python3 -m unittest -v test_service.py

Uses a fake backend — no model, no network, no heavy dependencies. The real
`laya` package is exercised only when installed (>= 3.10).
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request

import service


class FakeBackend:
    def __init__(self, answers=None, fail=False):
        self.answers = answers or {}
        self.fail = fail
        self.calls = []

    def predict(self, state, questions):
        self.calls.append((state, questions))
        if self.fail:
            raise RuntimeError("inference exploded")
        return {"answers": self.answers}

    def status(self):
        return {"backend": "fake", "detail": "test double"}


class UnavailableBackend:
    def predict(self, state, questions):
        raise service.BackendUnavailable("laya not installed")

    def status(self):
        return {"backend": "unavailable", "detail": "laya not installed"}


class TestSecurityInvariants(unittest.TestCase):
    def test_host_is_loopback_only(self):
        self.assertEqual(service.HOST, "127.0.0.1")
        self.assertNotEqual(service.HOST, "0.0.0.0")

    def test_taxonomy_contains_no_escape_and_hard_categories(self):
        self.assertIn("none", service.FIELD_TAXONOMY)
        self.assertEqual(service.FIELD_CATEGORY["accessibilityNeeds"], "eeo")


class TestClassifyField(unittest.TestCase):
    def test_happy_path(self):
        backend = FakeBackend({"field_key": {"choice": "portfolioUrl", "confidence": 0.94}})
        result = service.classify_field(backend, {"label": "Personal website", "type": "URL", "required": False})
        self.assertEqual(result["canonicalKey"], "portfolioUrl")
        self.assertEqual(result["category"], "contact")
        self.assertAlmostEqual(result["confidence"], 0.94)
        self.assertEqual(result["backend"], "laya")
        # The model received only the label/type — no candidate data.
        state, questions = backend.calls[0]
        self.assertEqual(set(state.keys()), {"field_label", "field_type", "select_options"})
        self.assertIn("field_key", questions)

    def test_none_choice_is_unknown(self):
        backend = FakeBackend({"field_key": {"choice": "none", "confidence": 0.8}})
        result = service.classify_field(backend, {"label": "Mystery field", "required": True})
        self.assertEqual(result["category"], "unknown")
        self.assertNotIn("canonicalKey", result)

    def test_confidence_is_clamped(self):
        backend = FakeBackend({"field_key": {"choice": "email", "confidence": 7.5}})
        result = service.classify_field(backend, {"label": "Email"})
        self.assertEqual(result["confidence"], 1.0)

    def test_options_are_capped(self):
        backend = FakeBackend({"field_key": {"choice": "none", "confidence": 0.1}})
        service.classify_field(backend, {"label": "Pick", "options": ["o%d" % i for i in range(200)]})
        state, _ = backend.calls[0]
        self.assertEqual(len(state["select_options"]), service.MAX_OPTIONS)


class TestClassifyQuestion(unittest.TestCase):
    def test_happy_path(self):
        backend = FakeBackend({
            "category": {"choice": "motivation", "confidence": 0.97},
            "answer_source": {"choice": "GENERATIVE_REQUIRED", "confidence": 0.91},
        })
        result = service.classify_question(backend, {"question": "Why do you want this role?", "type": "TEXTAREA"})
        self.assertEqual(result["category"], "motivation")
        self.assertEqual(result["answerSource"], "GENERATIVE_REQUIRED")
        self.assertAlmostEqual(result["confidence"], 0.97)


class TestHttpLayer(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend({"field_key": {"choice": "email", "confidence": 0.99}})
        self.server = service.create_server(0, self.backend)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, path, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path),
            data=data,
            method="POST" if data is not None else "GET",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_health(self):
        status, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["host"], "127.0.0.1")
        self.assertEqual(body["backend"], "fake")

    def test_classify_field_over_http(self):
        status, body = self.request("/classify-field", {"label": "Email address", "type": "EMAIL", "required": True})
        self.assertEqual(status, 200)
        self.assertEqual(body["canonicalKey"], "email")

    def test_bad_requests(self):
        status, _ = self.request("/classify-field", None)
        self.assertEqual(status, 404)  # GET on a POST-only path
        status, body = self.request("/classify-field", {})
        self.assertEqual(status, 400)
        status, _ = self.request("/unknown", {"label": "x"})
        self.assertEqual(status, 404)
        # Oversized body
        big = json.dumps({"label": "x" * (service.MAX_BODY_BYTES + 10)}).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:%d/classify-field" % self.port, data=big, method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            self.fail("oversized body should be rejected")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)

    def test_backend_unavailable_returns_503(self):
        server = service.create_server(0, UnavailableBackend())
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/classify-field" % port,
                data=json.dumps({"label": "Email"}).encode("utf-8"),
                method="POST", headers={"content-type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=5)
                self.fail("expected 503")
            except urllib.error.HTTPError as exc:
                self.assertEqual(exc.code, 503)
                body = json.loads(exc.read().decode("utf-8"))
                self.assertEqual(body["error"], "LAYA_UNAVAILABLE")
        finally:
            server.shutdown()
            server.server_close()

    def test_inference_error_is_500_and_sanitized(self):
        server = service.create_server(0, FakeBackend(fail=True))
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/classify-field" % port,
                data=json.dumps({"label": "Email"}).encode("utf-8"),
                method="POST", headers={"content-type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=5)
                self.fail("expected 500")
            except urllib.error.HTTPError as exc:
                self.assertEqual(exc.code, 500)
                body = json.loads(exc.read().decode("utf-8"))
                self.assertEqual(body["error"], "LAYA_INFERENCE_FAILED")
                self.assertNotIn("exploded", json.dumps(body))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
