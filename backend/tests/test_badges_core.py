"""勋章改制后核心判定：进阶三档、只升不降。

**为什么要测。** 档位逻辑的失败方式全是静默的：判定取错档（该金给了铜）、升档
时把 awarded_at 或档位写丢、同一枚重复插入撞唯一约束被当成"没新发"、推送名
不带档位——页面上只看得到结果，看不出算错。这里逐条钉住。
"""
from datetime import datetime, timezone

from app.models import User, Order, ClosedTrade, MT5Account, UserBadge
from app.services.gamification.badges import (
    BADGES, LEGACY_BADGE_MAP, LEGACY_DROPPED, MAX_TIER, award_badge,
    badge_display_name, equipped_badge_tiers, judge_and_award_badges)

NOW = datetime.now(timezone.utc)


def _user(db, **kw):
    u = User(email=kw.pop("email", "b@t.co"), api_token=kw.pop("tok", "tok_b"), **kw)
    db.add(u); db.commit(); return u


def _real_fill(db, u, ticket, login="1", profit=1.0, volume=0.2, trade_mode=2, close=True):
    db.add(Order(user_id=u.id, client_order_id=f"c{ticket}", symbol="X", side="BUY",
                 volume=volume, status="FILLED", mt5_login=login, mt5_ticket=ticket,
                 trade_mode=trade_mode, created_at=NOW))
    if close:
        db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                           close_volume=volume, close_price=1, profit=profit,
                           position_ticket=ticket, deal_ticket=ticket * 10,
                           closed_at=NOW, verified=True))


def test_registry_shape():
    assert {"starter", "evergreen", "winning_hand", "arena", "comp_back_to_back", "founder_2026"} <= set(BADGES)
    for bid in ("starter", "evergreen", "winning_hand"):
        assert BADGES[bid]["max_tier"] == MAX_TIER and len(BADGES[bid]["judges"]) == 3
    assert BADGES["arena"]["max_tier"] == 3 and BADGES["arena"]["judges"] is None      # 终审授予
    assert BADGES["comp_back_to_back"]["max_tier"] == 0 and BADGES["comp_back_to_back"]["judges"] is None
    assert BADGES["founder_2026"]["max_tier"] == 0 and callable(BADGES["founder_2026"]["judges"])
    # 旧 id 全部有去处或明确删除，且去处都是现存勋章
    assert all(new in BADGES and 1 <= tier <= 3 for new, tier in LEGACY_BADGE_MAP.values())
    assert LEGACY_DROPPED == {"discipline_90_7", "discipline_90_30", "no_bad_sl_50"}
    assert not (set(LEGACY_BADGE_MAP) & LEGACY_DROPPED)


def test_display_name_carries_tier_only_for_tiered_badges():
    assert badge_display_name("starter", 3) == "起步 · 金"
    assert badge_display_name("evergreen", 1) == "常青 · 铜"
    assert badge_display_name("comp_back_to_back") == "卫冕王"
    assert badge_display_name("founder_2026", 0) == "创始元老"
    assert badge_display_name("unknown_id", 2) == "unknown_id"       # 缺失回落原始 id，不炸


def test_starter_takes_highest_satisfied_tier(db_session):
    """起步：完善资料铜 / 首笔平仓银 / 首笔实盘金，取满足的最高档，不要求低档也满足。"""
    u = _user(db_session, nickname="T")
    db_session.add(MT5Account(user_id=u.id, login="1", server="s")); db_session.commit()
    assert judge_and_award_badges(db_session, u.id) == ["starter:1"]
    # 一笔完整的模拟盘平仓 → 银（模拟不算实盘）
    _real_fill(db_session, u, 9, trade_mode=0); db_session.commit()
    assert judge_and_award_badges(db_session, u.id) == ["starter:2"]
    assert judge_and_award_badges(db_session, u.id) == []               # 幂等
    # 一笔实盘开仓 → 金；库里仍只有一行、档位升到 3
    _real_fill(db_session, u, 10, close=False); db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "starter:3" in got and not {"starter:1", "starter:2"} & set(got)   # 同时也可能拿到创始元老
    rows = db_session.query(UserBadge).filter_by(user_id=u.id, badge_id="starter").all()
    assert len(rows) == 1 and rows[0].tier == 3


def test_starter_gold_without_bronze(db_session):
    """没设昵称的人首笔实盘直接拿金——档位是荣誉高低，不是关卡。"""
    u = _user(db_session, email="nonick@t.co", tok="tok_nn")
    _real_fill(db_session, u, 1, close=False); db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "starter:3" in got and "starter:1" not in got


def test_award_badge_only_moves_up(db_session):
    u = _user(db_session, email="up@t.co", tok="tok_up")
    assert award_badge(db_session, u.id, "evergreen", 2) is True
    assert award_badge(db_session, u.id, "evergreen", 2) is False       # 同档不动
    assert award_badge(db_session, u.id, "evergreen", 1) is False       # 不降档
    assert award_badge(db_session, u.id, "evergreen", 3) is True        # 升档
    row = db_session.query(UserBadge).filter_by(user_id=u.id, badge_id="evergreen").one()
    assert row.tier == 3
    # 独立勋章：档位 0，重复发不算新发
    assert award_badge(db_session, u.id, "comp_back_to_back") is True
    assert award_badge(db_session, u.id, "comp_back_to_back") is False


def test_hundred_wins_single_account_is_winning_hand_bronze(db_session):
    """胜手铜 = 单账户 100 笔盈利单。跨账号拼凑不得发；亏损单压住盈亏比，
    免得 100 笔零亏损直接触发金档（盈亏比无穷大）盖过本用例要测的铜档。"""
    u = _user(db_session)
    t = 0
    for login, n in (("A", 60), ("B", 60)):          # A 60 胜、B 60 胜
        for _ in range(n):
            t += 1
            _real_fill(db_session, u, t, login=login)
    for _ in range(60):                               # A 再加 60 笔小亏：盈亏比 1.1，不够金档
        t += 1
        _real_fill(db_session, u, t, login="A", profit=-0.9)
    db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert not any(x.startswith("winning_hand") for x in got)
    for _ in range(40):                               # A 补到 100 胜（≥20 手、盈利为正）→ 铜
        t += 1
        _real_fill(db_session, u, t, login="A")
    db_session.commit()
    assert "winning_hand:1" in judge_and_award_badges(db_session, u.id)


def test_founder_window(db_session):
    u = _user(db_session)
    u.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    _real_fill(db_session, u, 1, close=False); db_session.commit()
    assert "founder_2026" in judge_and_award_badges(db_session, u.id)
    u2 = _user(db_session, email="l@t.co", tok="tok_l")
    u2.created_at = datetime(2027, 1, 2, tzinfo=timezone.utc)
    _real_fill(db_session, u2, 2, login="2", close=False); db_session.commit()
    assert "founder_2026" not in judge_and_award_badges(db_session, u2.id)


def test_first_real_trade_requires_open_not_modify(db_session):
    u = _user(db_session)
    u.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    # 一笔 FILLED 的实盘 MODIFY（改止损）——Gateway 对 CLOSE/MODIFY 同样置 FILLED
    # 并打 trade_mode 快照，但这不是"开仓"，不该算首笔实盘成交。
    db_session.add(Order(user_id=u.id, client_order_id="m1", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=1,
                         action="MODIFY", trade_mode=2, created_at=NOW))
    db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "starter:3" not in got and "founder_2026" not in got
    _real_fill(db_session, u, 2, close=False); db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "starter:3" in got and "founder_2026" in got


def test_equipped_badge_tiers(db_session):
    """榜单行要画金银铜：按人取「默认佩戴」那枚的档位，没戴 / 独立勋章为 0。"""
    a = _user(db_session, email="a@t.co", tok="ta", equipped_badge="evergreen", equipped_badges="evergreen")
    b = _user(db_session, email="b2@t.co", tok="tb", equipped_badge="founder_2026", equipped_badges="founder_2026")
    c = _user(db_session, email="c@t.co", tok="tc")
    db_session.add_all([UserBadge(user_id=a.id, badge_id="evergreen", tier=2),
                        UserBadge(user_id=a.id, badge_id="starter", tier=3),
                        UserBadge(user_id=b.id, badge_id="founder_2026", tier=0)])
    db_session.commit()
    tiers = equipped_badge_tiers(db_session, [a, b, c])
    assert tiers == {a.id: 2, b.id: 0}          # a 戴的是常青银，不是起步金；c 没戴
