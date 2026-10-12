"""策略介绍的富文本块（2026-10-12）：与公告同一份白名单，入库前清洗。

这里盯两件事：rich 块里的危险标记进不了库；旧的四种块型照旧原样保存——它们在
渲染侧走纯文本节点，本来就不解析标记，不该被 HTML 清洗改掉一个字。

Rich-text blocks in strategy write-ups (2026-10-12): the same whitelist as
announcements, applied before storage. Two things are pinned: hostile markup in a
rich block never reaches storage, and the four legacy kinds are kept verbatim —
they render as plain text nodes and must not be altered by an HTML cleaner.
"""
from app.schemas import PlatformStrategyBlock, PlatformStrategyListOut, PlatformStrategyOut
from app.services.rich_text import MAX_RICH_LEN


def _strategy(blocks: list[dict]) -> dict:
    return {"id": "s1", "nameZh": "测试", "blocks": blocks}


def test_rich_block_is_sanitized_on_the_way_in():
    body = PlatformStrategyListOut(items=[_strategy([{
        "kind": "rich",
        "textZh": '<h2 onclick="x()">入场</h2><p>说明<script>alert(1)</script></p>'
                  '<ul><li><strong>要点</strong></li></ul><img src="javascript:alert(1)">',
        "textEn": '<p style="color:red">Entry</p><iframe src="https://evil"></iframe>',
    }])])
    b = body.items[0].blocks[0]
    assert b.kind == "rich"
    assert "<h2>入场</h2>" in b.textZh
    assert "<ul><li><strong>要点</strong></li></ul>" in b.textZh
    for bad in ("onclick", "<script", "alert(1)", "javascript:"):
        assert bad not in b.textZh
    assert b.textEn == "<p>Entry</p>"


def test_stored_rich_rows_are_cleaned_again_on_read():
    # 出库时同样过一遍：别的路径写进库的行也兜得住，而且清洗幂等。
    # Read path cleans too: rows from another path are covered, and it is idempotent.
    out = PlatformStrategyOut(**_strategy([{"kind": "rich", "textZh": '<p onmouseover="x()">a</p>'}]))
    assert out.blocks[0].textZh == "<p>a</p>"
    again = PlatformStrategyOut(**out.model_dump())
    assert again.blocks[0].textZh == "<p>a</p>"


def test_legacy_blocks_are_kept_verbatim():
    raw = "价格 <b>突破</b> 前高 & 回踩"
    out = PlatformStrategyOut(**_strategy([
        {"kind": "heading", "textZh": raw},
        {"kind": "paragraph", "textZh": raw},
        {"kind": "list", "textZh": "一\n二"},
    ]))
    assert [b.textZh for b in out.blocks] == [raw, raw, "一\n二"]


def test_rich_block_length_cap_follows_rich_limit():
    # 整篇说明放在一块里，4000 字的旧上限不够用 / one block holds the whole write-up
    long_html = "<p>" + "字" * 10_000 + "</p>"
    b = PlatformStrategyBlock(kind="rich", textZh=long_html)
    assert len(b.textZh) > 4_000
    assert PlatformStrategyBlock.model_fields["textZh"].metadata[0].max_length == MAX_RICH_LEN
