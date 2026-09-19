"""测试期的编码兜底。

starlette 的 `Config` 用系统默认编码读 `.env`。中文版 Windows 默认是 GBK，而
`.env` 里有 UTF-8 中文注释，于是 `import app.routers.gateway`（经 rate_limit →
slowapi → starlette.Config）会抛 UnicodeDecodeError，pytest 连用例都收集不完。

生产环境不受影响（Linux 默认 UTF-8），这纯粹是本地跑测试的问题，所以修在
conftest 而不是产品代码里。

conftest 在测试模块导入之前加载，因此这里替换 `io.open` 的默认编码来得及生效；
只对读 `.env` 生效，其余调用原样透传。

Encoding fallback for tests.

starlette's `Config` reads `.env` with the system default encoding. On Chinese
Windows that's GBK, but `.env` contains UTF-8 Chinese comments, so importing
app.routers.gateway (via rate_limit -> slowapi -> starlette.Config) raises
UnicodeDecodeError and pytest can't even finish collection.

Production is unaffected (Linux defaults to UTF-8), so this is fixed here rather
than in product code. conftest loads before test modules are imported, so
patching the default encoding here is early enough; only `.env` reads are
touched, everything else passes through unchanged.
"""

import builtins
import os

_real_open = builtins.open


def _open_env_as_utf8(file, *args, **kwargs):
    if (
        isinstance(file, (str, bytes, os.PathLike))
        and os.fspath(file).endswith(".env")
        and "b" not in str(kwargs.get("mode", args[0] if args else "r"))
        and kwargs.get("encoding") is None
    ):
        kwargs["encoding"] = "utf-8"
    return _real_open(file, *args, **kwargs)


builtins.open = _open_env_as_utf8


import pytest  # noqa: E402  —— 必须在上面的 open 补丁之后导入


@pytest.fixture(scope="session", autouse=True)
def _restore_builtin_open():
    """跑完把 `builtins.open` 还回去。

    补丁本身必须在**导入期**打（上面那几行）：pytest 收集用例时就会 import 各测试
    模块，那一刻已经会去读 `.env`，等到 fixture 才打就来不及了。但「打得早」不等于
    「永远不还」——这个补丁原来是打完就不管，整个 pytest 进程的 `open` 从此与生产
    不同；插件、报告器、跟在测试后面跑的任何东西都在这个改过的 `open` 上运行。
    这条 session 级 fixture 在最后一个用例结束后把原函数放回去，把影响范围收敛到
    「测试会话之内」。

    Restore `builtins.open` when the session ends. The patch has to be applied at
    import time (above): collection imports the test modules, which already read
    `.env`, so a fixture would be too late. Applying it early is fine; never
    undoing it is not — the process's `open` stayed different from production for
    plugins, reporters and anything running after the tests. This session-scoped
    fixture puts the original back once the last test finishes, so the change is
    scoped to the test session.
    """
    yield
    builtins.open = _real_open


@pytest.fixture(autouse=True)
def _fresh_gamification_settings_cache():
    """每个用例前后各清一次游戏化设置缓存。

    `settings_store` 的游戏化设置是**进程级 30 秒缓存**，而测试全在一个进程里跑：
    一条用例把 min_trades 改成 1 之后不复位，后面任何直接调 `compute_board_rows`
    的用例就会读到上一条用例写进缓存的门槛。在这条 fixture 之前，全仓 65 处手写
    的 `invalidate_gamification_cache()` 是唯一的同步手段，漏写一处就靠文件字母序
    侥幸不炸——换个执行顺序（单跑某两个文件、`--lf`、xdist）就会翻车，而且翻的是
    看起来完全无关的那条用例。

    前后各清一次：前置保证本用例从全局默认开始，后置保证本用例写进去的设置不会
    漏给下一条。

    Clear the gamification settings cache before and after every test. Those
    settings are cached per process for 30 seconds and the whole suite shares one
    process, so a test that writes min_trades without resetting leaks into any
    later test that calls compute_board_rows directly. Until this fixture the only
    synchronisation was 65 hand-written invalidate_gamification_cache() calls, and
    the suite only passed because alphabetical file order happened to be kind —
    changing the order (running two files alone, --lf, xdist) broke a seemingly
    unrelated test. Clearing on both sides means a test starts from the global
    defaults and can't leak its own writes forward.
    """
    from app.services.settings_store import invalidate_gamification_cache
    invalidate_gamification_cache()
    yield
    invalidate_gamification_cache()


@pytest.fixture()
def db_session():
    """一次性的内存 SQLite 会话，建全表。

    每个用例一套独立的库与引擎，用例之间互不影响，也不碰开发机上的
    backend/prismx.db。app.models 在 fixture 内部导入，确保上面的 .env 编码
    补丁已经生效。

    A throwaway in-memory SQLite session with the full schema. One engine per
    test so cases can't leak into each other, and the developer's local
    prismx.db is never touched. app.models is imported inside the fixture so the
    .env encoding patch above is already in place.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 触发建表所需的模型注册 / registers the tables

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
