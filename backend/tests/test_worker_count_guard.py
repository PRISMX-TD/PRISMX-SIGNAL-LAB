"""多 worker 检测：读得出就要读准，读不出就必须放行。

限流、登录失败锁定、MT5 验证锁定、回测并发闸门与回测缓存全是进程内状态。多开
一个 worker，它们各自独立计数——配置成 8 次/5 分钟的登录锁定，4 个 worker 下实际
要打满 32 次才锁，而且不报错、不打日志，防护静默除以 worker 数。config.py 在能
明确读出「多 worker + 进程内计数」时拒绝启动，把这种静默降级换成当场说话。

这个文件里最重要的不是「能不能认出 --workers 4」，是下面那组「必须返回 None」的
用例：这条检查一旦误判，代价是线上服务起不来。判不出来就放行，永远优于猜。

Detecting multiple workers: read it accurately when it can be read, and always
pass when it can't.

Rate limits, the login and MT5-verify lockouts, the backtest gate and its cache
are all in-process. Add a worker and each counts independently — a lockout set to
8 failures per 5 minutes really takes 32 across 4 workers, with no error and
nothing logged, every protection silently divided by the worker count. config.py
refuses to start when "multiple workers + in-process counters" reads off
positively, turning that silent degradation into a loud one.

The important group here is not "can it spot --workers 4" but the must-return-None
cases below: a false positive on this check costs a service that won't boot.
Can't tell, so don't block — always better than a guess.
"""
import pytest

from app.core.config import detect_worker_count


# ---------- 能读出来的写法 ----------


@pytest.mark.parametrize("argv,expected", [
    (["uvicorn", "app.main:app", "--workers", "4"], 4),
    (["uvicorn", "app.main:app", "--workers=4"], 4),
    (["gunicorn", "-w", "8", "app.main:app"], 8),
    (["uvicorn", "app.main:app", "--workers", "1"], 1),      # 明确的单 worker
    (["uvicorn", "app.main:app", "--host", "0.0.0.0", "--workers", "2"], 2),
])
def test_reads_worker_flags(argv, expected):
    assert detect_worker_count(argv, {}) == expected


@pytest.mark.parametrize("raw,expected", [("4", 4), ("1", 1), (" 3 ", 3)])
def test_reads_web_concurrency(raw, expected):
    assert detect_worker_count([], {"WEB_CONCURRENCY": raw}) == expected


def test_argv_wins_over_env():
    """命令行是实际生效的那个，环境变量只是默认值。"""
    assert detect_worker_count(["uvicorn", "--workers", "2"], {"WEB_CONCURRENCY": "9"}) == 2


# ---------- 必须返回 None（判不出来就放行）----------
#
# 这组用例保护的是可用性，不是安全。任何一条变成"猜出一个数"，都可能让一个正常的
# 单 worker 部署在下次重启时起不来。


@pytest.mark.parametrize("argv,env", [
    ([], {}),                                              # 什么都没有
    (["uvicorn", "app.main:app"], {}),                     # 常见的单 worker 启动
    (["uvicorn", "app.main:app", "--reload"], {}),         # 开发模式
    (["uvicorn", "--workers"], {}),                        # 有旗标但没有值
    (["uvicorn", "--workers", "abc"], {}),                 # 值不是数字
    (["uvicorn", "--workers=abc"], {}),
    ([], {"WEB_CONCURRENCY": ""}),                         # 空环境变量
    ([], {"WEB_CONCURRENCY": "   "}),
    ([], {"WEB_CONCURRENCY": "many"}),                     # 非数字
    (["python", "-m", "pytest", "-w", "tests"], {}),       # -w 后面不是数字
])
def test_returns_none_when_undeterminable(argv, env):
    assert detect_worker_count(argv, env) is None


def test_pytest_itself_is_not_mistaken_for_multi_worker():
    """本测试进程自己就是个反例：跑 pytest 时不能被判成多 worker。

    这条看着多余，实际是最贴近现实的一条——config.py 在 import 时就会跑这个判定，
    误判会让整个测试套件在收集阶段就崩掉。
    """
    import sys
    n = detect_worker_count(sys.argv, {})
    assert n is None or n == 1
