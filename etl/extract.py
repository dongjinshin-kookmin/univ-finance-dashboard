# -*- coding: utf-8 -*-
"""추출 단계: openpyxl read_only 로 교비회계 수입/지출 시트를 읽는다.

컬럼 식별자는 항상 (side, col_idx) 위치 기반이다. 헤더 문자열은 중복이 있어
키로 쓰지 않는다. 반환값은 원본 헤더 리스트와 데이터 행 리스트다.
row[0]=회계연도, row[1]=항목(학교명), row[2:]=계정 값.
"""
import openpyxl

import config


def _sheet_name(side):
    if side == "in":
        return config.SHEET_IN
    if side == "ex":
        return config.SHEET_EX
    raise ValueError(f"unknown side: {side!r}")


def extract_side(side):
    """(headers, rows) 반환.

    headers: 원본 헤더 문자열 리스트 (row 0 그대로).
    rows: 데이터 행 리스트(list). 각 행 길이는 헤더 길이에 맞춰 패딩.
    """
    ws = None
    wb = openpyxl.load_workbook(config.XLSX_PATH, read_only=True, data_only=True)
    try:
        ws = wb[_sheet_name(side)]
        it = ws.iter_rows(values_only=True)
        headers = list(next(it))
        ncols = len(headers)
        rows = []
        for r in it:
            r = list(r)
            # 완전 빈 행 스킵 (학교명·연도 둘 다 비면 데이터 아님)
            if (r[0] is None or r[0] == "") and (len(r) < 2 or r[1] is None or r[1] == ""):
                continue
            if len(r) < ncols:
                r = r + [None] * (ncols - len(r))
            rows.append(r)
        return headers, rows
    finally:
        wb.close()


def extract_all():
    """수입/지출 양측을 한 번에 추출."""
    hin, din = extract_side("in")
    hex_, dex = extract_side("ex")
    return {"in": (hin, din), "ex": (hex_, dex)}


if __name__ == "__main__":
    for side in ("in", "ex"):
        h, d = extract_side(side)
        print(f"[{side}] cols={len(h)} rows={len(d)}")
