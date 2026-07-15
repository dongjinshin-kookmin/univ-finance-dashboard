# -*- coding: utf-8 -*-
"""build_html.py — src/* + JSON 데이터 → 자체완결 단일 HTML 번들.

<link rel=stylesheet> → 인라인 <style>, <script src> → 인라인 <script>,
<script id="DATA">의 /*__DATA__*/ 토큰 → JSON 내용 치환.
외부 의존/네트워크 요청이 전혀 없어 file:// 로 열어도 동작한다.

사용:
  python3 dashboard/build_html.py --data build/dashboard_mock_data.json \
      --out dashboard/dashboard_mock.html [--minify]
"""
import argparse
import base64
import mimetypes
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def inline_css_assets(css):
    """CSS url(assets/…) 로컬 참조 → data URI 인라인. 외부/데이터/앵커 참조는 보존."""
    def repl(m):
        raw = m.group(1).strip().strip('\'"')
        if raw.startswith("data:") or raw.startswith("#") or "://" in raw:
            return m.group(0)
        path = os.path.normpath(os.path.join(SRC, raw))
        if not os.path.isfile(path):
            return m.group(0)
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return 'url("data:' + mime + ";base64," + b64 + '")'
    return re.sub(r"url\(\s*([^)]+?)\s*\)", repl, css)


def escape_for_script(json_text):
    # </script> 조기 종료 방지. JSON 안전 문자열.
    return json_text.replace("</", "<\\/")


def minify_js(js):
    # 보수적 최소화: 줄 앞뒤 공백 제거 + 빈 줄 삭제 (문자열/정규식 손상 위험 있는 공격적 최소화는 회피)
    out = []
    for line in js.split("\n"):
        s = line.strip()
        if not s:
            continue
        # 전체 줄 주석만 제거(인라인 // 은 URL 등 손상 위험 → 보존)
        if s.startswith("//"):
            continue
        out.append(s)
    return "\n".join(out)


def minify_css(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"\s*\n\s*", " ", css)
    css = re.sub(r"\s{2,}", " ", css)
    return css.strip()


def build(data_path, out_path, do_minify=False):
    html = read(os.path.join(SRC, "index.html"))

    # 1) CSS 인라인
    def repl_link(m):
        href = m.group(1)
        css = read(os.path.join(SRC, href))
        css = inline_css_assets(css)   # url(assets/…) → data URI (인라인 후 최소화)
        if do_minify:
            css = minify_css(css)
        return "<style>\n" + css + "\n</style>"
    html = re.sub(r'<link[^>]*rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)["\'][^>]*>',
                  repl_link, html)

    # 2) JS 인라인 (DATA 스크립트는 건너뜀)
    def repl_script(m):
        src = m.group(1)
        js = read(os.path.join(SRC, src))
        if do_minify:
            js = minify_js(js)
        return "<script>\n" + js + "\n</script>"
    html = re.sub(r'<script[^>]*src=["\']([^"\']+)["\'][^>]*>\s*</script>',
                  repl_script, html)

    # 3) 데이터 토큰 치환
    data_text = read(data_path)
    if "/*__DATA__*/" not in html:
        raise SystemExit("index.html에 /*__DATA__*/ 토큰이 없습니다.")
    html = html.replace("/*__DATA__*/", escape_for_script(data_text))

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    size = os.path.getsize(out_path)
    print("built", out_path, "({:.2f} MB)".format(size / 1024 / 1024))
    # 자체완결성 점검 (src/href 속성 + CSS url() 양쪽)
    leftover = re.findall(r'(?:src|href)=["\'](?!data:|#)([^"\']+)["\']', html)
    ext = [u for u in leftover if not u.startswith("data:")]
    css_urls = re.findall(r'url\(\s*["\']?([^)"\']+?)["\']?\s*\)', html)
    ext += [u for u in css_urls if not (u.startswith("data:") or u.startswith("#"))]
    if ext:
        print("  경고: 외부 참조 잔존:", ext)
    else:
        print("  자체완결 OK (외부 참조 없음)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--minify", action="store_true")
    args = ap.parse_args()
    build(os.path.abspath(args.data), os.path.abspath(args.out), args.minify)


if __name__ == "__main__":
    main()
