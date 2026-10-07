"""PRISMX 桥接程序 / PRISMX Bridge App.

一个本地桌面程序：扫描本机所有正在运行的 MT5 终端，用 API Token 与
后端建立连接，把多个账号上报到网页，并执行网页下发的下单指令。
A local desktop app that scans all running MT5 terminals, links to the
backend with an API token, reports multiple accounts to the web app, and
executes order commands pushed from the web.

打开后第一步即要求用户输入 API Token。
On launch the first thing it asks for is the user's API token.
"""
import base64
import ctypes
import hashlib
import hmac
import http.client
import json
import logging
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import webbrowser
import winreg
from ctypes import wintypes
from collections import deque
from logging.handlers import RotatingFileHandler
from tkinter import messagebox, ttk
from urllib import error, request
from urllib.parse import urlparse

from mt5_worker import (
    poll_terminal,
    read_live_quotes,
    read_pending_orders,
    read_positions,
    scan_closed_trades,
)
# 下划线开头但刻意从这里引：一张单到底成没成交的判据（查 history_orders_get、哪些
# 状态算终态、ORDER_STATE_PARTIAL 为什么不算）全部长在 mt5_worker 里，重发时的二次
# 确认（见 BridgeEngine._reconfirm_cached）必须与执行路径用**同一份**判据，另写一份
# 迟早会与它分叉。
# Imported despite the underscore: mt5_worker owns the entire "did this order fill"
# judgement, and the re-delivery re-confirmation must use that exact same judgement
# rather than a second copy that will drift away from it.
from mt5_worker import _confirm_order_filled as confirm_order_filled

# 系统托盘：可选依赖，缺失时静默降级为"点 X 直接退出"的旧行为，不影响主功能。
# System tray: optional dependency; missing it silently falls back to the old
# "X quits immediately" behavior instead of breaking the app.
try:
    import pystray
    from PIL import Image as PILImage
    _TRAY_AVAILABLE = True
except Exception:
    pystray = None
    PILImage = None
    _TRAY_AVAILABLE = False

# ---------- 版本 / Version ----------
# 1.4.2（2026-09-19 审计修复）：回执协议加了第三态。桥接现在除 `success` 外还上报
# `status`（FILLED / REJECTED / FAILED）与实际执行的 `volume`，后端按 `status` 落库、
# 不带该字段的旧桥接回落到老口径（见 backend/app/routers/bridge.py 的
# BridgeResultRequest）。这是**线上协议变更**，所以必须升版本号——后端的兼容分支、
# 以及下载页「有新版本可更新」的提示都以这个号为准。
# 同版还加了：自更新的 Ed25519 签名校验、PLACED 后的二次确认、positions_get 的
# None 与 () 分开处理、MODIFY 缺字段不再按 0 下发、开仓强制正手数。
#
# 1.4.2 (2026-09-19 audit): the result protocol gained a third state. The bridge now
# reports `status` (FILLED / REJECTED / FAILED) and the executed `volume` alongside
# `success`. This is a wire-protocol change, so the version must move: the backend's
# compatibility branch and the "update available" prompt both key on it.
# 1.4.3（2026-09-22 图表页挂单）：新增两种指令 PENDING（挂限价/止损单）与
# CANCEL_PENDING（撤挂单），回执协议加入第四态 `PLACED`（"单已挂在券商那边、
# 尚未成交，本来也不该成交"——不能并进 FILLED，否则一张可能永远不触发的挂单会
# 被当成一笔完成的交易计进胜率与勋章）。状态上报同时带上 `pendingOrders`，
# 网页据此显示并撤销真实的 MT5 挂单。
# 又一次**线上协议变更**：不带 `pendingOrders` 的旧桥接，后端会保留前端已有的
# 挂单列表而不是清空（见 BridgePositionsRequest.pendingOrders 的注释）。
#
# 1.4.3 (2026-09-22, pending orders from the charts page): two new commands,
# PENDING and CANCEL_PENDING, plus a fourth result state `PLACED` (resting at the
# broker, unfilled and not meant to fill — folding it into FILLED would count an
# order that may never trigger as a completed trade). Status reports now carry
# `pendingOrders` so the web can list and cancel real MT5 pending orders. Another
# wire-protocol change; a bridge that omits `pendingOrders` leaves the frontend's
# existing list alone rather than clearing it.
# 1.4.4（2026-09-23）：新增 MODIFY_PENDING 指令——网页图表上拖挂单的触发价 /
# 止损 / 止盈那条线即可改单。三项都是「没带 = 保留挂单上的现值」，止损止盈传 0
# 仍是清除（与 MODIFY 同一套语义）。指令集变了，所以版本号必须动。
#
# 1.4.4 (2026-09-23): new MODIFY_PENDING command — dragging a pending order's trigger,
# stop or target line on the web chart edits it. All three default to "keep what the
# order has"; 0 still clears SL/TP, as with MODIFY. The command set changed, so the
# version must move.
#
# 1.4.5 (2026-09-23)：开仓 / 挂单的券商备注按后端下发的来源标签写成 PRISMX-SIG（跟单）/
# PRISMX-STRAT（个人策略）/ PRISMX-CHART（图表）；后端没带标签时仍写 PRISMX。
#
# 1.4.5 (2026-09-23): open / pending-order comments carry the backend's source tag —
# PRISMX-SIG / PRISMX-STRAT / PRISMX-CHART; plain PRISMX when no tag is sent.
#
# 1.4.6（2026-09-25）：报价改由独立线程每 0.5 秒上报（只发有变化的，单终端时生效，
# 多终端退回主循环原路径）；状态轮询拆成两段短锁，平仓扫描不再挡住下单指令。
# 线上协议没变。
#
# 1.4.6 (2026-09-25): quotes go out from their own thread every 0.5 s (changes only;
# single-terminal only, multi-terminal falls back to the main loop); the status poll
# takes the MT5 lock in two short sections so the closed-trade scan no longer blocks
# commands. No wire-protocol change.
#
# 1.4.7（2026-09-29）：减负与稳定性。① 没有持仓/挂单且内容没变时不再每拍上报，约每
# 15 秒补一次保活；② 后端在 poll 响应里带 wantQuotes=false（没人开着网页）时报价放慢
# 到约 3 秒，字段缺失（旧后端）或为真时仍 0.5 秒；③ 状态循环的心跳 /poll 约每 3 秒一次
# （按上次成功计时，失败下一拍立即重试）；④ 后端不可用时指令循环 / 状态循环指数退避加
# 抖动；⑤ 指令长轮询 HTTP 超时 15→9 秒；⑥ 平仓/下单结果回报交给独立线程排队发送，指令
# 线程先报持仓、不再逐条等 /result。线上协议没有新增必填字段，回执三态语义不变。
#
# 1.4.7 (2026-09-29): load and resilience. Empty/unchanged positions are no longer posted
# every tick (keep-alive about every 15 s); quotes slow to ~3 s when the backend says
# wantQuotes=false in the poll reply (missing/true keeps 0.5 s); the status-loop heartbeat
# poll goes out about every 3 s (timed from the last success, retried next tick on
# failure); both loops back off exponentially with jitter while the backend is down; the
# command long-poll HTTP timeout drops 15 -> 9 s; order results are reported by their own
# thread so the command thread reports positions first. Result semantics are unchanged.
#
# 1.4.8（2026-10-08）：下单安全。① 断开重连 / 一键更新 / 退出时等进行中的指令做完并写进
# 已执行缓存再交接，缓存与 MT5 锁全进程共用、写盘合并，后端重发的同一张单只执行一次；
# ② 发单前核对终端当前登录的账号与指令一致，不一致直接拒绝（不会下到别的账户，也不会把
# 错账户上的平仓报成成交）；③ 断开不再卡界面；④ 手数步长 1e-05 等科学计数法、0 位小数
# 品种、按最小变动价位对齐止损止盈；⑤ 撤挂单查不到结果不再算成功；⑥ 深度回扫失败会重试。
#
# 1.4.8 (2026-10-08): order safety. Disconnect/reconnect, self-update and exit wait for
# the in-flight command to finish and be recorded before handing over; the executed
# cache and MT5 lock are process-wide and saves merge, so a re-sent order runs once.
# Orders are rejected when the terminal's logged-in account differs from the command's.
# Disconnect no longer freezes the UI; lot steps like 1e-05, 0-digit symbols and tick-size
# aligned SL/TP; an unconfirmable pending cancel no longer counts as done; a failed deep
# rescan is retried.
APP_VERSION = "1.4.8"

# ---------- 更新检测 / Update check ----------
# 通过 GitHub Releases 检查是否有更新的安装包版本。
# Check GitHub Releases for a newer installer version.
GITHUB_OWNER_REPO = "PRISMX-TD/PRISMX-SIGNAL-LAB"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_OWNER_REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{GITHUB_OWNER_REPO}/releases/latest"
# 安装包资产文件名（须与网页下载页 DownloadPage.tsx 的 BRIDGE_FILENAME 一致）。
# 找到匹配的资产就直接下载它，而不是把用户丢到 GitHub 发布页自己找文件。
# Installer asset filename (must match BRIDGE_FILENAME in the web DownloadPage.tsx).
# When found, download it directly instead of sending the user to the GitHub
# releases page to hunt for the file themselves.
BRIDGE_ASSET_FILENAME = "PRISMX-Bridge-Setup.exe"
# 更新检查间隔（秒）：启动检查一次，之后每 10 分钟复查一次。
# Update check interval (seconds): once on launch, then every 10 minutes.
UPDATE_CHECK_INTERVAL = 600

# ---------- 自更新的来源校验 / self-update provenance ----------
# 为什么需要这一段：自更新是整条链路上**唯一**一处「把远端二进制装到用户机器上并
# 执行」的地方，而运行它的那台机器上正登录着用户真实的 MT5 交易账号。旧版只检查
# 下载文件的头两字节是 MZ、体积不小于 5 MB——GitHub 账号被盗、Release 被投毒、
# 或者用户机器上装了中间人根证书（企业代理、部分国产安全软件；urlopen 默认读系统
# 信任库与系统代理），都足以让任意 exe 通过这两条检查并被执行。
# Why this exists: self-update is the only place in the whole system that installs
# and runs a remote binary on a machine that is signed into the user's real trading
# account. The old checks (MZ header + 5 MB floor) are passed trivially by any exe.
#
# 校验方案：发布方在 Release 里额外附两个资产——
#   SHA256SUMS      每行 "<64位十六进制>  <文件名>"（sha256sum 的标准输出格式）
#   SHA256SUMS.sig  对 SHA256SUMS **原始字节**的 Ed25519 签名，base64 单行
# 桥接硬编码发布公钥，顺序是：先取回清单并验签（证明这份哈希清单确实出自发布方），
# 再下载安装包并比对哈希（证明拿到手的字节就是清单里认的那一份）。
# 两步里任何一步失败都**不会**替换自身，一律回退到「请手动下载」。
# Scheme: the release carries a SHA256SUMS manifest plus an Ed25519 signature over
# its raw bytes. Verify the signature first (the manifest really is the publisher's),
# then hash the download and compare (the bytes really are the ones listed). Any
# failure aborts the swap and degrades to a manual download.
UPDATE_SUMS_ASSET = "SHA256SUMS"
UPDATE_SUMS_SIG_ASSET = "SHA256SUMS.sig"

# 发布公钥（2026-09-20 生成并启用）。Ed25519 公钥的 32 字节原始值的 base64，44 个字符。
#
# 配套私钥**不在本仓库、也不在任何仓库里**，只存在发布者手上（本机 2026-09-20 放在
# 仓库之外的 C:\prismx-release-keys\，需另行离线备份）。泄漏它等于能给全体桥接用户
# 推送任意可执行文件，而运行它的正是用户登录着真实 MT5 账号的那台机器。
#
# 换公钥要当心：**已经装在用户机器上的旧版本认的是旧公钥**。轮换时要么新旧两把都签，
# 要么先发一版把公钥换成新的、等存量升上来再停签旧的，否则存量用户会全部退回手动下载。
#
# 留着占位符时 update_signing_ready() 恒为 False：提示条只会引导手动下载，一键自更新
# 的入口整个不出现——「没配公钥」绝不等于「不校验就放行」。生成与签名流程见
# bridge/README.md「发版签名」一节。
#
# Release public key, generated and enabled 2026-09-20 (base64 of the raw 32-byte
# Ed25519 key). The matching private key lives only with the publisher, never in any
# repository: leaking it means being able to push arbitrary executables to every
# bridge user, on the machine where their live MT5 account is logged in. Rotating it
# needs care — installed builds trust the old key, so sign with both across a
# transition or existing users all fall back to manual downloads.
# Placeholder ⇒ update_signing_ready() is False ⇒ the one-click path is not offered
# at all. An unconfigured key must never degrade into "skip the check".
_UPDATE_PUBLIC_KEY_PLACEHOLDER = "!!!-REPLACE-ME-WITH-RELEASE-ED25519-PUBLIC-KEY-BASE64-!!!"
#
# 2026-09-23 轮换（1.4.5 起）：原私钥丢失、无备份，改用新钥匙。1.4.4 及更早的桥接认的是旧公钥，
# 对 1.4.5 验签失败、退回手动下载——这一次全体用户手动装一次，之后一键更新恢复。
# Rotated 2026-09-23 (from 1.4.5): the old private key was lost with no backup, so
# 1.4.4 and earlier fail verification on 1.4.5 and fall back to a manual download once.
UPDATE_PUBLIC_KEY_B64 = "UNHIYssYy10URzaUCYcBRV19euvIPA1VcsADhNewG5I="

# 只接受 GitHub 的下载域名。browser_download_url 会 302 到对象存储，所以请求前的
# URL 和跟随重定向后的最终 URL 都要查一遍——否则一个被改写的 Release JSON 就能把
# 下载指到任意主机上（HTTPS 证书只证明「是那台主机」，不证明「是我们的主机」）。
# Pin downloads to GitHub's hosts, checking both the requested URL and the final
# URL after redirects: TLS proves who the host is, not that it is ours.
UPDATE_ALLOWED_HOSTS = (
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
)
# 哈希清单与签名都是很小的文本文件，给个上限免得把一个巨大的响应读进内存。
# Both are tiny text files; cap the read so a huge response can't be slurped in.
UPDATE_TEXT_ASSET_MAX_BYTES = 256 * 1024

# ---------- 配置 / Configuration ----------
# 线上后端地址（所有用户默认连接，无需手动填写）。
# Production backend URL (all users connect here by default; no manual entry needed).
DEFAULT_BACKEND = "https://api.prismxsignallab.com"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.log")
POLL_INTERVAL = 1.5  # 状态上报间隔（秒）/ status report interval (seconds)

# 指令长轮询：/api/bridge/poll 在没有指令时最多挂这么久，后端一有指令落库立即返回。
# 上限由后端定（5 秒）——账号在线看 7 秒内的心跳，而心跳就是这个请求刷的，不能挂太久。
# 以前指令要等下一拍 1.5 秒轮询才被取走（平均 0.75 秒），现在是落库即取。
# Command long poll: /api/bridge/poll holds up to this long with nothing to deliver
# and returns the instant a command is committed. The backend caps it at 5s because
# liveness is a 7-second heartbeat window refreshed by this very request.
COMMAND_WAIT_SECONDS = 5.0
# 长轮询的 HTTP 超时必须大于 waitSeconds（后端最多挂这么久才回），留 4 秒缓冲。
# HTTP timeout of the long poll: must exceed waitSeconds; 4 s of slack.
COMMAND_HTTP_TIMEOUT = COMMAND_WAIT_SECONDS + 4.0

# 状态循环的心跳 /poll 间隔（秒）。后端 ONLINE_WINDOW=7 秒，指令长轮询每 ~5.5 秒也在刷
# 心跳；这里取 3 秒，实际拍距 1.5 秒 + 读终端耗时，故放行阈值留 0.5 秒余量，免得
# 拍距略小于 3 秒时被推迟整整一拍（3 -> 4.5 秒）。
# Heartbeat /poll cadence of the status loop. The gate keeps 0.5 s of slack so a tick a
# hair early doesn't slip a whole extra tick (3 -> 4.5 s).
HEARTBEAT_INTERVAL = 3.0
HEARTBEAT_SLACK = 0.5

# 空持仓（或内容没变）时的保活上报间隔（秒）。后端快照 TTL 600 秒，远大于此。
# Keep-alive interval for an unchanged/empty positions report.
POSITIONS_KEEPALIVE_SECONDS = 15.0

# 没人看网页时（后端 wantQuotes=false）的报价间隔（秒）。
# Quote interval while nobody is watching the web page (backend said wantQuotes=false).
QUOTE_INTERVAL_IDLE = 3.0

# 后端不可用时的指数退避上限（秒）：指令循环 / 状态循环。
# Backoff caps while the backend is unreachable.
COMMAND_BACKOFF_CAP = 10.0
STATUS_BACKOFF_CAP = 15.0


def _backoff_delay(failures: int, cap: float) -> float:
    """连续失败 n 次后的等待：min(cap, 1.5 * 2^(n-1)) * uniform(0.8, 1.2)。
    Wait after n consecutive failures, capped, with +-20% jitter."""
    n = min(max(1, failures), 16)
    return min(cap, POLL_INTERVAL * (2 ** (n - 1))) * random.uniform(0.8, 1.2)


def _is_backoff_error(e: BaseException) -> bool:
    """网络类异常与 5xx 才退避；4xx（含 401/403）不是后端挂了。
    Back off for network errors and 5xx only; 4xx means the backend is up."""
    if isinstance(e, error.HTTPError):
        return e.code >= 500
    return True

# 报价线程：单独一条线程只读关注品种的 tick，每 QUOTE_INTERVAL 秒一次，只发有变化的。
# 以前报价排在「读终端（含 15 分钟平仓扫描）→ 上报持仓 → poll」之后、每拍再固定睡
# 1.5 秒，网页上实际 2~3 秒才跳一次。/api/bridge/quotes 后端没有限频（slowapi 没配
# 默认限额、该路由也没加装饰器），鉴权有 10 秒缓存，所以 0.5 秒（最多每秒 2 个请求、
# 且只在价格变了时才发）是安全的；取区间里偏保守的一端。
# Quote thread: reads only the watched symbols' ticks every QUOTE_INTERVAL seconds and
# sends only what changed. Quotes used to queue behind the terminal read (including the
# 15-minute closed-trade scan), the positions report and the poll, then sleep 1.5s, so
# the web saw a new price every 2-3s. /api/bridge/quotes has no rate limit (no slowapi
# default, no decorator) and auth is cached for 10s; 0.5s — at most 2 requests a second,
# and only when a price moved — is the conservative end of the range.
QUOTE_INTERVAL = 0.5
# 报价请求自己的超时：报价过几秒就没用了，没必要像其它上报一样等 10 秒。
# The quote post's own timeout: a quote is worthless after a few seconds anyway.
QUOTE_HTTP_TIMEOUT = 3.0
# 报价线程多久没有成功跑完一轮，状态循环就接回原来的报价上报（线程挂了、卡在网络
# 上、或者还没读到第一份元数据）。
# How long without a successful quote-thread round before the status loop resumes
# sending quotes itself (thread died, stuck on the network, or no metadata yet).
QUOTE_THREAD_STALE_SECONDS = 3.0

# 单次平仓明细上报的最大条数。重连补扫可能一次产出几百条，整包发容易超时，
# 而超时的整包会原样退回重试队列反复重发。见 _post_trades。
# Max closing legs per POST; a reconnect catch-up can produce hundreds at once.
_TRADES_PER_POST = 100

# 后端在 /poll 响应里点名"需要一次性回扫补齐 MT5 明细"的账号（tradeHistoryBackfill）。
# 每个账号在本进程里只回扫一次：回扫回看一年、上报幂等，但没必要每拍都扫；后端那边
# 只要还有补不上的旧记录（比如终端历史里已经查不到的仓位）就会一直点名。
# Accounts the backend flags for a one-off deep rescan; done once per process
# per account — the backend keeps flagging while any row stays unfillable.
_backfill_requested: set[str] = set()
_backfill_done: set[str] = set()
_path_login: dict[str, str] = {}

# 已执行指令结果的本地持久化：程序重启后缓存不丢，后端超时重发同一指令时
# 只重报缓存结果、绝不重复下单（防止"已执行但回执丢失 + 重启"导致重复开仓）。
# Persisted cache of executed command results: survives restarts, so if the
# backend re-delivers a command after an ack timeout we re-report the cached
# result instead of executing again (prevents duplicate fills after a
# "executed but ack lost + restart" sequence).
EXECUTED_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_executed.json")
# 缓存保留时长（秒）：远大于后端 5 分钟的指令作废窗口即可 / retention (s),
# just needs to comfortably exceed the backend's 5-minute void window
EXECUTED_CACHE_TTL = 24 * 3600

# 未成功回报后端的执行结果队列，同样持久化：回执没送达就关程序，
# 重启后继续重试，后端不必等超时重发。
# Queue of results not yet acked by the backend, also persisted: if the app
# closes before a report lands, retries resume after restart instead of
# waiting for the backend's re-delivery timeout.
REPORTS_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_reports.json")

# 未成功上报的真实平仓明细队列（个人胜率用），同样持久化重试。
# Queue of closed-trade legs not yet acked by the backend (personal win-rate),
# also persisted for retry.
TRADES_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_trades.json")


def resource_path(name: str) -> str:
    """返回打包后/源码态下的资源绝对路径 / resolve a bundled resource path.

    PyInstaller 解压到 sys._MEIPASS；源码态用脚本所在目录。
    PyInstaller extracts to sys._MEIPASS; fall back to the script dir.
    """
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


# ---------- 日志 / Logging ----------
def _setup_logger() -> logging.Logger:
    """配置本地运行日志（滚动文件）/ set up a rotating local run log."""
    lg = logging.getLogger("prismx_bridge")
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        # 首选用户目录；建不起来（只读 profile、漫游目录不可写、被安全软件拦）就退到
        # 系统临时目录。以前这里失败就静默放弃，此后整个程序所有 logger.warning 全部
        # 无声——而桥接偏偏是「出了问题只能靠日志」的那类程序（用户机器上没人盯控制台，
        # console=False 连 stderr 都没有）。两处都失败才真的没有日志，并把原因留在
        # LOG_SETUP_ERROR 里给状态栏用。
        # Prefer the home directory; if that fails (read-only profile, unwritable roaming
        # folder, security software) fall back to the system temp dir. This used to give
        # up silently, after which every logger.warning in the process vanished — on a
        # program whose only diagnostic channel is the log (nobody watches a console on
        # the user's machine, and console=False means there is no stderr). Only when both
        # fail is there truly no log, and the reason is kept in LOG_SETUP_ERROR.
        global LOG_SETUP_ERROR
        fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        errors: list[str] = []
        for candidate in (LOG_PATH, os.path.join(tempfile.gettempdir(), "prismx_bridge.log")):
            try:
                handler = RotatingFileHandler(
                    candidate, maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
                )
                handler.setFormatter(fmt)
                lg.addHandler(handler)
                if candidate != LOG_PATH:
                    lg.warning("日志文件退到临时目录 / log file fell back to %s: %s", candidate, errors[-1])
                break
            except Exception as e:  # noqa: BLE001 - 日志系统自身的错误没有更好的去处
                errors.append(f"{candidate}: {e!r}")
        else:
            LOG_SETUP_ERROR = "; ".join(errors)
    return lg


# 日志系统自己建不起来时的原因（两个候选路径都失败才会有值）。日志写不了就没别的
# 地方能报这件事，所以留一个模块级变量给状态栏 / 排障时读。
# Why the logger could not be set up (set only when both candidate paths failed).
# There is nowhere else to report this when the log itself is unavailable.
LOG_SETUP_ERROR: str | None = None


logger = _setup_logger()


# ---------- Token 加密存储（Windows DPAPI）/ Token encryption via Windows DPAPI ----------
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_encrypt(plain: str) -> str | None:
    """用当前 Windows 用户密钥加密，返回 base64；失败返回 None。
    Encrypt with the current Windows user key, return base64; None on failure.
    """
    try:
        raw = plain.encode("utf-8")
        blob_in = _DataBlob(len(raw), ctypes.cast(ctypes.create_string_buffer(raw), ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        ):
            return None
        try:
            buf = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            return base64.b64encode(buf).decode("ascii")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def _dpapi_decrypt(b64: str) -> str | None:
    """解密 base64 密文；失败返回 None / decrypt base64 ciphertext; None on failure."""
    try:
        raw = base64.b64decode(b64)
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        ):
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData).decode("utf-8")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def load_config() -> dict:
    """读取本地配置（记住 Token 与后端地址）/ load saved token & backend URL.

    Token 以 DPAPI 加密存储在 token_enc 字段；兼容旧的明文 token 字段。
    Token is stored encrypted in token_enc; legacy plaintext token is still read.
    """
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    enc = cfg.get("token_enc")
    if enc:
        dec = _dpapi_decrypt(enc)
        cfg["token"] = dec or ""
    return cfg


class TokenStorageError(Exception):
    """Token 无法加密存盘（DPAPI 不可用）。调用方应提示用户、但可以继续用内存里的 token 连接。
    The token could not be encrypted for storage (DPAPI unavailable); the caller
    should warn but may keep using the in-memory token for this session."""


def save_config(cfg: dict) -> None:
    """保存本地配置；Token 加密后存盘，**绝不落明文**。

    以前 DPAPI 失败会退回明文写盘。这个退路的代价是：一台 DPAPI 坏掉的机器上，
    用户的 API Token 会以明文躺在用户目录里，任何能读文件的程序都能拿走它去冒充
    桥接程序下单。现在 DPAPI 失败就只保存后端地址、不保存 token，并抛
    TokenStorageError 让界面提示"这次能用，下次启动要重新输入"。
    Persist config; the token is encrypted, never written in plaintext. The old
    plaintext fallback left the API token readable on disk whenever DPAPI was
    broken; now the token is simply not persisted and TokenStorageError tells
    the UI to warn that it must be re-entered next launch.
    """
    out = {"backend": cfg.get("backend", DEFAULT_BACKEND)}
    token = cfg.get("token", "")
    enc = _dpapi_encrypt(token) if token else None
    if enc:
        out["token_enc"] = enc
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f)
    except Exception:
        # 不致命（内存里的配置照常生效），但下次启动会退回默认——要能查到是为什么。
        # Not fatal (the in-memory config still applies), but the next launch reverts
        # to defaults; that has to be traceable.
        logger.warning("配置写盘失败 / failed to persist config to %s", CONFIG_PATH, exc_info=True)
    if token and not enc:
        raise TokenStorageError("DPAPI encryption unavailable; token not persisted")


# ---------- 开机自启 / Start with Windows ----------
# 只对打包后的 exe 生效（注册表指向可执行文件路径）；源码态运行没有单一可
# 执行文件可指向，跳过。用当前用户级 Run 键，不需要管理员权限。
# Only meaningful for the packaged exe (the registry entry points at an
# executable path); running from source has no single file to point at, so
# this is skipped. Uses the per-user Run key, no admin rights required.
_AUTOSTART_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
_AUTOSTART_VALUE_NAME = "PRISMXBridge"


def autostart_supported() -> bool:
    """是否处于可以设置开机自启的环境（打包态）/ whether autostart can be offered (frozen build)."""
    return bool(getattr(sys, "frozen", False))


def is_autostart_enabled() -> bool:
    """查询开机自启是否已启用 / check whether autostart is currently enabled."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _AUTOSTART_KEY_PATH, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, _AUTOSTART_VALUE_NAME)
            return bool(value)
    except OSError:
        return False


def set_autostart_enabled(enabled: bool) -> bool:
    """启用/关闭开机自启；返回是否成功 / enable or disable autostart; returns success."""
    if enabled and not autostart_supported():
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _AUTOSTART_KEY_PATH, 0, winreg.KEY_WRITE) as key:
            if enabled:
                winreg.SetValueEx(key, _AUTOSTART_VALUE_NAME, 0, winreg.REG_SZ, f'"{sys.executable}"')
            else:
                try:
                    winreg.DeleteValue(key, _AUTOSTART_VALUE_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError:
        return False


# ---------- 进程级共享状态 / process-wide shared state ----------
# MetaTrader5 包附着的是**进程级**单连接；以前每个 BridgeEngine 各有一把 _mt5_lock，
# 断开重连 / 一键更新时新旧两个引擎的线程短暂并存，拿着两把不同的锁同时切终端，
# 单子就可能下到另一个账户上。锁必须和它保护的东西一样是进程级的。
# The MetaTrader5 package is one process-wide attachment. Each BridgeEngine used to own
# its own _mt5_lock, so during a reconnect / self-update the old and new engines'
# threads could switch terminals concurrently under two different locks — and an order
# could land on the wrong account. The lock must be as process-wide as what it guards.
_MT5_LOCK = threading.Lock()
# 「查幂等缓存 → 执行 → 写缓存」整段的进程级互斥。新引擎的指令线程会在这里等旧引擎
# 手上那条还没写进缓存的指令做完，并在锁内重查缓存——于是后端重发的同一条指令只会
# 命中缓存，不会在新旧引擎里各执行一次。旧引擎在锁内看到 stop 标志就不再开始新指令。
# Process-wide mutex over "check the executed cache → execute → record". A new engine's
# command thread waits here for an old engine's in-flight command to be recorded and
# re-checks the cache inside the lock, so a re-delivered command hits the cache instead
# of executing once per engine. An old engine sees its stop flag inside the lock and
# starts nothing new.
_EXEC_LOCK = threading.Lock()
# 已执行缓存的内存副本也是进程级共享的（按缓存文件路径区分，测试会换路径）。以前每个
# 引擎各加载一份、各自整表写盘，新引擎一写就能把旧引擎刚记下的条目冲掉 → 后端重发
# → 重复下单。
# The in-memory executed cache is shared process-wide too (keyed by file path, which
# tests swap). Each engine used to load its own copy and rewrite the whole file, so a
# new engine's save could wipe an entry the old one had just recorded → the backend
# re-sends → a duplicate order.
_EXECUTED_LOCK = threading.RLock()
_executed_store: dict = {"path": None, "results": None, "stamps": None}
# 停止 / 更新 / 退出时，最多等多久让进行中的指令做完并落盘（秒）。下单 + 确认最长
# 也就几秒，30 秒是宽裕的上限；超时照样继续，只记一条日志，不让程序卡死在退出上。
# How long stop / update / exit waits for an in-flight command to finish and persist.
# An order plus its confirmation takes seconds; 30 s is a generous bound, after which
# we proceed anyway (logged) rather than hang the exit.
ENGINE_DRAIN_TIMEOUT = 30.0


def _shared_executed_cache() -> tuple[dict[str, dict], dict[str, float]]:
    """进程内所有引擎共用的已执行缓存（首次使用时从磁盘加载）。
    The executed cache shared by every engine in this process (loaded on first use)."""
    with _EXECUTED_LOCK:
        if _executed_store["path"] != EXECUTED_CACHE_PATH or _executed_store["results"] is None:
            results, stamps = _load_executed_cache()
            _executed_store.update(path=EXECUTED_CACHE_PATH, results=results, stamps=stamps)
        return _executed_store["results"], _executed_store["stamps"]


def _load_executed_cache() -> tuple[dict[str, dict], dict[str, float]]:
    """读取已执行结果缓存，过滤超龄条目 / load the executed cache, drop stale entries.

    返回 (coid -> 结果, coid -> 写入时间戳)。文件损坏/缺失时返回空缓存。
    Returns (coid -> result, coid -> timestamp); empty caches on any failure.
    """
    try:
        with open(EXECUTED_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        results: dict[str, dict] = {}
        stamps: dict[str, float] = {}
        for coid, entry in (raw or {}).items():
            if not isinstance(entry, dict) or not isinstance(entry.get("result"), dict):
                continue
            ts = float(entry.get("ts", 0))
            if now - ts < EXECUTED_CACHE_TTL:
                results[coid] = entry["result"]
                stamps[coid] = ts
        return results, stamps
    except Exception:
        return {}, {}


def _save_executed_cache(results: dict[str, dict], stamps: dict[str, float]) -> None:
    """把已执行结果缓存写盘；失败不影响运行 / persist the cache; never fatal.

    写盘是**合并**而不是整表覆盖：先把盘上已有、内存里没有的未超龄条目并进来（同时并进
    传入的 dict，让本进程之后也认得它们），再整体写。一键更新时新旧两个进程会短暂
    并存，各写各的整表会互相冲掉对方刚记下的条目。写临时文件再 os.replace，避免半截文件。
    Saving merges rather than overwrites: fresh entries on disk that are missing from
    memory are folded in (into the passed dicts too, so this process honours them),
    then the whole map is written. During a self-update the old and new processes
    briefly coexist, and whole-file rewrites would wipe each other's new entries. Write
    to a temp file and os.replace so a reader never sees half a file.
    """
    try:
        on_disk, disk_stamps = _load_executed_cache()
        for coid, r in on_disk.items():
            if coid not in results:
                results[coid] = r
                stamps[coid] = disk_stamps.get(coid, time.time())
        payload = {
            coid: {"ts": stamps.get(coid, time.time()), "result": r}
            for coid, r in results.items()
        }
        # 临时文件带 pid：一键更新时新旧两个进程可能同时写盘，共用一个 .tmp 会互相截断。
        # Windows 上目标文件正被另一个进程读着时 os.replace 会抛 PermissionError，短暂重试。
        # The temp name carries the pid: old and new processes may save at the same time
        # during a self-update and must not truncate each other's temp file. On Windows
        # os.replace raises PermissionError while another process is reading the target,
        # so retry briefly.
        tmp = f"{EXECUTED_CACHE_PATH}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        for attempt in range(4):
            try:
                os.replace(tmp, EXECUTED_CACHE_PATH)
                break
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(0.05)
    except Exception:
        # 「不致命」只对本次进程成立：这份缓存是重启后「重发的指令绝不重新执行」的
        # 唯一依据，写不进去 = 下次启动可能重复下单。网关侧同一场景会 Log.Error
        # （Idempotency.cs），桥接以前却是裸 pass，两边标准要一致。
        # "Never fatal" holds only for this process: the cache is the sole basis for
        # "a re-delivered command is never re-executed" after a restart, so a failed
        # write means a possible duplicate order next launch. The gateway logs this
        # case (Idempotency.cs); the bridge used to swallow it.
        logger.warning("已执行缓存写盘失败 / failed to persist executed cache to %s",
                       EXECUTED_CACHE_PATH, exc_info=True)


def _load_pending_reports() -> list[dict]:
    """读取未回报队列 / load the pending-report queue; empty on any failure."""
    try:
        with open(REPORTS_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
    except Exception:
        return []


def _save_pending_reports(reports: list[dict]) -> None:
    """把未回报队列写盘；失败不影响运行 / persist the queue; never fatal."""
    try:
        with open(REPORTS_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(reports, f)
    except Exception:
        logger.warning("未回报队列写盘失败 / failed to persist pending reports to %s",
                       REPORTS_CACHE_PATH, exc_info=True)


def _load_pending_trades() -> list[dict]:
    """读取未上报的平仓明细队列 / load the pending closed-trades queue; empty on failure."""
    try:
        with open(TRADES_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [t for t in raw if isinstance(t, dict)] if isinstance(raw, list) else []
    except Exception:
        return []


def _save_pending_trades(trades: list[dict]) -> None:
    """把未上报的平仓明细队列写盘；失败不影响运行 / persist the queue; never fatal."""
    try:
        with open(TRADES_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(trades, f)
    except Exception:
        logger.warning("平仓明细队列写盘失败 / failed to persist pending trades to %s",
                       TRADES_CACHE_PATH, exc_info=True)


def scan_terminals() -> list[str]:
    """扫描本机正在运行的 MT5 终端可执行路径。
    Scan running MT5 terminals' executable paths on this machine.

    分开安装的多个 MT5 = 不同的 terminal64.exe 路径，以此区分。
    Separately installed terminals have distinct terminal64.exe paths.

    仅匹配 MT5 的 terminal64.exe；MT4 的 terminal.exe 不兼容 MetaTrader5
    库，若误连会导致进程卡死，因此显式排除。
    Only MT5's terminal64.exe is matched; MT4's terminal.exe is incompatible
    with the MetaTrader5 library and would hang, so it is excluded.
    """
    paths: list[str] = []
    try:
        import psutil
        for proc in psutil.process_iter(["name", "exe"]):
            name = (proc.info.get("name") or "").lower()
            if name == "terminal64.exe":
                exe = proc.info.get("exe")
                if exe and exe not in paths:
                    paths.append(exe)
    except Exception:
        # 以前这里静默返回空列表，界面上就是一句「未检测到正在运行的 MT5 终端」，
        # 真实原因（psutil 装坏、权限不足、被安全软件拦）一个字不留。每 1.5 秒
        # 一拍，所以限频到一分钟一条，别把日志刷满。
        # This used to return [] silently, which the UI renders as "no running MT5
        # terminal" — the real cause (broken psutil, missing privileges, security
        # software) never surfaced. Called every 1.5s, so rate-limit to one line a
        # minute rather than flooding the log.
        global _scan_error_logged_at
        now = time.monotonic()
        if now - _scan_error_logged_at > 60:
            _scan_error_logged_at = now
            logger.warning("扫描 MT5 终端进程失败 / scanning for MT5 terminals failed", exc_info=True)
    return paths


_scan_error_logged_at: float = -1e9


# ---------- 后端 HTTP 客户端 / Backend HTTP client ----------
class BackendClient:
    """复用连接的后端 POST 客户端。

    以前每次请求都用 urllib 新开一条连接：一拍三次请求（持仓、poll、报价）就是三次
    TCP + TLS 握手，大陆到新加坡每次握手 2~3 个 RTT，一拍光握手就要一秒上下。这里用
    http.client 保持一条 keep-alive 连接，握手只在启动和连接断掉时发生。

    一个实例一条连接、一把锁：http.client 的连接不能并发使用。状态上报循环和指令
    长轮询循环各持一个实例——否则挂着的 5 秒长轮询会把持仓上报堵在锁外。

    直连失败时退回 urllib（它会读系统代理设置）并从此固定走 urllib：有用户的机器必须
    经代理才出得去，不能因为省握手把他们挡在门外。

    Keep-alive POST client. urllib opened a fresh connection per request: three
    requests per tick meant three TCP+TLS handshakes, 2-3 RTTs each from mainland
    China to Singapore. One connection and one lock per instance (http.client
    connections are not concurrency-safe); the status loop and the command loop each
    own one so a held long poll never blocks a positions report. Falls back to urllib
    (which honours system proxy settings) when a direct connection cannot be made.
    """

    def __init__(self, backend: str, token: str):
        self._base = backend.rstrip("/")
        u = urlparse(self._base)
        self._https = u.scheme == "https"
        self._host = u.hostname or ""
        self._port = u.port
        self._token = token
        self._conn: http.client.HTTPConnection | None = None
        self._lock = threading.Lock()
        self._use_urllib = False

    def _open(self, timeout: float) -> http.client.HTTPConnection:
        if self._https:
            return http.client.HTTPSConnection(self._host, self._port, timeout=timeout)
        return http.client.HTTPConnection(self._host, self._port, timeout=timeout)

    def _drop(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def close(self) -> None:
        with self._lock:
            self._drop()

    def _post_urllib(self, path: str, data: bytes, timeout: float) -> dict:
        req = request.Request(self._base + path, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-API-Token", self._token)
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}

    def post(self, path: str, payload: dict, timeout: float = 10.0) -> dict:
        """POST JSON，返回 JSON dict。HTTP 4xx/5xx 抛 urllib.error.HTTPError（带 code /
        reason），与旧实现一致，调用方的错误分支不用改。
        POST JSON; raises urllib.error.HTTPError on 4xx/5xx like the old implementation."""
        data = json.dumps(payload).encode("utf-8")
        if self._use_urllib:
            return self._post_urllib(path, data, timeout)

        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(data)),
            "X-API-Token": self._token,
            "Connection": "keep-alive",
        }
        last: Exception | None = None
        with self._lock:
            # 第一次失败多半是服务端已经关掉了这条空闲连接（keep-alive 到期），重连再发
            # 一次；这里的请求都是幂等的（持仓/报价是快照，回执按 clientOrderId 去重）。
            # A first failure is usually the server having closed the idle connection;
            # reconnect and retry once. Every request here is idempotent.
            for attempt in range(2):
                try:
                    if self._conn is None:
                        self._conn = self._open(timeout)
                    elif self._conn.sock is not None:
                        self._conn.sock.settimeout(timeout)
                    self._conn.request("POST", path, body=data, headers=headers)
                    resp = self._conn.getresponse()
                    body = resp.read()
                    if (resp.getheader("Connection") or "").lower() == "close":
                        self._drop()
                    if resp.status >= 400:
                        raise error.HTTPError(self._base + path, resp.status, resp.reason, resp.headers, None)
                    return json.loads(body.decode("utf-8")) if body else {}
                except error.HTTPError:
                    raise
                except (http.client.HTTPException, OSError) as e:
                    self._drop()
                    last = e
                    if attempt == 0:
                        continue
        # 直连两次都不成：可能这台机器要走系统代理。urllib 会读代理设置，成了就固定走它。
        # Direct connection failed twice: maybe this machine needs the system proxy.
        try:
            out = self._post_urllib(path, data, timeout)
        except Exception:
            raise last if last is not None else RuntimeError("backend unreachable")
        self._use_urllib = True
        logger.warning("直连后端失败(%s)，已改走系统代理(urllib) / direct connection failed, using urllib with system proxy", last)
        return out


def _close_quietly(client) -> None:
    """线程退出时关自己的连接；关失败不该让线程带着异常退出。
    Close a thread's own client on exit; a failed close must not escape the thread."""
    try:
        client.close()
    except Exception:  # noqa: BLE001
        pass


class _HeartbeatSkipped(Exception):
    """本拍跳过心跳 /poll（内部控制流）/ this tick skips the heartbeat poll (control flow)."""


class BridgeEngine:
    """协调器：串行轮询本机所有 MT5 终端 + 轮询后端，运行在后台线程。
    Coordinator: serially poll all local MT5 terminals + the backend on a thread.

    单进程实现：用 mt5.initialize(path=...) 逐个连接终端，避免 onefile
    打包下多进程子进程无法启动的问题。
    Single-process design: attach to each terminal via initialize(path=...),
    which avoids broken multiprocessing children in a PyInstaller onefile build.
    """

    def __init__(self, token: str, backend: str, on_status):
        self.token = token
        self.backend = backend.rstrip("/")
        self.on_status = on_status  # 回调：把最新状态推给 GUI / push status to GUI
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        # 已执行订单的结果缓存：clientOrderId -> result。
        # 后端超时重发同一指令时，不重复下单，只重新回报缓存结果（幂等保护）。
        # 缓存持久化到本地文件，程序重启后依然生效。
        # Cache of executed order results: clientOrderId -> result. If the backend
        # re-delivers the same command after an ack timeout, we DON'T place the
        # order again — we just re-report the cached result (idempotency guard).
        # Persisted to a local file so it survives restarts.
        # 进程内所有引擎共用同一份（见 _shared_executed_cache）/ shared by every engine in
        # this process (see _shared_executed_cache).
        self._executed, self._executed_at = _shared_executed_cache()
        if self._executed:
            logger.info("已加载幂等缓存 / loaded executed cache: %d entrie(s)", len(self._executed))
        # 尚未成功回报后端的结果，下一轮重试；持久化到本地，重启不丢。
        # Results not yet acked by the backend, retried next tick; persisted
        # locally so they survive restarts.
        self._pending_reports: list[dict] = _load_pending_reports()
        # 未成功上报的真实平仓明细（个人胜率），持久化重试，逻辑同上。
        # Closed-trade legs (personal win-rate) not yet acked; persisted for
        # retry, same idea as the order-result queue above.
        self._pending_trades: list[dict] = _load_pending_trades()
        # 上一轮上报的报价 {(login, symbol): (bid, ask)}，仅上报变化项以省流量。
        # 按 (账号, 品种) 区分，而不是跨账户合并——下单确认页要按所选账户取
        # 对应交易商的报价，不同交易商同一品种的报价本就可能不同。
        # Last reported quotes {(login, symbol): (bid, ask)}; only changed
        # entries are sent. Keyed per (account, symbol) rather than merged
        # across accounts — the order-confirmation page looks up the quote for
        # whichever broker account is selected, and different brokers can
        # legitimately quote the same symbol differently.
        self._last_quotes: dict[tuple, tuple] = {}
        # 报价线程与状态循环（兜底路径）共用上面这份去重表，用这把锁保护。共用而不是
        # 各记一份：交接时各自的「上次发过什么」对不上，价格在另一条路径上变过又变回
        # 来，这边会误判"没变"，网页就停在中间那个价上。
        # The quote thread and the status loop (fallback path) share the dedupe table
        # above under this lock. Separate tables would disagree at a hand-over: a price
        # that moved on the other path and came back would read as unchanged here and
        # the web would stick at the intermediate price.
        self._quotes_lock = threading.Lock()
        # 两条循环各一条 keep-alive 连接（见 BackendClient 的说明）。报价线程再单独
        # 一条：它每 0.5 秒一发，和状态循环共用一条会互相堵在 BackendClient 的锁外。
        # One keep-alive connection per loop (see BackendClient); the quote thread gets
        # its own too, since at one post every 0.5s it would otherwise queue behind the
        # status loop on BackendClient's lock.
        self._http = BackendClient(self.backend, token)
        self._cmd_http = BackendClient(self.backend, token)
        self._quote_http = BackendClient(self.backend, token)
        self._quote_thread: threading.Thread | None = None
        # 报价线程这一刻该读的终端：仅当本机**恰好一个** MT5 终端时由状态循环填上，
        # 否则为 None（报价线程空转，状态循环照旧发报价）。见 _quote_loop。
        # The terminal the quote thread should read: set by the status loop only when
        # exactly one MT5 terminal is running, else None. See _quote_loop.
        self._quote_path: str | None = None
        # 报价线程最近一次成功跑完一轮的时刻（monotonic）；状态循环据此判断要不要兜底。
        # When the quote thread last completed a round (monotonic); the status loop
        # uses it to decide whether to fall back.
        self._quote_ok_at: float = 0.0
        self._quote_err_logged_at: float = -1e9
        self._quote_failing = False
        # 上一拍报价由谁发（True=报价线程，False=状态循环），只用来在切换时记一行日志。
        # Who sent quotes last tick (True = quote thread); only for logging hand-overs.
        self._quotes_via_thread: bool | None = None
        self._fallback_quotes_at = float("-inf")
        # MetaTrader5 包附着的是进程级单连接，两条循环不能同时碰它——新旧两个引擎
        # 也不能，所以用进程级的那把锁（见 _MT5_LOCK）。
        # The MetaTrader5 module is one process-wide attachment; neither the two loops
        # nor an old and a new engine may touch it concurrently, hence the process-wide
        # lock (see _MT5_LOCK).
        self._mt5_lock = _MT5_LOCK
        # 「查缓存 → 执行 → 记缓存」的进程级互斥，见 _EXEC_LOCK。
        # Process-wide mutex over check-cache → execute → record; see _EXEC_LOCK.
        self._exec_lock = _EXEC_LOCK
        # 状态循环每拍留下的快照，指令循环拿来发 poll、路由指令、合并持仓上报。
        # Snapshots the status loop leaves for the command loop.
        self._accounts_snapshot: list = []
        self._login_to_path: dict[str, str] = {}
        self._positions_by_path: dict[str, list] = {}
        # 同 _positions_by_path，挂单那一路：上报是整表替换，所以即时上报时必须
        # 拿本终端的新快照与其它终端的旧快照合并，不能只发本终端这一份。
        # The pending-order twin of _positions_by_path. Reports replace the whole
        # table, so an immediate report must merge this terminal's fresh snapshot with
        # the other terminals' latest rather than sending only its own.
        self._pending_by_path: dict[str, list] = {}
        self._state_lock = threading.Lock()
        self._cmd_thread: threading.Thread | None = None
        # 时钟可注入（测试用）/ injectable clock (tests)
        self._clock = time.monotonic
        # 持仓上报去重：上次成功发出的摘要与时刻（见 _tick 第 3 步）。
        # Positions-report dedupe: digest and time of the last successful post.
        self._pos_digest: str | None = None
        self._pos_sent_at: float = -1e9
        # 心跳 /poll：上次**成功**的时刻，以及该次响应里的状态栏警告（跳过的拍沿用）。
        # Heartbeat poll: time of the last success and the warning it carried.
        self._hb_ok_at: float = -1e9
        self._last_warning: str | None = None
        # 后端说有没有人在看网页；缺失 / True 都按「有人看」。
        # Whether anyone is watching the web; missing or True means yes.
        self._want_quotes = True
        # 两条循环各自的连续失败次数（退避用）。
        # Consecutive failures per loop (for backoff).
        self._cmd_fail_n = 0
        self._status_fail_n = 0
        # 结果回报：独立线程 + 队列。线程没起（未 start）时 _report_result 退回同步发送。
        # Result reporting: own thread + queue; without the thread (engine not started)
        # _report_result falls back to sending synchronously.
        self._report_q: deque = deque()
        self._report_wake = threading.Event()
        self._report_http = BackendClient(self.backend, token)
        self._report_thread: threading.Thread | None = None
        self._async_reports = False

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="bridge-status")
        self._thread.start()
        self._cmd_thread = threading.Thread(target=self._command_loop, daemon=True, name="bridge-commands")
        self._cmd_thread.start()
        self._quote_thread = threading.Thread(target=self._quote_loop, daemon=True, name="bridge-quotes")
        self._quote_thread.start()
        self._async_reports = True
        self._report_thread = threading.Thread(target=self._report_loop, daemon=True, name="bridge-reports")
        self._report_thread.start()

    def stop(self):
        """只发停止信号，立即返回（在界面线程里调）。
        Signal the threads to stop and return at once (called on the UI thread).

        各线程的连接都由线程自己在退出时关（_loop / _command_loop / _quote_loop /
        _report_loop 的 finally）：在这里 close 会卡在 BackendClient 的锁上——指令线程
        正挂着长轮询时最长要等十几秒，界面就冻住了。
        Every thread closes its own connection on exit (the finally blocks of _loop /
        _command_loop / _quote_loop / _report_loop): closing them here would block on
        BackendClient's lock, up to ~18 s behind a held long poll, freezing the UI.

        stop() 之后指令线程不会再开始新指令（_execute_commands 在 _exec_lock 内检查
        停止标志）；已经在执行的那一条会做完并写进幂等缓存。要确认它做完了（进程即将
        退出时），在**后台线程**里调 wait_idle()。
        After stop() the command thread starts no new command (checked inside _exec_lock);
        one already executing finishes and is recorded. To be sure it has (before the
        process exits), call wait_idle() from a background thread.
        """
        self._stop.set()
        self._report_wake.set()

    def wait_idle(self, timeout: float = ENGINE_DRAIN_TIMEOUT) -> bool:
        """等进行中的指令执行完并写进幂等缓存，再把没发出去的回执落盘。会阻塞，别在界面
        线程里调。返回 False = 超时（仍有指令没做完）。
        Wait for an in-flight command to finish and be recorded, then persist any
        unsent results. Blocks — never call on the UI thread. False means it timed out.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._exec_lock.acquire(timeout=max(0.0, timeout)):
            logger.warning("等待进行中的指令超时 / timed out waiting for an in-flight command")
            return False
        self._exec_lock.release()
        t = self._report_thread
        if t is not None and t is not threading.current_thread():
            t.join(max(0.0, deadline - time.monotonic()))
        # 报告线程退出后才入队的回执（执行线程最后那一条）由这里转进持久化重试队列。
        # Results queued after the reporter's final drain go to the persisted retry list.
        self._drain_reports(final=True)
        return True

    # ---------- 指令循环 / command loop ----------
    def _command_loop(self):
        """长轮询领指令、立刻执行。

        与状态上报循环分开跑：① 挂着等指令的 5 秒不拖慢持仓 / 报价上报；② 指令一到就
        执行，不再排在"读账号 + 持仓 + 报价 + 扫平仓明细"整轮之后；③ 执行完立刻重读
        持仓上报，网页上仓位成交即出现、平仓即消失。
        对旧版后端（不认识 waitSeconds、立即返回）自动退回 1.5 秒定频，不会空转。

        Long-poll for commands and execute them at once, on its own thread so the held
        request never delays status reports and execution never queues behind a full
        terminal read. Falls back to the 1.5s cadence against an old backend.
        """
        try:
            self._command_loop_body()
        finally:
            # 连接由本线程自己关，见 stop() / this thread closes its own client, see stop()
            _close_quietly(self._cmd_http)

    def _command_loop_body(self):
        while not self._stop.is_set():
            with self._state_lock:
                accounts = self._accounts_snapshot
            if not accounts:
                self._stop.wait(0.5)
                continue
            t0 = time.monotonic()
            try:
                resp = self._cmd_http.post(
                    "/api/bridge/poll",
                    {
                        "accounts": accounts,
                        "bridgeVersion": APP_VERSION,
                        "waitSeconds": COMMAND_WAIT_SECONDS,
                        "fetchCommands": True,
                    },
                    timeout=COMMAND_HTTP_TIMEOUT,
                )
                commands = resp.get("commands", [])
                commands = [c for c in commands if isinstance(c, dict)] if isinstance(commands, list) else []
                self._note_want_quotes(resp)
                self._cmd_fail_n = 0
            except Exception as e:
                logger.warning("指令长轮询失败 / command poll failed: %s", e)
                if _is_backoff_error(e):
                    self._cmd_fail_n += 1
                    self._stop.wait(_backoff_delay(self._cmd_fail_n, COMMAND_BACKOFF_CAP))
                else:
                    self._stop.wait(POLL_INTERVAL)
                continue
            if commands:
                try:
                    self._execute_commands(commands, self._cmd_http)
                except Exception as e:
                    logger.exception("执行指令异常 / command execution error: %s", e)
            elapsed = time.monotonic() - t0
            if not commands and elapsed < 1.0:
                # 后端没把请求挂住（旧版后端）：退回定频，别把后端打满。
                # The backend returned at once (older backend): fall back to the fixed cadence.
                self._stop.wait(max(0.2, POLL_INTERVAL - elapsed))

    # ---------- 报价线程 / quote thread ----------
    def _quote_loop(self):
        """每 QUOTE_INTERVAL 秒读一遍关注品种的 tick，只把有变化的发给后端。

        只在本机**恰好一个** MT5 终端时工作（`_quote_path` 由状态循环按此填写）。多终端
        时 MetaTrader5 包每读一台就要 shutdown + initialize 切一次，报价线程若也去切，
        就会和状态循环、指令循环抢连接；只读「碰巧附着着的那台」又会让各终端的报价
        刷新快慢不一。所以多终端时报价线程什么都不做，状态循环照旧发报价——退化成原
        来的行为，而不是半对的新行为。

        MT5 调用都在 `_mt5_lock` 里，锁内只有 `read_live_quotes` 那几次短读（它不会
        触发附着或切换）；HTTP 在锁外。一轮没有成功跑完（读不到、发不出去、抛异常）
        就不刷新 `_quote_ok_at`，状态循环超过 QUOTE_THREAD_STALE_SECONDS 看不到心跳就
        接回原路径；线程整个退出（is_alive() 为假）同理。

        Every QUOTE_INTERVAL seconds, read the watched symbols' ticks and post only what
        changed. Works only with exactly one MT5 terminal: with several, every read means
        a shutdown + initialize switch, which this thread must never trigger (it would
        fight the other loops for the connection), and reading "whichever happens to be
        attached" would refresh terminals unevenly — so it idles and the status loop
        keeps sending quotes as before. MT5 calls run under _mt5_lock and are only the
        short reads in read_live_quotes; HTTP happens outside it. A round that doesn't
        complete leaves _quote_ok_at alone, and the status loop takes over once the
        heartbeat is older than QUOTE_THREAD_STALE_SECONDS (likewise if the thread dies).
        """
        logger.info("报价线程已启动 / quote thread started (interval %.2fs)", QUOTE_INTERVAL)
        try:
            while not self._stop.is_set():
                t0 = time.monotonic()
                try:
                    if self._quote_round():
                        self._quote_ok_at = time.monotonic()
                        if self._quote_failing:
                            self._quote_failing = False
                            logger.info("报价线程已恢复 / quote thread recovered")
                except Exception as e:  # noqa: BLE001 - 单轮失败不该带走整条线程
                    self._quote_failing = True
                    # 每 0.5 秒一轮，后端断开时不限频会把日志刷满；一分钟一条。
                    # Rounds are 0.5s apart; rate-limit to a line a minute.
                    now = time.monotonic()
                    if now - self._quote_err_logged_at > 60:
                        self._quote_err_logged_at = now
                        logger.warning("报价线程本轮失败，由状态循环兜底 / quote round failed, "
                                       "status loop falls back: %s", e)
                self._quote_sleep(t0)
        except BaseException:
            # 走到这里是循环本身出了问题（不是单轮失败）：记下来，线程退出，状态循环
            # 看到 is_alive() 为假会自动接回原来的报价上报。
            # Something broke the loop itself rather than one round: log it and let
            # the thread end; the status loop sees is_alive() go false and takes over.
            logger.exception("报价线程异常退出，已退回状态循环上报报价 / quote thread died, "
                             "status loop resumes quote reporting")
            raise
        finally:
            self._quote_http.close()
            logger.info("报价线程已退出 / quote thread stopped")

    def _note_want_quotes(self, resp: dict) -> None:
        """记下后端对「有没有人在看网页」的回答；只有显式 False 才算没人看。
        Record the backend's wantQuotes; only an explicit False means nobody is watching."""
        if isinstance(resp, dict):
            self._want_quotes = resp.get("wantQuotes") is not False

    def _quote_interval(self) -> float:
        return QUOTE_INTERVAL_IDLE if self._want_quotes is False else QUOTE_INTERVAL

    def _quote_sleep(self, t0: float) -> None:
        """睡到下一轮。放慢期间切成 0.5 秒小段，poll 响应一说有人看了就提前醒。
        Sleep until the next round. While slowed, wake early in 0.5 s slices once a poll
        reply says someone is watching again."""
        while not self._stop.is_set():
            remaining = self._quote_interval() - (time.monotonic() - t0)
            if remaining <= 0:
                return
            if self._stop.wait(max(0.05, min(remaining, QUOTE_INTERVAL))):
                return

    def _quote_round(self) -> bool:
        """报价线程的一轮。返回 True = 这一轮完整跑完（读到了、该发的都发出去了）。
        One quote-thread round; True when it completed (read, and posted what changed)."""
        with self._state_lock:
            path = self._quote_path
        if not path or self._stop.is_set():
            return False
        with self._mt5_lock:
            # 拿锁可能等了一会儿，其间桥接可能已被停掉：停了就别再碰 MT5。
            # Acquiring the lock may have taken a while; don't touch MT5 once stopped.
            if self._stop.is_set():
                return False
            quotes = read_live_quotes(path)
        if quotes is None:
            return False
        self._send_quotes(quotes, self._quote_http, timeout=QUOTE_HTTP_TIMEOUT)
        return True

    def _quote_thread_serving(self) -> bool:
        """报价线程此刻是否在正常出报价；否则状态循环自己发（原路径）。
        Whether the quote thread is currently delivering; if not, the status loop sends."""
        t = self._quote_thread
        if t is None or not t.is_alive():
            return False
        with self._state_lock:
            if not self._quote_path:
                return False
        # 放慢期间每轮间隔本来就长，心跳新鲜度的门槛跟着放宽。
        # The freshness bar grows with the (slowed) round interval.
        stale = QUOTE_THREAD_STALE_SECONDS + (self._quote_interval() - QUOTE_INTERVAL)
        return time.monotonic() - self._quote_ok_at < stale

    def _send_quotes(self, quotes: list, http: "BackendClient", timeout: float = 10.0) -> None:
        """只上报相对上次**成功发出**的值有变化的 (账号, 品种)。发送失败就把这几条的去重
        记录退回去，下一轮照样算"有变化"重发——以前是先记后发，发失败的报价要等价格
        再跳一次才会补上。失败照常抛给调用方。
        Post only (login, symbol) entries that differ from what was last sent. On failure
        the dedupe entries are rolled back so the next round resends them (they used to be
        recorded before the post, so a failed quote waited for the next price move).
        Failures still propagate to the caller."""
        changed: list = []
        with self._quotes_lock:
            for q in quotes:
                key = (q["login"], q["symbol"])
                val = (q["bid"], q["ask"])
                prev = self._last_quotes.get(key)
                if prev != val:
                    self._last_quotes[key] = val
                    changed.append((key, prev, val, q))
        if not changed:
            return
        try:
            http.post("/api/bridge/quotes", {"data": [c[3] for c in changed]}, timeout=timeout)
        except Exception:
            with self._quotes_lock:
                for key, prev, val, _q in changed:
                    # 另一条路径已经发过更新的值就别覆盖它 / keep a newer value the other path sent
                    if self._last_quotes.get(key) == val:
                        if prev is None:
                            self._last_quotes.pop(key, None)
                        else:
                            self._last_quotes[key] = prev
            raise

    def _execute_commands(self, commands: list, http: "BackendClient") -> None:
        """按 login 分组执行指令并回报；已执行过的只重报缓存结果，不重复下单。
        执行完立刻重读该终端持仓并上报（与其它终端的最近快照合并成整表）。
        Execute by login, report results; re-report cached results for re-deliveries.
        Then re-read that terminal's positions and report them right away."""
        by_path: dict[str, list] = {}
        for cmd in commands:
            coid = str(cmd.get("clientOrderId"))
            cached = self._executed.get(coid)
            if cached is not None:
                # 重发的指令：只重报缓存结果，**绝不重新执行**。缓存里是 FAILED
                # （不知道成没成）时先重跑一次确认，见 _reconfirm_cached。
                # Re-delivered: re-report the cached result, never re-execute. A
                # cached FAILED gets its confirmation re-run first (see below).
                self._report_result(self._reconfirm_cached(coid, cached, cmd), http)
                continue
            with self._state_lock:
                path = self._login_to_path.get(str(cmd.get("login")))
            if path:
                by_path.setdefault(path, []).append(cmd)
            else:
                logger.warning("指令目标账号不在本机 / command for a login not attached here: %s", cmd.get("login"))
        for path, cmds in by_path.items():
            # 「重查缓存 → 执行 → 记缓存」整段在进程级 _exec_lock 里（见 _EXEC_LOCK）：
            # ① 停掉的引擎在这里看到 stop 标志就不再开始新指令；② 断开重连 / 一键更新时
            # 新引擎会在这里等旧引擎手上那条做完、记进缓存，再在锁内重查缓存，后端重发的
            # 同一条指令就只会命中缓存，不会执行两次。
            # Re-check cache → execute → record, all under the process-wide _exec_lock:
            # (1) a stopped engine sees its flag here and starts nothing new; (2) during a
            # reconnect / self-update the new engine waits here for the old one's in-flight
            # command to be recorded, then re-checks the cache inside the lock, so a
            # re-delivered command hits the cache instead of executing twice.
            hits: list = []
            with self._exec_lock:
                if self._stop.is_set():
                    logger.warning(
                        "桥接已停止，%d 条已领取的指令不再执行（留给后端重发）/ bridge stopped, "
                        "%d received command(s) left for re-delivery", len(cmds), len(cmds))
                    break
                todo = []
                for cmd in cmds:
                    coid = str(cmd.get("clientOrderId"))
                    cached = self._executed.get(coid)
                    if cached is not None:
                        hits.append((coid, cached, cmd))
                    else:
                        todo.append(cmd)
                res: dict = {"results": [], "error": None}
                if todo:
                    with self._mt5_lock:
                        res = poll_terminal(path, orders=todo, read_state=False,
                                            should_stop=self._stop.is_set)
                for r in res.get("results", []):
                    coid = str(r.get("clientOrderId"))
                    if coid:
                        # 缓存并落盘，以备幂等重报（重启后仍有效）
                        # cache & persist for idempotent retry (survives restarts)
                        #
                        # status=FAILED（「不知道成没成」，见 mt5_worker._result_from_retcode）
                        # 同样进缓存，这是**刻意**的：后端重发同一 clientOrderId 时，
                        # 重报一次 FAILED 是安全的，而重新执行可能开出第二笔仓位——
                        # 在两者之间只能选前者。
                        #
                        # 缓存 FAILED 曾经的代价是「那张单后来其实成交了，却在后端永远
                        # 停在 FAILED」——后端把 FAILED 当非终态、允许被更正，但更正永远
                        # 不会来。**这条代价已经消掉了**：后端重发同一 clientOrderId 时，
                        # `_reconfirm_cached` 会拿这条记录里的订单号**只重跑确认、不重跑
                        # 执行**，查到成交就把缓存条目就地升级成 FILLED 再回报。
                        # 仍然确认不了的那部分（没有订单号、平仓/改单、账号已不在本机）
                        # 照旧重报 FAILED，判据与取舍见 _reconfirm_cached 的注释。
                        #
                        # FAILED ("outcome unknown") is cached deliberately. When the
                        # backend re-delivers the same clientOrderId, re-reporting FAILED
                        # is safe while re-executing could open a second position, and
                        # that is the whole choice.
                        #
                        # Caching FAILED used to cost this: an order that did fill stayed
                        # FAILED in the backend forever (FAILED is non-terminal there and
                        # may be corrected, but the correction never arrived). That cost is
                        # gone — on a re-delivery of the same clientOrderId,
                        # _reconfirm_cached re-runs only the *confirmation*, never the
                        # execution, and upgrades the cached entry to FILLED when the order
                        # turns out to have filled. What still cannot be confirmed (no order
                        # ticket, closes/modifies, account no longer attached here) is
                        # re-reported as FAILED exactly as before.
                        #
                        # 放锁之前就记缓存：锁一放，别的引擎就可能拿着同一条重发进来。
                        # Recorded before the lock is released: once it is, another
                        # engine may arrive with the same re-delivered command.
                        self._remember_executed(coid, r)
            for coid, cached, cmd in hits:
                # 等锁期间别的引擎已经执行并记下了：只重报，不执行。
                # Executed and recorded by another engine while we waited: re-report only.
                self._report_result(self._reconfirm_cached(coid, cached, cmd), http)
            if not todo:
                continue
            if res.get("error"):
                logger.warning("poll_terminal(%s) 执行指令报错 / error: %s", path, res["error"])
            for r in res.get("results", []):
                coid = str(r.get("clientOrderId"))
                logger.info(
                    "下单结果 / order result: coid=%s success=%s ticket=%s price=%s msg=%s",
                    coid, r.get("success"), r.get("mt5Ticket"),
                    r.get("filledPrice"), r.get("message"),
                )
                self._report_result(r, http)
            # 成交后立刻重读持仓并上报，不等下一拍 1.5 秒的常规上报。
            # Report positions immediately after the fill, not on the next status tick.
            try:
                with self._mt5_lock:
                    fresh = read_positions(path)
                    # 挂单也一起重读：这一批指令里可能有挂单/撤挂单，用户按下去
                    # 之后要立刻在「挂单」页签里看到结果，而不是等下一拍。
                    # 读失败（None）就沿用上一份快照，不发空表——空表在整表替换
                    # 语义下等于"挂单都没了"。
                    # Re-read pending orders too: the batch may contain a place or a
                    # cancel and the user must see it land immediately. A failed read
                    # (None) keeps the previous snapshot; an empty one would read as
                    # "all pending orders are gone" under replace semantics.
                    fresh_pending = read_pending_orders(path)
                if fresh is not None or fresh_pending is not None:
                    with self._state_lock:
                        if fresh is not None:
                            self._positions_by_path[path] = fresh
                        if fresh_pending is not None:
                            self._pending_by_path[path] = fresh_pending
                        merged = [pos for lst in self._positions_by_path.values() for pos in lst]
                        merged_pending = [o for lst in self._pending_by_path.values() for o in lst]
                    http.post("/api/bridge/positions",
                              {"data": merged, "pendingOrders": merged_pending})
                    # 即时上报后让下一拍的状态循环上报一定放行，不与它的摘要比较。
                    # Make the next status tick's report unconditional after this one.
                    self._pos_digest = None
            except Exception as e:
                logger.warning("成交后即时上报持仓失败 / immediate positions report failed: %s", e)

    def _reconfirm_cached(self, coid: str, cached: dict, cmd: dict) -> dict:
        """后端重发同一 clientOrderId 时，对缓存里的 FAILED **只重跑确认、不重跑执行**。

        为什么要有这一步：FAILED 的意思是「不知道成没成」。把它写进 24 小时幂等缓存是
        刻意的（重报一次 FAILED 安全，重新执行可能开出第二笔仓），代价是那笔**后来其实
        成交了**的单会在后端一直停在 FAILED。这里把代价消掉：重发时拿缓存里记下的订单号
        去查这张单**现在**的终态，成交了就把缓存条目升级成 FILLED 并回报新结果；后端允许
        FAILED 被更正（routers/bridge.py 的 WHERE 里只有 FILLED/REJECTED 是终态）。

        不变式：**这条路径一次 order_send 都不会发**。`poll_terminal` 不带 orders 时
        它的执行循环是 `for cmd in orders or []`，一条都不会走到；随后只有
        `_confirm_order_filled`（读订单历史）与 `read_positions`（读持仓）两次只读查询。
        重新执行正是这套缓存要防的事，所以这条不变式有一条专门的用例钉着
        （tests/test_redelivery_reconfirm.py，断言 order_send 调用次数为 0）。

        查询借道 `poll_terminal(read_state=False)` 只是为了**附着到正确的终端**
        （`_ensure_attached`），并且整段在 `self._mt5_lock` 里——MetaTrader5 包是进程级
        单连接，另起一条 MT5 调用路径就会和状态循环、指令循环撞车。

        On a re-delivery, re-run only the confirmation — never the execution. FAILED
        means "outcome unknown"; caching it is deliberate (re-reporting FAILED is safe,
        re-executing could open a second position), and this removes its one cost: an
        order that did fill no longer stays FAILED forever. The invariant that matters
        is that nothing here can reach order_send — poll_terminal with no orders only
        attaches, and the two follow-up calls are read-only. It all runs under
        self._mt5_lock because the MetaTrader5 package is one process-wide attachment.
        """
        if str(cached.get("status") or "").upper() != "FAILED":
            return cached

        # 要查的必须是**订单号**，而不同动作的回执里订单号放在不同字段：
        #
        #   ORDER          `mt5Ticket` 就是订单号
        #   CLOSE / MODIFY `mt5Ticket` 是**仓位号**，订单号另放在 `mt5OrderTicket`
        #
        # 这个区分不是洁癖：MT5 的仓位号就是当初**开仓**那张单的订单号。拿平仓回执里的
        # `mt5Ticket` 去查订单历史，查到的是那张早已 FILLED 的开仓单，于是一笔没平成的
        # 平仓被升级成「已平」，而仓位还在裸奔——那正是这整套确认要防的事故。
        #
        # 所以平仓改用 `mt5OrderTicket`（mt5_worker._close_position 1.4.2 起带上的平仓单
        # 自己的订单号）。老桥接的缓存条目里没有这个字段，取不到就照旧重报 FAILED，不猜。
        #
        # The ticket to look up is always an *order* ticket, but different actions put it
        # in different fields: ORDER receipts carry it as mt5Ticket, while close/modify
        # receipts put the *position* id there and the order ticket in mt5OrderTicket.
        # This matters because an MT5 position id IS the opening order's ticket, so using
        # it on a close would find that long-since-filled open and upgrade a failed close
        # to "closed" while the position is still open — the exact accident this guards.
        # Cache entries written by older builds lack mt5OrderTicket; those are re-reported
        # unchanged rather than guessed at.
        action = str(cmd.get("action") or "ORDER").upper()
        ticket_field = "mt5Ticket" if action == "ORDER" else "mt5OrderTicket"
        try:
            ticket = int(cached.get(ticket_field) or 0)
        except (TypeError, ValueError):
            ticket = 0
        if ticket <= 0:
            # 没有可查的订单号（order_send 直接返回 None，或老版本缓存没带这个字段）：
            # 无从确认，照旧重报，绝不猜。
            # No order ticket to look up (order_send returned None, or an older cache
            # entry predates the field): nothing to confirm, so re-report unchanged.
            return cached

        with self._state_lock:

            path = self._login_to_path.get(str(cmd.get("login")))
        if not path:
            logger.warning(
                "重发指令想二次确认但账号不在本机 / cannot re-confirm, login not attached: coid=%s login=%s",
                coid, cmd.get("login"),
            )
            return cached

        try:
            with self._mt5_lock:
                # 不带 orders = 只附着，不执行 / no orders: attach only, execute nothing
                res = poll_terminal(path, read_state=False)
                if res.get("error"):
                    logger.warning(
                        "重发指令二次确认时附着终端失败 / attach failed while re-confirming: coid=%s %s",
                        coid, res["error"],
                    )
                    return cached
                filled = confirm_order_filled(ticket)
                # 成交价只在确认成交后才需要，多一次持仓读取不值得花在不会用到的分支上。
                # The fill price is only needed once the fill is confirmed.
                positions = read_positions(path) if filled is True else None
        except Exception as e:
            logger.warning("重发指令二次确认异常 / re-confirmation error: coid=%s %s", coid, e)
            return cached

        if filled is not True:
            # 确认没成交、或仍然确认不了，都照旧重报 FAILED。
            # 刻意不改判 REJECTED：REJECTED 在界面上的意思是「可以安全重下」，而这里
            # 既可能是单子还挂着、也可能是部分成交，重下就可能变成双倍仓位。
            # A confirmed non-fill and an inconclusive check both stay FAILED, never
            # REJECTED — REJECTED reads as "safe to place it again", and the order may
            # still be working or partially filled.
            logger.info(
                "重发指令二次确认仍未成交 / still not a confirmed fill: coid=%s ticket=%s confirmed=%s",
                coid, ticket, filled,
            )
            return cached

        upgraded = dict(cached)
        upgraded["status"] = "FILLED"
        upgraded["success"] = True
        upgraded["message"] = "执行结果已二次确认为成交 / Fill confirmed on re-delivery"
        # 补一个成交价：开仓成功后仓位号就是这张单的订单号，所以持仓表里那条的入场价
        # 就是本单的成交价。读不到就维持原样（后端此时写 NULL，与升级前一致，不会更差）。
        # Backfill a fill price: an opening order's ticket is its position's ticket, so
        # that position's entry price is this order's fill price. Left as-is if absent.
        if not upgraded.get("filledPrice"):
            for pos in positions or []:
                try:
                    same = int(pos.get("ticket") or 0) == ticket
                except (TypeError, ValueError):
                    same = False
                if same:
                    upgraded["filledPrice"] = pos.get("entryPrice")
                    break
        # 升级后的结果写回缓存：下一次重发直接命中 FILLED，不必再查一遍。
        # Write the upgrade back so a further re-delivery hits FILLED directly.
        self._remember_executed(coid, upgraded)
        logger.info(
            "重发指令二次确认为已成交，缓存 FAILED→FILLED / upgraded on re-delivery: coid=%s ticket=%s price=%s",
            coid, ticket, upgraded.get("filledPrice"),
        )
        return upgraded

    def _loop(self):
        try:
            while not self._stop.is_set():
                try:
                    self._tick()
                except Exception as e:
                    self.last_error = str(e)
                    self.on_status([], self.last_error)
                # 可被 stop 提前唤醒的等待；后端不可用时指数退避 + 抖动。
                # Interruptible wait; exponential backoff + jitter while the backend is down.
                if self._status_fail_n > 0:
                    self._stop.wait(_backoff_delay(self._status_fail_n, STATUS_BACKOFF_CAP))
                else:
                    self._stop.wait(POLL_INTERVAL)
        finally:
            # 连接由本线程自己关，见 stop() / this thread closes its own client, see stop()
            _close_quietly(self._http)

    @staticmethod
    def _positions_digest(positions: list, pending_orders: list) -> str:
        blob = json.dumps([positions, pending_orders], sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.blake2b(blob.encode("utf-8"), digest_size=16).hexdigest()

    def _tick(self):
        paths = scan_terminals()
        if not paths:
            # 终端没了：清掉快照，指令循环随即停止发 poll（否则会拿着旧账号列表继续挂着）。
            # No terminal: drop the snapshot so the command loop stops polling with stale accounts.
            with self._state_lock:
                self._accounts_snapshot = []
                self._quote_path = None
            self.on_status([], "未检测到正在运行的 MT5 终端 / No running MT5 terminal found")
            return

        # 1) 逐个终端读取账号与持仓 / read account & positions per terminal
        accounts: list = []
        positions: list = []
        pending_orders: list = []
        quotes_by_account: list = []
        closed_trades: list = []
        login_to_path: dict[str, str] = {}
        worker_errors: list[str] = []
        for path in paths:
            login_hint = _path_login.get(path)
            deep = login_hint is not None and login_hint in _backfill_requested and login_hint not in _backfill_done
            # 不在这里就记「已回扫」：回扫失败（读不到账号、history_deals_get 失败……）
            # 的话，本进程就再也不会重试了。等下面第 ② 段扫成功了再记。
            # Not marked done here: if the rescan failed (no account, history query
            # failed…) it would never be retried in this process. Marked after segment
            # (2) below succeeds.
            # 分两段拿 MT5 锁：① 账号 / 持仓 / 挂单 / 报价；② 平仓明细扫描（下面，账号
            # 读到了才做）。以前一整段攥着锁，扫描最慢的那一截也挡在下单指令前面；现在
            # 段间释放，指令线程可以插进来。第 ② 段会重新确认附着的是这台终端——段间
            # 指令线程可能已切到别的终端（多终端时）。
            # The MT5 lock is taken in two segments: (1) account / positions / pending /
            # quotes, (2) the closed-trade scan (below, only when an account was read). It
            # used to be one hold, so even the slow scan sat in front of any order; now the
            # command thread can get in between. Segment (2) re-confirms the attachment,
            # since the command thread may have switched terminals in the gap.
            with self._mt5_lock:
                res = poll_terminal(path, deep_backfill=deep, scan_closed=False)
            if res.get("error"):
                worker_errors.append(res["error"])
                # 只要账号在线（accounts 非空），这个错误此前完全不会展示在状态栏
                # 也不会写日志，会悄悄跳过账号/持仓/报价/平仓检测里失败的那部分——
                # 现在无论账号是否在线都记一行日志，不再无声无息。
                # Whenever accounts is non-empty this error used to never surface
                # in the status bar or the log — whichever of
                # account/positions/quotes/closed-trade-detection failed just
                # silently got skipped. Now it's logged regardless of whether
                # accounts came back, instead of vanishing silently.
                logger.warning("poll_terminal(%s) 报错 / error: %s", path, res["error"])
            acc = res.get("account")
            if acc:
                accounts.append(acc)
                login_to_path[acc["login"]] = path
                _path_login[path] = acc["login"]
                positions.extend(res.get("positions", []))
                pending_orders.extend(res.get("pendingOrders", []))
                with self._state_lock:
                    self._positions_by_path[path] = list(res.get("positions", []))
                    self._pending_by_path[path] = list(res.get("pendingOrders", []))
                # 按账户上报，不跨终端合并——下单确认页要按选中账户取对应
                # 交易商的报价。/ report per account, no cross-terminal merge —
                # the order-confirmation page needs the selected account's own
                # broker quote.
                for q in res.get("quotes", []):
                    quotes_by_account.append({**q, "login": acc["login"]})
                # 第 ② 段：平仓明细扫描，单独一次锁 / segment (2): closed-trade scan
                with self._mt5_lock:
                    scan = scan_closed_trades(path, deep_backfill=deep)
                if scan.get("error"):
                    worker_errors.append(scan["error"])
                    logger.warning("scan_closed_trades(%s) 报错 / error: %s", path, scan["error"])
                elif deep and acc["login"] == login_hint:
                    # 扫成了（且扫的确实是被点名的那个账号）才记已回扫。
                    # Only a successful scan of the flagged account counts as done.
                    _backfill_done.add(login_hint)
                closed_trades.extend(scan.get("closedTrades", []))

        if not accounts:
            msg = worker_errors[0] if worker_errors else "已连接终端但未读到已登录账号 / terminal attached but no logged-in account"
            with self._state_lock:
                self._accounts_snapshot = []
                self._quote_path = None
            self.on_status([], msg)
            return

        # 给指令循环留快照：它用这份账号列表发长轮询、按 login 找终端。
        # 三份快照在同一把锁里一起换，指令线程读到的账号列表与 login→终端映射
        # 必定来自同一拍；以前只有 _positions_by_path 加锁，另两份裸赋值——CPython
        # 下不会撕裂，但两者可能差一拍，且同一批状态两种口径本身就是隐患。
        # Snapshots for the command loop: accounts for its poll, login -> terminal for
        # routing. All three are swapped under one lock so the command thread always
        # sees an accounts list and a login map from the same tick; previously only
        # _positions_by_path was locked and the other two were bare assignments —
        # atomic in CPython, but possibly one tick apart, and two conventions for one
        # set of state is a hazard in itself.
        with self._state_lock:
            self._login_to_path = dict(login_to_path)
            self._accounts_snapshot = accounts
            # 报价线程只接单终端（原因见 _quote_loop）；多终端时置空，由本循环照旧发报价。
            # 按扫描到的终端数判断，而不是按有账号的终端数：没登录的那台终端照样会被
            # 本循环逐拍附着，连接一样在切来切去。
            # The quote thread only serves a single terminal (see _quote_loop). Counted by
            # terminals found, not by terminals with an account: a logged-out terminal is
            # still attached every tick, so the connection still switches.
            self._quote_path = paths[0] if len(paths) == 1 and paths[0] in login_to_path.values() else None
            for stale in [k for k in self._positions_by_path if k not in paths]:
                self._positions_by_path.pop(stale, None)
            for stale in [k for k in self._pending_by_path if k not in paths]:
                self._pending_by_path.pop(stale, None)

        # 2) 先上报持仓（触发自动仓位管理评估，命令立即入队），
        #    再拉指令（同一拍即可拿到刚入队的命令），比先 poll 再 positions
        #    节省整整一轮 1.5s 轮询间隔。快市里这 1.5 秒可能就是止损是否滑出
        #    目标区间的那一段。
        # Report positions first (triggers auto-manage evaluation → commands
        # are enqueued immediately), then poll (fetches those same commands in
        # the very same tick), saving a full 1.5s polling round. In a fast
        # market that 1.5s may be the gap between the trailing stop catching
        # the price or missing it.
        # 3) 上报持仓 / report positions
        try:
            # 挂单与持仓同一帧上报：两张表在网页上是并排的，分两次发会让它们
            # 来回错开一拍。/ Pending orders ride the same report: the two tables sit
            # side by side on the web and separate posts would leave them a tick apart.
            # 内容与上次成功发出的一样、且距上次不足保活间隔就不发（空持仓最常见）。
            # Skip when identical to the last successful post and inside the keep-alive
            # window (an empty book is the common case).
            digest = self._positions_digest(positions, pending_orders)
            now = self._clock()
            if not (digest == self._pos_digest and now - self._pos_sent_at < POSITIONS_KEEPALIVE_SECONDS):
                self._http.post("/api/bridge/positions",
                                {"data": positions, "pendingOrders": pending_orders})
                self._pos_digest = digest
                self._pos_sent_at = now
        except Exception as e:  # noqa: BLE001
            # 这一步以前是完全静默的：用户报「网页上仓位不刷新」时，日志里
            # 连一次失败的痕迹都找不到。与本文件其它上报路径保持一致，记一行。
            # This used to be silent, leaving "positions aren't refreshing"
            # reports with no trace in the log at all.
            logger.warning("上报持仓失败 / failed to report positions: %s", e)

        # 4) 上报账号（刷心跳、收后端对账号的裁决）。指令不在这里领：fetchCommands=False，
        #    由指令循环的长轮询去领并立刻执行。旧版后端不认识这个字段会照旧把指令给过来，
        #    下面第 8 步仍会执行它们，所以新桥接配旧后端也不会丢单。
        # Report accounts (heartbeat + the backend's verdicts). Commands are not taken
        # here (fetchCommands=False) but by the command loop's long poll. An older backend
        # ignores the flag and still hands commands over; step 8 below still runs them.
        commands = []
        warning = self._last_warning
        try:
            # 心跳约每 3 秒一次，按上次成功计时；失败的话 _hb_ok_at 不动，下一拍立即重试。
            # Heartbeat about every 3 s, timed from the last success; a failure leaves
            # _hb_ok_at alone so the next tick retries at once.
            if self._clock() - self._hb_ok_at < HEARTBEAT_INTERVAL - HEARTBEAT_SLACK:
                raise _HeartbeatSkipped()
            resp = self._http.post(
                "/api/bridge/poll",
                {"accounts": accounts, "bridgeVersion": APP_VERSION, "fetchCommands": False},
            )
            self._hb_ok_at = self._clock()
            self._status_fail_n = 0
            self._note_want_quotes(resp)
            commands = resp.get("commands", [])
            # 仅接受 list[dict]，过滤畸形元素，防止后续执行链异常。
            # Only accept list[dict]; drop malformed elements to protect the chain.
            if not isinstance(commands, list):
                commands = []
            else:
                commands = [c for c in commands if isinstance(c, dict)]
            self.last_error = None
            # 被拒绝入库的账号：此前这两个字段完全没读取，用户唯一能看到的
            # 现象是本机绿灯"已连接"、网页「连接 MT5」页却什么账户都没有,
            # 却没有任何解释。把拒绝原因摊在状态栏上，而不是让用户自己去猜
            # 是不是产品坏了。
            # Accounts the backend rejected: these two fields used to be
            # completely unread. The only symptom a user could see was this
            # app showing a green "connected" light while the web Bind page
            # showed nothing — with zero explanation. Surface the reason in
            # the status line instead of leaving the user to guess the
            # product is broken.
            broker_rejected = [
                str(x) for x in (resp.get("brokerRejected") or []) if x
            ]
            limit_exceeded = [
                str(x) for x in (resp.get("accountLimitExceeded") or []) if x
            ]
            _backfill_requested.update(
                str(x) for x in (resp.get("tradeHistoryBackfill") or []) if x
            )
            parts = []
            if broker_rejected:
                parts.append(
                    f"{len(broker_rejected)} 个账号非合作券商被拒 ({', '.join(broker_rejected)})"
                    f" / not a partner broker"
                )
            if limit_exceeded:
                parts.append(
                    f"{len(limit_exceeded)} 个账号超出套餐额度 ({', '.join(limit_exceeded)})"
                    f" / over your plan's account limit"
                )
            if parts:
                warning = "；".join(parts) + "，详见网页「连接 MT5」页 / see the web Bind page for details"
            else:
                warning = None
            self._last_warning = warning
        except _HeartbeatSkipped:
            pass
        except error.HTTPError as e:
            # 只有 401/403 才是 Token 的问题。此前所有 HTTP 错误都提示"检查 Token"，
            # 后端 500 时用户只会反复核对一个本来就正确的 Token，永远查不到方向。
            # Only 401/403 are token problems. This used to say "check your token"
            # for every HTTP error, so a backend 500 sent the user off re-checking
            # a token that was correct all along.
            if e.code in (401, 403):
                self.last_error = f"后端拒绝 HTTP {e.code}: {e.reason}（检查 Token）"
            else:
                self.last_error = (
                    f"后端异常 HTTP {e.code}: {e.reason}"
                    f"（与 Token 无关，服务端故障，正在自动重试）"
                )
            if _is_backoff_error(e):
                self._status_fail_n += 1
            self.on_status(accounts, self.last_error)
            return
        except Exception as e:
            self.last_error = f"无法连接后端: {e}"
            self._status_fail_n += 1
            self.on_status(accounts, self.last_error)
            return

        # 5) 上报报价：仅上报相对上一轮变化的 (账号, 品种) 以省流量。
        #    报价线程在正常出报价时（单终端、心跳新鲜）这一步跳过，由它每 0.5 秒发；
        #    线程退出、卡住或多终端时自动回到这里，与改动前完全一样。
        # Report quotes: only (account, symbol) entries changed since last tick. Skipped
        # while the quote thread is delivering (single terminal, fresh heartbeat); if it
        # dies, stalls, or there are several terminals, this path resumes unchanged.
        via_thread = self._quote_thread_serving()
        if via_thread != self._quotes_via_thread:
            self._quotes_via_thread = via_thread
            logger.info("报价上报改由%s / quotes now reported by %s",
                        "报价线程" if via_thread else "状态循环",
                        "the quote thread" if via_thread else "the status loop")
        # 没人看网页（wantQuotes=False）时兜底路径也放慢到 QUOTE_INTERVAL_IDLE；
        # 一旦响应说有人看，_quote_interval() 恢复 0.5 秒，这里每拍都发。
        # While nobody watches (wantQuotes=False) the fallback path also slows to
        # QUOTE_INTERVAL_IDLE; once the reply says someone is watching it sends every tick.
        if not via_thread and (
            self._clock() - self._fallback_quotes_at >= self._quote_interval() - HEARTBEAT_SLACK
            or self._want_quotes is not False
        ):
            self._fallback_quotes_at = self._clock()
            try:
                self._send_quotes(quotes_by_account, self._http)
            except Exception as e:  # noqa: BLE001
                # 同上：报价不刷新时也要在日志里留下线索 / leave a trace here too
                logger.warning("上报报价失败 / failed to report quotes: %s", e)

        # 6) 上报新检测到的真实平仓明细（个人胜率）；失败则入队下一轮重试。
        # 这一步之前完全不写日志，无论成功失败都看不出"到底有没有尝试上报"，
        # 排查漏报问题时只能靠猜——现在两种结果都记一行，成交编号写进去，
        # 方便日后对着后端日志核对是否真的到账。
        # Report newly detected real closed-trade legs (personal win-rate);
        # queue for retry on failure. This step used to log nothing either
        # way, making "did it even try to report" unknowable when debugging a
        # missing trade — now both outcomes are logged with the deal
        # ticket(s), so it can be cross-checked against the backend log.
        if closed_trades:
            failed = self._post_trades(closed_trades)
            if failed:
                self._pending_trades.extend(failed)
                _save_pending_trades(self._pending_trades)

        # 7) 先重试上一轮未成功回报的结果 / retry results & trades not yet acked last tick
        self._flush_reports()
        self._flush_trades()

        # 8) 旧版后端会在这里把指令给过来（新后端对 fetchCommands=False 回空列表）：
        #    照常执行，与指令循环共用同一套执行 / 回报 / 幂等缓存。
        # An older backend still hands commands over here (a new one returns none for
        # fetchCommands=False): run them through the same path as the command loop.
        if commands:
            self._execute_commands(commands, self._http)

        # 6) 通知 GUI 刷新 / notify GUI to refresh
        self.on_status(accounts, self.last_error, warning)

    def _remember_executed(self, coid: str, result: dict) -> None:
        """记录一条已执行结果并落盘，同时清理超龄条目。两条循环都会调，加锁。
        Record one executed result, persist to disk and prune stale entries."""
        now = time.time()
        # 缓存是进程级共享的，用进程级的锁 / the cache is process-wide, so is its lock
        with _EXECUTED_LOCK:
            self._executed[coid] = result
            self._executed_at[coid] = now
            stale = [k for k, ts in self._executed_at.items() if now - ts > EXECUTED_CACHE_TTL]
            for k in stale:
                self._executed.pop(k, None)
                self._executed_at.pop(k, None)
            _save_executed_cache(self._executed, self._executed_at)

    def _report_result(self, result: dict, http: "BackendClient | None" = None):
        """回报单条结果。报告线程在跑时只入队立即返回（由 _report_loop 发送）；否则同步发，
        失败入队下一轮重试。
        Report one result. With the reporter thread running this only enqueues and returns
        (_report_loop sends it); otherwise it posts synchronously, queueing on failure."""
        if self._async_reports:
            self._report_q.append(result)
            self._report_wake.set()
            return
        try:
            (http or self._http).post("/api/bridge/result", result)
        except Exception:
            with self._state_lock:
                if result not in self._pending_reports:
                    self._pending_reports.append(result)
                    _save_pending_reports(self._pending_reports)

    def _report_loop(self):
        """独立线程：顺序发送队列里的结果回报。第一条失败就把剩下的都转进持久化的重试队列
        （状态循环的 _flush_reports 会接手），不逐条空等超时。退出时队列里剩的同样转进去。
        Own thread: send queued results in order. On the first failure the rest move to
        the persisted retry list (the status loop's _flush_reports takes over) instead of
        each waiting out a timeout; whatever is left at exit moves there too."""
        try:
            while not self._stop.is_set():
                self._report_wake.wait(1.0)
                self._report_wake.clear()
                self._drain_reports()
        finally:
            self._drain_reports(final=True)
            self._report_http.close()

    def _drain_reports(self, final: bool = False) -> None:
        failed = final
        while True:
            try:
                r = self._report_q.popleft()
            except IndexError:
                return
            if not failed:
                try:
                    self._report_http.post("/api/bridge/result", r)
                    continue
                except Exception:
                    failed = True
            with self._state_lock:
                if r not in self._pending_reports:
                    self._pending_reports.append(r)
                    _save_pending_reports(self._pending_reports)

    def _flush_reports(self):
        """重试此前未成功回报的结果 / retry previously failed reports."""
        with self._state_lock:
            pending = list(self._pending_reports)
        if not pending:
            return
        still_pending = []
        for r in pending:
            try:
                self._http.post("/api/bridge/result", r)
            except Exception:
                still_pending.append(r)
        with self._state_lock:
            # 重试期间指令循环可能又排进了新的失败回执，别把它们冲掉。
            # The command loop may have queued new failures meanwhile; keep them.
            # 按对象身份而不是逐字段比较：pending 是同一批 dict 的引用拷贝，`r not in
            # pending` 对每条都要和整批做 dict 相等比较，队列积压到几百条时每轮 O(n²)。
            # Identity, not equality: `pending` holds references to the same dicts, and
            # `r not in pending` compared every element against the whole batch — O(n²)
            # per flush once a few hundred reports back up.
            pending_ids = {id(r) for r in pending}
            newer = [r for r in self._pending_reports if id(r) not in pending_ids]
            self._pending_reports = still_pending + newer
            if self._pending_reports != pending:
                _save_pending_reports(self._pending_reports)

    def _post_trades(self, legs: list) -> list:
        """分批上报平仓明细，返回**没能上报成功**的那些。

        分批的理由：桥接重连后会做一次数天的补扫（见 mt5_worker 的
        _BACKFILL_WINDOW），一个活跃账号可能一次产出几百条。整包发出去一旦超时，
        它会原样退回重试队列、下一轮再整包重发——同一个包永远失败，队列再也清不掉。
        切成小批之后，慢的那批失败也只拖住自己，其余照常落库。
        上报天然幂等（后端按 (用户, 账号, 成交编号) 去重），重叠重发无副作用。

        Chunked because a reconnect triggers a multi-day catch-up scan that can
        produce hundreds of legs at once: one oversized POST that times out would
        be requeued and re-sent whole forever. Reporting is idempotent, so
        overlapping re-sends are harmless.
        """
        failed: list = []
        for i in range(0, len(legs), _TRADES_PER_POST):
            chunk = legs[i:i + _TRADES_PER_POST]
            tickets = [t.get("dealTicket") for t in chunk]
            try:
                self._http.post("/api/bridge/trade-history", {"data": chunk})
                logger.info("已上报平仓明细 / reported closed trades: dealTickets=%s", tickets)
            except Exception as e:
                logger.warning(
                    "平仓明细上报失败，已入队重试 / closed-trade report failed, queued for retry: "
                    "dealTickets=%s err=%s", tickets, e,
                )
                failed.extend(chunk)
        return failed

    def _flush_trades(self):
        """重试此前未成功上报的平仓明细 / retry previously failed closed-trade reports."""
        if not self._pending_trades:
            return
        still_pending = self._post_trades(self._pending_trades)
        if still_pending != self._pending_trades:
            # 有批次成功了才落盘，避免每轮都无谓写文件
            # Persist only when something actually got through.
            self._pending_trades = still_pending
            _save_pending_trades(self._pending_trades)


def _parse_version(v: str) -> tuple[int, ...]:
    """把版本字符串解析为可比较的整数元组（忽略前缀 v 与非数字段）。
    Parse a version string into a comparable int tuple (drop 'v' prefix / non-numeric)."""
    nums: list[int] = []
    for part in v.strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if digits == "":
            break
        nums.append(int(digits))
    return tuple(nums)


def check_latest_release(timeout: float = 6.0) -> dict | None:
    """查询 GitHub 最新 Release：版本号 + 安装包资产的直链，失败返回 None。

    直链（browser_download_url）指向 GitHub 对象存储，打开即触发浏览器直接
    下载该文件，不会展示任何 GitHub 页面——这是比跳转发布页更省心的更新体验。
    找不到匹配文件名的资产时 download_url 为 None，调用方回退到发布页。

    Query the latest GitHub Release: version tag + the installer asset's direct
    URL; return None on any failure. The asset's browser_download_url points at
    GitHub's object storage and triggers an immediate browser download with no
    GitHub page in between — a smoother update flow than opening the releases
    page. download_url is None if no asset matches the expected filename; the
    caller then falls back to the releases page.
    """
    try:
        req = request.Request(LATEST_RELEASE_API, method="GET")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
        with request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tag = (data.get("tag_name") or data.get("name") or "").strip()
        if not tag:
            return None
        # 除了安装包本身，还要取回哈希清单与它的签名这两个资产的直链；缺任何一个
        # 都会让 fetch_expected_sha256() 明确报错，从而退回手动下载（而不是放行）。
        # Also pick up the manifest and its signature; a missing one makes
        # fetch_expected_sha256() fail loudly and fall back to a manual download.
        urls = {BRIDGE_ASSET_FILENAME: None, UPDATE_SUMS_ASSET: None, UPDATE_SUMS_SIG_ASSET: None}
        for asset in data.get("assets", []) or []:
            name = asset.get("name")
            if name in urls and urls[name] is None:
                urls[name] = asset.get("browser_download_url")
        return {
            "tag": tag,
            "download_url": urls[BRIDGE_ASSET_FILENAME],
            "sums_url": urls[UPDATE_SUMS_ASSET],
            "sums_sig_url": urls[UPDATE_SUMS_SIG_ASSET],
        }
    except Exception:
        return None


def is_newer_version(latest: str, current: str) -> bool:
    """判断 latest 是否比 current 更新 / whether latest is newer than current."""
    lv, cv = _parse_version(latest), _parse_version(current)
    return bool(lv) and lv > cv


# ---------- 一键自更新 / one-click self-update ----------
# 以前点提示条只是把浏览器打开到安装包直链：用户要自己下载、关掉旧的、把新 exe 放回原处
# 再打开、再等它重连。一个版本一套动作，落后几版就得来几遍。现在点一下：程序自己把最新
# 安装包下载到旁边、把自己换掉、重新拉起新版本并自动重连——一次到最新版，不管中间隔了
# 几个版本（安装包直链取的本来就是 releases/latest）。
# Clicking the banner used to open a browser download; the user then had to quit,
# replace the exe and relaunch — once per version. Now one click downloads the latest
# installer next to the running exe, swaps it in, relaunches and auto-reconnects.
#
# 换文件的手法：Windows 不允许覆盖或删除正在运行的 exe，但允许给它改名。于是把自己改成
# `<exe>.old`，再把下载好的新版挪到原路径，启动新版后退出；新版启动时删掉 `.old`。
# Windows lets a running exe be renamed (not overwritten or deleted): rename self to
# `.old`, move the download into place, launch it, exit; the new build deletes `.old`.

UPDATE_MIN_BYTES = 5 * 1024 * 1024  # 安装包正常 30 MB 上下，小于这个数一定是残缺的 / a real build is ~30 MB


def frozen_exe_path() -> str | None:
    """打包态下自己的 exe 路径；源码态返回 None（源码态不做自更新）。
    The running exe's path when frozen by PyInstaller; None when run from source."""
    if getattr(sys, "frozen", False):
        return os.path.abspath(sys.executable)
    return None


def cleanup_old_binary() -> None:
    """启动时删掉上一版自更新留下的 `.old`。上一进程还没退干净时删不掉，下次启动再删。
    Remove the previous build left behind by a self-update; retried on the next launch."""
    exe = frozen_exe_path()
    if not exe:
        return
    old = exe + ".old"
    if os.path.exists(old):
        try:
            os.remove(old)
            logger.info("已清理上一版本 / removed previous build: %s", old)
        except OSError:
            pass


class UpdateVerificationError(Exception):
    """来源校验失败。抛出它就意味着**不换文件**，调用方必须退回手动下载。
    Provenance check failed: never swap the exe; fall back to a manual download."""


def _ensure_allowed_host(url: str) -> None:
    """URL 的主机必须在 UPDATE_ALLOWED_HOSTS 里 / the URL's host must be pinned."""
    host = (urlparse(url).hostname or "").lower()
    if host not in UPDATE_ALLOWED_HOSTS:
        raise UpdateVerificationError(
            f"更新下载地址不在允许的域名内 / update URL host is not allowed: {host or url!r}"
        )


def _load_update_public_key():
    """取回硬编码的发布公钥；没配置好就抛异常（调用方据此关闭自更新）。
    Return the pinned release public key; raise when it isn't usable."""
    key_b64 = (UPDATE_PUBLIC_KEY_B64 or "").strip()
    if not key_b64 or key_b64 == _UPDATE_PUBLIC_KEY_PLACEHOLDER:
        raise UpdateVerificationError(
            "尚未填入发布公钥，自更新已禁用 / release public key not configured, self-update disabled"
        )
    # cryptography 只在这条路径上用到，放在函数里导入：万一打包时漏进包，
    # 受影响的也只是自更新（会被关掉并提示手动下载），而不是整个程序起不来。
    # Imported lazily so a packaging miss only disables self-update, not the app.
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError(
            f"缺少 cryptography 依赖，无法验签 / cryptography unavailable, cannot verify: {e}"
        ) from e
    try:
        raw = base64.b64decode(key_b64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError("发布公钥不是合法的 base64 / public key is not valid base64") from e
    if len(raw) != 32:
        raise UpdateVerificationError(
            f"发布公钥长度不对（Ed25519 应为 32 字节，实为 {len(raw)}）/ bad public key length"
        )
    return Ed25519PublicKey.from_public_bytes(raw)


def update_signing_ready() -> bool:
    """公钥是否已正确配置。False 时界面不提供一键更新，只提供手动下载。
    Whether the pinned key is usable; when False the UI only offers a manual download."""
    try:
        _load_update_public_key()
        return True
    except UpdateVerificationError as e:
        logger.warning("自更新不可用 / self-update unavailable: %s", e)
        return False


def verify_sums_signature(sums_bytes: bytes, signature_b64: str) -> None:
    """用硬编码公钥验证 SHA256SUMS 的 Ed25519 签名，不通过就抛。
    Verify the Ed25519 signature over the raw SHA256SUMS bytes."""
    key = _load_update_public_key()
    try:
        signature = base64.b64decode((signature_b64 or "").strip(), validate=True)
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError("签名不是合法的 base64 / signature is not valid base64") from e
    try:
        key.verify(signature, sums_bytes)
    except Exception as e:  # noqa: BLE001
        # 签名不符、签名长度不对、清单被改过——全都走这里。
        # Wrong signature, wrong length, tampered manifest: all land here.
        raise UpdateVerificationError(
            "哈希清单的签名校验未通过 / SHA256SUMS signature verification failed"
        ) from e


def expected_sha256_from_sums(sums_text: str, filename: str) -> str:
    """从 SHA256SUMS 文本里取出 filename 那一行的哈希（小写十六进制）。
    Pull the digest for `filename` out of a sha256sum-format manifest."""
    found = None
    for line in sums_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest = parts[0].strip().lower()
        # sha256sum 的二进制模式会在文件名前加一个 "*" / binary mode prefixes "*"
        name = os.path.basename(parts[1].strip().lstrip("*"))
        if name != filename:
            continue
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise UpdateVerificationError(f"哈希清单里 {filename} 的哈希格式不对 / malformed digest")
        # 同一个文件名出现两条不同哈希，说明清单本身就有歧义，宁可不更新。
        # Two different digests for one name means an ambiguous manifest: refuse.
        if found is not None and found != digest:
            raise UpdateVerificationError(f"哈希清单里 {filename} 有互相冲突的两条记录 / conflicting entries")
        found = digest
    if found is None:
        raise UpdateVerificationError(f"哈希清单里没有 {filename} / {filename} is not listed in the manifest")
    return found


def sha256_file(path: str) -> str:
    """分块算文件的 SHA-256（安装包 30 MB 上下，不要整包读进内存）。
    Chunked SHA-256 of a file; the installer is ~30 MB."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _http_get_bytes(url: str, timeout: float = 15.0, max_bytes: int = UPDATE_TEXT_ASSET_MAX_BYTES) -> bytes:
    """取回一个小文本资产（哈希清单 / 签名），带域名钉死与体积上限。
    Fetch a small text asset with host pinning and a size cap."""
    _ensure_allowed_host(url)
    req = request.Request(url, method="GET")
    req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
    with request.urlopen(req, timeout=timeout) as resp:
        _ensure_allowed_host(resp.geturl())          # 重定向后的最终地址也要查 / check after redirects
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise UpdateVerificationError(f"{url} 返回的内容过大 / response too large")
    return data


def fetch_expected_sha256(release: dict, filename: str = BRIDGE_ASSET_FILENAME) -> str:
    """取回并验签哈希清单，返回 filename 应有的 SHA-256。任何问题都抛异常。
    Fetch + verify the signed manifest, returning the expected digest."""
    sums_url = release.get("sums_url")
    sig_url = release.get("sums_sig_url")
    if not sums_url or not sig_url:
        raise UpdateVerificationError(
            f"这个 Release 没有附 {UPDATE_SUMS_ASSET} 与 {UPDATE_SUMS_SIG_ASSET}，"
            f"无法校验来源 / release is missing the signed checksum manifest"
        )
    sums_bytes = _http_get_bytes(sums_url)
    sig_bytes = _http_get_bytes(sig_url)
    try:
        sig_text = sig_bytes.decode("ascii").strip()
    except UnicodeDecodeError as e:
        raise UpdateVerificationError("签名文件不是 ASCII 文本 / signature file is not ASCII") from e
    verify_sums_signature(sums_bytes, sig_text)
    try:
        sums_text = sums_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        # 走到这里说明签名验过了但内容不是文本，属于发布流程出错。
        # Signature verified but the content isn't text: a broken release.
        raise UpdateVerificationError("哈希清单不是 UTF-8 文本 / manifest is not UTF-8") from e
    digest = expected_sha256_from_sums(sums_text, filename)
    logger.info("哈希清单验签通过 / manifest signature ok: %s = %s", filename, digest)
    return digest


def verify_downloaded_installer(dest: str, expected_sha256: str) -> None:
    """对已下载的文件做两道检查：像不像安装包（给出好读的报错）+ 哈希是否与清单一致。
    不一致就删掉它并抛异常——绝不能把一个来源不明的 exe 留在原地等着被换进去。
    Sanity-check the download, then compare its digest with the signed manifest;
    a mismatch deletes the file and raises."""
    size = os.path.getsize(dest)
    with open(dest, "rb") as f:
        head = f.read(2)
    if head != b"MZ" or size < UPDATE_MIN_BYTES:
        raise UpdateVerificationError(
            f"下载的文件不是完整的安装包 / downloaded file is not a complete installer ({size} bytes)"
        )
    actual = sha256_file(dest)
    # 常量时间比较：这里比的是公开的哈希值，泄漏风险本就很低，但统一用
    # compare_digest 免得以后有人照抄这段去比对秘密值。
    # Constant-time compare — the digest isn't secret, but keep the habit.
    if not hmac.compare_digest(actual, (expected_sha256 or "").lower()):
        try:
            os.remove(dest)
        except OSError:
            pass
        raise UpdateVerificationError(
            f"安装包哈希与已签名的清单不符，已丢弃 / digest mismatch, download discarded "
            f"(expected {expected_sha256}, got {actual})"
        )


def download_release(url: str, dest: str, progress, expected_sha256: str, timeout: float = 30.0) -> None:
    """流式下载安装包到 dest，每收到一块调一次 progress(done, total)，下载完比对哈希。

    `expected_sha256` 是**必填**位置参数，来自 fetch_expected_sha256() 验过签的清单：
    做成必填就没法「忘了传」——少传一个参数是 TypeError，而不是静默地不校验。
    `expected_sha256` is a required positional arg so it can't be silently omitted.
    """
    _ensure_allowed_host(url)
    req = request.Request(url, method="GET")
    req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
    with request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
        _ensure_allowed_host(resp.geturl())          # 重定向后的最终地址也要查 / check after redirects
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            progress(done, total)
    verify_downloaded_installer(dest, expected_sha256)


def swap_in_update(new_path: str) -> str:
    """把下载好的新版换到自己的位置，返回新 exe 路径。挪不进去就把自己改回来。
    Rename self to .old and move the download into place; roll back on failure."""
    exe = frozen_exe_path()
    if not exe:
        raise RuntimeError("源码态不做自更新 / self-update only applies to the packaged exe")
    old = exe + ".old"
    if os.path.exists(old):
        try:
            os.remove(old)
        except OSError:
            # 上上次的 .old 还被占着：换个名字让路 / still locked: park it under another name
            os.rename(old, f"{exe}.old.{int(time.time())}")
    os.rename(exe, old)
    try:
        os.replace(new_path, exe)
    except Exception:
        os.rename(old, exe)
        raise
    return exe


# ---------- GUI ----------
class BridgeGUI:
    """tkinter 界面：先要 Token，连接后显示多账号状态。
    tkinter UI: ask for token first, then show multi-account status.
    """

    def __init__(self, root: tk.Tk):
        self.root = root
        self.engine: BridgeEngine | None = None
        self.tray_icon = None  # pystray.Icon | None，惰性创建 / created lazily
        cfg = load_config()
        self.saved_token = cfg.get("token", "")

        root.title(f"PRISMX Bridge v{APP_VERSION}")
        root.geometry("760x720")
        root.resizable(False, False)
        root.configure(bg=self.BG)
        self._set_app_icon(root)
        self._buttons: dict[str, dict] = {}
        self._init_style()
        self._build_widgets()
        # 启动后在后台检查更新（不阻塞 UI）/ check for updates in background after launch
        self._start_update_check()
        # 记住 token 却要求每次开机手动点「连接」，对一个理应 7×24 挂机的
        # 程序来说很烦——本地存过 token 就自动连接，用户仍可随时手动断开。
        # Remembering the token but still requiring a manual "Connect" click
        # every launch is annoying for an app meant to run around the clock —
        # auto-connect whenever a token is already saved; the user can still
        # disconnect manually at any time.
        if self.saved_token:
            self.root.after(300, self._on_connect)

    def _set_app_icon(self, root: tk.Tk):
        """设置窗口/任务栏图标 / set the window & taskbar icon."""
        ico = resource_path("app.ico")
        if os.path.exists(ico):
            try:
                root.iconbitmap(default=ico)
            except tk.TclError:
                pass
            # 让任务栏使用应用自身图标而非 python 宿主图标
            # make the taskbar use this app's icon instead of the python host
            try:
                ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("PRISMX.Bridge")
            except Exception:
                pass

    # ---------- 主题配色 / theme palette ----------
    BG = "#07070c"        # 近黑背景 / near-black background
    CARD = "#11111c"      # 卡片底 / card surface
    CARD_HI = "#181826"   # 卡片高亮底 / elevated card surface
    FIELD = "#0b0b13"     # 输入框底 / input field
    BORDER = "#262640"    # 描边 / border
    ACCENT = "#8b46ff"    # 荧光紫 / neon violet
    ACCENT_HI = "#a779ff" # 亮紫 / bright violet
    ACCENT_DK = "#5b22c9" # 深紫 / deep violet
    OK = "#37e0a6"        # 在线绿 / online green
    WARN = "#f5c451"      # 警告黄 / warning amber
    ERR = "#ff5c7a"       # 错误红 / error red
    TEXT = "#e9e9f2"      # 主文字 / primary text
    MUTED = "#8a8aa3"     # 次要文字 / muted text
    FAINT = "#50506e"     # 极弱文字 / faint text

    def _init_style(self):
        """配置 ttk 暗色主题（表格）/ configure dark ttk theme for the table."""
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "PX.Treeview",
            background=self.CARD_HI, fieldbackground=self.CARD_HI, foreground=self.TEXT,
            borderwidth=0, rowheight=32, font=("Segoe UI", 9),
        )
        style.map("PX.Treeview", background=[("selected", "#2a1d4d")], foreground=[("selected", self.ACCENT_HI)])
        style.configure(
            "PX.Treeview.Heading",
            background=self.CARD_HI, foreground=self.MUTED, relief="flat",
            borderwidth=0, padding=(6, 8), font=("Segoe UI", 8, "bold"),
        )
        style.map("PX.Treeview.Heading", background=[("active", "#22223a")])
        # 滚动条暗色 / dark scrollbar
        style.configure(
            "PX.Vertical.TScrollbar", background=self.BORDER, troughcolor=self.CARD_HI,
            borderwidth=0, arrowcolor=self.MUTED,
        )

    def _draw_logo(self, parent, px=40):
        """用 Canvas 绘制新 logo：黑底圆角 + 荧光紫三角描边（中间镂空）。
        Draw the new logo on a Canvas: black rounded base + neon-violet
        triangle outline with a hollow center.
        """
        c = tk.Canvas(parent, width=px, height=px, bg=self.BG, highlightthickness=0)
        # 黑色圆角底 / black rounded base
        r, pad = px * 0.26, 1
        x0, y0, x1, y1 = pad, pad, px - pad, px - pad
        c.create_oval(x0, y0, x0 + 2 * r, y0 + 2 * r, fill="#000000", outline="")
        c.create_oval(x1 - 2 * r, y0, x1, y0 + 2 * r, fill="#000000", outline="")
        c.create_oval(x0, y1 - 2 * r, x0 + 2 * r, y1, fill="#000000", outline="")
        c.create_oval(x1 - 2 * r, y1 - 2 * r, x1, y1, fill="#000000", outline="")
        c.create_rectangle(x0 + r, y0, x1 - r, y1, fill="#000000", outline="")
        c.create_rectangle(x0, y0 + r, x1, y1 - r, fill="#000000", outline="")
        # 荧光紫三角形描边（中间镂空）/ neon-violet hollow triangle
        apex = (px * 0.5, px * 0.20)
        bl = (px * 0.18, px * 0.78)
        br = (px * 0.82, px * 0.78)
        tri = [*apex, *br, *bl]
        # 外层微光 / outer glow
        c.create_polygon(tri, outline="#5b22c9", fill="", width=6, joinstyle="round")
        c.create_polygon(tri, outline=self.ACCENT, fill="", width=3, joinstyle="round")
        c.create_polygon(tri, outline=self.ACCENT_HI, fill="", width=1.4, joinstyle="round")
        return c

    # ---------- 圆角绘制工具 / rounded-rect drawing helpers ----------
    CARD_W = 716  # 卡片统一宽度 / unified card width

    def _round_rect(self, cv, x1, y1, x2, y2, r, **kw):
        """在 Canvas 上画一个平滑圆角矩形 / draw a smooth rounded rectangle."""
        pts = [
            x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r,
            x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2,
            x1, y2, x1, y2 - r, x1, y1 + r, x1, y1,
        ]
        return cv.create_polygon(pts, smooth=True, **kw)

    def _card(self, parent, height, pad=18):
        """创建一张圆角卡片，返回内部内容 Frame。
        Create a rounded card; return its inner content frame.
        """
        w = self.CARD_W
        cv = tk.Canvas(parent, width=w, height=height, bg=self.BG, highlightthickness=0)
        cv.pack(padx=22, pady=7)
        self._round_rect(cv, 1, 1, w - 1, height - 1, 20, fill=self.CARD, outline=self.BORDER, width=1)
        inner = tk.Frame(cv, bg=self.CARD)
        cv.create_window(pad, pad, anchor="nw", window=inner, width=w - 2 * pad, height=height - 2 * pad)
        return inner

    def _make_button(self, parent, text, command, kind="primary", width=212, height=46):
        """创建圆角按钮（Canvas 自绘），返回状态字典。
        Create a rounded (Canvas-drawn) button; return its state dict.
        """
        if kind == "primary":
            fill, fill_hi, fg = self.ACCENT, self.ACCENT_HI, "white"
        else:
            fill, fill_hi, fg = "#262640", "#33335a", self.TEXT
        cv = tk.Canvas(parent, width=width, height=height, bg=self.CARD, highlightthickness=0, cursor="hand2")
        rect = self._round_rect(cv, 2, 2, width - 2, height - 2, (height - 4) // 2, fill=fill, outline="")
        label = cv.create_text(width // 2, height // 2, text=text, fill=fg, font=("Segoe UI", 10, "bold"))
        state = {"cv": cv, "rect": rect, "label": label, "fill": fill, "fill_hi": fill_hi,
                 "fg": fg, "enabled": True, "command": command}

        def on_click(_e):
            if state["enabled"]:
                command()

        def on_enter(_e):
            if state["enabled"]:
                cv.itemconfig(rect, fill=fill_hi)

        def on_leave(_e):
            if state["enabled"]:
                cv.itemconfig(rect, fill=fill)

        cv.bind("<Button-1>", on_click)
        cv.bind("<Enter>", on_enter)
        cv.bind("<Leave>", on_leave)
        return state

    def _set_button(self, state, enabled: bool):
        """启用/禁用圆角按钮并切换配色 / toggle a rounded button's enabled state."""
        state["enabled"] = enabled
        state["cv"].itemconfig(state["rect"], fill=state["fill"] if enabled else "#1a1a28")
        state["cv"].itemconfig(state["label"], fill=state["fg"] if enabled else self.FAINT)
        state["cv"].config(cursor="hand2" if enabled else "arrow")

    def _build_widgets(self):
        # 标题区：logo + 名称 / header: logo + title
        title_row = tk.Frame(self.root, bg=self.BG)
        self._title_row = title_row
        title_row.pack(fill="x", padx=30, pady=(22, 10))
        self._draw_logo(title_row, px=50).pack(side="left")
        name_box = tk.Frame(title_row, bg=self.BG)
        name_box.pack(side="left", padx=16)
        tk.Label(
            name_box, text="PRISMX Bridge",
            font=("Segoe UI Semibold", 19, "bold"), fg=self.TEXT, bg=self.BG,
        ).pack(anchor="w")
        tk.Label(
            name_box, text=f"棱镜桥接 · MT5 Connector · v{APP_VERSION}",
            font=("Segoe UI", 9), fg=self.ACCENT_HI, bg=self.BG,
        ).pack(anchor="w", pady=(2, 0))

        # 更新提示条（默认隐藏，检测到新版本时显示）/ update banner (hidden until a newer version is found)
        self.update_bar = tk.Frame(self.root, bg="#2a1d4d", cursor="hand2")
        self.update_var = tk.StringVar(value="")
        self._update_url = RELEASES_PAGE
        bar_lbl = tk.Label(
            self.update_bar, textvariable=self.update_var, fg=self.ACCENT_HI, bg="#2a1d4d",
            font=("Segoe UI", 9, "bold"), anchor="w", padx=14, pady=8, cursor="hand2",
        )
        bar_lbl.pack(side="left", fill="x", expand=True)
        close_lbl = tk.Label(
            self.update_bar, text="✕", fg=self.MUTED, bg="#2a1d4d",
            font=("Segoe UI", 9, "bold"), padx=12, cursor="hand2",
        )
        close_lbl.pack(side="right")
        for w in (self.update_bar, bar_lbl):
            w.bind("<Button-1>", lambda _e: self._on_update_click())
        self._update_release: dict | None = None
        self._updating = False
        self._update_failed = False
        close_lbl.bind("<Button-1>", lambda _e: self.update_bar.pack_forget())

        # 连接卡片：Token 输入 + 操作按钮 / connection card
        conn = self._card(self.root, height=212, pad=22)
        tk.Label(
            conn, text="API TOKEN", fg=self.MUTED, bg=self.CARD,
            font=("Segoe UI", 8, "bold"),
        ).pack(anchor="w")
        tk.Label(
            conn, text="粘贴网页「绑定」页的 Token / Paste the token from the web Bind page",
            fg=self.FAINT, bg=self.CARD, font=("Segoe UI", 8),
        ).pack(anchor="w", pady=(3, 10))

        # 圆角输入框 + 显示按钮 / rounded entry + show toggle
        entry_row = tk.Frame(conn, bg=self.CARD)
        entry_row.pack(fill="x")
        field_w, field_h = 520, 46
        field_cv = tk.Canvas(entry_row, width=field_w, height=field_h, bg=self.CARD, highlightthickness=0)
        field_cv.pack(side="left")
        self._round_rect(field_cv, 1, 1, field_w - 1, field_h - 1, 14, fill=self.FIELD, outline=self.BORDER, width=1)
        self.token_var = tk.StringVar(value=self.saved_token)
        self.token_entry = tk.Entry(
            field_cv, textvariable=self.token_var, show="•",
            bg=self.FIELD, fg=self.TEXT, insertbackground=self.ACCENT_HI,
            relief="flat", font=("Consolas", 11), bd=0,
        )
        field_cv.create_window(16, field_h // 2, anchor="w", window=self.token_entry, width=field_w - 32)

        self._token_shown = False
        self.eye_btn = self._make_button(entry_row, "显示", self._toggle_token, kind="ghost", width=78, height=46)
        self.eye_btn["cv"].pack(side="left", padx=(12, 0))

        self.backend_var = tk.StringVar(value=DEFAULT_BACKEND)

        # 连接 / 断开按钮 / connect & disconnect buttons
        btns = tk.Frame(conn, bg=self.CARD)
        btns.pack(fill="x", pady=(16, 0))
        self.connect_btn = self._make_button(btns, "连接 / Connect", self._on_connect, kind="primary", width=318, height=48)
        self.connect_btn["cv"].pack(side="left")
        self.disconnect_btn = self._make_button(btns, "断开 / Disconnect", self._on_disconnect, kind="ghost", width=318, height=48)
        self.disconnect_btn["cv"].pack(side="left", padx=(16, 0))
        self._set_button(self.disconnect_btn, False)

        # 开机自启开关：只在打包态展示（源码运行没有单一可执行文件可指向）。
        # Autostart toggle: only shown in the packaged build (source-run has no
        # single executable path to register).
        if autostart_supported():
            self.autostart_var = tk.BooleanVar(value=is_autostart_enabled())
            autostart_cb = tk.Checkbutton(
                conn, text="开机自启动 / Start with Windows",
                variable=self.autostart_var, command=self._on_toggle_autostart,
                bg=self.CARD, fg=self.MUTED, activebackground=self.CARD, activeforeground=self.TEXT,
                selectcolor=self.FIELD, font=("Segoe UI", 9), bd=0, highlightthickness=0,
                anchor="w", cursor="hand2",
            )
            autostart_cb.pack(fill="x", pady=(10, 0))

        # 状态指示灯 + 文案 / status dot + text
        status_row = tk.Frame(self.root, bg=self.BG)
        status_row.pack(fill="x", padx=32, pady=(12, 8))
        self.status_dot = tk.Canvas(status_row, width=14, height=14, bg=self.BG, highlightthickness=0)
        self.status_dot.pack(side="left")
        self._draw_dot(self.FAINT)
        self.status_var = tk.StringVar(value="未连接 / Not connected")
        tk.Label(
            status_row, textvariable=self.status_var, fg=self.MUTED, bg=self.BG,
            font=("Segoe UI", 9),
        ).pack(side="left", padx=10)

        # 账号卡片：标题 + 表格 / accounts card
        acct = self._card(self.root, height=326, pad=20)
        acct_head = tk.Frame(acct, bg=self.CARD)
        acct_head.pack(fill="x", pady=(0, 10))
        tk.Label(
            acct_head, text="已连接账号 / Connected Accounts", fg=self.TEXT, bg=self.CARD,
            font=("Segoe UI", 11, "bold"),
        ).pack(side="left")
        self.count_var = tk.StringVar(value="0 个")
        tk.Label(
            acct_head, textvariable=self.count_var, fg=self.ACCENT_HI, bg=self.CARD,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="right")

        table_wrap = tk.Frame(acct, bg=self.CARD_HI)
        table_wrap.pack(fill="both", expand=True)
        cols = ("login", "name", "company", "balance", "equity")
        heads = ("账号", "名称", "券商", "余额", "净值")
        self.tree = ttk.Treeview(
            table_wrap, columns=cols, show="headings", height=7, style="PX.Treeview",
        )
        for c, h, w in zip(cols, heads, (95, 150, 150, 100, 100)):
            self.tree.heading(c, text=h)
            self.tree.column(c, width=w, anchor="center")
        self.tree.pack(fill="both", expand=True, padx=6, pady=6)

        # 底部：日志路径提示 / footer
        tk.Label(
            self.root, text=f"运行日志 / Log: {LOG_PATH}",
            font=("Segoe UI", 8), fg=self.FAINT, bg=self.BG,
        ).pack(anchor="w", padx=32, pady=(8, 12))

    def _start_update_check(self):
        """后台线程检查 GitHub 是否有更新版本 / check GitHub for a newer version on a thread.

        启动时立即检查一次，之后每 UPDATE_CHECK_INTERVAL 秒复查一次。
        Check once on launch, then re-check every UPDATE_CHECK_INTERVAL seconds.
        """
        def worker():
            # 以前提示过一次就 return，轮询线程直接结束：用户随手把提示条点掉（或
            # 一次自更新失败）之后，这个本该 7×24 挂机的程序就永远停在旧版本上，
            # 连之后发布的更新版也不会再提示。现在改成一直轮询，只是不为**同一个
            # 版本号**重复提示；出了更新的版本仍然会再弹一次。
            # This used to return after the first notification, so dismissing the
            # banner once pinned a 24/7 app to an old build forever. Keep polling;
            # only suppress repeats of the same tag.
            notified_tag = None
            while True:
                release = check_latest_release()
                if (
                    release
                    and is_newer_version(release["tag"], APP_VERSION)
                    and release["tag"] != notified_tag
                ):
                    notified_tag = release["tag"]
                    # 切回 UI 线程更新提示条 / marshal back to the UI thread
                    self.root.after(0, lambda r=release: self._show_update(r))
                time.sleep(UPDATE_CHECK_INTERVAL)
        threading.Thread(target=worker, daemon=True).start()

    def _show_update(self, release: dict):
        """显示更新提示条 / reveal the update banner."""
        latest = release["tag"]
        # 优先直接下载安装包；找不到匹配资产才退回发布页。
        # Prefer downloading the installer directly; fall back to the releases
        # page only if no matching asset was found.
        # 换了一个新版本号就把「上次更新失败」的记忆清掉：上一版下载失败不代表
        # 这一版也会失败，否则一次失败会把之后所有版本都锁在手动下载上。
        # A new tag clears the previous failure: one bad download must not pin
        # every future version to the manual path.
        if (self._update_release or {}).get("tag") != latest:
            self._update_failed = False
        self._update_url = release.get("download_url") or RELEASES_PAGE
        self._update_release = release
        # 一键自更新的三个前提缺一不可：打包态、有安装包直链、**公钥已配置**。
        # 公钥还是占位符时这里就是 False，界面只会引导手动下载——不校验就换 exe
        # 这条路根本不存在。同理，Release 里没有签名清单时下一步会抛错回退。
        # All three must hold: frozen build, a direct asset link, and a configured
        # key. A placeholder key leaves only the manual path; there is no
        # "update without verifying" branch at all.
        can_self_update = (
            frozen_exe_path() is not None
            and bool(release.get("download_url"))
            and update_signing_ready()
        )
        self.update_var.set(
            f"发现新版本 {latest}（当前 v{APP_VERSION}），点击一键更新并重启  /  "
            f"Update {latest} available — click to update and restart"
            if can_self_update else
            f"发现新版本 {latest}（当前 v{APP_VERSION}），点击直接下载安装包  /  "
            f"Update {latest} available — click to download the installer"
        )
        # 插在标题行之后、连接卡片之前 / place it right below the header
        self.update_bar.pack(fill="x", padx=22, pady=(0, 6), after=self._title_row)
        logger.info("发现新版本 / update available: %s (current %s)", latest, APP_VERSION)

    def _on_update_click(self):
        """点提示条：打包态且有安装包直链就一键自更新；否则（源码态 / 没找到资产 / 上次自更新
        失败）退回打开浏览器下载。
        Banner click: self-update when packaged and a direct link exists; otherwise
        (source checkout / no asset / previous self-update failed) open the browser."""
        if self._updating:
            return
        release = self._update_release or {}
        if (
            self._update_failed
            or frozen_exe_path() is None
            or not release.get("download_url")
            or not update_signing_ready()      # 公钥没配好就只能手动下载 / no key ⇒ manual only
        ):
            self._open_update_page()
            return
        self._updating = True
        threading.Thread(target=self._self_update_worker, args=(release,), daemon=True).start()

    def _self_update_worker(self, release: dict):
        """后台下载 → 换文件 → 回 UI 线程重启。任何一步失败都把提示条改成"点击手动下载"。
        Download → swap → restart on the UI thread; any failure degrades to manual download."""
        latest = release.get("tag", "")
        url = release["download_url"]
        exe = frozen_exe_path()
        tmp = exe + ".new"

        def progress(done: int, total: int):
            if total > 0:
                text = f"正在下载新版本 {latest}… {done * 100 // total}%  /  Downloading {latest}… {done * 100 // total}%"
            else:
                text = f"正在下载新版本 {latest}… {done // (1024 * 1024)} MB  /  Downloading {latest}…"
            self.root.after(0, lambda t=text: self.update_var.set(t))

        try:
            logger.info("自更新开始 / self-update start: %s -> %s", url, tmp)
            # 顺序很要紧：先把已签名的哈希清单拿回来验签，拿到本次应有的哈希，
            # 再开始下 30 MB 的安装包。清单不对就根本不用下载了。
            # Order matters: verify the signed manifest first, then download.
            self.root.after(0, lambda: self.update_var.set(
                f"正在校验发布签名…  /  Verifying release signature…"
            ))
            expected = fetch_expected_sha256(release)
            download_release(url, tmp, progress, expected)
            new_exe = swap_in_update(tmp)
        except Exception as e:  # noqa: BLE001
            logger.exception("自更新失败 / self-update failed: %s", e)
            # 校验失败与「网络断了」是两回事，必须让用户看得出区别：前者意味着
            # 拿到的包**来源不可信**，这时候引导他去官方发布页手动下载才安全。
            # Distinguish a failed provenance check from a plain network error:
            # the former means the bytes were not trustworthy.
            verification_failed = isinstance(e, UpdateVerificationError)
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

            def failed():
                self._updating = False
                self._update_failed = True
                self.update_var.set(
                    "更新包来源校验未通过，已阻止自动更新；点击前往官方发布页手动下载  /  "
                    "Update blocked: signature/checksum check failed — click to download "
                    "from the official releases page"
                    if verification_failed else
                    "自动更新失败，点击改为手动下载安装包  /  "
                    "Auto-update failed — click to download the installer instead"
                )
            self.root.after(0, failed)
            return
        self.root.after(0, lambda: self._restart_into(new_exe))

    def _restart_into(self, new_exe: str):
        """停掉桥接与托盘，拉起新版本，然后退出。

        原来这里传了个 `--autoconnect`，但 main() 从来没解析过它——重连其实是由
        「本地存过 token 就自动连接」那段实现的（见 __init__ 末尾）。留着一个不存在的
        参数会让人以为自动重连靠它，将来删掉那段自动连接的代码就会踩空，所以去掉。
        The old `--autoconnect` flag was never parsed; auto-reconnect actually comes
        from the saved-token branch in __init__. Dropping the flag so nobody relies
        on a switch that does nothing.
        """
        self.update_var.set("下载完成，正在重启到新版本…  /  Restarting into the new version…")
        self.root.update_idletasks()
        # 先等旧引擎手上的指令做完、写进幂等缓存，再拉起新版本、退出进程。以前 stop()
        # 只发信号、400ms 后就 os._exit：一张单若正卡在 order_send 与写缓存之间，进程就
        # 被杀了，后端重发 → 新版本缓存里没有 → 再下一次。等待放在后台线程，界面不卡。
        # Wait for the old engine's in-flight command to finish and be recorded before
        # launching the new build and exiting. stop() only signals, and the process used
        # to os._exit 400 ms later — an order caught between order_send and the cache
        # write was lost, the backend re-sent it, and the new build executed it again.
        # The wait runs off the UI thread.
        self._stop_engine_then(lambda: self._launch_new_build(new_exe))

    def _stop_engine_then(self, then) -> None:
        """停引擎（立即返回），在后台线程里等进行中的指令做完并落盘（有上限），再回到
        界面线程执行 then。没有引擎就直接执行。
        Stop the engine (returns at once), wait off the UI thread — bounded — for any
        in-flight command to finish and persist, then run `then` on the UI thread. With
        no engine, `then` runs right away."""
        # 进入收尾：等待期间（最长 ENGINE_DRAIN_TIMEOUT）界面上的「连接」和再次「退出」
        # 都不能再起作用——否则会起一个没人等的新引擎，随后进程直接退出。
        # Entering shutdown: during the (bounded) wait neither Connect nor a second Exit
        # may act — otherwise a fresh engine starts that nobody waits for, and then the
        # process exits underneath it.
        self._closing = True
        engine = self.engine
        self.engine = None
        if engine is None:
            then()
            return
        engine.stop()

        def drain():
            try:
                if not engine.wait_idle(ENGINE_DRAIN_TIMEOUT):
                    logger.warning("进行中的指令未在 %.0fs 内结束，照常继续 / in-flight command "
                                   "did not finish within %.0fs, proceeding", ENGINE_DRAIN_TIMEOUT,
                                   ENGINE_DRAIN_TIMEOUT)
            except Exception:  # noqa: BLE001 - 等待失败也要继续退出 / proceed even if waiting fails
                logger.exception("等待引擎收尾失败 / waiting for the engine to drain failed")
            try:
                self.root.after(0, then)
            except Exception:  # noqa: BLE001 - 窗口已被销毁 / the window is already gone
                pass

        threading.Thread(target=drain, daemon=True, name="bridge-drain").start()

    def _launch_new_build(self, new_exe: str):
        if self.tray_icon is not None:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        logger.info("自更新：启动新版本并退出 / self-update: launching %s", new_exe)
        try:
            subprocess.Popen(
                [new_exe],
                cwd=os.path.dirname(new_exe),
                close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("启动新版本失败 / failed to launch new build: %s", e)
            self._updating = False
            self._update_failed = True
            self.update_var.set("新版本已就位但启动失败，请手动重新打开程序  /  Updated, please relaunch the app manually")
            return
        self.root.after(400, self._exit_now)

    def _exit_now(self):
        try:
            self.root.destroy()
        except Exception:
            pass
        os._exit(0)

    def _open_update_page(self):
        """打开安装包直链（触发浏览器直接下载）；无直链则退回发布页。
        Open the installer's direct link (triggers an immediate browser
        download); falls back to the releases page if no direct link exists.
        """
        try:
            webbrowser.open(self._update_url)
        except Exception:
            pass

    def _draw_dot(self, color):
        """绘制状态指示灯 / draw the status dot."""
        self.status_dot.delete("all")
        self.status_dot.create_oval(2, 2, 12, 12, fill=color, outline="")

    def _toggle_token(self):
        """切换 Token 明文显示 / toggle token plaintext visibility."""
        self._token_shown = not self._token_shown
        self.token_entry.config(show="" if self._token_shown else "•")
        self.eye_btn["cv"].itemconfig(self.eye_btn["label"], text="隐藏" if self._token_shown else "显示")

    def _on_toggle_autostart(self):
        """勾选/取消开机自启；失败则回滚勾选框并提示。
        Toggle autostart; roll back the checkbox and warn on failure."""
        wanted = self.autostart_var.get()
        ok = set_autostart_enabled(wanted)
        if not ok:
            self.autostart_var.set(not wanted)
            messagebox.showwarning(
                "PRISMX Bridge",
                "设置开机自启失败，请检查权限后重试。\n"
                "Failed to update the Windows startup setting; check permissions and try again.",
            )

    def _on_connect(self):
        if getattr(self, "_closing", False):
            return  # 正在退出 / 重启到新版本 / shutting down or restarting into a new build
        token = self.token_var.get().strip()
        # 后端地址固定为线上地址，不再从用户输入或旧配置读取。
        # Backend is fixed to production; never read from user input or stale config.
        backend = DEFAULT_BACKEND
        if not token:
            messagebox.showwarning("PRISMX Bridge", "请先填写 API Token / Please enter your API token")
            return
        try:
            save_config({"token": token, "backend": backend})
        except TokenStorageError:
            # 加密不可用：token 只留在内存里，照常连接，但要告诉用户下次得重输。
            # Encryption unavailable: keep the token in memory only, connect as
            # usual, and tell the user it must be re-entered next time.
            logger.warning("DPAPI 不可用，token 未保存 / DPAPI unavailable, token not persisted")
            messagebox.showwarning(
                "PRISMX Bridge",
                "无法安全保存 API Token（系统加密不可用）。本次仍可连接，但下次启动需要重新输入。\n"
                "The API token could not be stored securely (system encryption unavailable). "
                "This session will connect, but you will need to enter it again next launch.",
            )
        self.engine = BridgeEngine(token, backend, self._on_status)
        self.engine.start()
        logger.info("已连接后端 / connected to backend: %s", backend)
        self._set_button(self.connect_btn, False)
        self._set_button(self.disconnect_btn, True)
        self.token_entry.config(state="disabled")
        self._draw_dot(self.WARN)
        self.status_var.set("已连接，正在扫描 MT5… / Connected, scanning MT5…")

    def _on_disconnect(self):
        # stop() 只发信号、不阻塞界面。旧引擎手上那条指令会做完并写进**进程级**幂等缓存；
        # 紧接着「连接」起来的新引擎与它共用 MT5 锁和 _exec_lock，执行前会在锁内等它做完
        # 并重查缓存，所以不会重复下单，也不会两个引擎同时切终端。
        # stop() only signals and never blocks the UI. The old engine finishes any
        # in-flight command and records it in the process-wide cache; a new engine
        # started by Connect shares the MT5 lock and _exec_lock, waits inside them and
        # re-checks the cache before executing — no duplicate, no concurrent attach.
        if self.engine:
            self.engine.stop()
            self.engine = None
        self._set_button(self.connect_btn, True)
        self._set_button(self.disconnect_btn, False)
        self.token_entry.config(state="normal")
        self._draw_dot(self.FAINT)
        self.status_var.set("未连接 / Not connected")
        self.count_var.set("0 个")
        for row in self.tree.get_children():
            self.tree.delete(row)

    def _on_status(self, accounts: list, last_error: str | None, warning: str | None = None):
        """后台线程回调，切回主线程更新界面 / marshal back to the UI thread."""
        self.root.after(0, lambda: self._render(accounts, last_error, warning))

    def _render(self, accounts: list, last_error: str | None, warning: str | None = None):
        for row in self.tree.get_children():
            self.tree.delete(row)
        for a in accounts:
            self.tree.insert("", "end", values=(
                a.get("login", ""),
                a.get("accountName", ""),
                a.get("company", ""),
                a.get("balance", ""),
                a.get("equity", ""),
            ))
        self.count_var.set(f"{len(accounts)} 个")
        if last_error:
            self._draw_dot(self.ERR)
            self.status_var.set(f"已连接 · {len(accounts)} 个账号 · 错误: {last_error}")
        elif accounts:
            # 有账号被后端拒绝（非合作券商/超出套餐额度）：显示为警告而非绿色
            # 正常态，避免用户误以为一切正常。
            # Some accounts were rejected by the backend (wrong broker / over
            # the plan's limit): show as a warning rather than plain green, so
            # the user doesn't assume everything is fine.
            self._draw_dot(self.WARN if warning else self.OK)
            base = f"已连接 · 在线账号 {len(accounts)} 个 / {len(accounts)} account(s) online"
            self.status_var.set(f"{base} · ⚠ {warning}" if warning else base)
        else:
            self._draw_dot(self.WARN)
            self.status_var.set("已连接 · 未检测到已登录的 MT5 终端 / No logged-in MT5 terminal found")

    def on_close(self):
        """窗口 X 按钮：有托盘就最小化到托盘,继续在后台接收/执行交易；
        没有托盘依赖时退回旧行为(直接走真正退出的确认流程)。

        Window's X button: minimize to the system tray when available so
        trading keeps running in the background; without the tray dependency,
        fall back to the old behavior (go straight to the real-exit confirm).
        """
        if _TRAY_AVAILABLE:
            self._minimize_to_tray()
        else:
            self._do_exit()

    def _minimize_to_tray(self):
        """隐藏主窗口，惰性创建并显示托盘图标 / hide the window; lazily create & show the tray icon."""
        self.root.withdraw()
        first_time = self.tray_icon is None
        if self.tray_icon is None:
            self.tray_icon = self._build_tray_icon()
            threading.Thread(target=self.tray_icon.run, daemon=True).start()
        if first_time:
            # 只在第一次最小化时提示一次，避免用户以为点 X 真的退出了程序。
            # Only notify on the first minimize, so the user doesn't think X
            # actually quit the app.
            try:
                self.tray_icon.notify(
                    "仍在后台运行，交易照常执行 / Still running in the background",
                    "PRISMX Bridge",
                )
            except Exception:
                pass

    def _build_tray_icon(self):
        """构造托盘图标 + 右键菜单（显示窗口 / 退出）。
        Build the tray icon + right-click menu (Show window / Exit)."""
        try:
            ico_path = resource_path("app.ico")
            image = PILImage.open(ico_path) if os.path.exists(ico_path) else PILImage.new("RGB", (32, 32), "#8b46ff")
        except Exception:
            image = PILImage.new("RGB", (32, 32), "#8b46ff")
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口 / Show window", self._tray_show, default=True),
            pystray.MenuItem("退出 / Exit", self._tray_exit),
        )
        return pystray.Icon("prismx_bridge", image, "PRISMX Bridge", menu)

    def _tray_show(self, icon=None, item=None):
        # pystray 的回调跑在它自己的线程上，切回 tkinter 主线程再动窗口。
        # pystray callbacks run on its own thread; marshal back to the tkinter
        # main thread before touching the window.
        self.root.after(0, self._restore_window)

    def _restore_window(self):
        if self.tray_icon is not None:
            self.tray_icon.stop()
            self.tray_icon = None
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def _tray_exit(self, icon=None, item=None):
        self.root.after(0, self._do_exit)

    def _do_exit(self):
        """真正退出：连接中二次确认，停引擎、收托盘、关窗口。
        The real exit: confirm while connected, stop the engine, tear down
        the tray icon, close the window."""
        # 从托盘发起退出时窗口是隐藏的，askyesno 弹窗在这种状态下仍能正常
        # 显示在最前，但先取消隐藏更保险，避免弹窗被父窗口挡住/找不到。
        # Exiting from the tray leaves the window hidden; askyesno still shows
        # up fine, but un-hiding first is safer so the dialog isn't hidden
        # behind/lost relative to its (invisible) parent.
        if getattr(self, "_closing", False):
            return  # 已经在收尾，等它走完 / already shutting down; let it finish
        if self.root.state() == "withdrawn":
            self.root.deiconify()
        if self.engine is not None:
            ok = messagebox.askyesno(
                "PRISMX Bridge",
                "桥接正在运行，退出后将无法接收和执行交易指令。\n"
                "确认要退出吗？\n\n"
                "The bridge is running. Quitting stops receiving and executing "
                "trades. Are you sure you want to exit?",
            )
            if not ok:
                return
        # 同 _restart_into：等进行中的指令做完、落盘再关窗口（后台等，界面不卡）。
        # As in _restart_into: let an in-flight command finish and persist before the
        # window closes (waited for off the UI thread).
        self._stop_engine_then(self._finish_exit)

    def _finish_exit(self):
        logger.info("应用退出 / app closed")
        if self.tray_icon is not None:
            self.tray_icon.stop()
        self.root.destroy()


def main():
    # 自更新留下的上一版 exe：新版本起来后顺手删掉（见 swap_in_update）。
    # Remove the previous build left behind by a self-update.
    cleanup_old_binary()
    root = tk.Tk()
    gui = BridgeGUI(root)
    root.protocol("WM_DELETE_WINDOW", gui.on_close)
    root.mainloop()


if __name__ == "__main__":
    # 隐藏自检：打包态验证 numpy / MetaTrader5 是否能正常导入
    # hidden self-test: verify numpy / MetaTrader5 import in the bundled exe
    if "--selftest" in sys.argv:
        out = os.path.join(os.path.expanduser("~"), ".prismx_selftest.txt")
        parts = []
        ok = True
        try:
            import numpy as _np
            import MetaTrader5 as _mt5
            parts.append(f"numpy={_np.__version__} mt5={_mt5.__version__}")
        except Exception as _e:  # noqa: BLE001
            ok = False
            parts.append(f"core-import-failed={_e!r}")

        # 自更新链路也要自检，而且必须**在打包产物里**验。
        #
        # cryptography 在 _load_update_public_key() 里是函数内惰性 import，这是刻意的
        # （打包漏了只禁用自更新，不让整个程序起不来）——但正因为如此，漏打进包不会有
        # 任何报错：程序照常启动、照常交易，只有「一键更新」悄悄退回手动下载。而验签
        # 自更新正是 1.4.2 的主要内容，这种失败形态必须在发版前就被看见。
        #
        # 一并把公钥是不是还停在占位符也报出来：那同样会让一键更新整个不出现，而且
        # 同样不报错。发版前看一眼这一行，比装到用户机器上才发现强。
        #
        # The self-update chain is checked here too, and it must be checked in the
        # packaged binary: cryptography is imported lazily inside a function (so a
        # packaging miss only disables self-update rather than the app), which means a
        # miss is completely silent — the app runs and trades, only one-click update
        # quietly degrades. Verified self-update is the headline of 1.4.2, so that
        # failure mode has to be visible before release. The placeholder public key is
        # reported for the same reason: equally silent, equally disabling.
        try:
            import cryptography as _crypto
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: F401
                Ed25519PublicKey as _Ed25519PublicKey,
            )
            parts.append(f"cryptography={_crypto.__version__}")
        except Exception as _e:  # noqa: BLE001
            ok = False
            parts.append(f"cryptography-missing={_e!r}")

        parts.append(f"update_signing_ready={update_signing_ready()}")
        if not update_signing_ready():
            ok = False

        msg = ("OK " if ok else "FAIL ") + " ".join(parts)
        with open(out, "w", encoding="utf-8") as _f:
            _f.write(msg)
        print(msg)
        sys.exit(0 if ok else 1)
    main()
