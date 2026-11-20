# -*- coding: utf-8 -*-
"""문장 → SQL — Vercel 서버 함수 (Gemini).

**키를 숨기기 위해서** 서버에 있다. SQL을 실행하지는 않는다 — 실행은 브라우저의 DuckDB가 한다.
여기서는 SQL 문장을 **만들어 돌려주기만** 한다. 사람이 읽고, 고치고, 실행 버튼을 누른다.

  받는 것   {"question": "모바일 신청 완료율은?", "schema": {...schema.json...}}
  주는 것   {"sql": "SELECT ...", "why": "어떻게 셌는지 한 문장", "model": "..."}
            실패하면 {"sql": null, "reason": "..."} — 200

읽기(SELECT · WITH)가 아닌 SQL은 돌려주지 않는다.
외부 라이브러리를 쓰지 않는다.
"""
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

# 모델 이름·무료 한도는 자주 바뀐다 — 00_지침/도구_무료확인.md. Vercel 환경 변수 GEMINI_MODEL 로 바꾼다.
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT = 25

FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b", re.I)


def read_only(sql):
    """읽기만 하는 SQL인가. 한 문장만, SELECT/WITH 로 시작, 쓰기·설치 명령 없음."""
    s = re.sub(r"--[^\n]*", "", sql or "").strip().rstrip(";").strip()
    if not s or ";" in s:
        return None
    if not re.match(r"^(select|with)\b", s, re.I):
        return None
    if FORBIDDEN.search(re.sub(r"'[^']*'", "''", s)):
        return None
    return s


def compact_schema(schema):
    lines = []
    for t, info in schema.get("tables", {}).items():
        cols = []
        for c in info.get("columns", []):
            v = f" 값: {', '.join(map(str, c['values']))}" if c.get("values") else ""
            cols.append(f"{c['name']} {c['type']}{v}")
        lines.append(f"- {t} (한 줄 = {info.get('grain', '?')}, {info.get('rows', '?')}행): " + " | ".join(cols))
    return "\n".join(lines)


def build_prompt(question, schema):
    return f"""너는 DuckDB SQL을 쓰는 데이터 분석가다. 아래 표만 쓴다. 표에 없는 열을 지어내지 않는다.

[표]
{compact_schema(schema)}

[규칙]
- 읽기만 한다. SELECT 또는 WITH 로 시작하는 한 문장.
- **사람을 셀 때는 COUNT(DISTINCT ...)** 를 쓴다. 한 줄의 단위(한 줄 = …)를 보고 판단한다.
- 표를 이어 붙이기 전에 두 표의 «한 줄»이 같은지 본다. 다르면 먼저 묶어서(집계해서) 붙인다.
- 비율은 100을 곱해 소수 첫째 자리까지 ROUND 한다.
- 결과 열 이름은 한국어로 짧게 붙인다 (AS 사람, AS 완료율 …).
- 답할 수 없는 질문이면 sql 을 빈 문자열로 두고 why 에 이유를 쓴다.

[질문]
{question}

JSON 하나로만 답한다: {{"sql": "...", "why": "무엇을 어떻게 셌는지 한 문장"}}
"""


def call_gemini(key, prompt):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT.format(model=MODEL), data=body, method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    return json.loads(data["candidates"][0]["content"]["parts"][0]["text"])


class handler(BaseHTTPRequestHandler):
    def _send(self, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            return self._send({"sql": None, "reason": "키가 없습니다 — Vercel 환경 변수 GEMINI_API_KEY"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(n, 80000)).decode("utf-8"))
            q = str(req.get("question", "")).strip()[:300]
            if not q:
                return self._send({"sql": None, "reason": "질문이 없습니다"})
            out = call_gemini(key, build_prompt(q, req.get("schema") or {}))
            sql = str(out.get("sql", "")).strip()
            why = str(out.get("why", ""))[:300]
            if not sql:
                return self._send({"sql": None, "reason": "AI가 답할 수 없다고 했습니다 — " + why})
            safe = read_only(sql)
            if not safe:
                return self._send({"sql": None, "reason": "AI가 읽기(SELECT)가 아닌 SQL을 썼습니다. 돌려주지 않습니다"})
            return self._send({"sql": safe, "why": why, "model": MODEL})
        except urllib.error.HTTPError as e:
            return self._send({"sql": None, "reason": f"AI 호출 실패 ({e.code}) — 모델 이름·한도를 확인"})
        except Exception as e:  # noqa: BLE001
            return self._send({"sql": None, "reason": f"AI 호출 실패 — {type(e).__name__}"})
