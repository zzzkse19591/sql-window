# -*- coding: utf-8 -*-
"""준비한 질문의 SQL이 «확인할 값»을 내는지 파이썬 DuckDB로 검산한다.

    python tools/verify_sql.py            사람이 읽는 표
    python tools/verify_sql.py --json     질문별 결과 (브라우저 결과와 대조용)

브라우저의 DuckDB-WASM 과 같은 SQL을 같은 parquet 에 돌린다. 둘이 다르면 어딘가 틀렸다.
"""
import io
import json
import os
import sys

import duckdb

# 한글 Windows 콘솔(cp949)은 ✓ · ✕ 를 못 찍고 멈춘다 — 출력만 UTF-8 로
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
Q = json.load(io.open(os.path.join(HERE, "questions.json"), encoding="utf-8"))

con = duckdb.connect()
for f in sorted(os.listdir(DATA)):
    if f.endswith(".parquet"):
        con.execute(f"CREATE VIEW {f[:-8]} AS SELECT * FROM read_parquet('{os.path.join(DATA, f)}')")


def rows_of(sql):
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def val(x):
    return float(x) if hasattr(x, "__float__") and not isinstance(x, bool) else x


results, bad = {}, 0
for q in Q["questions"]:
    rows = rows_of(q["sql"])
    results[q["id"]] = [{k: val(v) for k, v in r.items()} for r in rows]
    for c in q["check"]:
        hit = [r for r in rows if all(r.get(k) == v for k, v in c.get("where", {}).items())]
        got = val(hit[0][c["col"]]) if hit else None
        ok = got is not None and abs(got - c["want"]) < 1e-9
        bad += not ok
        if "--json" not in sys.argv:
            where = " ".join(f"{k}={v}" for k, v in c.get("where", {}).items())
            print(f"  {'✓' if ok else '✕'} {q['id']:<10} {where:<16} {c['col']:<10} 확인할 값 {c['want']:<10} 실제 {got}")

if "--json" in sys.argv:
    print(json.dumps(results, ensure_ascii=False))
else:
    print(f"\n질문 {len(Q['questions'])}개 · 어긋남 {bad}건")
sys.exit(1 if bad else 0)
