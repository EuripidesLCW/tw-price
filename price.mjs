// 台服通貨價格表：抓遊戲內「通貨交換」公開的每小時成交摘要（webtw.poecdn.com），
// 算出各物品的混沌石價、神聖石價（各自取實際成交，不互相換算），寫成 data.js，index.html 讀它顯示
// 用法：node price.mjs [聯盟名稱] [--no-open] [--audit]   聯盟預設為交易量最大的非標準聯盟
//   GitHub Actions（.github/workflows/update.yml）每 20 分鐘跑一次並發布到 GitHub Pages
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.join(here, 'cache')
fs.mkdirSync(path.join(cache, 'hours'), { recursive: true })
const API = 'https://webtw.poecdn.com/api/currency-exchange/'
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'
const HOURS = 24 // 價格、熱門用最近 24 小時
const HIST = 168 // 漲跌、走勢圖用最近 7 天
const SELL_HOURS = 6 // 賣價參考取最近幾個有成交的小時

const getJson = async url => {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}
// 對照資料一天更新一次（新聯盟會有新物品）
const cached = async (file, url) => {
  const f = path.join(cache, file)
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 864e5) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const j = await getJson(url)
  fs.writeFileSync(f, JSON.stringify(j))
  return j
}
// 過去的小時摘要不會再變，抓過就存；還沒發布的小時回傳空 markets，不存
const hour = async ts => {
  const f = path.join(cache, 'hours', ts + '.json')
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const j = await getJson(API + ts)
  if (j.markets?.length) fs.writeFileSync(f, JSON.stringify(j))
  return j
}

// 1. 每小時摘要：從最近一個已發布的小時往回抓 7 天（抓過的會存起來，平常每次只需抓新的一兩小時）
let latest = Math.floor(Date.now() / 3.6e6) * 3600 - 3600
while (!(await hour(latest)).markets.length) latest -= 3600
const stamps = Array.from({ length: HIST }, (_, i) => latest - i * 3600)
const all = []
for (let i = 0; i < HIST; i += 12) // 一次 12 個，不要同時對官方發太多請求
  all.push(...await Promise.all(stamps.slice(i, i + 12).map((ts, j) =>
    i + j < HOURS ? hour(ts) : hour(ts).catch(() => ({ markets: [] }))))) // 24 小時以前的抓不到只影響走勢圖，不讓整次更新失敗
const digests = all.slice(0, HOURS)
for (const f of fs.readdirSync(path.join(cache, 'hours'))) if (+f.split('.')[0] < latest - 7 * 86400) fs.rmSync(path.join(cache, 'hours', f))

const rows = digests.flatMap(d => d.markets)
const volByLeague = {}
for (const m of rows) volByLeague[m.league] = (volByLeague[m.league] ?? 0) + 1
const league = process.argv.slice(2).find(a => !a.startsWith('--')) || Object.keys(volByLeague).filter(l => l !== '標準模式').sort((a, b) => volByLeague[b] - volByLeague[a])[0]
if (!volByLeague[league]) { console.error(`找不到聯盟「${league}」，可用：${Object.keys(volByLeague).join('、')}`); process.exit(1) }

// 2. 名稱與分類：metadata id →（RePoE 圖檔路徑）→ 台服交易資料的同圖物品
const base = await cached('base_items.json', 'https://repoe-fork.github.io/base_items.json')
const stat = await cached('static.json', 'https://pathofexile.tw/api/trade/data/static')
// 共用圖示的物品（命運卡等）用英文名對照繁中名：本機有 APT 就從它的 app.asar 讀並順便更新 names-zh.json，
// 沒有（例如在 GitHub 雲端執行）就讀 names-zh.json（asar = 8 位元組前綴 + JSON 目錄 + 檔案內容）
const namesFile = path.join(here, 'names-zh.json')
const asarFile = path.join(here, '..', 'Awakened PoE Trade', 'resources', 'app.asar')
let zhByEn
if (fs.existsSync(asarFile) && !process.env.CI) { // GitHub Actions 會設 CI=true
  const asar = fs.readFileSync(asarFile)
  const dir = JSON.parse(asar.toString('utf8', 16, 16 + asar.readUInt32LE(12)))
  const ent = dir.files.data.files['cmn-Hant'].files['items.ndjson'], at = 8 + asar.readUInt32LE(4) + +ent.offset
  const aptItems = asar.toString('utf8', at, at + ent.size).split('\n').filter(Boolean).map(l => JSON.parse(l))
  zhByEn = new Map(aptItems.map(o => [o.refName, { name: o.name, icon: o.icon }]).reverse())
  const snap = JSON.stringify(Object.fromEntries([...zhByEn].map(([en, z]) => [en, [z.name, z.icon]])))
  if (!fs.existsSync(namesFile) || fs.readFileSync(namesFile, 'utf8') !== snap) fs.writeFileSync(namesFile, snap)
} else {
  zhByEn = new Map(Object.entries(JSON.parse(fs.readFileSync(namesFile, 'utf8'))).map(([en, [name, icon]]) => [en, { name, icon }]))
}
const byArt = new Map(), artUses = new Map(), catByText = new Map()
for (const c of stat.result) {
  if (!c.label) continue
  for (const e of c.entries) {
    catByText.set(e.text, c.id)
    const seg = e.image?.split('/')[3]
    if (!seg) continue
    const art = JSON.parse(Buffer.from(seg, 'base64url').toString())[2].f
    artUses.set(art, (artUses.get(art) ?? 0) + 1)
    byArt.set(art, { name: e.text, icon: 'https://webtw.poecdn.com' + e.image })
  }
}
const info = id => {
  const it = base[id]
  if (!it) return { name: id.split('/').pop(), cat: '其他', id }
  const art = it.visual_identity?.dds_file?.replace(/^Art\/|\.dds$/g, '')
  const a = artUses.get(art) === 1 ? byArt.get(art) : null
  const z = zhByEn.get(it.name)
  const name = a?.name ?? z?.name ?? it.name
  return { name, en: it.name, icon: a?.icon ?? z?.icon, cat: exCat(id, it, catByText.get(name)), id, ...placed.get(norm(name)) }
}
// 遊戲內的分頁 → 小分組 → 物品順序（layout.json，照遊戲截圖抄錄）優先；沒列到的物品才用下面的規則分頁
const norm = t => t.replace(/汙/g, '污')
const layout = JSON.parse(fs.readFileSync(path.join(here, 'layout.json'), 'utf8'))
const placed = new Map(), groups = {}
for (const [tab, gs] of Object.entries(layout)) if (Array.isArray(gs)) {
  groups[tab] = gs.map(g => g.group)
  gs.forEach((g, gi) => g.items.forEach((n, i) => placed.set(norm(n), { cat: tab, group: g.group, ord: gi * 1000 + i, label: n })))
}
// 分類比照遊戲內通貨交換市場的分頁；交易網站分類 + 物品類型對照
const EX_CATS = ['通貨', '精髓', '掘獄聯盟', '綢帶', '命運卡', '譫妄異域', '戰亂之殤', '碎片', '油瓶', '催化劑', '預兆', '紋身', '探險聯盟', '生靈之力', '符文之結', '其他']
const exCat = (id, { name: en, item_class: ic }, tc) =>
  /Lifeforce/.test(en) ? '生靈之力'
  : /^Omen of/.test(en) ? '預兆'
  : tc === 'Ancestor' ? '紋身'
  : id.includes('/Threads/') ? '綢帶'
  : /Legion/.test(id) ? '戰亂之殤' // 永恆徽印、裂片、壟罩晶石
  : tc === 'DeliriumOrbs' || /^Simulacrum/.test(en) ? '譫妄異域'
  : ic === 'DivinationCard' ? '命運卡'
  : { Currency: '通貨', Essences: '精髓', Delve: '掘獄聯盟', Cards: '命運卡', Fragments: '碎片', Oils: '油瓶', Catalysts: '催化劑', Expedition: '探險聯盟', Runegrafts: '符文之結' }[tc] ?? (ic === 'StackableCurrency' ? '通貨' : '其他')

// 3. 價格：混沌石價只看「物品↔混沌石」、神聖石價只看「物品↔神聖石」的實際成交，互不換算
//    條件：最近 24 小時內有成交；最新一小時沒人在賣的標「售完」（soldOut），價格仍是最近一次實際成交
//    價格 = 最近一個有成交的小時的成交均價（付出量 ÷ 換得量），附當小時成交比例範圍
const pair = {} // 物品 id → { chaos, divine }
const kind = y => y === CHAOS ? 'chaos' : y === DIVINE ? 'divine' : null
const listed = new Map() // 最新一小時「物品|通貨」→ 在售數量
for (const m of digests[0].markets) if (m.league === league) {
  const [a, b] = m.market_pair
  for (const [x, y] of [[a, b], [b, a]]) if (kind(y) && m.highest_stock[x] > 0) listed.set(x + '|' + y, [m.lowest_stock[x], m.highest_stock[x]])
}
for (const [i, d] of digests.entries()) for (const m of d.markets) {
  // 沒成交的小時（只有掛單）成交量和比例都是 0，跳過
  if (m.league !== league || !Object.values(m.volume_traded).every(v => v > 0)) continue
  const [a, b] = m.market_pair
  for (const [x, y] of [[a, b], [b, a]]) {
    if (!kind(y)) continue
    const stock = listed.get(x + '|' + y)
    const q = ((pair[x] ??= {})[kind(y)] ??= { stock: stock ?? [0, 0], soldOut: !stock, vol24: 0 })
    const v = m.volume_traded
    q.vol24 += v[x]
    const r = [m.lowest_ratio[y] / m.lowest_ratio[x], m.highest_ratio[y] / m.highest_ratio[x]]
    const avg = v[y] / v[x], lo = Math.min(...r), hi = Math.max(...r)
    // 每小時「賣家賣到的最高價／最低價」；超過均價 3 倍或不到 1/3 視為掛錯單，改用均價
    if ((q.h ??= []).length < SELL_HOURS) q.h.push([lo < avg / 3 ? avg : lo, hi > avg * 3 ? avg : hi])
    if (q.price) continue // 已經取到更新的一小時
    Object.assign(q, { price: avg, range: [lo, hi], vol: [v[x], v[y]], ago: i })
  }
}
// 賣價參考（給「我要賣，該開多少」用）：最近 SELL_HOURS（6）個有成交的小時（24 小時內）
//   sell  = 每小時最高成交價的中位數 → 掛單慢慢等，多數小時都有人用這個價賣出
//   quick = 每小時最低成交價的中位數 → 急著賣、直接賣給收購單大概拿到的價
//   用中位數：單一小時的異常成交不會帶偏
const median = a => { a = [...a].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2 }
const items = Object.entries(pair).map(([id, p]) => {
  for (const k of ['chaos', 'divine']) if (!p[k]?.price) delete p[k]
    else { const q = p[k]; Object.assign(q, { sell: median(q.h.map(h => h[1])), quick: median(q.h.map(h => h[0])), sellN: q.h.length }); delete q.h }
  return { ...info(id), ...p }
}).filter(it => it.chaos || it.divine)
const divinePrice = pair[DIVINE].chaos.price

// 漲跌與走勢（只用實際成交，混沌石、神聖石各自算）：
//   d1 = 近 24 小時的成交均價 比 前一天（24～48 小時前）漲跌幾 %；d7 = 比 一週前（144～168 小時前）
//   兩段都至少要有 2 個小時有成交才算，避免一兩筆零星成交造成誇張的漲跌
//   spark = 7 天內每 6 小時的成交均價（舊→新，沒成交的時段是 null）
//   成交均價 = 該段時間付出量總和 ÷ 換得量總和（成交量大的小時影響較大，單筆掛錯的異常成交影響小）
const sums = {} // 「物品|chaos/divine」→ 第 i 小時 [物品量, 通貨量]
for (const [i, d] of all.entries()) for (const m of d.markets) {
  if (m.league !== league || !Object.values(m.volume_traded).every(v => v > 0)) continue
  const [a, b] = m.market_pair
  for (const [x, y] of [[a, b], [b, a]]) {
    if (!kind(y)) continue
    const h = ((sums[x + '|' + kind(y)] ??= [])[i] ??= [0, 0])
    h[0] += m.volume_traded[x]; h[1] += m.volume_traded[y]
  }
}
const vwap = (s, from, to) => {
  let x = 0, y = 0, n = 0
  for (let i = from; i < to; i++) if (s[i]) { x += s[i][0]; y += s[i][1]; n++ }
  return n ? { p: y / x, n } : null
}
for (const it of items) for (const k of ['chaos', 'divine']) {
  const q = it[k], s = sums[it.id + '|' + k]
  if (!q || !s) continue
  const now = vwap(s, 0, 24)
  const chg = before => now?.n >= 2 && before?.n >= 2 ? Math.round((now.p / before.p - 1) * 1000) / 10 : undefined
  q.d1 = chg(vwap(s, 24, 48))
  q.d7 = chg(vwap(s, 144, 168))
  q.spark = Array.from({ length: HIST / 6 }, (_, j) => vwap(s, HIST - 6 * (j + 1), HIST - 6 * j)).map(v => v ? +v.p.toPrecision(4) : null)
}

// 分類按鈕圖示（台服交易資料 id）；含多種物品的分類放每種的代表圖；沒列的分類由網頁取成交量最大的物品
const CAT_ICONS = {
  通貨: ['divine'],
  掘獄聯盟: ['dense-fossil', 'primitive-chaotic-resonator'],
  綢帶: ['ultimatum-thread'],
  譫妄異域: ['simulacrum', 'simulacrum-splinter'],
  戰亂之殤: ['timeless-karui-emblem', 'timeless-karui-splinter'],
  碎片: ['phoenix'],
  預兆: ['omen-of-amelioration'],
  紋身: ['tattoo-of-the-hinekora-warrior'],
}
const imgById = new Map(stat.result.flatMap(c => c.entries.map(e => [e.id, e.image])))
const catIcons = Object.fromEntries(Object.entries(CAT_ICONS).map(([k, ids]) => [k, ids.map(i => imgById.get(i)).filter(Boolean).map(i => 'https://webtw.poecdn.com' + i)]))
// 熱門 = 24 小時成交總值（換算成混沌石，只用來排名）最高的 30 種
const worth = it => (it.chaos ? it.chaos.vol24 * it.chaos.price : 0) + (it.divine ? it.divine.vol24 * it.divine.price * divinePrice : 0)
const hot = [...items].sort((x, y) => worth(y) - worth(x)).slice(0, 30).map(i => i.id)
// 熱門（近 1 小時）= 資料時間那一小時的成交總值前 30 名（同樣換算成混沌石，只用來排名）
const worth1 = {}
for (const m of digests[0].markets) {
  if (m.league !== league || !Object.values(m.volume_traded).every(v => v > 0)) continue
  const [a, b] = m.market_pair
  for (const [x, y] of [[a, b], [b, a]]) {
    if (y === CHAOS) worth1[x] = (worth1[x] ?? 0) + m.volume_traded[CHAOS]
    else if (y === DIVINE) worth1[x] = (worth1[x] ?? 0) + m.volume_traded[DIVINE] * divinePrice
  }
}
const hot1 = items.filter(i => worth1[i.id]).sort((x, y) => worth1[y.id] - worth1[x.id]).slice(0, 30).map(i => i.id)
// 遊戲版面裡 24 小時沒有成交的物品也列出（noTrade，不給價格），讓每頁跟遊戲一樣完整
const traded = new Set(items.map(i => norm(i.name)))
const iconByZh = new Map(), enByZh = new Map()
for (const c of stat.result) for (const e of c.entries) if (e.image) iconByZh.set(norm(e.text), 'https://webtw.poecdn.com' + e.image)
for (const [en, z] of zhByEn) { enByZh.set(norm(z.name), en); if (!iconByZh.has(norm(z.name)) && z.icon) iconByZh.set(norm(z.name), z.icon) }
// 沒成交但最新一小時有人在賣的，附上在售數量（官方資料沒有開價，只有數量）
const idByZh = new Map()
for (const d of digests) for (const m of d.markets) if (m.league === league) for (const x of m.market_pair) if (!idByZh.has(norm(info(x).name))) idByZh.set(norm(info(x).name), x)
for (const [n, p] of placed) if (!traded.has(n)) {
  const mid = idByZh.get(n)
  const listing = mid && { chaos: listed.get(mid + '|' + CHAOS), divine: listed.get(mid + '|' + DIVINE) }
  items.push({ name: p.label, en: enByZh.get(n), icon: iconByZh.get(n), ...p, id: 'layout:' + n, noTrade: true, ...(listing?.chaos || listing?.divine ? { listing } : {}) })
}

// 4. 產生網頁
const data = { generated: Date.now(), catIcons, league, divinePrice, divineRange: pair[DIVINE].chaos.range, updated: (latest + 3600) * 1000, hours: HOURS, hist: HIST, groups, hot, hot1, cats: EX_CATS.filter(c => items.some(i => i.cat === c)), items }
// 資料放 data.js（網頁會定時重新載入它來自動更新）；先寫暫存檔再改名，避免網頁讀到寫一半的檔案
fs.writeFileSync(path.join(here, 'data.js.tmp'), 'window.TW_DATA = ' + JSON.stringify(data))
fs.renameSync(path.join(here, 'data.js.tmp'), path.join(here, 'data.js'))
fs.copyFileSync(path.join(here, 'template.html'), path.join(here, 'index.html'))
console.log(`${league}：${items.filter(i => !i.noTrade).length} 種有成交（版面共 ${items.length} 種），1 神聖石 ≈ ${divinePrice.toFixed(1)} 混沌石，資料到 ${new Date(data.updated).toLocaleString('zh-TW')}`)
if (!process.argv.includes('--no-open')) execFile('cmd', ['/c', 'start', '', path.join(here, 'index.html')])

// 檢查模式：node price.mjs --audit → 列出遊戲版面裡沒有成交價的物品與原因，以及對照不到版面的名稱
if (process.argv.includes('--audit')) {
  const stat24 = new Map() // 名稱 → { seen: 出現過的交易對, traded: 有成交的交易對 }
  const nm = id => norm(info(id).name)
  for (const d of digests) for (const m of d.markets) {
    if (m.league !== league) continue
    for (const [x, y] of [m.market_pair, [...m.market_pair].reverse()]) {
      const s = stat24.get(nm(x)) ?? stat24.set(nm(x), { traded: new Set(), seen: new Set() }).get(nm(x))
      const other = y === CHAOS ? '混沌' : y === DIVINE ? '神聖' : '其他'
      s.seen.add(other)
      if (Object.values(m.volume_traded).every(v => v > 0)) s.traded.add(other)
    }
  }
  const shown = new Set(items.filter(i => !i.noTrade).map(i => norm(i.name)))
  const why = {}
  for (const [tab, gs] of Object.entries(layout)) if (Array.isArray(gs)) for (const g of gs) for (const n of g.items) {
    if (shown.has(norm(n))) continue
    const s = stat24.get(norm(n))
    const r = !s ? '24 小時內完全沒出現在市場資料'
      : !['混沌', '神聖'].some(k => s.seen.has(k)) ? '只跟其他物品交易（沒有混沌/神聖交易對）'
      : !['混沌', '神聖'].some(k => s.traded.has(k)) ? '有掛單但 24 小時內沒成交'
      : '有成交卻沒顯示（不應發生，請檢查名稱對照）'
    ;(why[r] ??= []).push(`${tab}/${n}`)
  }
  for (const [r, list] of Object.entries(why)) console.log(`\n【${r}】${list.length} 種\n  ` + list.join('、'))
  const layoutNames = new Set(Object.values(layout).filter(Array.isArray).flatMap(gs => gs.flatMap(g => g.items.map(norm))))
  const orphan = [...stat24.keys()].filter(n => !layoutNames.has(n))
  console.log(`\n【市場資料裡有、但遊戲版面沒有的名稱（可能是名稱對照錯誤）】${orphan.length} 種\n  ` + orphan.join('、'))
}
