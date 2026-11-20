# -*- coding: utf-8 -*-
"""이 폴더의 데이터에 Claude Code를 직접 잇는 MCP 서버 (4부 14-11).

Claude Code가 이 폴더에서 켜지면 `.mcp.json` 을 보고 이 프로그램을 띄운다.
Claude는 아래 세 도구로 `data/*.parquet` 에 직접 묻는다. 이 서버는 내 컴퓨터 안에서 돌고,
돌려준 결과(앞 20행까지)는 Claude에게 간다 — 가상 데이터라 괜찮지만 회사 데이터라면 5-4를 먼저 묻는다.

  list_tables      표 이름 · 한 줄이 무엇인지 · 행 수
  describe_table   한 표의 열 이름과 형식
  query            SQL 한 문장을 돌려 «행 수 + 앞 20행»을 돌려준다

도구 이름은 영문이다 — MCP 표준과 Claude API가 도구 이름에 영문 · 숫자 · _ · - 만 받는다. 설명은 한글로 둔다.

지키는 것
  - **읽기만 한다.** SELECT · WITH 로 시작하는 한 문장. 서버 함수(api/sql.py)와 같은 검사를 쓴다 (16-3)
  - **조금만 돌려준다.** 결과는 앞 20행까지. 다 돌려주면 Claude의 컨텍스트와 사용 한도를 먹는다 (0장 한도 습관)
  - 파일을 만들거나 고치거나 지우지 않는다. 인터넷에 접속하지 않는다
"""
import json
import os
import re
import sys

import duckdb
from mcp.server.fastmcp import FastMCP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
SCHEMA = os.path.join(ROOT, "schema.json")
MAX_ROWS = 20

FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b", re.I)


def read_only(sql):
    """읽기만 하는 SQL인가. 한 문장만, SELECT/WITH 로 시작, 쓰기·설치 명령 없음. (api/sql.py 와 같은 검사)"""
    s = re.sub(r"--[^\n]*", "", sql or "").strip().rstrip(";").strip()
    if not s or ";" in s:
        return None
    if not re.match(r"^(select|with)\b", s, re.I):
        return None
    if FORBIDDEN.search(re.sub(r"'[^']*'", "''", s)):
        return None
    return s


def load_schema():
    with open(SCHEMA, encoding="utf-8") as f:
        return json.load(f)


def connect():
    """표마다 parquet 파일을 보는 이름(view)을 만든다. 메모리 안에서만."""
    con = duckdb.connect(":memory:")
    for name in sorted(os.listdir(DATA)):
        if name.endswith(".parquet"):
            table = name[:-len(".parquet")]
            path = os.path.join(DATA, name).replace("\\", "/").replace("'", "''")
            con.execute(f"CREATE VIEW {table} AS SELECT * FROM read_parquet('{path}')")
    return con


mcp = FastMCP("edata9-data")


@mcp.tool()
def list_tables() -> str:
    """이 폴더의 표 목록 — 표 이름, 한 줄이 무엇인지(grain), 행 수. 조회하기 전에 먼저 본다."""
    schema = load_schema()
    lines = [schema.get("note", ""), ""]
    for t, info in schema["tables"].items():
        lines.append(f"- {t}: 한 줄 = {info.get('grain', '?')} · {info.get('rows', '?')}행")
    return "\n".join(lines)


@mcp.tool()
def describe_table(table: str) -> str:
    """한 표의 열 이름과 형식, 한 줄이 무엇인지."""
    info = load_schema()["tables"].get(table)
    if not info:
        return f"«{table}» 라는 표는 없습니다. list_tables 로 이름을 확인하세요."
    cols = "\n".join(f"  - {c['name']} ({c['type']})" for c in info.get("columns", []))
    return f"{table}: 한 줄 = {info.get('grain', '?')} · {info.get('rows', '?')}행\n{cols}"


@mcp.tool()
def query(sql: str) -> str:
    """읽기 전용 SQL 한 문장을 돌린다. 결과는 «전체 행 수 + 앞 20행». 바꾸는 명령은 돌지 않는다."""
    safe = read_only(sql)
    if not safe:
        return "읽기(SELECT · WITH)만 실행합니다. 한 문장만, 바꾸는 명령 없이."
    con = connect()
    try:
        total = con.execute(f"SELECT COUNT(*) FROM ({safe}) AS q").fetchone()[0]
        cur = con.execute(f"SELECT * FROM ({safe}) AS q LIMIT {MAX_ROWS}")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    except Exception as e:                      # SQL 오류는 그대로 알려 준다 — 지어내지 않게
        return f"SQL 오류: {e}"
    finally:
        con.close()
    out = [f"전체 {total}행" + (f" — 앞 {MAX_ROWS}행만 보입니다" if total > MAX_ROWS else ""),
           " | ".join(cols)]
    out += [" | ".join("" if v is None else str(v) for v in r) for r in rows]
    return "\n".join(out)


if __name__ == "__main__":
    mcp.run()
