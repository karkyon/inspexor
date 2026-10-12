"""docs/deliverables/*.md → 提案書と同じ配色の A4 縦 PDF（納品用）。
使い方: python3 scripts/docs/render_deliverables.py docs/deliverables <出力ディレクトリ>
必要: pip install markdown playwright（Chromium は CHROMIUM_PATH で指定可）
"""
import os
import re
import sys
from pathlib import Path

import markdown
from playwright.sync_api import sync_playwright

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

CSS = """
@page { size: A4; margin: 20mm 17mm 18mm 17mm; }
:root { --navy:#16233F; --amber:#BD8226; --gray:#67707A; --text:#23262B; --line:#DBDDD3; --cream:#F4F5F1; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Yu Gothic','YuGothic','Noto Sans CJK JP',sans-serif; color: var(--text); font-size: 10pt; line-height: 1.7; margin: 0; }
.cover { height: 257mm; background: var(--cream); margin: -20mm -17mm 0 -17mm; padding: 26mm 20mm 18mm 20mm; position: relative; page-break-after: always; display: flex; flex-direction: column; }
.cover .to { font-size: 15pt; font-weight: 700; color: var(--navy); }
.cover .meta { position: absolute; right: 20mm; top: 26mm; text-align: right; font-family: Consolas,'DejaVu Sans Mono',monospace; font-size: 8.5pt; color: var(--gray); line-height: 1.6; }
.cover .eyebrow { margin-top: 62mm; font-family: Consolas,'DejaVu Sans Mono',monospace; letter-spacing: .18em; color: var(--amber); font-weight: 700; font-size: 10pt; }
.cover h1 { font-size: 28pt; line-height: 1.3; color: var(--navy); margin: 4mm 0 0 0; border: 0; padding: 0; }
.cover .sub { color: var(--gray); font-size: 11.5pt; margin-top: 4mm; }
.cover .sys { margin-top: 18mm; font-size: 13pt; font-weight: 700; color: var(--navy); }
.cover .sys small { display: block; font-weight: 400; color: var(--gray); font-size: 9pt; font-family: Consolas,'DejaVu Sans Mono',monospace; margin-top: 1mm; }
.cover .foot { margin-top: auto; border-top: 1px solid var(--line); padding-top: 3mm; display: flex; justify-content: space-between; font-size: 9pt; color: var(--gray); }
.toc { page-break-after: auto; margin-bottom: 8mm; }
.toc h2 { border: 0; }
.toc ul { list-style: none; padding-left: 0; margin: 0; }
.toc ul ul { padding-left: 6mm; }
.toc li { margin: .8mm 0; }
.toc > ul > li > a { font-weight: 700; color: var(--navy); }
.toc a { color: var(--text); text-decoration: none; }
h1 { font-size: 16pt; color: var(--navy); border-bottom: 2px solid var(--navy); padding-bottom: 1.5mm; margin: 9mm 0 4mm; page-break-after: avoid; }
h1.pb { page-break-before: always; margin-top: 0; }
h2 { font-size: 12.5pt; color: var(--navy); border-left: 4px solid var(--amber); padding-left: 2.5mm; margin: 7mm 0 3mm; page-break-after: avoid; }
h3 { font-size: 10.5pt; color: var(--navy); margin: 5mm 0 2mm; page-break-after: avoid; }
p { margin: 1.5mm 0; }
ul, ol { margin: 1.5mm 0; padding-left: 6mm; }
li { margin: .6mm 0; }
table { border-collapse: collapse; width: 100%; margin: 2.5mm 0 4mm; font-size: 8.8pt; line-height: 1.5; page-break-inside: auto; }
tr { page-break-inside: avoid; }
thead { display: table-header-group; }
th { white-space: nowrap; background: var(--navy); color: #fff; font-weight: 700; text-align: left; padding: 1.4mm 2mm; border: 1px solid var(--navy); }
td { border: 1px solid var(--line); padding: 1.3mm 2mm; vertical-align: top; background: #fff; }
tbody tr:nth-child(even) td { background: #FAFAF7; }
td[style*="center"], th[style*="center"] { text-align: center; }
code { font-family: Consolas,'DejaVu Sans Mono',monospace; font-size: 8.6pt; background: var(--cream); padding: 0 1mm; border-radius: 2px; }
figure { margin: 4mm 0; page-break-inside: avoid; text-align: center; }
figure svg { width: 100%; height: auto; }
figcaption { font-size: 8.5pt; color: var(--gray); margin-top: 1.5mm; }
strong { color: var(--navy); }
"""

HEADER = '<div style="width:100%;font-size:7.5pt;color:#7891A6;padding:0 17mm;display:flex;justify-content:space-between;font-family:Noto Sans CJK JP,sans-serif;"><span>三成興業株式会社様　作業日報デジタル化システム</span><span>{title}</span></div>'
FOOTER = '<div style="width:100%;font-size:7.5pt;color:#7891A6;padding:0 17mm;display:flex;justify-content:space-between;font-family:Consolas,monospace;"><span>{docno}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'


def parse(md_text: str):
    m = re.match(r"^---\n(.*?)\n---\n", md_text, re.S)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
        md_text = md_text[m.end():]
    return meta, md_text


def build(md_path: Path) -> tuple[str, dict]:
    meta, body = parse(md_path.read_text(encoding="utf-8"))
    md = markdown.Markdown(extensions=["tables", "toc", "attr_list", "md_in_html"], extension_configs={"toc": {"toc_depth": "1-2"}})
    html = md.convert(body)
    # 第1章以降の h1 は改ページ（改訂履歴の後）
    count = {"n": 0}

    def h1(mm):
        count["n"] += 1
        return mm.group(0) if count["n"] == 1 else mm.group(0).replace("<h1", '<h1 class="pb"', 1)

    html = re.sub(r"<h1[^>]*>", h1, html)
    toc = md.toc
    cover = f"""
<section class="cover">
  <div class="to">合同会社NINE　御中</div>
  <div class="meta">DOCUMENT No. {meta.get('docno','')}<br>版 {meta.get('version','')}<br>作成日 {meta.get('date','')}<br>作成者 有馬　順史</div>
  <div class="eyebrow">SANSEI 現場報告システム</div>
  <h1>三成興業株式会社様向け<br>作業日報デジタル化システム<br>{meta.get('title','')}</h1>
  <div class="sub">{meta.get('subtitle','')}</div>
  <div class="sys">SANSEI 現場報告システム<small>提案書 SK-2026-08-MINI（2026年9月5日）にもとづく納品資料</small></div>
  <div class="foot"><span>{meta.get('docno','')}</span><span>{meta.get('title','')}</span></div>
</section>"""
    doc = f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>{meta.get('title','')}</title><style>{CSS}</style></head>
<body>{cover}<section class="toc"><h2>目次</h2>{toc}</section>{html}</body></html>"""
    return doc, meta


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
    page = browser.new_page()
    for md_path in sorted(SRC.glob("*.md")):
        html, meta = build(md_path)
        tmp = OUT / (md_path.stem + ".html")
        tmp.write_text(html, encoding="utf-8")
        page.goto(tmp.resolve().as_uri())
        page.pdf(
            path=str(OUT / (md_path.stem + ".pdf")),
            format="A4",
            print_background=True,
            display_header_footer=True,
            header_template=HEADER.format(title=meta.get("title", "")),
            footer_template=FOOTER.format(docno=meta.get("docno", "")),
            margin={"top": "20mm", "bottom": "18mm", "left": "17mm", "right": "17mm"},
        )
        print("wrote", md_path.stem)
    browser.close()
