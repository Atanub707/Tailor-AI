#!/usr/bin/env python3
"""Tailor AI — Local Laya decision runtime (Auto Apply, experimental).

A minimal, dependency-free HTTP sidecar that exposes the official `laya`
package (https://pypi.org/project/laya/, Apache-2.0) to the local Tailor AI
backend for ADVISORY field/question classification only.

HARD BOUNDARIES
  * Binds 127.0.0.1 ONLY — never 0.0.0.0, never a public interface.
  * Classification only: Laya returns typed choices + calibrated confidence.
    It never generates answers; the Node side never lets it resolve consent,
    EEO, legal, demographic or other hard-blocked categories.
  * Minimal data: only the field label / type / options (and a question text)
    are sent to the model. No applicant profile, resume, email, phone, salary
    or address ever reaches this process.
  * Fails closed: if `laya` is not installed (or the Python version is too
    old — Laya needs >= 3.10), classify endpoints return 503 and the dry run
    continues without suggestions.
  * No request-body logging.

RUN
  pip install -r requirements.txt        # needs Python >= 3.10
  python3 service.py                     # serves http://127.0.0.1:8765

TEST (stdlib only, no model needed)
  python3 -m unittest -v test_service.py
"""

from __future__ import annotations

import json
import platform
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

# ── Security constants ────────────────────────────────────────────────────

HOST = "127.0.0.1"  # NEVER configurable to 0.0.0.0 — local runtime only.
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 64 * 1024
MAX_LABEL_CHARS = 500
MAX_OPTIONS = 50
MAX_OPTION_CHARS = 200
MIN_PYTHON = (3, 10)

# ── Taxonomy (mirrors the Node decision-engine canonical-key vocabulary) ──
# Kept small on purpose: Laya degrades on very high-cardinality choice sets,
# so this is the curated set of common ATS keys + a "none" escape hatch.

FIELD_TAXONOMY: Dict[str, str] = {
    "fullName": "the applicant's full name",
    "firstName": "the applicant's first / given name",
    "lastName": "the applicant's last / family name",
    "email": "an email address",
    "phone": "a phone number",
    "currentCity": "a city / location",
    "currentCountry": "a country",
    "linkedinUrl": "a LinkedIn profile URL",
    "githubUrl": "a GitHub profile URL",
    "portfolioUrl": "a personal website or portfolio URL",
    "websiteUrl": "a website URL",
    "authorizedToWork": "work authorization / eligibility to work",
    "requiresSponsorship": "visa sponsorship or immigration assistance",
    "noticePeriod": "notice period / availability to start",
    "targetSalary": "expected / desired salary or compensation",
    "referralSource": "how the applicant heard about the job",
    "hasReferralsAtCompany": "whether the applicant knows someone at the company",
    "onsiteAvailability": "availability for on-site work",
    "accessibilityNeeds": "accessibility or disability accommodation",
    "none": "none of the above",
}

FIELD_CATEGORY: Dict[str, str] = {
    "fullName": "identity", "firstName": "identity", "lastName": "identity",
    "email": "contact", "phone": "contact",
    "currentCity": "location", "currentCountry": "location",
    "linkedinUrl": "contact", "githubUrl": "contact",
    "portfolioUrl": "contact", "websiteUrl": "contact",
    "authorizedToWork": "work_authorization", "requiresSponsorship": "work_authorization",
    "noticePeriod": "availability", "targetSalary": "salary",
    "referralSource": "unknown", "hasReferralsAtCompany": "unknown",
    "onsiteAvailability": "availability", "accessibilityNeeds": "eeo",
}

FIELD_ANSWER_SOURCE: Dict[str, str] = {
    "accessibilityNeeds": "USER_REQUIRED",
    "authorizedToWork": "PROFILE", "requiresSponsorship": "PROFILE",
    "noticePeriod": "PROFILE", "targetSalary": "PROFILE",
}

QUESTION_CATEGORY_CRITERIA: Dict[str, str] = {
    "identity": "name, identity documents",
    "contact": "email, phone, links",
    "location": "where the applicant lives or wants to work",
    "work_authorization": "work eligibility, visas, sponsorship",
    "salary": "compensation expectations",
    "availability": "notice period, start date, travel",
    "motivation": "why the applicant wants the role/company",
    "experience": "work history, skills, years of experience",
    "education": "degrees, schools, certifications",
    "consent": "legal consent, terms, declarations, background checks",
    "eeo": "gender, race, veteran, disability, demographics",
    "file_upload": "resume or document uploads",
    "unknown": "none of the above",
}

ANSWER_SOURCE_CRITERIA: Dict[str, str] = {
    "PROFILE": "a fact already configured in the applicant profile",
    "MASTER_CV": "a fact found in the candidate's resume/experience",
    "JOB_CONTEXT": "the specific job posting or company",
    "GENERATIVE_REQUIRED": "a free-text answer that must be written",
    "USER_REQUIRED": "the applicant must answer personally (sensitive/unknown)",
}


# ── Backend ───────────────────────────────────────────────────────────────


class BackendUnavailable(Exception):
    """Raised when the Laya runtime cannot serve a request. The HTTP layer
    turns this into a 503; the Node side treats it as 'no suggestion'."""


class LayaRouterBackend:
    """Adapter over the official `laya` package (Router mode, preloaded).

    Pinned to the documented 0.3.x API:
        from laya import Router
        router = Router(preload=True)
        res = router.predict(state, questions)   # res["answers"][name]["choice"|"confidence"]
    Any mismatch raises BackendUnavailable — never a silent wrong answer.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._router = None
        self._load_error: Optional[str] = None

    def _ensure_loaded(self) -> None:
        if self._router is not None:
            return
        if self._load_error is not None:
            raise BackendUnavailable(self._load_error)
        if sys.version_info < MIN_PYTHON:
            self._load_error = (
                "Laya requires Python %d.%d+ (running %s). Create a newer venv and "
                "pip install -r requirements.txt" % (MIN_PYTHON[0], MIN_PYTHON[1], platform.python_version())
            )
            raise BackendUnavailable(self._load_error)
        try:
            from laya import Router  # type: ignore
        except Exception as exc:  # noqa: BLE001 — report, never crash
            self._load_error = "The 'laya' package is not installed (%s). Run: pip install -r requirements.txt" % exc
            raise BackendUnavailable(self._load_error)
        try:
            self._router = Router(preload=True)
        except Exception as exc:  # noqa: BLE001
            self._load_error = "Laya Router failed to initialise: %s" % exc
            raise BackendUnavailable(self._load_error)

    def predict(self, state: Dict[str, Any], questions: Dict[str, Any]) -> Dict[str, Any]:
        self._ensure_loaded()
        assert self._router is not None
        with self._lock:  # one forward pass at a time — predictable memory
            result = self._router.predict(state, questions)
        if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
            raise BackendUnavailable("Laya returned an unexpected response shape.")
        return result

    def status(self) -> Dict[str, Any]:
        try:
            self._ensure_loaded()
            return {"backend": "laya", "detail": "Router preloaded"}
        except BackendUnavailable as exc:
            return {"backend": "unavailable", "detail": str(exc)}


def load_backend() -> LayaRouterBackend:
    return LayaRouterBackend()


# ── Classification (backend-agnostic; unit-testable with a fake) ─────────


def _clamp_confidence(raw: Any) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, value))


def classify_field(backend: Any, req: Dict[str, Any]) -> Dict[str, Any]:
    label = str(req.get("label", ""))[:MAX_LABEL_CHARS]
    options = [str(o)[:MAX_OPTION_CHARS] for o in (req.get("options") or [])][:MAX_OPTIONS]
    state = {
        "field_label": label,
        "field_type": str(req.get("type", ""))[:40],
        "select_options": options,
    }
    questions = {
        "field_key": {
            "type": "choice",
            "instructions": "Which applicant application-field is this form field?",
            "criteria": FIELD_TAXONOMY,
        }
    }
    result = backend.predict(state, questions)
    answer = result["answers"]["field_key"]
    choice = str(answer.get("choice", "none"))
    confidence = _clamp_confidence(answer.get("confidence"))
    if choice == "none" or choice not in FIELD_TAXONOMY:
        return {"category": "unknown", "confidence": confidence, "backend": "laya"}
    return {
        "canonicalKey": choice,
        "category": FIELD_CATEGORY.get(choice, "unknown"),
        "answerSource": FIELD_ANSWER_SOURCE.get(choice, "PROFILE"),
        "confidence": confidence,
        "backend": "laya",
    }


def classify_question(backend: Any, req: Dict[str, Any]) -> Dict[str, Any]:
    question = str(req.get("question", ""))[:MAX_LABEL_CHARS]
    state = {"question_text": question, "field_type": str(req.get("type", ""))[:40]}
    questions = {
        "category": {
            "type": "choice",
            "instructions": "What kind of application question is this?",
            "criteria": QUESTION_CATEGORY_CRITERIA,
        },
        "answer_source": {
            "type": "choice",
            "instructions": "Where should the answer to this question come from?",
            "criteria": ANSWER_SOURCE_CRITERIA,
        },
    }
    result = backend.predict(state, questions)
    category_answer = result["answers"]["category"]
    source_answer = result["answers"]["answer_source"]
    return {
        "category": str(category_answer.get("choice", "unknown")),
        "answerSource": str(source_answer.get("choice", "USER_REQUIRED")),
        "confidence": _clamp_confidence(category_answer.get("confidence")),
        "answerSourceConfidence": _clamp_confidence(source_answer.get("confidence")),
        "backend": "laya",
    }


# ── HTTP layer ────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "TailorLaya/0.1"
    protocol_version = "HTTP/1.1"

    backend: Any = None  # injected by create_server

    # No request-body logging, ever (privacy).
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("[laya] %s\n" % (fmt % args))

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Optional[Dict[str, Any]]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            status = self.backend.status() if hasattr(self.backend, "status") else {"backend": "unknown"}
            self._send(200, {
                "ok": status.get("backend") == "laya",
                "python": platform.python_version(),
                "host": HOST,
                "model": "convaiinnovations/laya (Router)",
                **status,
            })
            return
        self._send(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ("/classify-field", "/classify-question"):
            self._send(404, {"error": "NOT_FOUND"})
            return
        body = self._read_json()
        if body is None:
            self._send(400, {"error": "BAD_REQUEST"})
            return
        key = "label" if path == "/classify-field" else "question"
        if not str(body.get(key, "")).strip():
            self._send(400, {"error": "BAD_REQUEST", "detail": "%s is required" % key})
            return
        started = time.time()
        try:
            payload = classify_field(self.backend, body) if path == "/classify-field" else classify_question(self.backend, body)
        except BackendUnavailable as exc:
            self._send(503, {"error": "LAYA_UNAVAILABLE", "detail": str(exc)})
            return
        except Exception:  # noqa: BLE001 — never leak internals or input
            self._send(500, {"error": "LAYA_INFERENCE_FAILED"})
            return
        payload["durationMs"] = int((time.time() - started) * 1000)
        self._send(200, payload)


def create_server(port: int = DEFAULT_PORT, backend: Optional[Any] = None) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"backend": backend or load_backend()})
    # HOST is the module constant 127.0.0.1 — deliberately NOT parameterised.
    return ThreadingHTTPServer((HOST, port), handler)


def main() -> None:
    port = DEFAULT_PORT
    args = sys.argv[1:]
    if args and args[0] == "--port" and len(args) > 1:
        port = int(args[1])
    server = create_server(port)
    status = server.RequestHandlerClass.backend.status()
    print("[laya] listening on http://%s:%d — backend=%s (%s)" % (HOST, port, status.get("backend"), status.get("detail")))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
