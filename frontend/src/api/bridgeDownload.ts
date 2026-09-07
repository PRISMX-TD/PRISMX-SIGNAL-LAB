// 桥接程序安装包直链（GitHub Releases 的 latest 资产）。在仓库建 Release、按这个文件名
// 上传安装包即可，网页无需改代码；版本号由后端抓 releases/latest 的 tag 提供。
// 下载入口在「连接 MT5」页的桥接折叠区（2026-09-07 起），/download 只剩教程与注意事项。
// Direct link to the Bridge installer (GitHub Releases "latest" asset). Publish a
// Release with this asset name and the link just works; the version badge comes
// from the backend. The download entry lives in the Bind page's bridge section
// since 2026-09-07; /download keeps the guide and notes.
export const GITHUB_REPO = 'https://github.com/PRISMX-TD/PRISMX-SIGNAL-LAB'
export const BRIDGE_FILENAME = 'PRISMX-Bridge-Setup.exe'
export const BRIDGE_DOWNLOAD_URL = `${GITHUB_REPO}/releases/latest/download/${BRIDGE_FILENAME}`
