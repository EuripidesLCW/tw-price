// 疊加模式：把價格表釘在遊戲上面，並監看剪貼簿——在遊戲裡把滑鼠移到物品上按 Ctrl+C，
// 這個視窗就直接跳到那一個物品的價格。
//
// ## 為什麼是獨立小程式，不是改 Awakened PoE Trade
// APT 查的是國際服的官方交易 API，沒有台服資料；要讓它顯示台服價得改它的查價流程，
// 而 tw-patch/apply.mjs 自己就寫了「改的是壓縮後的 JS，靠 regex 比對，上游改寫就會失敗」。
// 顯示層的小修補還撐得住，整套價格來源不行——APT 每更新一次就要重修。
// 剪貼簿這條路完全不碰 APT，APT 怎麼更新都不影響。
//
// ## 為什麼是剪貼簿
// Ctrl+C 是遊戲內建的複製物品功能（APT 用的也是這個），不是注入、不是自動化輸入。
// 它的好處是**不必用眼睛配名字**：複製的就是你手上那一顆，不會把「折磨之破空精髓」
// 看成「折磨之尖嘯精髓」——那兩個差了 5 倍價。
//
// 用法：node overlay.mjs [--port 8766] [--no-top] [--no-window]
//   --no-top     不要置頂（想自己排視窗時用）
//   --no-window  不要開瀏覽器，只跑伺服器（想用自己開的分頁，或要測的時候用）
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const PORT = +arg('--port', 8766)
const TITLE_MARK = '疊加' // 置頂時用視窗標題找它；疊加模式的頁面會把標題改成含這兩個字

// ── 物品名索引 ────────────────────────────────────────────
// 從 data.js 讀。price.mjs 每次更新都會重寫它，所以每次有人複製東西就重讀一次檔案，
// 不要快取在記憶體裡——不然開著疊加視窗跨過更新時間點，新物品會查不到。
function nameIndex() {
  const s = fs.readFileSync(path.join(here, 'data.js'), 'utf8')
  const d = JSON.parse(s.slice(s.indexOf('=') + 1))
  const ix = new Map()
  for (const it of d.items) {
    ix.set(it.name, it.name)
    if (it.en) ix.set(it.en.toLowerCase(), it.name)
  }
  return ix
}

/**
 * 從 Ctrl+C 複製出來的物品文字裡找出物品名。
 *
 * 遊戲複製出來長這樣（台服客戶端是中文，國際服是英文）：
 *   物品種類: 堆疊通貨
 *   稀有度: 通貨
 *   混沌石
 *   --------
 *   堆疊數量: 1/10
 *   ...
 *
 * 只看第一段（第一條分隔線之前），因為後面的說明文字裡也會出現別的通貨名稱
 * （例如「右鍵點擊後左鍵點擊一個稀有物品」之類的敘述會提到其他物品）。
 * 丟掉「鍵: 值」那種標頭行，剩下的逐行比對名稱索引，第一個對得上的就是答案。
 * 比對不到就回 null——使用者複製的可能根本不是物品。
 */
export function itemName(text, ix) {
  const lines = String(text).split(/\r?\n/)
  const end = lines.findIndex(l => /^-{3,}$/.test(l.trim()))
  const head = (end < 0 ? lines : lines.slice(0, end))
    .map(l => l.trim())
    .filter(l => l && !/^[^:：]{1,12}[:：]\s/.test(l))
  for (const l of head) {
    // 「高階的混沌石」這種前綴在通貨上不會出現，但稀有物品的名字會有兩行（名字＋基底），
    // 所以逐行試，而不是只試最後一行
    const hit = ix.get(l) ?? ix.get(l.toLowerCase())
    if (hit) return hit
  }
  return null
}

// ── 剪貼簿監看 ────────────────────────────────────────────
// 用一個常駐的 PowerShell 迴圈，不是每 300ms 開一次行程：開行程一次 50–100ms CPU，
// 一秒三次會讓風扇一直轉，而這個東西是要開著打一整晚的。
let current = { seq: 0, name: null, at: 0 }
// 每 10 圈（約 3 秒）確認一次父行程還在：node 要是被強制中止（工作管理員、當掉），
// 這個迴圈不一定會跟著死，那就會變成一個一直在讀剪貼簿的孤兒行程
const PS_WATCH = parentPid => `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$last = ''
$n = 0
while ($true) {
  $t = Get-Clipboard -Raw
  if ($t -and $t -ne $last) { $last = $t; [Console]::Out.WriteLine(($t | ConvertTo-Json -Compress)) }
  Start-Sleep -Milliseconds 300
  $n++
  if ($n % 10 -eq 0 -and -not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
}`

function watchClipboard() {
  const ps = spawn('powershell', ['-NoProfile', '-STA', '-Command', PS_WATCH(process.pid)], { windowsHide: true })
  ps.stdout.setEncoding('utf8')
  let buf = ''
  ps.stdout.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let text
      try { text = JSON.parse(line) } catch { continue }
      let name = null
      try { name = itemName(text, nameIndex()) } catch (e) { console.error('查名字失敗：' + e.message) }
      // 複製到非物品的東西時保留上一次的結果：使用者可能只是去複製了別的字，
      // 不代表他想把價格視窗清空
      if (name) {
        current = { seq: current.seq + 1, name, at: Date.now() }
        console.log(`複製到：${name}`)
      }
    }
  })
  ps.on('exit', c => console.error(`剪貼簿監看結束（代碼 ${c}），Ctrl+C 連動停止`))
  return ps
}

// ── 本機伺服器 ────────────────────────────────────────────
// 頁面要用 http:// 開而不是 file://：file:// 下 fetch 同資料夾的檔案會被 CORS 擋，
// 而疊加模式需要去問 /clip。順便也讓 data.js 的定時重載照舊能用。
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/clip') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
    return res.end(JSON.stringify(current))
  }
  // 路徑正規化後必須仍在本資料夾內，否則就是 ../ 穿越
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  const file = path.resolve(here, '.' + rel)
  if (!file.startsWith(here) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': TYPES['.html'] })
    return res.end('找不到 ' + rel)
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})

// ── 瀏覽器視窗 ────────────────────────────────────────────
const BROWSERS = [
  path.join(process.env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env['ProgramFiles'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
]

// 置頂：遊戲要用「視窗化全螢幕」才蓋得上去（獨佔全螢幕時 Windows 不讓任何視窗疊上來）。
// 視窗標題要等頁面載入後才改得到，所以重試幾秒。
const PS_TOPMOST = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TopMost {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
for ($i = 0; $i -lt 40; $i++) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${TITLE_MARK}*' } | Select-Object -First 1
  if ($p) {
    # HWND_TOPMOST = -1；SWP_NOMOVE(0x2) + SWP_NOSIZE(0x1) = 3，只改層級不動位置大小
    [TopMost]::SetWindowPos($p.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 3) | Out-Null
    "已置頂：$($p.MainWindowTitle)"
    exit
  }
  Start-Sleep -Milliseconds 400
}
"找不到疊加視窗，沒有置頂（遊戲請用視窗化全螢幕）"`

function openWindow() {
  const exe = BROWSERS.find(p => p && fs.existsSync(p))
  if (!exe) {
    console.error('找不到 Chrome 或 Edge，請自己開： http://127.0.0.1:' + PORT + '/?overlay=1')
    return null
  }
  // 專用的 user-data-dir：才會是獨立視窗（不會併進你原本開著的瀏覽器），
  // 而且 Chrome 會記住這個視窗的大小位置，下次打開還在同一個地方
  const profile = path.join(here, 'cache', 'overlay-profile')
  const child = spawn(exe, [
    `--app=http://127.0.0.1:${PORT}/?overlay=1`,
    `--user-data-dir=${profile}`,
    '--window-size=420,820',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
  ], { detached: false, stdio: 'ignore' })
  if (!process.argv.includes('--no-top')) {
    execFile('powershell', ['-NoProfile', '-Command', PS_TOPMOST], { windowsHide: true },
      (e, out) => console.log((out || '').trim() || (e ? '置頂失敗：' + e.message : '')))
  }
  return child
}

// ── 起跑 ──────────────────────────────────────────────────
if (!fs.existsSync(path.join(here, 'data.js'))) {
  console.error('還沒有 data.js，請先跑一次「台服通貨價格.cmd」抓價格')
  process.exit(1)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`疊加模式  http://127.0.0.1:${PORT}/?overlay=1`)
  console.log('遊戲裡把滑鼠移到物品上按 Ctrl+C，這個視窗就會跳到那個物品')
  console.log('關掉視窗就會結束；或在這裡按 Ctrl+C')
  const ps = watchClipboard()
  const win = process.argv.includes('--no-window') ? null : openWindow()
  const bye = () => { try { ps.kill() } catch {} ; server.close(); process.exit(0) }
  // 關掉瀏覽器視窗就一起收工；--no-window 時沒有視窗可關，等 Ctrl+C
  win?.on('exit', bye)
  process.on('SIGINT', bye)
})
