"""网关入口 / gateway entry point.

用法 / usage:
    python -m manager_feed.main              正常运行 / run
    python -m manager_feed.main --check      只自检配置与连接，不上报 / check only
    python -m manager_feed.main --dry-run    算但不推，用于验证聚合 / compute, don't push
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# 支持直接 python manager_feed/main.py 运行 / allow running the file directly
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from manager_feed.config import load_config
from manager_feed.gateway import Gateway

LOG_DIR = Path(__file__).resolve().parent / "logs"


def setup_logging(level: str) -> None:
    """同时输出到控制台和文件。文件便于装成服务后回溯问题。
    Log to console and file; the file matters once this runs as a service."""
    LOG_DIR.mkdir(exist_ok=True)
    fmt = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    try:
        handlers.append(logging.FileHandler(LOG_DIR / "manager_feed.log", encoding="utf-8"))
    except OSError as exc:
        print(f"无法写日志文件，仅输出到控制台 / file logging unavailable: {exc}")
    logging.basicConfig(level=getattr(logging, level, logging.INFO),
                        format=fmt, handlers=handlers)


def main() -> int:
    parser = argparse.ArgumentParser(description="PRISMX Manager 行情网关 / market-feed gateway")
    parser.add_argument("--check", action="store_true",
                        help="只自检配置与连接 / verify config and connection only")
    parser.add_argument("--dry-run", action="store_true",
                        help="计算但不上报 / compute without pushing")
    args = parser.parse_args()

    cfg = load_config()
    if args.dry_run:
        cfg.dry_run = True
    setup_logging(cfg.log_level)
    logger = logging.getLogger("manager_feed")

    problems = cfg.validate()
    if problems:
        logger.error("配置不完整 / incomplete configuration:")
        for p in problems:
            logger.error("  - %s", p)
        logger.error(
            "请编辑 %s，或设置对应环境变量 / edit %s or set the matching env vars",
            "manager_feed/config.ini", "manager_feed/config.ini",
        )
        return 2

    gw = Gateway(cfg)

    if args.check:
        return _run_check(gw, logger)

    gw.run_forever()
    return 0


def _run_check(gw: Gateway, logger: logging.Logger) -> int:
    """自检：连接、取价、取 M1、聚合。不上报任何数据。
    Self-check: connect, quote, M1, aggregate. Pushes nothing."""
    import time

    from manager_feed.aggregate import CANDLE_INTERVALS, aggregate

    if not gw.manager.connect():
        logger.error("连接失败，请检查 server / login / password"
                     " / connection failed, check server/login/password")
        return 1

    enabled = gw.cfg.enabled_symbols()
    logger.info("检查 %d 个品种 / checking %d symbol(s)", len(enabled), len(enabled))
    gw.manager.subscribe([s["broker"] for s in enabled])
    time.sleep(5)  # 等服务器泵第一批 tick / let the server pump the first ticks

    failures = 0
    for item in enabled:
        broker, display = item["broker"], item["display"]
        tick = gw.manager.tick(broker)
        if tick is None:
            logger.error("  %-10s (%s) 取不到报价 / no quote", display, broker)
            failures += 1
            continue

        now = int(time.time())
        m1 = gw.manager.m1_bars(broker, now - 6 * 3600, now)
        if not m1:
            logger.warning(
                "  %-10s (%s) bid=%s ask=%s，但近 6 小时无 M1（可能休市）"
                " / no M1 in 6h (market may be closed)",
                display, broker, tick["bid"], tick["ask"],
            )
            continue

        built = {i: len(aggregate(m1, i)) for i in CANDLE_INTERVALS}
        logger.info(
            "  %-10s (%s) bid=%s ask=%s digits=%d  M1=%d → %s",
            display, broker, tick["bid"], tick["ask"], gw.manager.digits(broker),
            len(m1), " ".join(f"{k}:{v}" for k, v in built.items()),
        )

    gw.manager.disconnect()
    if failures:
        logger.error("自检完成，%d 个品种有问题 / check finished with %d problem(s)",
                     failures, failures)
        return 1
    logger.info("自检通过 / check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
