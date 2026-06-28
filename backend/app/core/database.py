"""数据库连接与会话管理 / Database engine and session management."""
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app.core.config import settings

# SQLite 需要 check_same_thread=False 以支持多线程 / SQLite needs this for multithreading
connect_args = (
    {"check_same_thread": False}
    if settings.DATABASE_URL.startswith("sqlite")
    else {}
)

engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI 依赖：提供数据库会话 / FastAPI dependency: yield a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """创建所有数据表 / Create all tables."""
    # 导入模型以注册到 Base / import models so they register on Base
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_columns()


def _migrate_columns() -> None:
    """轻量迁移：为已存在的旧表补充新列（SQLite 不会自动加列）。
    Lightweight migration: add new columns to existing tables (SQLite won't).
    """
    # 列名 -> SQL 类型 / column name -> SQL type
    ea_columns = {
        "symbol_suffix": "VARCHAR",
        "account_name": "VARCHAR",
        "account_currency": "VARCHAR",
        "balance": "FLOAT",
        "equity": "FLOAT",
        "leverage": "INTEGER",
        "company": "VARCHAR",
    }
    # 跨数据库的列类型映射 / cross-DB column type mapping
    is_postgres = settings.DATABASE_URL.startswith("postgres")
    datetime_type = "TIMESTAMP" if is_postgres else "DATETIME"

    inspector = inspect(engine)
    if "ea_bindings" in inspector.get_table_names():
        existing = {c["name"] for c in inspector.get_columns("ea_bindings")}
        with engine.begin() as conn:
            for name, col_type in ea_columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE ea_bindings ADD COLUMN {name} {col_type}"))

    # orders 表：补充新列 / add new columns on orders
    if "orders" in inspector.get_table_names():
        order_cols = {c["name"] for c in inspector.get_columns("orders")}
        order_new = {
            "mt5_login": "VARCHAR",
            "delivered_at": datetime_type,
        }
        with engine.begin() as conn:
            for name, col_type in order_new.items():
                if name not in order_cols:
                    conn.execute(text(f"ALTER TABLE orders ADD COLUMN {name} {col_type}"))
