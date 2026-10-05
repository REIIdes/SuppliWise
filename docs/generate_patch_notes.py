"""
SuppliWise - Patch Notes generator.

Renders docs/patch_notes_content.py into:
  docs/SuppliWise_Patch_Notes.docx   (Word, via python-docx)
  docs/SuppliWise_Patch_Notes.html   (intermediate, print-styled)
  docs/SuppliWise_Patch_Notes.pdf    (via Chrome/Edge headless --print-to-pdf)

Usage:  python docs/generate_patch_notes.py
"""

import html as html_lib
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from patch_notes_content import BLOCKS, META  # noqa: E402

OUT_DIR = HERE
BASENAME = "SuppliWise_Patch_Notes"

# Palette
GREEN = "16A34A"
GREEN_DARK = "14532D"
SLATE = "0F172A"
SLATE_MID = "334155"
SLATE_SOFT = "64748B"
LINE = "E2E8F0"
BAND = "F8FAFC"
BAND_GREEN = "F0FDF4"
AMBER = "B45309"
AMBER_BG = "FFFBEB"
AMBER_LINE = "FDE68A"


# ===========================================================================
# Inline markup: **bold**, `code`
# ===========================================================================

def _split_inline(text):
    """Yield (kind, chunk) tuples where kind is 'text' | 'bold' | 'code'."""
    pattern = re.compile(r"(\*\*.+?\*\*|`[^`]+`)", re.S)
    for part in pattern.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            yield ("bold", part[2:-2])
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            yield ("code", part[1:-1])
        else:
            yield ("text", part)


# ===========================================================================
# DOCX renderer
# ===========================================================================

def build_docx(path):
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, Cm, RGBColor

    doc = Document()

    # ---- page + base styles ------------------------------------------------
    for section in doc.sections:
        section.page_width = Cm(21.0)      # A4
        section.page_height = Cm(29.7)
        section.top_margin = Cm(2.2)
        section.bottom_margin = Cm(2.0)
        section.left_margin = Cm(2.1)
        section.right_margin = Cm(2.1)

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(SLATE)
    normal.paragraph_format.space_after = Pt(7)
    normal.paragraph_format.line_spacing = 1.16

    def style_heading(name, size, colour, before, after, bold=True, caps=False):
        st = doc.styles[name]
        st.font.name = "Calibri"
        st.font.size = Pt(size)
        st.font.bold = bold
        st.font.color.rgb = RGBColor.from_string(colour)
        st.font.all_caps = caps
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True
        st.paragraph_format.line_spacing = 1.05
        return st

    style_heading("Heading 1", 20, GREEN_DARK, 20, 9)
    style_heading("Heading 2", 14.5, SLATE, 16, 6)
    style_heading("Heading 3", 12, GREEN, 13, 4)
    style_heading("Heading 4", 10.5, SLATE_MID, 10, 3, caps=True)

    for lvl, (name, indent) in enumerate(
        [("List Bullet", Cm(0.7)), ("List Number", Cm(0.7))], start=1
    ):
        st = doc.styles[name]
        st.font.name = "Calibri"
        st.font.size = Pt(10.5)
        st.font.color.rgb = RGBColor.from_string(SLATE)
        st.paragraph_format.space_after = Pt(3)
        st.paragraph_format.line_spacing = 1.13

    def shade(el, colour):
        sh = OxmlElement("w:shd")
        sh.set(qn("w:val"), "clear")
        sh.set(qn("w:color"), "auto")
        sh.set(qn("w:fill"), colour)
        el.append(sh)

    def cell_shade(cell, colour):
        shade(cell._tc.get_or_add_tcPr(), colour)

    def cell_borders(cell, **edges):
        tcPr = cell._tc.get_or_add_tcPr()
        borders = OxmlElement("w:tcBorders")
        for edge, spec in edges.items():
            e = OxmlElement(f"w:{edge}")
            e.set(qn("w:val"), spec.get("val", "single"))
            e.set(qn("w:sz"), str(spec.get("sz", 4)))
            e.set(qn("w:space"), "0")
            e.set(qn("w:color"), spec.get("color", LINE))
            borders.append(e)
        tcPr.append(borders)

    def para_border(paragraph, colour=GREEN, size=18):
        pPr = paragraph._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), str(size))
        bottom.set(qn("w:space"), "4")
        bottom.set(qn("w:color"), colour)
        pbdr.append(bottom)
        pPr.append(pbdr)

    def keep_together(paragraph):
        pPr = paragraph._p.get_or_add_pPr()
        kn = OxmlElement("w:keepLines")
        pPr.append(kn)

    def repeat_header(row):
        trPr = row._tr.get_or_add_trPr()
        th = OxmlElement("w:tblHeader")
        th.set(qn("w:val"), "true")
        trPr.append(th)

    def rich(paragraph, text, size=None, colour=None, base_bold=False):
        for kind, chunk in _split_inline(text):
            run = paragraph.add_run(chunk)
            run.font.name = "Calibri"
            if size:
                run.font.size = Pt(size)
            if colour:
                run.font.color.rgb = RGBColor.from_string(colour)
            if kind == "bold":
                run.font.bold = True
            elif kind == "code":
                run.font.name = "Consolas"
                run.font.size = Pt((size or 10.5) - 1.0)
                run.font.color.rgb = RGBColor.from_string(GREEN_DARK)
            elif base_bold:
                run.font.bold = True

    # ---- cover page --------------------------------------------------------
    for _ in range(3):
        doc.add_paragraph()

    brand = doc.add_paragraph()
    brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = brand.add_run("SUPPLIWISE")
    r.font.name = "Calibri"
    r.font.size = Pt(13)
    r.font.bold = True
    r.font.color.rgb = RGBColor.from_string(GREEN)
    rpr = r._element.get_or_add_rPr()
    sp = OxmlElement("w:spacing")
    sp.set(qn("w:val"), "90")
    rpr.append(sp)

    doc.add_paragraph()

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(4)
    r = title.add_run("Comprehensive Patch Notes")
    r.font.name = "Calibri"
    r.font.size = Pt(32)
    r.font.bold = True
    r.font.color.rgb = RGBColor.from_string(SLATE)

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = sub.add_run("Complete record of every feature added to the platform")
    r.font.name = "Calibri"
    r.font.size = Pt(12.5)
    r.font.color.rgb = RGBColor.from_string(SLATE_SOFT)
    para_border(sub, LINE, 6)
    sub.paragraph_format.space_after = Pt(24)

    meta_rows = [
        ("Release", META["release"] + "  (build " + META["build"] + ")"),
        ("Date", META["date"]),
        ("Document", META["docid"] + "  |  " + META["revision"]),
        ("Baseline", META["baseline"]),
        ("Classification", META["classification"]),
        ("Platform", "React 18 + Vite 8 client  |  Node 18 + Express 4 + Mongoose 8 API"),
    ]
    tbl = doc.add_table(rows=0, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    for k, v in meta_rows:
        row = tbl.add_row()
        c0, c1 = row.cells
        c0.width = Cm(3.6)
        c1.width = Cm(12.4)
        p0 = c0.paragraphs[0]
        p0.paragraph_format.space_after = Pt(3)
        r = p0.add_run(k.upper())
        r.font.size = Pt(8.5)
        r.font.bold = True
        r.font.color.rgb = RGBColor.from_string(SLATE_SOFT)
        p1 = c1.paragraphs[0]
        p1.paragraph_format.space_after = Pt(3)
        r = p1.add_run(v)
        r.font.size = Pt(10)
        r.font.color.rgb = RGBColor.from_string(SLATE)
        for c in (c0, c1):
            cell_shade(c, BAND)
            cell_borders(c, top={"sz": 0, "val": "nil"}, bottom={"sz": 0, "val": "nil"},
                         left={"sz": 0, "val": "nil"}, right={"sz": 0, "val": "nil"})

    doc.add_paragraph()
    contents = doc.add_paragraph()
    contents.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = contents.add_run(
        "1  Release Overview\n"
        "2  Member Experience\n"
        "3  Web3 and Blockchain Layer\n"
        "4  Administrator Console\n"
        "5  Backend and API\n"
        "6  Security Programme\n"
        "7  Progressive Web App and Mobile\n"
        "8  Testing and Verification\n"
        "9  Known Gaps and Manual Actions\n"
        "10  Appendix - Feature to Source Map"
    )
    r.font.name = "Consolas"
    r.font.size = Pt(9.5)
    r.font.color.rgb = RGBColor.from_string(SLATE_MID)

    # ---- footer with page numbers -----------------------------------------
    footer_p = doc.sections[0].footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = footer_p.add_run(f"{META['product']} {META['release']} - Patch Notes   |   Page ")
    fr.font.size = Pt(8)
    fr.font.color.rgb = RGBColor.from_string(SLATE_SOFT)
    _add_field(footer_p, "PAGE")
    fr2 = footer_p.add_run(" of ")
    fr2.font.size = Pt(8)
    fr2.font.color.rgb = RGBColor.from_string(SLATE_SOFT)
    _add_field(footer_p, "NUMPAGES")

    # ---- content -----------------------------------------------------------
    def emit_table(headers, rows, widths):
        t = doc.add_table(rows=1, cols=len(headers))
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.autofit = False
        hdr = t.rows[0]
        repeat_header(hdr)
        for i, htxt in enumerate(headers):
            c = hdr.cells[i]
            c.width = Cm(widths[i])
            para = c.paragraphs[0]
            para.paragraph_format.space_before = Pt(3)
            para.paragraph_format.space_after = Pt(3)
            run = para.add_run(htxt.upper())
            run.font.size = Pt(8.5)
            run.font.bold = True
            run.font.color.rgb = RGBColor.from_string("FFFFFF")
            cell_shade(c, SLATE)
            cell_borders(c, top={"sz": 0, "val": "nil"}, left={"sz": 0, "val": "nil"},
                         right={"sz": 0, "val": "nil"}, bottom={"sz": 0, "val": "nil"})
        for ri, rowvals in enumerate(rows):
            cells = t.add_row().cells
            for i, val in enumerate(rowvals):
                if i >= len(headers):
                    continue
                c = cells[i]
                c.width = Cm(widths[i])
                para = c.paragraphs[0]
                para.paragraph_format.space_before = Pt(3)
                para.paragraph_format.space_after = Pt(3)
                para.paragraph_format.line_spacing = 1.1
                keep_together(para)
                rich(para, str(val), size=9.5)
                cell_shade(c, BAND if ri % 2 else "FFFFFF")
                cell_borders(c, top={"sz": 2, "color": LINE}, left={"sz": 0, "val": "nil"},
                             right={"sz": 0, "val": "nil"},
                             bottom={"sz": 2, "color": LINE})
        doc.add_paragraph().paragraph_format.space_after = Pt(2)

    for block in BLOCKS:
        kind = block[0]

        if kind == "pagebreak":
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

        elif kind in ("h1", "h2", "h3", "h4"):
            level = int(kind[1])
            para = doc.add_heading("", level=level)
            rich(para, block[1], size=None)
            if level == 1:
                para_border(para, GREEN, 12)
            elif level == 2:
                para_border(para, LINE, 6)

        elif kind == "p":
            para = doc.add_paragraph()
            rich(para, block[1])

        elif kind == "lead":
            para = doc.add_paragraph()
            para.paragraph_format.space_after = Pt(10)
            rich(para, block[1], size=11, colour=SLATE_MID)

        elif kind in ("bullets", "numbers"):
            style = "List Bullet" if kind == "bullets" else "List Number"
            for item in block[1]:
                para = doc.add_paragraph(style=style)
                para.paragraph_format.space_after = Pt(3)
                rich(para, item, size=10)

        elif kind == "table":
            _, headers, rows, widths = block
            n = len(headers)
            if not widths:
                widths = [16.8 / n] * n
            emit_table(headers, rows, widths)

        elif kind == "note":
            _, title, text = block
            t = doc.add_table(rows=1, cols=1)
            c = t.rows[0].cells[0]
            c.width = Cm(16.8)
            para = c.paragraphs[0]
            para.paragraph_format.space_before = Pt(5)
            para.paragraph_format.space_after = Pt(2)
            run = para.add_run(title.upper())
            run.font.size = Pt(8.5)
            run.font.bold = True
            run.font.color.rgb = RGBColor.from_string(AMBER)
            para2 = c.add_paragraph()
            para2.paragraph_format.space_after = Pt(5)
            rich(para2, text, size=10)
            cell_shade(c, AMBER_BG)
            cell_borders(c,
                         top={"sz": 2, "color": AMBER_LINE},
                         bottom={"sz": 2, "color": AMBER_LINE},
                         left={"sz": 18, "color": "F59E0B"},
                         right={"sz": 2, "color": AMBER_LINE})
            doc.add_paragraph().paragraph_format.space_after = Pt(2)

        elif kind == "files":
            for item in block[1]:
                para = doc.add_paragraph()
                para.paragraph_format.left_indent = Cm(0.5)
                para.paragraph_format.space_after = Pt(1)
                run = para.add_run(item)
                run.font.name = "Consolas"
                run.font.size = Pt(8.5)
                run.font.color.rgb = RGBColor.from_string(SLATE_SOFT)

        elif kind == "code":
            t = doc.add_table(rows=1, cols=1)
            c = t.rows[0].cells[0]
            for i, line in enumerate(block[1]):
                para = c.paragraphs[0] if i == 0 else c.add_paragraph()
                para.paragraph_format.space_after = Pt(0)
                run = para.add_run(line)
                run.font.name = "Consolas"
                run.font.size = Pt(8.5)
            cell_shade(c, BAND)
            cell_borders(c, top={"sz": 2, "color": LINE}, bottom={"sz": 2, "color": LINE},
                         left={"sz": 2, "color": LINE}, right={"sz": 2, "color": LINE})
            doc.add_paragraph().paragraph_format.space_after = Pt(2)

    doc.save(path)
    return path


def _add_field(paragraph, code):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {code} "
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr)
    run._r.append(fld_end)
    run.font.size = Pt(8)
    run.font.color.rgb = RGBColor.from_string(SLATE_SOFT)


# ===========================================================================
# HTML renderer (intermediate for the PDF)
# ===========================================================================

def inline_html(text):
    out = []
    for kind, chunk in _split_inline(text):
        esc = html_lib.escape(chunk)
        if kind == "bold":
            out.append(f"<strong>{esc}</strong>")
        elif kind == "code":
            out.append(f"<code>{esc}</code>")
        else:
            out.append(esc)
    return "".join(out)


def build_html(path):
    e = html_lib.escape

    # The palette constants are bare hex (python-docx wants them without a '#'),
    # so re-bind CSS-local names with the prefix CSS requires.
    # Read them out of the module globals: assigning the same names below makes
    # them function-local for the whole scope, so a plain reference would fail.
    _pal = globals()
    GREEN, GREEN_DARK, SLATE, SLATE_MID, SLATE_SOFT, LINE, BAND, BAND_GREEN, AMBER, AMBER_BG, AMBER_LINE = (
        "#" + _pal[k] for k in (
            "GREEN", "GREEN_DARK", "SLATE", "SLATE_MID", "SLATE_SOFT", "LINE",
            "BAND", "BAND_GREEN", "AMBER", "AMBER_BG", "AMBER_LINE",
        )
    )

    parts = []
    parts.append(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{e(META['product'])} - {e(META['title'])}</title>
<style>
@page {{
  size: A4;
  margin: 18mm 16mm 16mm 16mm;
  @bottom-left {{
    content: "{META['product']}  |  {META['release']}  |  {META['docid']}";
    font: 8pt "Segoe UI", sans-serif; color: {SLATE_SOFT};
  }}
  @bottom-right {{
    content: "Page " counter(page) " of " counter(pages);
    font: 8pt "Segoe UI", sans-serif; color: {SLATE_SOFT};
  }}
}}
* {{ box-sizing: border-box; }}
html, body {{
  margin: 0; padding: 0;
  font-family: "Segoe UI", "Calibri", system-ui, sans-serif;
  color: {SLATE};
  font-size: 10.2pt;
  line-height: 1.5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}
.cover {{
  page-break-after: always;
  height: 258mm;
  display: flex; flex-direction: column; justify-content: center;
  text-align: center;
}}
.brand {{
  font-size: 12pt; font-weight: 700; letter-spacing: .34em;
  color: {GREEN}; margin-bottom: 6mm;
}}
.cover h1 {{
  font-size: 33pt; line-height: 1.12; margin: 0 0 4mm;
  color: {SLATE}; font-weight: 700;
}}
.cover .sub {{
  font-size: 12pt; color: {SLATE_SOFT}; margin: 0 0 14mm;
  padding-bottom: 10mm; border-bottom: 1px solid {LINE};
}}
.cmeta {{
  width: 118mm; margin: 0 auto 14mm; border-collapse: collapse; text-align: left;
}}
.cmeta td {{ padding: 2.4mm 0; border: none; font-size: 9.6pt; }}
.cmeta td.k {{
  width: 34mm; color: {SLATE_SOFT}; font-weight: 700;
  font-size: 7.6pt; letter-spacing: .1em; text-transform: uppercase;
  vertical-align: top; padding-top: 2.9mm;
}}
.toc {{
  font-family: Consolas, "Courier New", monospace;
  font-size: 9pt; line-height: 1.85; color: {SLATE_MID};
  white-space: pre; text-align: left; width: 118mm; margin: 0 auto;
}}
h1.sec {{
  font-size: 19pt; color: {GREEN_DARK}; font-weight: 700;
  margin: 0 0 4mm; padding-bottom: 2.6mm; border-bottom: 2.5px solid {GREEN};
  page-break-before: always; page-break-after: avoid;
}}
h1.sec.first {{ page-break-before: avoid; }}
h2 {{ font-size: 14pt; color: {SLATE}; font-weight: 700;
      margin: 9mm 0 2.6mm; padding-bottom: 1.4mm; border-bottom: 1px solid {LINE};
      page-break-after: avoid; }}
h3 {{ font-size: 11.4pt; color: {GREEN}; font-weight: 700;
      margin: 6.5mm 0 1.8mm; page-break-after: avoid; }}
h4 {{ font-size: 9pt; color: {SLATE_MID}; font-weight: 700;
      letter-spacing: .1em; text-transform: uppercase;
      margin: 5mm 0 1.5mm; page-break-after: avoid; }}
p {{ margin: 0 0 2.8mm; orphans: 2; widows: 2; }}
p.lead {{ font-size: 11pt; color: {SLATE_MID}; margin-bottom: 4mm; }}
ul, ol {{ margin: 0 0 3.2mm; padding-left: 6.2mm; }}
li {{ margin-bottom: 1.5mm; }}
code {{ font-family: Consolas, "Courier New", monospace; font-size: 8.9pt;
        color: {GREEN_DARK}; background: {BAND}; padding: .3mm .9mm; border-radius: 2px; }}
.files {{ margin: -1mm 0 3.5mm; padding-left: 1mm; }}
.files div {{
  font-family: Consolas, "Courier New", monospace; font-size: 8.4pt;
  color: {SLATE_SOFT}; line-height: 1.45;
}}
table {{
  width: 100%; border-collapse: collapse; margin: 0 0 4mm;
  font-size: 9.2pt; page-break-inside: avoid;
}}
th {{
  background: {SLATE}; color: #fff; text-align: left;
  font-size: 7.8pt; font-weight: 700; letter-spacing: .09em;
  text-transform: uppercase; padding: 2.1mm 2.4mm;
}}
td {{ padding: 2.1mm 2.4mm; border-top: 1px solid {LINE}; border-bottom: 1px solid {LINE};
      vertical-align: top; line-height: 1.42; }}
tr:nth-child(even) td {{ background: {BAND}; }}
.note {{
  background: {AMBER_BG}; border: 1px solid {AMBER_LINE};
  border-left: 4px solid #F59E0B;
  padding: 3mm 3.6mm; margin: 0 0 4mm; border-radius: 0 4px 4px 0;
  page-break-inside: avoid;
}}
.note .nt {{
  font-size: 7.8pt; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; color: {AMBER}; margin-bottom: 1.4mm;
}}
.note p {{ margin: 0; font-size: 9.4pt; }}
pre {{
  background: {BAND}; border: 1px solid {LINE}; padding: 3mm;
  font-size: 8.4pt; overflow: hidden; page-break-inside: avoid;
}}
</style></head><body>
""")

    # cover
    parts.append(f"""
<div class="cover">
  <div class="brand">SUPPLIWISE</div>
  <h1>{e(META['title'])}</h1>
  <div class="sub">{e(META['subtitle'])}</div>
  <table class="cmeta">
    <tr><td class="k">Release</td><td>{e(META['release'])} &nbsp;&middot;&nbsp; build {e(META['build'])}</td></tr>
    <tr><td class="k">Date</td><td>{e(META['date'])}</td></tr>
    <tr><td class="k">Document</td><td>{e(META['docid'])} &nbsp;&middot;&nbsp; {e(META['revision'])}</td></tr>
    <tr><td class="k">Baseline</td><td>{e(META['baseline'])}</td></tr>
    <tr><td class="k">Classification</td><td>{e(META['classification'])}</td></tr>
    <tr><td class="k">Platform</td><td>React 18 + Vite 8 client &nbsp;|&nbsp; Node 18 + Express 4 + Mongoose 8 API</td></tr>
  </table>
  <div class="toc">1  Release Overview
2  Member Experience
3  Web3 and Blockchain Layer
4  Administrator Console
5  Backend and API
6  Security Programme
7  Progressive Web App and Mobile
8  Testing and Verification
9  Known Gaps and Manual Actions
10  Appendix - Feature to Source Map</div>
</div>
""")

    first_h1 = True
    for block in BLOCKS:
        kind = block[0]
        if kind == "pagebreak":
            continue
        if kind == "h1":
            cls = "sec first" if first_h1 else "sec"
            first_h1 = False
            parts.append(f'<h1 class="{cls}">{inline_html(block[1])}</h1>')
        elif kind == "h2":
            parts.append(f"<h2>{inline_html(block[1])}</h2>")
        elif kind == "h3":
            parts.append(f"<h3>{inline_html(block[1])}</h3>")
        elif kind == "h4":
            parts.append(f"<h4>{inline_html(block[1])}</h4>")
        elif kind == "p":
            parts.append(f"<p>{inline_html(block[1])}</p>")
        elif kind == "lead":
            parts.append(f'<p class="lead">{inline_html(block[1])}</p>')
        elif kind == "bullets":
            items = "".join(f"<li>{inline_html(i)}</li>" for i in block[1])
            parts.append(f"<ul>{items}</ul>")
        elif kind == "numbers":
            items = "".join(f"<li>{inline_html(i)}</li>" for i in block[1])
            parts.append(f"<ol>{items}</ol>")
        elif kind == "table":
            _, headers, rows, widths = block
            cols = ""
            if widths:
                total = float(sum(widths))
                cols = "<colgroup>" + "".join(
                    f'<col style="width:{w / total * 100:.2f}%">' for w in widths
                ) + "</colgroup>"
            head = "".join(f"<th>{inline_html(h)}</th>" for h in headers)
            body = "".join(
                "<tr>" + "".join(f"<td>{inline_html(c)}</td>" for c in row) + "</tr>"
                for row in rows
            )
            parts.append(f"<table>{cols}<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>")
        elif kind == "note":
            _, title, text = block
            parts.append(
                f'<div class="note"><div class="nt">{inline_html(title)}</div>'
                f"<p>{inline_html(text)}</p></div>"
            )
        elif kind == "files":
            items = "".join(f"<div>{e(i)}</div>" for i in block[1])
            parts.append(f'<div class="files">{items}</div>')
        elif kind == "code":
            parts.append("<pre>" + "\n".join(e(l) for l in block[1]) + "</pre>")

    parts.append("</body></html>")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    return path


# ===========================================================================
# PDF via headless Chrome / Edge
# ===========================================================================

def find_browser():
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def build_pdf(html_path, pdf_path):
    browser = find_browser()
    if not browser:
        print("  ! no Chromium-based browser found - skipping PDF")
        return None
    profile = os.path.join(OUT_DIR, ".chrome-profile")
    cmd = [
        browser,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        "--print-to-pdf-no-header",
        f"--user-data-dir={profile}",
        f"--print-to-pdf={pdf_path}",
        "file:///" + html_path.replace("\\", "/"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    for _ in range(40):
        if os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 20000:
            break
        time.sleep(0.5)
    shutil.rmtree(profile, ignore_errors=True)
    if os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 20000:
        return pdf_path
    print("  ! PDF generation failed")
    print(result.stdout[-800:])
    print(result.stderr[-800:])
    return None


# ===========================================================================

def main():
    docx_path = os.path.join(OUT_DIR, BASENAME + ".docx")
    html_path = os.path.join(OUT_DIR, BASENAME + ".html")
    pdf_path = os.path.join(OUT_DIR, BASENAME + ".pdf")

    print("Rendering patch notes ...")
    print(f"  blocks: {len(BLOCKS)}")
    print(f"  words : {sum(len(str(b)) for b in BLOCKS):,}")

    build_docx(docx_path)
    print(f"  [ok] {docx_path}  ({os.path.getsize(docx_path):,} bytes)")

    build_html(html_path)
    print(f"  [ok] {html_path}  ({os.path.getsize(html_path):,} bytes)")

    out = build_pdf(html_path, pdf_path)
    if out:
        print(f"  [ok] {out}  ({os.path.getsize(out):,} bytes)")

    if os.path.isfile(html_path):
        os.remove(html_path)
        print("  [ok] removed intermediate HTML")


if __name__ == "__main__":
    main()
