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
