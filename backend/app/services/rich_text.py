"""公告正文的富文本清洗：把管理员编辑器产出的 HTML 收敛成一小撮已知标签。

为什么后台从「内容块」改成一个富文本框（2026-09-21）：分块编辑在实际使用里太笨重
——发一条活动公告要点七八次「+ 段落」，而管理员真正想要的只是"在一个框里打字，
顺手调字号、加粗、空一行、插张图"。块模型换来的安全性并没有消失，只是挪了个位置：
存进库之前这里按白名单重建一遍 HTML，前端渲染时再按同一份白名单解析成 React 节点，
两侧都不存在"把库里的字符串塞进 innerHTML"这一步。

清洗规则（白名单，不是黑名单——黑名单永远漏）：
  · 标签：只留版式相关的那几个，其余**拆掉但保留文字**（unwrap）；script / iframe /
    svg 这类连内容一起丢。
  · 属性：只留 class（再按 ALLOWED_CLASSES 过一遍）、a 的 href、img 的 src/alt。
    on* 事件、style、srcset 一概不留。
  · 链接只认 http(s) 与 mailto，图片只认 http(s)：javascript: / data: 直接判死。
  · 结构：块级标签不嵌套，游离的文字自动裹进 <p>，li 只在 ul/ol 里成立。

空段落（<p></p>）是**内容**不是垃圾：管理员按两次回车要的就是一条空行，这里不清。

Server-side cleaning of the announcement body's rich HTML.

Why the admin switched from content blocks to one rich-text box (2026-09-21):
block editing turned out to be clumsy in practice — publishing one campaign post
meant pressing "+ paragraph" eight times, when all an admin wants is to type in a
box and reach for bold, a bigger size, a blank line, an image. The safety the
block model bought is not lost, only moved: this rebuilds the HTML against a
whitelist before it is stored, and the client parses it into React nodes against
the same whitelist when rendering. Neither side ever pushes a stored string into
innerHTML.

Whitelist, never a blacklist (a blacklist always leaks): only layout tags survive,
anything else is unwrapped with its text kept, and script/iframe/svg-style
elements are dropped with their contents. Only class (itself filtered), a[href]
and img[src|alt] survive as attributes — no on* handlers, no style, no srcset.
Links accept http(s) and mailto only, images http(s) only. Block tags never nest,
loose text is wrapped in <p>, and li only counts inside ul/ol.

An empty <p> is content, not noise: two Enters means a blank line, and it stays.
"""

from __future__ import annotations

import html as _html
import re
from html.parser import HTMLParser

# 清洗后的正文长度上限。一条公告是通知不是文章，6 万字符（约 2 万汉字）已经远超
# 任何真实用法，这里只是别让一个畸形输入把库和响应撑爆。
# Cap on the cleaned body. An announcement is a notice, not an essay; 60k chars is
# far past any real use and exists only so malformed input can't bloat the row.
MAX_RICH_LEN = 60_000
# 嵌套深度上限：正常内容最多 ul > li > strong > span 四层，超过的一律摊平。
# Nesting cap: real content peaks at ul > li > strong > span; deeper is flattened.
MAX_DEPTH = 12

# 允许的 class。字号 / 对齐 / 颜色都走这张表，而不是 style 属性——取值定死在
# 设计刻度上，管理员调不出 72px 的荧光绿，CSS 也不必信任库里的字符串。
# The allowed classes. Size, alignment and colour ride here rather than in a style
# attribute: the values stay on the design scale (no 72px neon green), and the CSS
# never has to trust a string from the database.
ALLOWED_CLASSES = frozenset({
    "fs-sm", "fs-lg", "fs-xl",
    "ta-center", "ta-right",
    "c-hi", "c-dim", "c-violet", "c-up", "c-down", "c-amber",
})

BLOCK_TAGS = frozenset({"p", "h2", "h3", "blockquote"})
LIST_TAGS = frozenset({"ul", "ol"})
INLINE_TAGS = frozenset({"strong", "em", "u", "s", "span", "a", "br", "img"})
SELF_CLOSING = frozenset({"br", "hr", "img"})
ALLOWED_TAGS = BLOCK_TAGS | LIST_TAGS | INLINE_TAGS | {"li", "hr"}

# 同义标签归一：b→strong 之类。浏览器的 execCommand 到今天仍然产出 b / i / font，
# 归一之后渲染侧只需要认一种写法。
# Fold synonyms: execCommand still emits b / i / font in 2026, and normalising here
# means the renderer only ever meets one spelling.
TAG_MAP = {
    "b": "strong", "i": "em", "strike": "s", "del": "s", "ins": "u",
    "h1": "h2", "h4": "h3", "h5": "h3", "h6": "h3",
    "div": "p", "section": "p", "article": "p", "header": "p", "footer": "p",
    "figure": "p", "figcaption": "p", "pre": "p", "dd": "p", "dt": "p",
    "code": "span", "small": "span", "mark": "span", "sub": "span",
    "sup": "span", "font": "span", "big": "span", "abbr": "span",
}

# 连内容一起丢的标签：这些东西的"文字"本身就是代码或样式，unwrap 反而把脚本正文
# 倒进页面。/ Dropped with their contents: for these the text *is* code or CSS, and
# unwrapping would pour a script body into the page as copy.
DROP_TREE = frozenset({
    "script", "style", "iframe", "object", "embed", "svg", "math", "template",
    "noscript", "link", "meta", "base", "head", "title", "form", "input",
    "button", "select", "option", "textarea", "audio", "video", "source",
    "track", "canvas", "applet", "frame", "frameset", "map", "area", "portal",
})

# HTML 规范里的空元素：解析时不能把它们压进栈，否则后面的内容会全被当成它的孩子。
# The spec's void elements: they must not be pushed on the parse stack, or every
# following node becomes their child.
_VOID = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})

_SAFE_HREF = re.compile(r"^(?:https?://|mailto:)\S", re.IGNORECASE)
_SAFE_SRC = re.compile(r"^https?://\S", re.IGNORECASE)
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
# 地址里出现引号 / 尖括号 / 空白只可能是畸形输入或一次越界尝试。序列化本来就会把
# 它们转义、伤不到人，但留着等于把一段"看起来像属性"的字符串塞进 URL——直接剪掉，
# 输出里就不会有 onerror= 这种看着惊悚、实则无害的噪声。
# A quote, angle bracket or space inside a URL is either malformed input or an
# attempt to break out. Serialisation escapes them and they are inert either way,
# but keeping them buries an attribute-looking string inside a URL; cutting them
# means the output never carries alarming-but-harmless noise like onerror=.
_URL_JUNK = re.compile(r"[\"'<>`\\\s]")


class _Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs: dict[str, str] | None = None) -> None:
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[_Node | str] = []


class _Builder(HTMLParser):
    """宽容地把一串 HTML 建成树：多余的结束标签忽略，没闭合的标签在末尾自动收口。
    Forgiving tree build: stray end tags are ignored, unclosed ones close at EOF."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root")
        self.stack: list[_Node] = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs})
        self.stack[-1].children.append(node)
        if node.tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.stack[-1].children.append(_Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs}))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data: str) -> None:
        if data:
            self.stack[-1].children.append(data)


def _classes(raw: str) -> str:
    seen: list[str] = []
    for c in raw.split():
        if c in ALLOWED_CLASSES and c not in seen:
            seen.append(c)
    return " ".join(seen)


def _attrs_for(tag: str, raw: dict[str, str]) -> dict[str, str] | None:
    """按标签过属性；返回 None 表示这个节点该整个丢掉（图片地址不合法）。
    Filter attributes per tag; None means drop the node (an illegal image URL)."""
    out: dict[str, str] = {}
    cls = _classes(raw.get("class", ""))
    if cls:
        out["class"] = cls
    if tag == "a":
        href = _URL_JUNK.sub("", _CTRL.sub("", raw.get("href", "")))
        if _SAFE_HREF.match(href):
            out["href"] = href[:500]
    elif tag == "img":
        src = _URL_JUNK.sub("", _CTRL.sub("", raw.get("src", "")))
        if not _SAFE_SRC.match(src):
            return None
        out["src"] = src[:500]
        alt = _CTRL.sub(" ", raw.get("alt", "")).strip()
        if alt:
            out["alt"] = alt[:200]
    return out


def _clean_inline(nodes: list[_Node | str], depth: int) -> list[_Node | str]:
    """行内上下文：块级标签在这里被拆开，只留它们的文字与行内标记。
    Inline context: block tags are unwrapped here, keeping their text and marks."""
    out: list[_Node | str] = []
    for n in nodes:
        if isinstance(n, str):
            out.append(n)
            continue
        if n.tag in DROP_TREE:
            continue
        tag = TAG_MAP.get(n.tag, n.tag)
        if depth >= MAX_DEPTH or tag not in INLINE_TAGS:
            out.extend(_clean_inline(n.children, depth + 1))
            continue
        attrs = _attrs_for(tag, n.attrs)
        if attrs is None:
            continue
        # href 没活下来的 <a> 不该再是链接，但文字要留着。
        # An <a> whose href didn't survive is no longer a link, but keeps its text.
        if tag == "a" and "href" not in attrs:
            out.extend(_clean_inline(n.children, depth + 1))
            continue
        node = _Node(tag, attrs)
        if tag not in SELF_CLOSING:
            node.children = _clean_inline(n.children, depth + 1)
        out.append(node)
    return out


def _is_blank(nodes: list[_Node | str]) -> bool:
    return all(isinstance(n, str) and not n.strip() for n in nodes)


def _list_items(node: _Node, depth: int) -> list[_Node]:
    """ul / ol 的条目。嵌套列表摊平成同级条目：公告里第二层缩进没有信息量。
    The items of a ul/ol. Nested lists flatten into siblings — a second indent
    level carries no meaning in an announcement."""
    items: list[_Node] = []
    for child in node.children:
        if isinstance(child, str):
            if child.strip():
                li = _Node("li")
                li.children = [child]
                items.append(li)
            continue
        if child.tag in DROP_TREE:
            continue
        ctag = TAG_MAP.get(child.tag, child.tag)
        if ctag in LIST_TAGS and depth < MAX_DEPTH:
            items.extend(_list_items(child, depth + 1))
            continue
        li = _Node("li", _attrs_for("li", child.attrs) or {})
        li.children = _clean_inline(child.children if ctag == "li" else [child], depth + 1)
        items.append(li)
    return items


def _has_block_child(n: _Node) -> bool:
    """这个块里是不是又套了一层块级标签。

    浏览器真的会产出 `<p><ul><li>…</li></ul></p>`（在一个整段都被选中的段落上按
    「项目符号」就是），照 `_clean_inline` 走会把 ul 拆掉、列表整个消失。认出来之后
    改走块级递归，把它顶出去变成兄弟节点。
    Whether this block wraps another block. Browsers really do emit
    `<p><ul><li>…</li></ul></p>` — pressing "bullet list" on a fully selected
    paragraph does it — and treating that as inline content would unwrap the ul and
    lose the list. Recognising it switches to the block path, which lifts the list
    out as a sibling.
    """
    hoistable = BLOCK_TAGS | LIST_TAGS | {"li", "hr"}
    return any(
        isinstance(c, _Node) and c.tag not in DROP_TREE and TAG_MAP.get(c.tag, c.tag) in hoistable
        for c in n.children
    )


def _clean_blocks(nodes: list[_Node | str], depth: int, wrap: str = "p", wrap_attrs: dict[str, str] | None = None) -> list[_Node]:
    """块级上下文：游离的行内内容攒起来裹进一个块，块级标签逐个落地。

    `wrap` 是游离内容用哪个标签收口。默认 <p>；从一个套了块的 <h2> 里递归下来时
    传 h2，这样被顶出去的列表两边的文字不会降级成正文。
    Block context: loose inline content accumulates into one block; block tags land
    one by one. `wrap` is the tag that collects the loose content — <p> by default,
    or the outer tag when recursing into a block that wrapped another, so text on
    either side of a lifted list does not demote to body copy.
    """
    out: list[_Node] = []
    pending: list[_Node | str] = []

    def flush() -> None:
        nonlocal pending
        if pending and not _is_blank(pending):
            p = _Node(wrap, dict(wrap_attrs or {}))
            p.children = pending
            out.append(p)
        pending = []

    for n in nodes:
        if isinstance(n, str):
            pending.append(n)
            continue
        if n.tag in DROP_TREE:
            continue
        tag = TAG_MAP.get(n.tag, n.tag)

        if tag == "img":
            # 图片自成一块：公告里的图是配图，不是行内小图标，夹在段落中间只会
            # 把行高撑歪。/ An image is its own block: announcement art is art, not
            # an inline glyph, and mid-paragraph it only wrecks the line box.
            flush()
            out.extend(x for x in _clean_inline([n], depth) if isinstance(x, _Node))
            continue

        if tag in INLINE_TAGS:
            pending.extend(_clean_inline([n], depth))
            continue

        if tag == "hr":
            flush()
            out.append(_Node("hr"))
            continue

        if tag in BLOCK_TAGS:
            flush()
            # 一个子节点都没有的块是解析产物而不是内容（HTML 解析器拆非法嵌套时
            # 会留下这种空壳）。管理员按两次回车留下的空行是 <p><br></p>——
            # contenteditable 一定会补那个 <br>——有子节点，照常保留。
            # A block with no child nodes is a parsing artefact rather than content
            # (HTML parsers leave these shells behind when splitting illegal
            # nesting). The blank line two Enters make is <p><br></p>, since
            # contenteditable always adds that filler, and it is kept.
            if not n.children:
                continue
            attrs = _attrs_for(tag, n.attrs) or {}
            if depth < MAX_DEPTH and _has_block_child(n):
                out.extend(_clean_blocks(n.children, depth + 1, wrap=tag, wrap_attrs=attrs))
                continue
            node = _Node(tag, attrs)
            node.children = _clean_inline(n.children, depth + 1)
            out.append(node)
            continue

        if tag in LIST_TAGS:
            flush()
            items = _list_items(n, depth)
            if items:
                node = _Node(tag, _attrs_for(tag, n.attrs) or {})
                node.children = list(items)
                out.append(node)
            continue

        if tag == "li":
            # 游离的 li（没有 ul 包着）当段落处理 / a stray li reads as a paragraph
            flush()
            p = _Node("p")
            p.children = _clean_inline(n.children, depth + 1)
            out.append(p)
            continue

        # 其余容器：拆掉外壳，内容按块继续 / unknown container: unwrap, keep going
        if depth >= MAX_DEPTH:
            pending.extend(_clean_inline(n.children, depth + 1))
        else:
            flush()
            out.extend(_clean_blocks(n.children, depth + 1))

    flush()
    return out


def _serialize(nodes: list[_Node | str]) -> str:
    parts: list[str] = []
    for n in nodes:
        if isinstance(n, str):
            parts.append(_html.escape(n, quote=False))
            continue
        attrs = "".join(f' {k}="{_html.escape(v, quote=True)}"' for k, v in n.attrs.items())
        if n.tag in SELF_CLOSING:
            parts.append(f"<{n.tag}{attrs}>")
            continue
        parts.append(f"<{n.tag}{attrs}>{_serialize(n.children)}</{n.tag}>")
    return "".join(parts)


def sanitize_rich_html(raw: str) -> str:
    """把任意 HTML 收敛成白名单内的公告正文。空输入返回空串。

    超过 MAX_RICH_LEN 抛 ValueError——静默截断会把正文在半句话处切断，管理员按了
    保存、页面说成功，内容却少了一截，比报错难查得多。
    Reduce arbitrary HTML to the whitelisted announcement body; empty in, empty out.
    Over MAX_RICH_LEN raises ValueError: silent truncation would cut the body
    mid-sentence behind a "saved" toast, which is far harder to notice than an error.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if len(raw) > MAX_RICH_LEN * 2:
        raise ValueError(f"正文过长 / body too long (max {MAX_RICH_LEN} characters)")
    builder = _Builder()
    builder.feed(raw)
    builder.close()
    out = _serialize(_clean_blocks(builder.root.children, 0))
    if len(out) > MAX_RICH_LEN:
        raise ValueError(f"正文过长 / body too long (max {MAX_RICH_LEN} characters)")
    return out


def rich_plain_text(raw: str) -> str:
    """富文本 → 纯文本，块之间用换行隔开。推送正文、日志、审计用。
    Rich HTML to plain text with newlines between blocks — for pushes and logs."""
    if not raw:
        return ""
    builder = _Builder()
    builder.feed(raw)
    builder.close()
    breaks = BLOCK_TAGS | LIST_TAGS | {"li", "br", "hr"}

    def walk(nodes: list[_Node | str], buf: list[str]) -> None:
        for n in nodes:
            if isinstance(n, str):
                buf.append(n)
                continue
            if n.tag in DROP_TREE:
                continue
            if TAG_MAP.get(n.tag, n.tag) in breaks:
                buf.append("\n")
            walk(n.children, buf)

    buf: list[str] = []
    walk(builder.root.children, buf)
    lines = [ln.strip() for ln in "".join(buf).split("\n")]
    return "\n".join(ln for ln in lines if ln)
