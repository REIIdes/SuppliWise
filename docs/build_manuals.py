"""
SuppliWise — manual builder.

Renders the Markdown manuals into print-ready PDF via headless Chrome/Edge:

    docs/USER_MANUAL.md      ->  docs/SuppliWise_User_Manual.pdf
    docs/DEVELOPER_MANUAL.md ->  docs/SuppliWise_Developer_Manual.pdf

Usage:
    python docs/build_manuals.py                # build both
    python docs/build_manuals.py user           # build one (user | developer)
    python docs/build_manuals.py --check-only   # validate links, build nothing

The HTML is kept as docs/_build/<name>.html so it can be opened and inspected.

WHY A BUILT-IN LINK CHECKER
---------------------------
A manual is worse than no manual if its table of contents lies. Every internal
anchor in both documents is verified against the set of generated heading ids,
and the build FAILS on a dangling one. Markdown's default slugifier also
collapses runs of hyphens while GitHub's does not, which silently breaks any
anchor containing an em dash -- so the slugifier here is pinned to GitHub's
exact algorithm instead.
"""

import html as html_lib
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata

import markdown

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD_DIR = os.path.join(HERE, "_build")

# Deepest indentation a ```flow block may use. Indentation means depth there, so
# anything beyond this is column-aligned ASCII art pasted into the wrong fence.
# Kept in step with FLOW_INDENT_MM below: the two together decide how much of an
# A4 text column a chart may consume before it stops being readable.
MAX_FLOW_DEPTH = 8
FLOW_INDENT_MM = 6

# ── Palette ──────────────────────────────────────────────────────────────────
# NOTE: these carry their leading '#'. They are interpolated straight into CSS,
# and a bare "2563EB" is a silently invalid colour -- the whole sheet drops and
# the document renders as unstyled HTML.
GREEN = "#0F9D58"
GREEN_DARK = "#065F46"
SLATE = "#0F172A"
SLATE_MID = "#334155"
SLATE_SOFT = "#64748B"
LINE = "#E2E8F0"
BAND = "#F8FAFC"
AMBER_BG = "#FFFBEB"
AMBER_LINE = "#FDE68A"
AMBER = "#B45309"
ROSE_BG = "#FFF1F2"
ROSE_LINE = "#FECDD3"
BLUE_BG = "#EFF6FF"
BLUE_LINE = "#BFDBFE"
BLUE = "#1D4ED8"

DOCS = {
    "user": {
        "src": os.path.join(HERE, "USER_MANUAL.md"),
        "pdf": os.path.join(HERE, "SuppliWise_User_Manual.pdf"),
        "title": "SuppliWise",
        "subtitle": "User Manual",
        "tagline": "Your personalised supplement advisor, with proof you can check.",
        "audience": "For members, new and existing",
        "accent": GREEN,
        "accent_dark": GREEN_DARK,
    },    "developer": {
        "src": os.path.join(HERE, "DEVELOPER_MANUAL.md"),
        "pdf": os.path.join(HERE, "SuppliWise_Developer_Manual.pdf"),
        "title": "SuppliWise",
        "subtitle": "Developer Manual",
        "tagline": "Architecture, request lifecycles, data model and extension playbooks.",
        "audience": "For engineers maintaining and extending the system",
        "accent": "#2563EB",
        "accent_dark": "#1E3A8A",
    },
}


# ── GitHub-compatible slugs ──────────────────────────────────────────────────

def github_slug(value, separator):
    """
    Reproduce github-slugger exactly.

    GitHub lowercases, drops every character that is not alphanumeric / space /
    hyphen / underscore, then turns each space into ONE hyphen. It does NOT
    collapse runs of hyphens -- which is why "Track Intake -- the daily habit"
    keeps its double hyphen. Markdown's built-in slugifier collapses them, so
    every em-dash anchor in these manuals would break.

    Signature matches the `toc` extension's slugify contract; it appends the
    `-1` / `-2` de-duplication suffix itself, so this returns the bare slug.
    """
    value = unicodedata.normalize("NFKC", value)
    value = value.strip().lower()
    value = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
    value = re.sub(r"\s", separator, value)
    return value


# ── flow blocks -> real flowcharts ────────────────────────────────────────────

def render_flow(block):
    """
    Turn an indented ```flow block into a stacked CSS flowchart.

        You place an order
          Your WELL moves into escrow
            The seller cannot touch it

    Indentation is depth. Each line becomes a card; consecutive cards are joined
    by a connector, and depth draws a guide rail down the left so a branch reads
    as a branch.
    """
    rows = []
    # Normalise CRLF first: the repository is checked out with Windows line
    # endings, and an unguarded ``\r`` before the newline silently fails every
    # fence match.
    for raw in block.replace("\r\n", "\n").replace("\r", "\n").strip("\n").split("\n"):
        if not raw.strip():
            continue
        depth = len(raw) - len(raw.lstrip(" \t"))
        rows.append((depth // 2, raw.strip()))

    parts = ['<div class="flow">']
    for i, (depth, label) in enumerate(rows):
        rail = '<span class="flow-rail"></span>' if depth else ""
        parts.append(
            f'<div class="flow-row" style="--depth:{depth}">'
            f'{rail}'
            f'<div class="flow-node">{html_lib.escape(label)}</div>'
            f'</div>'
        )
        if i < len(rows) - 1:
            parts.append(
                f'<div class="flow-link" style="--depth:{depth}">'
                f'<span class="flow-link-line"></span>'
                f'<span class="flow-link-arrow"></span>'
                f'</div>'
            )
    parts.append("</div>")
    return "\n".join(parts)


def make_md(accent):
    """Markdown instance with a ```flow fenced-block handler."""
    # The extension must be passed as an INSTANCE in `extensions`. `registerExtension`
    # looks like the natural hook but only records resettable state -- it never calls
    # extendMarkdown, so registering after construction silently does nothing and the
    # flow blocks fall through to `fenced_code` as a "flow" language tag.
    return markdown.Markdown(
        extensions=[
            "extra",          # tables, fenced_code, attr_list, def_list, footnotes
            "toc",
            "sane_lists",
            FlowExtension(),
        ],
        extension_configs={
            "toc": {"permalink": False, "slugify": github_slug, "separator": "-"},
        },
        output_format="html",
    )


def FlowExtension():
    """A ```flow fenced block rendered as a CSS flowchart instead of a <pre>."""
    from markdown.extensions import Extension
    from markdown.preprocessors import Preprocessor

    # `\r?` before every newline: these files may be checked out with CRLF endings,
    # and a bare ``\n`` anchor would never match, silently emitting the raw fence.
    FLOW_RE = re.compile(r"^```flow[ \t]*\r?\n(.*?)^```[ \t]*\r?$", re.MULTILINE | re.DOTALL)

    class FlowPreprocessor(Preprocessor):
        def run(self, lines):
            text = "\n".join(lines)
            text = FLOW_RE.sub(lambda m: "\n\n" + render_flow(m.group(1)) + "\n\n", text)
            return text.split("\n")

    class _Flow(Extension):
        def extendMarkdown(self, md):
            # Priority 30 runs BEFORE fenced_code (25), so the flow fence is claimed
            # first and never reaches the generic code handler.
            md.preprocessors.register(FlowPreprocessor(md), "flow_diagrams", 30)

    return _Flow()


# ── CSS ──────────────────────────────────────────────────────────────────────

def check_css(css):
    """
    Fail loudly on a colour that lost its '#'.

    A bare `2563EB` is not "slightly wrong", it is an invalid declaration: the
    browser drops that rule and often the rest of the sheet with it, so the
    document renders as unstyled HTML and still produces a plausible-looking PDF.
    Nothing about the build output signals it, which is exactly why it needs a
    check.
    """
    bare = re.findall(r":\s*(#[0-9A-Fa-f]{3,8}|)\b([0-9A-Fa-f]{6})\s*(?:;|\})", css)
    bad = [m[1] for m in bare if not m[0]]
    if bad:
        raise SystemExit(
            "CSS colours are missing their '#' prefix: "
            + ", ".join(sorted(set(bad)))
            + "\nThe stylesheet would be dropped and the PDF would render unstyled."
        )


def build_css(accent, accent_dark):
    css = f"""
@page {{ size: A4; margin: 20mm 16mm 18mm 16mm; }}

:root {{
  --accent: {accent};
  --accent-dark: {accent_dark};
  --slate: {SLATE};
  --slate-mid: {SLATE_MID};
  --slate-soft: {SLATE_SOFT};
  --line: {LINE};
}}

* {{ box-sizing: border-box; }}

html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}

body {{
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--slate);
  font-size: 10.4pt;
  line-height: 1.62;
  margin: 0;
}}

/* ── Cover ─────────────────────────────────────────────────────────────── */
.cover {{
  page-break-after: always;
  break-after: page;
  min-height: 232mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-top: 7mm solid var(--accent);
  padding-top: 10mm;
}}
.cover-kicker {{
  font-size: 9pt; font-weight: 700; letter-spacing: .22em;
  text-transform: uppercase; color: var(--accent); margin-bottom: 6mm;
}}
.cover-title {{ font-size: 40pt; font-weight: 300; letter-spacing: -.02em; margin: 0 0 2mm; line-height: 1.05; }}
.cover-sub {{ font-size: 23pt; font-weight: 700; color: var(--accent-dark); margin: 0 0 6mm; line-height: 1.15; }}
.cover-tag {{ font-size: 12pt; color: var(--slate-soft); max-width: 135mm; margin: 0 0 12mm; line-height: 1.55; }}
.cover-audience {{
  display: inline-block; font-size: 9.5pt; font-weight: 600; color: var(--accent-dark);
  background: #F1F5F9; border: 1px solid var(--line); border-radius: 999px;
  padding: 3mm 7mm; margin-bottom: 4mm; align-self: flex-start;
}}
.cover-rule {{ width: 34mm; height: 3px; background: var(--accent); margin: 8mm 0; }}
.cover-foot {{ font-size: 8.6pt; color: var(--slate-soft); border-top: 1px solid var(--line); padding-top: 4mm; }}
.cover-foot strong {{ color: var(--slate-mid); }}

/* ── Headings ──────────────────────────────────────────────────────────── */
h1 {{
  font-size: 21pt; font-weight: 300; letter-spacing: -.015em;
  margin: 0 0 6mm; padding: 0 0 3mm; border-bottom: 2px solid var(--accent);
  color: var(--slate); page-break-after: avoid; break-after: avoid;
}}
h2 {{
  font-size: 15pt; font-weight: 700; color: var(--accent-dark);
  margin: 9mm 0 3.5mm; padding-bottom: 2mm; border-bottom: 1px solid var(--line);
  page-break-after: avoid; break-after: avoid;
}}
h3 {{ font-size: 12pt; font-weight: 700; color: var(--slate); margin: 7mm 0 2.5mm; page-break-after: avoid; break-after: avoid; }}
h4 {{ font-size: 10.8pt; font-weight: 700; color: var(--slate-mid); margin: 5.5mm 0 2mm; page-break-after: avoid; break-after: avoid; }}
h5 {{ font-size: 10pt; font-weight: 700; color: var(--slate-soft); margin: 4mm 0 1.5mm; }}

p {{ margin: 0 0 3mm; orphans: 3; widows: 3; }}

a {{ color: var(--accent-dark); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}

/* ── Lists ─────────────────────────────────────────────────────────────── */
ul, ol {{ margin: 0 0 3.5mm; padding-left: 6mm; }}
li {{ margin: 0 0 1.4mm; }}
li > ul, li > ol {{ margin-top: 1.4mm; }}
ul {{ list-style: none; padding-left: 5mm; }}
ul > li {{ position: relative; }}
ul > li::before {{
  content: ""; position: absolute; left: -4mm; top: 2.1mm;
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent);
}}
ol {{ list-style: decimal; }}
ol > li::marker {{ color: var(--accent); font-weight: 700; }}
li > p {{ margin: 0 0 1.5mm; }}

/* ── Code ──────────────────────────────────────────────────────────────── */
code {{
  font-family: "Cascadia Mono", "Consolas", "SF Mono", "Roboto Mono", monospace;
  font-size: 8.9pt; background: #F1F5F9; color: var(--accent-dark);
  padding: .6mm 1.4mm; border-radius: 3px; border: 1px solid #E2E8F0;
}}
pre {{
  background: {SLATE}; color: #E2E8F0; padding: 3.5mm 4mm; border-radius: 5px;
  overflow: visible; font-size: 8.3pt; line-height: 1.5;
  page-break-inside: avoid; break-inside: avoid; margin: 0 0 4mm;
  border-left: 3px solid var(--accent);
}}
pre code {{ background: none; color: inherit; border: none; padding: 0; font-size: inherit; }}
pre::-webkit-scrollbar {{ display: none; }}

/* ── Tables ────────────────────────────────────────────────────────────── */
table {{
  border-collapse: collapse; width: 100%; margin: 0 0 4.5mm;
  font-size: 9pt; page-break-inside: avoid; break-inside: avoid;
}}
th {{
  background: var(--accent); color: #fff; text-align: left;
  padding: 2mm 2.5mm; font-weight: 600; font-size: 8.8pt;
  letter-spacing: .02em; border: 1px solid var(--accent);
}}
td {{ padding: 1.8mm 2.5mm; border: 1px solid var(--line); vertical-align: top; }}
tbody tr:nth-child(even) {{ background: {BAND}; }}
td code {{ font-size: 8.1pt; }}

/* ── Blockquote ────────────────────────────────────────────────────────── */
blockquote {{
  margin: 0 0 4mm; padding: 3mm 4mm; background: {BLUE_BG};
  border-left: 3px solid {BLUE}; border-radius: 0 4px 4px 0;
}}
blockquote h3, blockquote h4, blockquote h5 {{ margin-top: 0; color: {BLUE}; }}
blockquote h3 {{ font-size: 11pt; }}
blockquote p:last-child {{ margin-bottom: 0; }}
blockquote ul > li::before {{ background: {BLUE}; }}

/* ── Flowcharts ────────────────────────────────────────────────────────── */
.flow {{
  margin: 0 0 5mm; padding: 4mm 4mm 3mm;
  background: {BAND}; border: 1px solid var(--line); border-radius: 6px;
  page-break-inside: avoid; break-inside: avoid;
}}
.flow-row {{ display: flex; align-items: stretch; padding-left: calc(var(--depth) * {FLOW_INDENT_MM}mm); }}
.flow-rail {{
  width: 3px; margin: 0 3mm 0 0; border-radius: 2px;
  background: var(--line); align-self: stretch;
}}
.flow-node {{
  flex: 1; font-size: 9.3pt; line-height: 1.45; font-weight: 500;
  background: #fff; border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 4px; padding: 2.2mm 3mm; color: var(--slate);
}}
.flow-row[style*="--depth:0"] .flow-node {{ font-weight: 600; }}
.flow-link {{
  display: flex; align-items: center; padding-left: calc(var(--depth) * {FLOW_INDENT_MM}mm);
  height: 4.5mm;
}}
.flow-link-line {{ width: 3px; height: 100%; background: var(--line); margin-left: 1.5mm; }}
.flow-link-arrow {{
  width: 0; height: 0; margin-left: 0;
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--accent);
}}

/* ── Misc ──────────────────────────────────────────────────────────────── */
hr {{ border: none; border-top: 1px solid var(--line); margin: 7mm 0; }}
strong {{ font-weight: 700; color: var(--slate); }}
img {{ max-width: 100%; }}
div[align="center"] {{ text-align: center; color: var(--slate-soft); font-size: 9.5pt; }}
div[align="center"] strong {{ color: var(--accent-dark); }}

kbd {{
  font-family: inherit; font-size: 8.4pt; background: #F1F5F9;
  border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px;
  padding: .3mm 1.2mm;
}}
"""
    check_css(css)
    return css


COVER = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>{title} {subtitle}</title>
<style>{css}
.cover-page {{ page-break-after: always; }}
</style></head><body>

<div class="cover">
  <div class="cover-kicker">{title}</div>
  <div class="cover-title">{title}</div>
  <div class="cover-sub">{subtitle}</div>
  <div class="cover-rule"></div>
  <p class="cover-tag">{tagline}</p>
  <div class="cover-audience">{audience}</div>
  <div class="cover-foot">
    <p><strong>{title}</strong> &middot; {subtitle} &middot; Version 1.0</p>
    <p>Wellness guidance, not a diagnosis. Always consult a qualified healthcare
       professional before starting, stopping or changing any supplement or medication.</p>
  </div>
</div>

"""


# ── Link check ───────────────────────────────────────────────────────────────

def check_links(html_text, label):
    """Fail the build on any internal anchor that has no target."""
    ids = set(re.findall(r'id="([^"]+)"', html_text))
    bad = []
    for href in re.findall(r'href="#([^"]+)"', html_text):
        if href not in ids:
            bad.append(href)
    if bad:
        print(f"  ! {label}: {len(bad)} broken internal link(s)")
        for href in sorted(set(bad)):
            print(f"      #{href}")
    return bad


# ── PDF ──────────────────────────────────────────────────────────────────────

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
    if os.path.exists(pdf_path):
        os.remove(pdf_path)
    profile = os.path.join(BUILD_DIR, ".chrome-profile")
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
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    for _ in range(40):
        if os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 20000:
            break
        time.sleep(0.5)
    shutil.rmtree(profile, ignore_errors=True)
    if os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 20000:
        return pdf_path
    print("  ! PDF generation failed")
    print((result.stdout or "")[-800:])
    print((result.stderr or "")[-800:])
    return None


# ── Per-document build ───────────────────────────────────────────────────────

def build_one(key):
    cfg = DOCS[key]
    src = cfg["src"]
    if not os.path.isfile(src):
        print(f"  ! missing source: {src}")
        return False

    with open(src, "r", encoding="utf-8") as fh:
        text = fh.read()

    css = build_css(cfg["accent"], cfg["accent_dark"])
    md = make_md(cfg["accent"])
    body = md.convert(text)
    toc_html = md.toc

    document = (
        COVER.format(
            title=cfg["title"],
            subtitle=cfg["subtitle"],
            tagline=cfg["tagline"],
            audience=cfg["audience"],
            css=css,
        )
        + body
        + "\n</body></html>\n"
    )

    broken = check_links(document, cfg["subtitle"])
    if broken:
        return False

    os.makedirs(BUILD_DIR, exist_ok=True)
    html_path = os.path.join(BUILD_DIR, f"{key}.html")
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(document)

    # Every ```flow fence in the source must become exactly one .flow div. Compared
    # by COUNT, deliberately: the earlier probe grepped for the bare word "flow" in
    # the output, which matched the flowchart's own node text and warned on a
    # perfectly good build -- a check that cries wolf gets ignored.
    fences = len(re.findall(r"^```flow[ \t]*\r?$", text, re.MULTILINE))
    rendered = body.count('class="flow"')
    unconverted = body.count("language-flow")
    if fences != rendered or unconverted:
        print(f"  ! {fences} flow fence(s) -> {rendered} chart(s), "
              f"{unconverted} unconverted. Build aborted.")
        return False

    # Indentation in a flow block means DEPTH. ASCII art means COLUMN alignment,
    # and pasting it into a flow fence silently produces 18-level-deep nodes that
    # collapse the chart. Catch that here rather than shipping a broken diagram.
    depths = [int(d) for d in re.findall(r'--depth:(\d+)', body)]
    if depths and max(depths) > MAX_FLOW_DEPTH:
        print(f"  ! a flow node is nested {max(depths)} levels deep (limit {MAX_FLOW_DEPTH}).")
        print("      That is ASCII art in a ```flow block - use ```text instead.")
        return False

    print(f"  flow  {rendered} flowchart(s) rendered"
          + (f", max depth {max(depths)}" if depths else ""))

    print(f"  html  {os.path.relpath(html_path, ROOT)}")
    pdf = build_pdf(html_path, cfg["pdf"])
    if pdf:
        size_kb = os.path.getsize(pdf) // 1024
        print(f"  pdf   {os.path.relpath(pdf, ROOT)}  ({size_kb} KB)")
    return bool(pdf)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    check_only = "--check-only" in sys.argv

    keys = args or ["user", "developer"]
    unknown = [k for k in keys if k not in DOCS]
    if unknown:
        print(f"unknown document(s): {', '.join(unknown)}")
        print("valid: user, developer")
        return 1

    print(f"\nSuppliWise manual builder\n{'=' * 40}")
    ok = True
    for key in keys:
        cfg = DOCS[key]
        print(f"\n{cfg['title']} {cfg['subtitle']}")
        if check_only:
            with open(cfg["src"], "r", encoding="utf-8") as fh:
                text = fh.read()
            md = make_md(cfg["accent"])
            body = md.convert(text)
            broken = check_links(COVER.format(
                title=cfg["title"], subtitle=cfg["subtitle"], tagline=cfg["tagline"],
                audience=cfg["audience"], css=build_css(cfg["accent"], cfg["accent_dark"]),
            ) + body, cfg["subtitle"])
            flows = body.count('class="flow"')
            print(f"  links : {'OK' if not broken else str(len(broken)) + ' broken'}")
            print(f"  flowcharts rendered: {flows}")
            ok = ok and not broken
        else:
            ok = build_one(key) and ok

    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
