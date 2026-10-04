# Local Laya decision runtime (Auto Apply — experimental)

A tiny local sidecar that exposes [Laya](https://pypi.org/project/laya/) —
an Apache-2.0, non-autoregressive "System 1" decision model — to the Tailor
AI backend for **advisory classification only**.

```
Tailor AI (Node) ── HTTP 127.0.0.1 only ──> service.py ──> laya Router ──> probabilities
```

## What it is used for

When the deterministic mapper cannot classify an application field or
question, the Node decision pass may ask this runtime which canonical key /
category a field belongs to, or where a question's answer should come from.
Laya returns typed choices with calibrated probabilities. **It never
generates text and never supplies an answer value** — values can only come
from the existing applicant profile / Master CV catalog on the Node side.

Hard-blocked categories (consent, EEO, legal declarations, demographics,
CAPTCHA, OTP/MFA, passwords, background checks) are never auto-resolved,
regardless of confidence — that policy lives in the Node decision engine and
is enforced there.

## Requirements

- **Python ≥ 3.10** (Laya's own floor: `huggingface_hub` 1.x,
  `transformers` 5.x, `torch` 2.14). On older Pythons the service still
  starts but reports `backend: unavailable` and returns 503 on classify —
  the dry run then simply has no suggestions.
- Disk/network: first run downloads the model weights from the Hugging Face
  Hub and caches them locally.

## Install & run

```bash
cd local-ai/laya
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python service.py               # http://127.0.0.1:8765
python service.py --port 8899   # optional port
curl http://127.0.0.1:8765/health
```

Then enable it for Auto Apply (Tailor AI `.env` / docker-compose env):

```ini
LAYA_ENABLED=true
LAYA_URL=http://127.0.0.1:8765
LAYA_REQUEST_TIMEOUT_MS=5000
LAYA_HIGH_CONFIDENCE=0.90
LAYA_REVIEW_CONFIDENCE=0.70
```

`LAYA_ENABLED` defaults to **false** — the feature is fully optional.

## Security properties

- Binds **127.0.0.1 only**. The host is a constant; it cannot be set to
  `0.0.0.0` from the command line or environment.
- Request bodies are capped (64 KB); labels 500 chars; options capped.
- **No request-body logging.** Only method + path are logged.
- The Node adapter refuses non-loopback `LAYA_URL` values before any request
  and enforces a hard timeout on every call.
- The payload sent to the model is only the field label / type / options (or
  the question text). No applicant profile, resume, email, phone, salary or
  address ever reaches this process.

## API (used by the Node adapter)

| Endpoint | Body | Response |
|---|---|---|
| `GET /health` | — | `{ ok, backend, detail, python, host, model }` |
| `POST /classify-field` | `{ label, type?, required?, options? }` | `{ canonicalKey?, category, answerSource?, confidence, backend }` |
| `POST /classify-question` | `{ question, type?, required?, options? }` | `{ category, answerSource, confidence, answerSourceConfidence, backend }` |

Unavailable runtime → `503 { error: "LAYA_UNAVAILABLE" }`; malformed request
→ `400`; inference error → sanitized `500`.

## Tests

```bash
python3 -m unittest -v test_service.py   # stdlib only — fake backend, no model
```

## Honest limits (from the upstream model card)

- The **base checkpoints are near chance zero-shot** on the upstream
  typed-decisions benchmark (0.36 vs 0.32 random). Laya is a fast base to
  specialise, not a zero-shot oracle. Treat its output as advisory.
- Confidence is not truth: the upstream card reports a language where the
  model is 95% confident and 0% accurate. The Node side therefore never
  treats confidence as absolute — hard blocks ignore it entirely, and
  deterministic results always win.
- Very high-cardinality choice questions degrade; the field taxonomy here is
  deliberately curated and small. Fine-tuning on your own field labels is
  the recommended way to improve accuracy (see the upstream fine-tuning
  notebook).

## Wire protocol note

The backend pins the documented `laya` 0.3.x API
(`from laya import Router; Router(preload=True); router.predict(state, questions)`
→ `answers[name]["choice"|"confidence"]`). If the installed package changes
that surface, the adapter fails closed (`LAYA_UNAVAILABLE`) rather than
guessing — update `LayaRouterBackend` to the new API if upstream changes.
