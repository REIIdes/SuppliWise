"""
SuppliWise - System Manual generator.

Renders docs/system_manual_content.py into:
  docs/SuppliWise_System_Manual.docx   (Word, via python-docx)
  docs/SuppliWise_System_Manual.pdf    (via Chrome/Edge headless --print-to-pdf)

Layout is deliberately DENSE: 9pt body, single spacing, tight table cells,
narrow side margins. The document is reference material for the team's document
writer, so content-per-page matters more than airy whitespace.

Usage:  python docs/generate_system_manual.py
"""

import html as html_lib
import os
import re
import shutil
import subprocess
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from system_manual_content import (  # noqa: E402
    BLOCKS,
    CHAPTERS,
    COVER,
    DOC_META,
    FRONT_MATTER,
)

OUT_DIR = HERE
BASENAME = "SuppliWise_System_Manual"

# ---------------------------------------------------------------------------
# Palette - matches the project's existing document language
# ---------------------------------------------------------------------------
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
RED = "B91C1C"
RED_BG = "FEF2F2"
RED_LINE = "FECACA"
BLUE = "1D4ED8"
BLUE_BG = "EFF6FF"
BLUE_LINE = "BFDBFE"

BODY_FONT = "Calibri"
MONO_FONT = "Consolas"

# ===========================================================================
# Shared helpers
# ===========================================================================


def shade(el, hex_fill):
    """Apply a solid fill to a docx table cell."""
    pr = el._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    pr.append(shd)


def cell_margins(table, top=28, bottom=28, left=60, right=60):
    """Tight cell padding in twentieths of a point."""
    tblPr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for tag, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement("w:" + tag)
        node.set(qn("w:w"), str(val))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tblPr.append(mar)


def table_borders(table, color=LINE, size=4, inside=True):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    edges = ["top", "left", "bottom", "right"]
    if inside:
        edges += ["insideH", "insideV"]
    for edge in edges:
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), str(size))
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), color)
        borders.append(e)
    tblPr.append(borders)


def no_borders(table):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), "none")
        e.set(qn("w:sz"), "0")
        borders.append(e)
    tblPr.append(borders)


def left_accent(table, color=GREEN, size=18):
    """Give a single-cell table a thick coloured left edge (note/code look)."""
    tblPr = table._tbl.tblPr
    borders = tblPr.find(qn("w:tblBorders"))
    if borders is None:
        return
    for e in borders.findall(qn("w:left")):
        borders.remove(e)
    le = OxmlElement("w:left")
    le.set(qn("w:val"), "single")
    le.set(qn("w:sz"), str(size))
    le.set(qn("w:space"), "0")
    le.set(qn("w:color"), color)
    borders.append(le)


def repeat_header(row):
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trPr.append(el)


def set_font(run, name=BODY_FONT, size=9, bold=False, italic=False, color=None,
             mono=False):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    face = MONO_FONT if mono else name
    run.font.name = face
    rPr = run._element.get_or_add_rPr()
    rf = rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rPr.append(rf)
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(attr), face)


def add_field(paragraph, instr, placeholder=""):
    """Insert a Word field code (TOC, PAGE, NUMPAGES)."""
    r1 = paragraph.add_run()
    fc = OxmlElement("w:fldChar")
    fc.set(qn("w:fldCharType"), "begin")
    r1._element.append(fc)

    r2 = paragraph.add_run()
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    r2._element.append(it)

    r3 = paragraph.add_run()
    fc2 = OxmlElement("w:fldChar")
    fc2.set(qn("w:fldCharType"), "separate")
    r3._element.append(fc2)

    if placeholder:
        paragraph.add_run(placeholder)

    r5 = paragraph.add_run()
    fc3 = OxmlElement("w:fldChar")
    fc3.set(qn("w:fldCharType"), "end")
    r5._element.append(fc3)


def force_update_fields(doc):
    """Ask Word to refresh the TOC when the document is opened."""
    settings = doc.settings.element
    el = OxmlElement("w:updateFields")
    el.set(qn("w:val"), "true")
    settings.append(el)


# ===========================================================================
# Inline markup:  **bold**   `monospace`   [[green]] [[red]] [[muted]]
# ===========================================================================

TOKEN = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\[\[[a-z]+\]\])")
MARKER_COLORS = {"green": GREEN_DARK, "red": RED, "muted": SLATE_SOFT, "blue": BLUE}


def split_runs(text):
    """Split marked-up text into (text, bold, mono, color) tuples."""
    out = []
    for part in TOKEN.split(str(text)):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append((part[2:-2], True, False, None))
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append((part[1:-1], False, True, SLATE_MID))
        elif part.startswith("[[") and part.endswith("]]"):
            out.append((part[2:-2], False, False, MARKER_COLORS.get(part[2:-2])))
        else:
            out.append((part, False, False, None))
    return out


# ===========================================================================
# DOCX renderer
# ===========================================================================


class DocxBuilder:
    def __init__(self):
        self.doc = Document()
        self._setup_styles()
        self._setup_page()

    # -- setup --------------------------------------------------------------

    def _setup_page(self):
        s = self.doc.sections[0]
        s.page_width = Inches(8.27)     # A4
        s.page_height = Inches(11.69)
        s.left_margin = Inches(0.62)
        s.right_margin = Inches(0.62)
        s.top_margin = Inches(0.6)
        s.bottom_margin = Inches(0.58)
        s.footer_distance = Inches(0.3)
        self._footer(s)

    def _footer(self, section):
        p = section.footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(DOC_META["short_title"] + "   " + DOC_META["version"] + "   Page ")
        set_font(r, size=7.5, color=SLATE_SOFT)
        add_field(p, " PAGE ", "1")
        r2 = p.add_run(" of ")
        set_font(r2, size=7.5, color=SLATE_SOFT)
        add_field(p, " NUMPAGES ", "1")
        for run in p.runs:
            set_font(run, size=7.5, color=SLATE_SOFT)

    def _setup_styles(self):
        normal = self.doc.styles["Normal"]
        normal.font.size = Pt(9)
        normal.font.name = BODY_FONT
        pf = normal.paragraph_format
        pf.space_before = Pt(0)
        pf.space_after = Pt(3)
        pf.line_spacing = 1.0
        rpr = normal.element.get_or_add_rPr()
        rf = OxmlElement("w:rFonts")
        for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rf.set(qn(a), BODY_FONT)
        rpr.append(rf)

    def _content_width(self):
        s = self.doc.sections[0]
        return s.page_width - s.left_margin - s.right_margin

    # -- primitives ---------------------------------------------------------

    def _runs(self, p, text, size=9, bold=False, italic=False, color=None, mono=False):
        for chunk, b, m, c in split_runs(text):
            r = p.add_run(chunk)
            set_font(r, size=size, bold=bold or b, italic=italic,
                     color=color or c, mono=mono or m)

    def para(self, text="", size=9, bold=False, italic=False, color=None,
             space_after=3, align=None):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_after = Pt(space_after)
        pf.space_before = Pt(0)
        pf.line_spacing = 1.0
        if align == "center":
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif align == "right":
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        if text:
            self._runs(p, text, size, bold, italic, color)
        return p

    def heading(self, level, text):
        sizes = {1: 14, 2: 10.5, 3: 9.5, 4: 9}
        colors = {1: GREEN_DARK, 2: SLATE, 3: SLATE_MID, 4: SLATE_MID}
        before = {1: 0, 2: 8, 3: 6, 4: 4}
        after = {1: 4, 2: 2.5, 3: 1.5, 4: 1}
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(before[level])
        pf.space_after = Pt(after[level])
        pf.line_spacing = 1.0
        pf.keep_with_next = True
        if level == 1:
            pdr = OxmlElement("w:pBdr")
            bot = OxmlElement("w:bottom")
            bot.set(qn("w:val"), "single")
            bot.set(qn("w:sz"), "8")
            bot.set(qn("w:space"), "3")
            bot.set(qn("w:color"), GREEN)
            pdr.append(bot)
            p._p.get_or_add_pPr().append(pdr)
        self._runs(p, text, sizes[level], bold=True, color=colors[level])
        return p

    def bullet(self, text, indent=0.16):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Inches(indent + 0.14)
        pf.first_line_indent = Inches(-0.14)
        pf.space_after = Pt(1.2)
        pf.line_spacing = 1.0
        r = p.add_run("\u2022  ")
        set_font(r, size=9, color=GREEN, bold=True)
        self._runs(p, text, 9)
        return p

    def numbered(self, n, text):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Inches(0.32)
        pf.first_line_indent = Inches(-0.32)
        pf.space_after = Pt(1.4)
        pf.line_spacing = 1.0
        r = p.add_run(str(n) + ".  ")
        set_font(r, size=9, bold=True, color=GREEN)
        self._runs(p, text, 9)
        return p

    def spacer(self, pts=3):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_after = Pt(0)
        pf.space_before = Pt(0)
        pf.line_spacing = 1.0
        r = p.add_run("")
        set_font(r, size=max(1.0, pts / 2.0))
        return p

    def pagebreak(self):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0)
        p.add_run().add_break(WD_BREAK.PAGE)

    # -- composite blocks ---------------------------------------------------

    def note(self, text, kind="info", label=None):
        themes = {
            "info": (BLUE_BG, BLUE, "NOTE"),
            "warn": (AMBER_BG, AMBER, "CAUTION"),
            "crit": (RED_BG, RED, "IMPORTANT"),
            "ok": (BAND_GREEN, GREEN_DARK, "DESIGN NOTE"),
        }
        bg, accent, default_label = themes.get(kind, themes["info"])
        label = label or default_label

        t = self.doc.add_table(rows=1, cols=1)
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        cell = t.cell(0, 0)
        shade(cell, bg)
        cell_margins(t, top=40, bottom=40, left=90, right=80)
        table_borders(t, color=bg, size=2)
        left_accent(t, color=accent, size=18)

        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(label + "   ")
        set_font(r, size=8, bold=True, color=accent)
        self._runs(p, text, 8.5)
        self.spacer(2)
        return t

    def code(self, lines, caption=None):
        if caption:
            self.para(caption, size=8, bold=True, color=SLATE_MID, space_after=1.5)
        t = self.doc.add_table(rows=1, cols=1)
        cell = t.cell(0, 0)
        shade(cell, BAND)
        cell_margins(t, top=40, bottom=40, left=90, right=70)
        table_borders(t, color=LINE, size=2)
        left_accent(t, color=GREEN, size=14)

        cell.text = ""
        for i, ln in enumerate(lines):
            p = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.line_spacing = 1.0
            r = p.add_run(ln)
            set_font(r, size=8, mono=True, color=SLATE)
        self.spacer(2)
        return t

    def table(self, headers, rows, widths=None, font=8, zebra=True, first_bold=False):
        cols = len(headers) if headers else (len(rows[0]) if rows else 1)
        t = self.doc.add_table(rows=0, cols=cols)
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        t.autofit = False
        table_borders(t)
        cell_margins(t, top=24, bottom=24, left=60, right=60)

        if headers:
            hr = t.add_row()
            repeat_header(hr)
            for i, h in enumerate(headers):
                c = hr.cells[i]
                shade(c, GREEN_DARK)
                p = c.paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.0
                r = p.add_run(str(h))
                set_font(r, size=font, bold=True, color="FFFFFF")

        for ri, row in enumerate(rows):
            tr = t.add_row()
            if zebra and ri % 2 == 1:
                for c in tr.cells:
                    shade(c, BAND)
            for ci in range(cols):
                val = row[ci] if ci < len(row) else ""
                p = tr.cells[ci].paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.0
                self._runs(p, val, font, bold=bool(first_bold and ci == 0))

        if widths:
            total = self._content_width()
            for row in t.rows:
                for ci, frac in enumerate(widths):
                    if ci < cols:
                        row.cells[ci].width = int(total * frac)
        self.spacer(2)
        return t


def render_blocks(b, blocks):
    """Dispatch the content block grammar onto the DOCX builder."""
    for blk in blocks:
        kind = blk[0]
        if kind == "h1":
            b.heading(1, blk[1])
        elif kind == "h2":
            b.heading(2, blk[1])
        elif kind == "h3":
            b.heading(3, blk[1])
        elif kind == "h4":
            b.heading(4, blk[1])
        elif kind == "p":
            b.para(blk[1], space_after=3)
        elif kind == "lead":
            b.para(blk[1], size=9.5, color=SLATE_MID, space_after=4)
        elif kind == "bullets":
            for item in blk[1]:
                b.bullet(item)
        elif kind == "numbers":
            for n, item in enumerate(blk[1], 1):
                b.numbered(n, item)
        elif kind == "table":
            spec = blk[1]
            b.table(spec.get("headers"), spec.get("rows", []),
                    widths=spec.get("widths"), font=spec.get("font", 8),
                    first_bold=spec.get("first_bold", False))
        elif kind == "note":
            spec = blk[1]
            b.note(spec.get("text", ""), spec.get("kind", "info"), spec.get("label"))
        elif kind == "code":
            spec = blk[1]
            b.code(spec.get("lines", []), spec.get("caption"))
        elif kind == "pagebreak":
            b.pagebreak()


# ===========================================================================
# HTML renderer (intermediate for the PDF)
# ===========================================================================

H = html_lib.escape


def inline_html(text):
    parts = []
    for chunk, bold, mono, color in split_runs(str(text)):
        s = H(chunk)
        if mono:
            s = "<code>" + s + "</code>"
        if bold:
            s = "<strong>" + s + "</strong>"
        if color:
            s = '<span style="color:#' + color + '">' + s + "</span>"
        parts.append(s)
    return "".join(parts)


CSS_TEMPLATE = """
@page { size: A4; margin: 13mm 12mm 14mm 12mm; }
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  font-family: "Segoe UI", Calibri, Arial, sans-serif;
  font-size: 8.6pt; line-height: 1.24; color: @{slate};
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 { font-size: 14pt; color:@{green_dark}; margin: 13px 0 5px;
     border-bottom: 1.6px solid @{green}; padding-bottom: 3px;
     page-break-after: avoid; }
h2 { font-size: 10.4pt; color:@{slate}; margin: 10px 0 3px;
     page-break-after: avoid; }
h3 { font-size: 9.2pt; color:@{slate_mid}; margin: 7px 0 2px;
     page-break-after: avoid; }
h4 { font-size: 8.7pt; color:@{slate_mid}; margin: 5px 0 1px;
     page-break-after: avoid; }
p  { margin: 0 0 4px 0; }
p.lead { font-size: 9.4pt; color:@{slate_mid}; margin-bottom: 5px; }
ul, ol { margin: 0 0 5px 0; padding-left: 15px; }
li { margin: 0 0 1.4px 0; }
li::marker { color:@{green}; font-weight: 700; }
code { font-family: Consolas, monospace; font-size: 7.9pt;
       color:@{slate_mid}; background:@{band};
       padding: 0 2px; border-radius: 2px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 5px 0;
        font-size: 7.9pt; table-layout: fixed; }
th { background:@{green_dark}; color:#fff; text-align:left; font-weight:600;
     padding: 2.4px 4px; border: 0.5px solid @{line};
     word-wrap: break-word; }
td { padding: 2.2px 4px; border: 0.5px solid @{line}; vertical-align: top;
     word-wrap: break-word; overflow-wrap: anywhere; }
tr { page-break-inside: avoid; }
tr:nth-child(even) td { background:@{band}; }
.note { padding: 4px 7px; margin: 0 0 5px 0; border-left: 2.6pt solid;
        border-radius: 0 2px 2px 0; font-size: 8.1pt;
        page-break-inside: avoid; }
.note .lbl { font-weight: 700; letter-spacing: .3pt; margin-right: 4px; }
.note.info { background:@{blue_bg}; border-color:@{blue}; }
.note.info .lbl { color:@{blue}; }
.note.warn { background:@{amber_bg}; border-color:@{amber}; }
.note.warn .lbl { color:@{amber}; }
.note.crit { background:@{red_bg}; border-color:@{red}; }
.note.crit .lbl { color:@{red}; }
.note.ok   { background:@{band_green}; border-color:@{green}; }
.note.ok .lbl { color:@{green_dark}; }
pre.code { background:@{band}; border:0.5px solid @{line};
           border-left:2.6pt solid @{green}; padding: 5px 8px; margin: 0 0 5px 0;
           font-family:Consolas, monospace; font-size: 7.8pt;
           line-height: 1.3; white-space: pre-wrap; overflow-wrap: anywhere;
           page-break-inside: avoid; }
pre.code .cap { display:block; font-family:"Segoe UI",sans-serif; font-weight:600;
                color:@{slate_mid}; margin-bottom:3px; font-size:8pt; }
.pb { page-break-before: always; }
.hdr { position: fixed; top: -9mm; left: 0; right: 0;
       border-bottom: 0.5px solid @{line}; padding-bottom: 1.5px; }
.hdr .t { font-size: 7pt; color:@{slate_soft}; }
"""


def _css():
    """Substitute the palette into the stylesheet.

    Every value is written as a bare hex token; the leading ``#`` is added here
    so it can never be consumed by the substitution itself.
    """
    palette = {
        "green": GREEN, "green_dark": GREEN_DARK,
        "slate": SLATE, "slate_mid": SLATE_MID, "slate_soft": SLATE_SOFT,
        "line": LINE, "band": BAND, "band_green": BAND_GREEN,
        "amber": AMBER, "amber_bg": AMBER_BG,
        "red": RED, "red_bg": RED_BG,
        "blue": BLUE, "blue_bg": BLUE_BG,
    }
    out = CSS_TEMPLATE
    for name, value in palette.items():
        out = out.replace("@{" + name + "}", "#" + value)
    return out


HTML_CSS = _css()
COVER_CSS = """
body { font-family: "Segoe UI", Calibri, Arial, sans-serif; color: #0F172A;
       font-size: 9pt; line-height: 1.3;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover { padding: 3mm 0 0 0; }
.rule { height: 5px; background: linear-gradient(90deg,#16A34A,#0F172A);
        border-radius: 3px; }
.badge { display:inline-block; font-size:7.6pt; font-weight:700;
         letter-spacing:1.4pt; color:#16A34A; text-transform:uppercase;
         margin: 2px 0 7px 0; }
h1.title { font-size: 27pt; line-height: 1.08; margin: 10px 0 2px 0;
           color:#14532D; letter-spacing: -0.4pt; }
p.sub { font-size: 11pt; color:#334155; margin: 0 0 3px 0; }
p.tag { font-size: 9pt; color:#64748B; margin: 0 0 12px 0; font-style: italic; }
table.meta { width:100%; border-collapse:collapse; font-size:8.4pt; }
table.meta td { border:0.5px solid #E2E8F0; padding: 3.4px 6px; vertical-align: top; }
table.meta td.k { width: 26%; background:#F8FAFC; font-size:7.4pt;
                  letter-spacing:.8pt; text-transform:uppercase;
                  color:#64748B; font-weight:700; }
.foot { margin-top: 11px; font-size:7.6pt; color:#64748B; font-style:italic;
        border-top:0.5px solid #E2E8F0; padding-top:5px; }
"""


def render_html(blocks):
    out = []
    for blk in blocks:
        kind = blk[0]
        if kind in ("h1", "h2", "h3", "h4"):
            lvl = kind[1]
            out.append("<h%s>%s</h%s>" % (lvl, inline_html(blk[1]), lvl))
        elif kind == "p":
            out.append("<p>%s</p>" % inline_html(blk[1]))
        elif kind == "lead":
            out.append('<p class="lead">%s</p>' % inline_html(blk[1]))
        elif kind == "bullets":
            out.append("<ul>" + "".join("<li>%s</li>" % i for i in blk[1]) + "</ul>")
        elif kind == "numbers":
            out.append("<ol>" + "".join("<li>%s</li>" % i for i in blk[1]) + "</ol>")
        elif kind == "note":
            spec = blk[1]
            themes = {"info": ("NOTE", "info"), "warn": ("CAUTION", "warn"),
                      "crit": ("IMPORTANT", "crit"), "ok": ("DESIGN NOTE", "ok")}
            default_label, cls = themes.get(spec.get("kind", "info"), themes["info"])
            label = spec.get("label") or default_label
            out.append('<div class="note %s"><span class="lbl">%s</span>%s</div>'
                       % (cls, H(label), inline_html(spec.get("text", ""))))
        elif kind == "code":
            spec = blk[1]
            cap = ""
            if spec.get("caption"):
                cap = '<span class="cap">%s</span>' % inline_html(spec["caption"])
            body = "\n".join(H(line) for line in spec.get("lines", []))
            out.append('<pre class="code">%s%s</pre>' % (cap, body))
        elif kind == "table":
            spec = blk[1]
            headers = spec.get("headers")
            ncols = len(headers) if headers else (len(spec["rows"][0]) if spec["rows"] else 1)
            out.append("<table>")
            if spec.get("widths"):
                out.append("<colgroup>" + "".join(
                    '<col style="width:%.1f%%">' % (w * 100) for w in spec["widths"])
                    + "</colgroup>")
            if headers:
                out.append("<thead><tr>" + "".join("<th>%s</th>" % inline_html(h)
                                                    for h in headers) + "</tr></thead>")
            out.append("<tbody>")
            for row in spec.get("rows", []):
                cells = ""
                for ci in range(ncols):
                    val = row[ci] if ci < len(row) else ""
                    style = ' style="font-weight:600"' if spec.get("first_bold") and ci == 0 else ""
                    cells += "<td%s>%s</td>" % (style, inline_html(val))
                out.append("<tr>%s</tr>" % cells)
            out.append("</tbody></table>")
        elif kind == "pagebreak":
            out.append('<div class="pb"></div>')
    return "\n".join(out)


# ===========================================================================
# Front matter
# ===========================================================================


def build_cover_html(meta):
    rows = "".join('<tr><td class="k">%s</td><td>%s</td></tr>' % (H(k), inline_html(v))
                   for k, v in meta["fields"])
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        "<style>%s</style></head><body><div class=\"cover\">"
        "<div class=\"badge\">%s</div><div class=\"rule\"></div>"
        "<h1 class=\"title\">%s</h1><p class=\"sub\">%s</p><p class=\"tag\">%s</p>"
        "<table class=\"meta\">%s</table><div class=\"foot\">%s</div>"
        "</div></body></html>"
        % (COVER_CSS, H(meta["badge"]), H(meta["title"]), H(meta["subtitle"]),
           H(meta["tagline"]), rows, H(meta["footer"]))
    )


def build_toc_html():
    rows = []
    for num, title, sections in CHAPTERS:
        entries = "".join(
            '<div style="display:flex;gap:6px;margin:0 0 0.6px 0;">'
            '<span style="min-width:17px;color:#16A34A;font-weight:700;">%s</span>'
            "<span>%s</span></div>" % (H(s["id"]), H(s["title"]))
            for s in sections
        )
        rows.append(
            '<div style="margin:0 0 4px 0;page-break-inside:avoid;">'
            '<div style="font-weight:700;color:#14532D;font-size:9.6pt;'
            'border-bottom:0.5px solid #E2E8F0;padding-bottom:1.4px;margin-bottom:2.4px;">'
            '<span style="color:#16A34A;margin-right:5px;">%s</span>%s</div>'
            '<div style="font-size:8.5pt;color:#334155;">%s</div></div>'
            % (H(num), H(title), entries)
        )
    fm = "".join('<div style="margin:0 0 1.8px 0;font-size:8.6pt;">'
                 '<span style="color:#16A34A;font-weight:700;">%s</span>&nbsp;&nbsp;%s</div>'
                 % (H(k), H(v)) for k, v in FRONT_MATTER)
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>%s</style></head><body>"
        "<h1 style=\"margin-top:0;\">Table of Contents</h1>%s"
        "<div style=\"margin:11px 0 4px 0;font-weight:700;color:#14532D;font-size:9.6pt;"
        "border-bottom:0.5px solid #E2E8F0;padding-bottom:1.4px;\">Chapters</div>%s"
        "</body></html>" % (HTML_CSS, fm, "".join(rows))
    )


# ===========================================================================
# Main
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
        "--user-data-dir=" + profile,
        "--print-to-pdf=" + pdf_path,
        "file:///" + html_path.replace("\\", "/"),
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    shutil.rmtree(profile, ignore_errors=True)
    return pdf_path if os.path.isfile(pdf_path) else None


def build_docx():
    print("Building DOCX ...")
    b = DocxBuilder()

    # ---- cover ---------------------------------------------------------
    tp = b.doc.add_paragraph()
    tp.paragraph_format.space_after = Pt(1)
    set_font(tp.add_run(COVER["badge"].upper()), size=8, bold=True, color=GREEN)

    rule = b.doc.add_table(rows=1, cols=1)
    rc = rule.cell(0, 0)
    shade(rc, GREEN_DARK)
    no_borders(rule)
    cell_margins(rule, top=8, bottom=8, left=0, right=0)
    rc.paragraphs[0].paragraph_format.space_after = Pt(0)
    set_font(rc.paragraphs[0].add_run(""), size=2)
    b.spacer(8)

    b.para(COVER["title"], size=26, bold=True, color=GREEN_DARK, space_after=2)
    b.para(COVER["subtitle"], size=13, color=SLATE, space_after=2)
    b.para(COVER["tagline"], size=9.5, italic=True, color=SLATE_SOFT, space_after=10)

    ct = b.doc.add_table(rows=0, cols=2)
    table_borders(ct)
    cell_margins(ct, top=34, bottom=34, left=70, right=70)
    for k, v in COVER["fields"]:
        tr = ct.add_row()
        kc, vc = tr.cells[0], tr.cells[1]
        shade(kc, BAND)
        kp = kc.paragraphs[0]
        kp.paragraph_format.space_after = Pt(0)
        kp.paragraph_format.line_spacing = 1.0
        set_font(kp.add_run(k.upper()), size=7.3, bold=True, color=SLATE_SOFT)
        vp = vc.paragraphs[0]
        vp.paragraph_format.space_after = Pt(0)
        vp.paragraph_format.line_spacing = 1.0
        b._runs(vp, v, 9.5)

    total_w = b._content_width()
    for row in ct.rows:
        row.cells[0].width = int(total_w * 0.28)
        row.cells[1].width = int(total_w * 0.72)

    b.spacer(10)
    b.para(COVER["footer"], size=7.5, color=SLATE_SOFT, italic=True)

    # ---- table of contents --------------------------------------------
    b.pagebreak()
    b.heading(1, "Table of Contents")
    for k, v in FRONT_MATTER:
        p = b.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_after = Pt(1.5)
        pf.line_spacing = 1.0
        set_font(p.add_run(k + "   "), size=9, bold=True, color=GREEN)
        b._runs(p, v, 9)

    b.spacer(5)
    ph = b.para("The page-numbered table of contents below is a Word field. "
                "Word refreshes it automatically on open; if it appears blank, "
                "select it and press F9 to update.", size=8, italic=True,
                color=SLATE_SOFT, space_after=4)
    toc_p = b.doc.add_paragraph()
    toc_p.paragraph_format.space_after = Pt(0)
    add_field(toc_p, ' TOC \\o "1-2" \\h \\z \\u ', "")
    force_update_fields(b.doc)

    # ---- body ----------------------------------------------------------
    render_blocks(b, BLOCKS)

    path = os.path.join(OUT_DIR, BASENAME + ".docx")
    b.doc.save(path)
    print("  -> " + path)
    return path


def build_pdf_document():
    print("Building PDF ...")
    tmp = []

    cover = os.path.join(OUT_DIR, "_sm_cover.html")
    with open(cover, "w", encoding="utf-8") as f:
        f.write(build_cover_html(DOC_META["cover"]))
    tmp.append(cover)

    toc = os.path.join(OUT_DIR, "_sm_toc.html")
    with open(toc, "w", encoding="utf-8") as f:
        f.write(build_toc_html())
    tmp.append(toc)

    body = render_html(BLOCKS)
    running_head = (
        '<div class="hdr"><div class="t">%s &nbsp;&middot;&nbsp; %s</div></div>'
        % (H(DOC_META["short_title"]), H(DOC_META["version"]))
    )
    merged = os.path.join(OUT_DIR, "_sm_merged.html")

    def strip_doc(path):
        raw = open(path, encoding="utf-8").read()
        return raw.split("<body>", 1)[1].rsplit("</body>", 1)[0]

    with open(merged, "w", encoding="utf-8") as f:
        f.write("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>%s</title>"
                "<style>%s</style></head><body>"
                % (H(DOC_META["short_title"]), HTML_CSS))
        # cover: no running head, no page counter
        f.write(strip_doc(cover))
        f.write('<div class="pb"></div>')
        # table of contents
        f.write(running_head + strip_doc(toc))
        f.write('<div class="pb"></div>')
        # body
        f.write(running_head + body)
        f.write("</body></html>")
    tmp.append(merged)

    pdf = os.path.join(OUT_DIR, BASENAME + ".pdf")
    made = build_pdf(merged, pdf)

    for path in tmp:
        if os.path.isfile(path):
            os.remove(path)

    if made:
        print("  -> " + made)
    else:
        print("  ! PDF not produced")
    return made


def main():
    build_docx()
    build_pdf_document()
    print("Done.")


if __name__ == "__main__":
    main()