# -*- coding: utf-8 -*-
"""등록금 인상 법정상한(price_cap) 시계열 산출 — 고등교육법 제11조.

법정상한 산식(고등교육법 제11조):
  등록금 인상률 ≤ 직전 3개 연도 평균 소비자물가상승률 × 배수
    cap(t) = mean(cpi(t-1), cpi(t-2), cpi(t-3)) × MULT(t)
  * MULT = 1.5 (2025학년도까지) → 1.2 (2026학년도부터, 2025년 고등교육법 개정 시행)
  시뮬레이션 π_cap 시나리오가 이 값을 사용(docs/시뮬레이션_모델_설계.md 4.2/10.2절).

소비자물가상승률(cpi_yoy) 소스: KOSIS 통계표 DT_1J22003
  "소비자물가지수(품목성질별: 2020=100)" (orgId=101, 통계청 소비자물가조사)
  항목 ITM_ID=T(소비자물가지수 총지수), 지역 C=T10(전국), 연간(Y) 지수.
  → YoY = idx(t)/idx(t-1) - 1 을 계산, 통계청 공표 관례에 맞춰 0.1%p 반올림.

수집 경로는 fetch_population.py / fetch_population_actual.py 와 동일한 무인증 CSV
다운로드 역설계(statHtmlContent → downGrid → downNormal)를 재사용한다.

KOSIS 접근 실패 시 CPI_FALLBACK(하드코딩 표)로 대체한다. 이 값들은 통계청
소비자물가조사 연간 총지수 전년비 공표치이며, KOSIS DT_1J22003 지수 실측
(2012=91.815 … 2025=116.61)과 교육부 등록금 법정상한 공고를 통해 교차검증했다.

법정상한은 교육부가 매년 공고하며 산식(반올림·잠정치)상 소폭 차이가 나므로,
공고값(OFFICIAL_CAP)이 있는 연도는 공고값을 cap_rate로 우선 채택하고,
없는 연도(2016~2020)는 산식값을 사용한다. 산식 검증 대조표는 build/d6_report.md.

산출:
  metadata/raw/kosis_cpi.csv          (KOSIS 원본 CSV 캐시, 탭구분)
  build/interim/price_cap.csv
    year, cpi_yoy, cap_rate           (비율=소수, 예 0.0549)

멱등: raw 캐시가 있으면 재다운로드하지 않는다(--force 로 강제).
"""
import csv
import json
import re
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from etl.config import INTERIM_DIR, METADATA_DIR
except Exception:  # 스크립트 직접 실행 대비
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from etl.config import INTERIM_DIR, METADATA_DIR

import requests

RAW_DIR = METADATA_DIR / "raw"
RAW_CSV = RAW_DIR / "kosis_cpi.csv"
OUT_CSV = INTERIM_DIR / "price_cap.csv"

ORG_ID = "101"
TBL_ID = "DT_1J22003"
CONN = "I2"
REF_URL = ("https://kosis.kr/statHtml/statHtml.do?orgId=%s&tblId=%s&conn_path=%s"
           % (ORG_ID, TBL_ID, CONN))

ITEM = "T"       # ITM_ID: 소비자물가지수(총지수)
REGION = "T10"   # C(지역): 전국
# 지수 수집 범위: cap 2016 산출에 직전 3개년(2013~2015) 필요 → YoY 2013 위해 2012부터.
IDX_YEAR_START, IDX_YEAR_END = 2012, 2025

# 출력 커버리지(cap 연도).
CAP_YEAR_START, CAP_YEAR_END = 2016, 2026

# 배수: 고등교육법 제11조. 2025년 개정으로 2026학년도부터 1.5 → 1.2.
def multiplier(cap_year):
    return 1.5 if cap_year <= 2025 else 1.2

# ── 소비자물가상승률 전국 총지수 전년비(%) — 통계청 공표치 ──────────────
# 출처①: 통계청 소비자물가조사(KOSIS DT_1J22003 연간 총지수 지수로 재계산 일치).
# 출처②: 교육부 등록금 법정상한 공고(직전 3개년 평균 산정 근거치)로 교차검증.
# 예: 2022=5.1, 2023=3.6, 2024=2.3, 2025=2.1(2026 상한 공고 근거) 모두 일치.
CPI_FALLBACK = {
    2013: 1.3, 2014: 1.3, 2015: 0.7, 2016: 1.0, 2017: 1.9, 2018: 1.5,
    2019: 0.4, 2020: 0.5, 2021: 2.5, 2022: 5.1, 2023: 3.6, 2024: 2.3,
    2025: 2.1,
}

# ── 교육부 공고 법정상한(학년도, %) ─────────────────────────────────────
# 출처: 교육부 「대학·대학원 등록금 법정 인상 한도」 연도별 공고(보도자료/moe.go.kr).
#   2021 1.20 / 2022 1.65 / 2023 4.05 / 2024 5.64 / 2025 5.49 / 2026 3.19(배수 1.2 최초 적용)
# 산식값과의 미세차는 (i) 공고 시점 잠정 CPI(당해년 1~11월) 사용, (ii) 지수 기하평균·
#   반올림 관례 때문(build/d6_report.md 대조표). 2016~2020은 공고값 미확보 → 산식값.
OFFICIAL_CAP = {
    2021: 1.20, 2022: 1.65, 2023: 4.05, 2024: 5.64, 2025: 5.49, 2026: 3.19,
}

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _param_info(shell):
    """셸의 #ParamInfo 폼 → {name: value} (기본 히든값 포함)."""
    i = shell.find('id="ParamInfo"')
    end = shell.find("</form>", i)
    seg = shell[i:end]
    params = {}
    for tag in re.findall(r"<(?:input|textarea|select)\b[^>]*>", seg):
        nm = re.search(r'\bname="([^"]*)"', tag)
        if not nm:
            continue
        val = re.search(r'\bvalue="([^"]*)"', tag)
        params.setdefault(nm.group(1), val.group(1) if val else "")
    return params


def download(force=False):
    """KOSIS CSV(탭구분) 원본을 받아 RAW_CSV 에 캐시하고 경로를 반환한다.

    실패 시 None 을 반환(호출부에서 하드코딩 폴백)."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_CSV.exists() and not force:
        print("[price_cap] cache hit: %s" % RAW_CSV.name)
        return RAW_CSV
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": UA})
        s.get(REF_URL, timeout=30, verify=False)
        shell = s.post(
            "https://kosis.kr/statHtml/statHtmlContent.do",
            data={"orgId": ORG_ID, "tblId": TBL_ID, "conn_path": CONN},
            headers={"X-Requested-With": "XMLHttpRequest", "Referer": REF_URL},
            timeout=40, verify=False,
        ).text
        params = _param_info(shell)
        if not params.get("orgId"):
            params.update({"orgId": ORG_ID, "tblId": TBL_ID})

        years = [str(y) for y in range(IDX_YEAR_START, IDX_YEAR_END + 1)]
        mk = [
            {"targetId": "PRD", "targetValue": "",
             "prdValue": "Y," + ",".join(years) + ",@"},
            {"targetId": "ITM_ID", "targetValue": ITEM, "prdValue": ""},
            {"targetId": "OV_L1_ID", "targetValue": REGION, "prdValue": ""},
        ]
        params.update({
            "fieldList": json.dumps(mk, ensure_ascii=False),
            "rowAxis": "C", "colAxis": "TIME",
            "downGridFileType": "csv", "downGridCsvType": "utf8",
            "downGridCsv": "Y", "downGridMeta": "N", "downSort": "asc",
        })
        hd = {"Referer": REF_URL}
        grid = s.post("https://kosis.kr/statHtml/downGrid.do", data=params,
                      headers=hd, timeout=120, verify=False).json()
        token = grid.get("file")
        if not token:
            raise RuntimeError("downGrid.do 파일토큰 없음: %s" % str(grid)[:200])
        params["file"] = token
        r = s.post("https://kosis.kr/statHtml/downNormal.do", data=params,
                   headers=hd, timeout=120, verify=False)
        r.raise_for_status()
        if len(r.content) < 200:
            raise RuntimeError("downNormal.do 응답 과소(%d bytes)" % len(r.content))
        RAW_CSV.write_bytes(r.content)
        print("[price_cap] saved %s (%d bytes)" % (RAW_CSV.name, len(r.content)))
        return RAW_CSV
    except Exception as e:  # 네트워크/구조 변경 → 폴백
        print("[price_cap] KOSIS 다운로드 실패 → 하드코딩 CPI 폴백: %r" % (e,))
        return None


def _decode(path):
    raw = path.read_bytes()
    for enc in ("cp949", "utf-8-sig", "euc-kr", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp949", "ignore")


def parse_index(path):
    """탭구분 원본(전국 총지수 연간 지수) → {year: index_float}."""
    txt = _decode(path)
    lines = [ln for ln in txt.splitlines() if ln.strip()]
    rows = [[c.strip().strip('"') for c in ln.split("\t")] for ln in lines]
    hdr_year = rows[0]
    hdr_kind = rows[1]
    year_of = {}
    for ci in range(1, len(hdr_year)):
        if ci < len(hdr_kind) and hdr_kind[ci] == "원데이터":
            m = re.search(r"(20\d\d)", hdr_year[ci])
            if m:
                year_of[ci] = int(m.group(1))
    idx = {}
    for r in rows[2:]:
        if not r or "전국" not in r[0]:
            continue
        for ci, year in year_of.items():
            if ci >= len(r):
                continue
            v = r[ci].replace(",", "").strip()
            if v in ("", "-", "X"):
                continue
            try:
                idx[year] = float(v)
            except ValueError:
                continue
        break  # 전국 행 하나면 충분
    return idx


def cpi_from_index(idx):
    """연간 지수 → YoY(%), 통계청 관례대로 0.1%p 반올림. {year: yoy_pct}."""
    out = {}
    for y in range(IDX_YEAR_START + 1, IDX_YEAR_END + 1):
        if y in idx and (y - 1) in idx and idx[y - 1]:
            out[y] = round((idx[y] / idx[y - 1] - 1) * 100, 1)
    return out


def resolve_cpi(force=False):
    """KOSIS 우선, 실패 시 폴백. (cpi_dict, source_label, cross_check) 반환."""
    path = download(force=force)
    if path is not None:
        try:
            idx = parse_index(path)
            cpi = cpi_from_index(idx)
            if cpi:
                # 폴백표와 교차검증(0.1%p 초과 차이만 경고).
                diffs = {y: (cpi[y], CPI_FALLBACK[y])
                         for y in cpi if y in CPI_FALLBACK
                         and abs(cpi[y] - CPI_FALLBACK[y]) > 0.1}
                # 폴백에만 있는 연도(예: 결측)는 폴백으로 보충.
                for y, v in CPI_FALLBACK.items():
                    cpi.setdefault(y, v)
                return cpi, "KOSIS DT_1J22003(지수→YoY)", diffs
        except Exception as e:
            print("[price_cap] KOSIS 파싱 실패 → 폴백: %r" % (e,))
    return dict(CPI_FALLBACK), "하드코딩(통계청 공표, KOSIS 지수 교차검증)", {}


def compute_cap_formula(cpi, cap_year):
    """산식값 cap(t) = mean(cpi[t-1..t-3]) × MULT(t), 소수 비율."""
    ys = [cap_year - 1, cap_year - 2, cap_year - 3]
    if not all(y in cpi for y in ys):
        return None
    mean_cpi = sum(cpi[y] for y in ys) / 3.0
    return mean_cpi * multiplier(cap_year) / 100.0


def build_rows(cpi):
    rows = []
    for year in range(CAP_YEAR_START, CAP_YEAR_END + 1):
        cpi_yoy = cpi.get(year)  # 당해년 CPI(미완료년=None)
        formula = compute_cap_formula(cpi, year)
        official = OFFICIAL_CAP.get(year)
        cap = official / 100.0 if official is not None else formula
        rows.append({
            "year": year,
            "cpi_yoy": "" if cpi_yoy is None else round(cpi_yoy / 100.0, 4),
            "cap_rate": "" if cap is None else round(cap, 4),
        })
    return rows


def main(force=False):
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    cpi, source, diffs = resolve_cpi(force=force)
    if diffs:
        print("[price_cap] ⚠ KOSIS vs 폴백 CPI 차이(>0.1%p): %s" % diffs)
    rows = build_rows(cpi)
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["year", "cpi_yoy", "cap_rate"])
        w.writeheader()
        w.writerows(rows)

    # 콘솔 검증 요약: 공고값 대조.
    print("[price_cap] source: %s" % source)
    print("[price_cap] price_cap.csv: %d행 (%d~%d)"
          % (len(rows), CAP_YEAR_START, CAP_YEAR_END))
    print("  year  cpi_yoy  cap(공고/산식)   비고")
    for year in range(CAP_YEAR_START, CAP_YEAR_END + 1):
        formula = compute_cap_formula(cpi, year)
        official = OFFICIAL_CAP.get(year)
        f_s = "-" if formula is None else "%.4f" % formula
        o_s = "-" if official is None else "%.4f" % (official / 100.0)
        note = ""
        if official is not None and formula is not None:
            note = "Δ%+.2f%%p" % ((official - formula * 100))
        note += (" [배수1.2]" if multiplier(year) == 1.2 else "")
        print("  %d  %6s   공고=%s 산식=%s   %s"
              % (year,
                 "-" if cpi.get(year) is None else "%.1f%%" % cpi[year],
                 o_s, f_s, note))


if __name__ == "__main__":
    main(force="--force" in sys.argv)
