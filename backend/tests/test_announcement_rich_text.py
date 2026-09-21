"""公告富文本清洗的白名单测试。

这层是**存进库之前**的那道，不是渲染时的那道：前端也按同一份白名单解析
（frontend/src/utils/richText.ts），但绕过前端直接打 API 的请求只会遇到这里。
所以这些用例盯的是"什么进不去库"，而不是"页面上长什么样"。

Whitelist tests for the announcement rich-text cleaner. This is the pass that runs
*before* the row is stored, not the one at render time: the client parses against
the same whitelist (frontend/src/utils/richText.ts), but a request aimed straight
at the API only ever meets this one. So these cases are about what cannot get into
the database, not about how a page looks.
"""
from html.parser import HTMLParser

import pytest

from app.schemas import AnnouncementBlock, AnnouncementIn
from app.services.rich_text import MAX_RICH_LEN, rich_plain_text, sanitize_rich_html


class _AttrProbe(HTMLParser):
    """把清洗后的 HTML 重新解析一遍，看每个标签实际带了哪些属性。
    Re-parses cleaned HTML to see which attributes each tag actually carries."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.seen: list[tuple[str, list[str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.seen.append((tag, [k for k, _ in attrs]))

    handle_startendtag = handle_starttag


# ---------- 危险输入 / hostile input ----------

@pytest.mark.parametrize(
    "raw",
    [
        '<script>alert(1)</script>',
        '<p>a</p><script>alert(1)</script>',
        '<svg><script>alert(1)</script></svg>',
        '<iframe src="https://evil"></iframe>',
        '<p onclick="steal()">x</p>',
        '<p onmouseover=alert(1)>x</p>',
        '<img src=x onerror=alert(1)>',
        '<style>body{display:none}</style>',
        '<form action="https://evil"><input name="pw"></form>',
        '<object data="https://evil"></object>',
    ],
)
def test_no_executable_markup_survives(raw: str) -> None:
    out = sanitize_rich_html(raw)
    lowered = out.lower()
    for bad in ("<script", "<iframe", "<svg", "<style", "<form", "<input", "<object", "onerror", "onclick", "onmouseover"):
        assert bad not in lowered, f"{bad!r} survived in {out!r}"


def test_script_body_is_not_kept_as_text() -> None:
    """script 是连内容一起丢的——unwrap 会把脚本正文当成正文倒进页面。
    script drops with its contents: unwrapping would pour the code in as copy."""
    assert "alert" not in sanitize_rich_html('<script>alert(1)</script>')


@pytest.mark.parametrize(
    "href",
    ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "/local/path", "#anchor"],
)
def test_only_http_and_mailto_links(href: str) -> None:
    out = sanitize_rich_html(f'<a href="{href}">click</a>')
    assert "href" not in out
    # 链接死了，文字还在：管理员看得见自己写过什么 / the text stays so the copy survives
    assert "click" in out


def test_good_links_survive() -> None:
    assert '<a href="https://prismxsignallab.com">go</a>' in sanitize_rich_html(
        '<a href="https://prismxsignallab.com">go</a>'
    )
    assert 'href="mailto:a@b.com"' in sanitize_rich_html('<a href="mailto:a@b.com">mail</a>')


def test_images_must_be_http() -> None:
    assert sanitize_rich_html('<img src="data:image/svg+xml,<svg onload=alert(1)>">') == ""
    assert sanitize_rich_html('<img src="https://cdn.example/a.png" alt="cover">') == (
        '<img src="https://cdn.example/a.png" alt="cover">'
    )


def test_style_attribute_is_dropped() -> None:
    """字号 / 颜色只走 class 白名单，style 一概不留——不然 CSS 得信任库里的字符串。
    Size and colour ride the class whitelist only; a style attribute would make the
    CSS trust a string from the database."""
    out = sanitize_rich_html('<p style="position:fixed;font-size:200px">x</p>')
    assert "style" not in out
    assert out == "<p>x</p>"


def test_unknown_classes_are_dropped() -> None:
    out = sanitize_rich_html('<p class="fs-lg ta-center made-up">x</p>')
    assert out == '<p class="fs-lg ta-center">x</p>'


def test_quotes_in_attributes_cannot_break_out() -> None:
    """属性值里塞引号不会多出一个属性。

    断言写成"重新解析后 img 只有 src / alt"，而不是"输出里不含 onerror"：越界尝试
    的残字会留在 URL 里（无害，它就是一段字符），真正要守的是它进不了属性位。
    A quote inside an attribute value cannot open a second attribute. The assertion
    re-parses rather than grepping for "onerror": leftovers of the attempt stay
    inside the URL as inert characters, and what matters is that they never become
    an attribute of their own.
    """
    out = sanitize_rich_html('<img src=\'https://cdn/a.png" onerror="alert(1)\' alt="x">')
    parser = _AttrProbe()
    parser.feed(out)
    assert [tag for tag, _ in parser.seen] == ["img"]
    assert set(parser.seen[0][1]) <= {"src", "alt"}


# ---------- 正常排版 / ordinary formatting ----------

def test_blank_paragraph_is_content() -> None:
    """管理员按两次回车要的就是一条空行，清掉就等于替他重排版面。
    编辑器留下的空行一定是 <p><br></p>（contenteditable 会补那个 <br>）。
    Two Enters means a blank line; removing it re-typesets the post for them. The
    editor's blank line is always <p><br></p> — contenteditable adds the filler."""
    assert sanitize_rich_html("<p>a</p><p><br></p><p>b</p>") == "<p>a</p><p><br></p><p>b</p>"
    assert sanitize_rich_html("<p>a</p><p>&nbsp;</p><p>b</p>") == "<p>a</p><p>\xa0</p><p>b</p>"


def test_a_childless_block_is_dropped() -> None:
    """一个子节点都没有的块是解析产物：HTML 解析器拆 <p><ul>…</ul></p> 这种非法
    嵌套时，两头会留下这样的空壳，谁也没按出来过它。
    A block with no children is a parsing artefact: splitting illegal nesting such
    as <p><ul>…</ul></p> leaves these shells at either end, and nobody typed them."""
    assert sanitize_rich_html("<p>a</p><p></p><p>b</p>") == "<p>a</p><p>b</p>"


def test_synonym_tags_are_folded() -> None:
    assert sanitize_rich_html("<p><b>a</b><i>b</i><strike>c</strike></p>") == (
        "<p><strong>a</strong><em>b</em><s>c</s></p>"
    )


def test_headings_and_lists() -> None:
    assert sanitize_rich_html("<h1>t</h1>") == "<h2>t</h2>"
    assert sanitize_rich_html("<ul><li>a</li><li>b</li></ul>") == "<ul><li>a</li><li>b</li></ul>"
    assert sanitize_rich_html("<ol><li>a</li></ol>") == "<ol><li>a</li></ol>"


def test_loose_text_is_wrapped_in_a_paragraph() -> None:
    assert sanitize_rich_html("hello <b>world</b>") == "<p>hello <strong>world</strong></p>"


def test_block_tags_never_nest() -> None:
    assert sanitize_rich_html("<div><div>a</div></div>") == "<p>a</p>"


def test_a_list_wrapped_in_a_paragraph_is_lifted_out() -> None:
    """浏览器真的会产出 <p><ul>…</ul></p>：在整段选中的段落上按「项目符号」就是。
    按行内内容处理会把 ul 拆掉、列表整个消失，所以要把它顶成兄弟节点。
    Browsers really emit <p><ul>…</ul></p> — pressing "bullet list" on a fully
    selected paragraph does it. Treating that as inline content would unwrap the
    ul and lose the list, so it is lifted out as a sibling instead."""
    assert sanitize_rich_html("<p><ul><li>a</li><li>b</li></ul></p>") == "<ul><li>a</li><li>b</li></ul>"
    assert sanitize_rich_html("<p>before<ul><li>x</li></ul>after</p>") == (
        "<p>before</p><ul><li>x</li></ul><p>after</p>"
    )


def test_text_around_a_lifted_block_keeps_its_own_tag() -> None:
    # 被顶出去的列表两边的文字仍然是标题，不降级成正文。
    # Text on either side of a lifted list stays a heading rather than demoting.
    assert sanitize_rich_html("<h2>head<ul><li>x</li></ul>tail</h2>") == (
        "<h2>head</h2><ul><li>x</li></ul><h2>tail</h2>"
    )


def test_text_is_escaped_not_reinterpreted() -> None:
    assert sanitize_rich_html("<p>&lt;script&gt;a &amp; b</p>") == "<p>&lt;script&gt;a &amp; b</p>"


def test_empty_in_empty_out() -> None:
    assert sanitize_rich_html("") == ""
    assert sanitize_rich_html("   ") == ""


def test_too_long_raises_rather_than_truncating() -> None:
    with pytest.raises(ValueError):
        sanitize_rich_html("<p>" + "x" * (MAX_RICH_LEN * 2 + 10) + "</p>")


def test_plain_text_keeps_block_boundaries() -> None:
    assert rich_plain_text("<p>a</p><ul><li>b</li><li>c</li></ul>") == "a\nb\nc"
    assert rich_plain_text("") == ""


# ---------- 走 schema 的那条路 / through the schema ----------

def test_announcement_input_cleans_rich_blocks() -> None:
    body = AnnouncementIn(
        titleZh="标题",
        blocks=[AnnouncementBlock(kind="rich", textZh='<p onclick="x">中文</p><script>alert(1)</script>', textEn="<p>en</p>")],
    )
    assert body.blocks[0].textZh == "<p>中文</p>"
    assert body.blocks[0].textEn == "<p>en</p>"


def test_legacy_blocks_pass_through_untouched() -> None:
    """旧的分块内容不过清洗器：它们本来就不是 HTML，渲染侧当纯文本处理。
    Legacy blocks skip the cleaner: they were never HTML, and the renderer treats
    them as plain text."""
    body = AnnouncementIn(
        titleZh="t",
        blocks=[AnnouncementBlock(kind="paragraph", textZh="a < b", textEn="")],
    )
    assert body.blocks[0].textZh == "a < b"
