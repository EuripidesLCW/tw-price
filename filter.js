// 台服價格過濾器：讀玩家上傳的過濾器，只調整「台服價格和作者分級差很多」的物品，其他一律不動。
// 純程式判斷，不需要 AI：
//   1. 把過濾器拆成一條條規則（條件＋樣式），格式是遊戲規定的，誰寫的都一樣
//   2. 照遊戲的方式（由上往下、第一條符合就用，Continue 會往下疊加）模擬每個有台服價格的物品，得到作者現在給它的樣式
//   3. 依樣式分組，算每組物品的台服價格中間值 → 反推「這位作者的每種樣式代表多少錢」
//   4. 物品價格是所屬那組中間值的 5 倍以上或 1/5 以下 → 換成同類物品中、中間值最接近它價格的那組樣式
// 調整只寫在檔案最上面，原內容一字不改。網頁與 node 測試共用：twFilter(D, 原檔文字, 原檔名) → { text, name, changes, stats }
(function (root) {
  const RATIO = 5        // 預設：差幾倍以上才調整（玩家可選）
  // 價位分級（混沌石）：玩家勾選哪些價位的物品可以調整；預設不調 1C 以下的便宜貨
  const tiers = dp => [['lt1', '1C 以下', 0, 1], ['c1', '1–10C', 1, 10], ['c10', '10–100C', 10, 100], ['c100', '100C–1D', 100, dp],
    ['d1', '1–10D', dp, 10 * dp], ['d10', '10–100D', 10 * dp, 100 * dp], ['d100', '100D 以上', 100 * dp, Infinity]].map(([key, label, lo, hi]) => ({ key, label, lo, hi }))
  const tierOf = (v, dp) => tiers(dp).find(t => v < t.hi).key
  const DEFAULT_TIERS = ['c1', 'c10', 'c100', 'd1', 'd10', 'd100']
  const FIXED = new Set(['Chaos Orb', 'Divine Orb', 'Chromatic Orb', 'Exalted Orb', 'Orb of Alchemy', 'Orb of Alteration', 'Stacked Deck']) // 基本交易通貨：作者怎麼顯示就怎麼顯示，一律不調整
  const MIN_GROUP = 3   // 一種樣式至少要有幾個物品，才拿來推算價位、借給別的物品用（少於這個數，多半是作者給特定物品的專屬樣式，不動）
  const STYLE = new Set(['SetTextColor', 'SetBackgroundColor', 'SetBorderColor', 'SetFontSize', 'PlayAlertSound', 'PlayAlertSoundPositional', 'CustomAlertSound', 'CustomAlertSoundOptional',
    'DisableDropSound', 'EnableDropSound', 'DisableDropSoundIfAlertSound', 'EnableDropSoundIfAlertSound', 'MinimapIcon', 'PlayEffect'])
  const SOUND = new Set(['PlayAlertSound', 'PlayAlertSoundPositional', 'CustomAlertSound', 'CustomAlertSoundOptional'])
  const LOOK = ['SetTextColor', 'SetBackgroundColor', 'SetBorderColor', 'SetFontSize', 'PlayEffect', 'MinimapIcon'] // 決定「長什麼樣子」的項目（分組用）
  const RARITY = ['Normal', 'Magic', 'Rare', 'Unique']

  // 一行拆成字詞：引號內是一個字詞；# 之後是註解
  function tokens(line) {
    const out = []
    const re = /"([^"]*)"|(#.*)|(\S+)/g
    let m
    while ((m = re.exec(line))) { if (m[2] != null) break; out.push(m[1] ?? m[3]) }
    return out
  }

  // 拆成規則：{ show, cont, conds: [{ key, op, vals }], style: { 項目: 原始那一行 }, ok }
  function parse(text) {
    const blocks = []
    let b = null
    for (const raw of text.split(/\r?\n/)) {
      const t = tokens(raw.trim())
      if (!t.length) continue
      const [k, ...rest] = t
      if (k === 'Show' || k === 'Hide' || k === 'Minimal') { blocks.push(b = { show: k !== 'Hide', cont: false, conds: [], style: {}, ok: true }); continue }
      if (!b) continue
      if (k === 'Continue') b.cont = true
      else if (STYLE.has(k)) b.style[k] = raw.trim().replace(/\s+#.*$/, '').replace(/\s+/g, ' ').trim()
      else {
        const op = /^(==|!=|<=|>=|<|>|=|!)$/.test(rest[0]) ? rest.shift() : '='
        b.conds.push({ key: k, op, vals: rest })
      }
    }
    return blocks
  }

  const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : op === '!' || op === '!=' ? a !== b : a === b
  // 物品符不符合一個條件；模擬不了的條件（插槽、詞綴…這些是裝備用的）回傳 null，整條規則視為不符合
  function test(c, it) {
    const { key, op, vals } = c
    if (key === 'Class' || key === 'BaseType') {
      const v = key === 'Class' ? it.cls : it.en
      const hit = op === '==' || op === '!=' ? vals.some(x => x === v) : vals.some(x => v.includes(x))
      return op === '!' || op === '!=' ? !hit : hit
    }
    const num = { StackSize: it.stack, AreaLevel: it.area }[key]
    if (num != null) return vals.some(x => cmp(num, op, +x))
    if (key === 'Rarity') return vals.some(x => cmp(0, op, RARITY.indexOf(x)))
    return null
  }

  // 模擬遊戲：回傳物品最後的樣子 { show, style, from: 決定外觀的那條規則 }
  function simulate(blocks, it) {
    let style = {}, from = null
    for (const b of blocks) {
      if (!b.conds.every(c => test(c, it) === true)) continue
      style = { ...style, ...b.style }
      from = b
      if (!b.cont) return { show: b.show, style, from }
    }
    return from ? { show: from.show, style, from } : { show: true, style: {}, from: null }
  }

  const lookKey = s => (s.show ? 'S|' : 'H|') + LOOK.map(k => s.style[k] ?? '').join('|')
  const soundOf = st => [...SOUND].map(k => st[k]).find(Boolean) ?? ''
  const median = a => { a = [...a].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2 }
  // 單價（混沌石）：成交量較大那個市場的「掛單賣」參考價
  // 降級保護：成交太少的價格不可靠（稀有命運卡常常一天只成交一兩張、剛好缺貨時只剩便宜成交），
  //   24 小時成交不到 MIN_VOL 個就不降級；降級時改用「近期價格」和「7 天中位數」較高的那個，短暫跌價不會被降級
  const MIN_VOL = 10
  const vol24 = it => (it.chaos?.vol24 ?? 0) + (it.divine?.vol24 ?? 0)
  const safeValue = (it, v, dp) => {
    const sp = [...(it.chaos?.spark ?? []).filter(x => x != null), ...(it.divine?.spark ?? []).filter(x => x != null).map(x => x * dp)]
    return sp.length ? Math.max(v, median(sp)) : v
  }
  const value = (it, dp) => { const c = it.chaos, d = it.divine; return c && (!d || c.vol24 >= d.vol24) ? c.sell : d ? d.sell * dp : 0 }

  function twFilter(D, original, fileName, opt = {}) {
    const area = 83 // 模擬高階地圖；實測文子各階段的結果不受區域等級影響，所以不讓玩家選
    const bom = original.charCodeAt(0) === 0xfeff
    // 每次上傳都是新的開始：上傳的檔案（就算是之前產生過的）原樣當作判斷基準
    const body = bom ? original.slice(1) : original
    const keep = new Set(opt.keep ?? []) // 玩家勾選「不更改」的物品（英文名）
    const ratio = opt.ratio ?? RATIO, allow = new Set(opt.tiers ?? DEFAULT_TIERS)
    const vis = opt.vis ?? {} // 玩家自訂顯示／隱藏：英文名 → true 顯示、false 隱藏（優先於一切）
    const blocks = parse(body)
    if (blocks.filter(b => b.conds.length).length < 20) throw new Error('這個檔案看起來不是過濾器（讀不到規則）')

    // 2. 模擬每個物品（單個、指定的區域等級）
    const items = [], all = []
    for (const it of D.items) {
      if (!it.en || !it.cls || it.en.includes('"')) continue
      const v = it.noTrade ? 0 : value(it, D.divinePrice)
      const r = simulate(blocks, { en: it.en, cls: it.cls, stack: 1, area })
      const x = { it, v, ...r, key: it.cls + '#' + lookKey(r) }
      all.push(x)
      if (v > 0) items.push(x)
    }
    // 3. 依「類別＋樣子」分組，算台服價格中間值
    function grouping() {
      const groups = new Map()
      for (const x of items) (groups.get(x.key) ?? groups.set(x.key, { items: [] }).get(x.key)).items.push(x)
      for (const g of groups.values()) {
        g.med = median(g.items.map(x => x.v))
        const sounds = new Set(g.items.map(x => soundOf(x.style)))
        g.sound = sounds.size === 1 ? [...sounds][0] : null // 整組同一個音效才借音效；各自專屬音效就不借
        g.sample = g.items.find(x => !x.moved) ?? g.items[0] // 借樣式時以作者原本就放在這組的物品為代表
      }
      return groups
    }
    // 4. 找出差很多的物品，替它找同類中價位最接近、而且確實更醒目／更不起眼的樣式
    function decide(x, groups, usable) {
      x.guard = false
      const g = groups.get(x.key)
      if (g.items.length < MIN_GROUP) return null // 作者的專屬樣式，不動
      if (FIXED.has(x.it.en)) return null // 基本交易通貨不調整
      if (x.it.en in vis) return null // 玩家自己決定顯示／隱藏的，不再依價格調整
      if (!allow.has(tierOf(x.v, D.divinePrice))) return null // 玩家沒勾的價位不調整
      const r = x.v / g.med
      if (r < 1 && r <= 1 / ratio && (vol24(x.it) < MIN_VOL || safeValue(x.it, x.v, D.divinePrice) / g.med > 1 / ratio)) { x.guard = true; return null } // 降級保護
      if (r < ratio && r > 1 / ratio) return null
      const up = r > 1, now = loud(x.show, x.style)
      let best = null, bestStyle = null
      for (const t of usable) {
        // 只在同類物品裡借；不借「隱藏」的樣式（降級最多變不起眼，不會把作者原本有顯示的東西藏起來）
        if (t === g || !t.sample.show || t.sample.it.cls !== x.it.cls) continue
        // 必須比現在更接近它的台服價格
        const d = Math.abs(Math.log(x.v / t.med))
        if (d >= Math.abs(Math.log(r)) || (best && d >= Math.abs(Math.log(x.v / best.med)))) continue
        const st = borrow(t, x, up)
        // 升級一定要比原本醒目、降級一定要比原本不起眼，否則不算數
        if (up ? loud(true, st) <= now : loud(true, st) >= now) continue
        best = t; bestStyle = st
      }
      return best && { to: best, style: bestStyle }
    }
    // 物品換組後，各組的中間價會跟著變，可能讓別的物品也跨過門檻；
    // 所以反覆調整到沒有物品再變動為止。這樣下載的檔案再上傳一次，就不會再有調整（升級、降級都是 0）
    for (const x of items) { x.orig = { show: x.show, style: x.style, key: x.key }; x.origMed = null }
    const proposals = new Map() // 玩家選「不更改」的物品：程式原本建議的調整（只用來列在清單上）
    let groups
    for (let round = 0; round < 30; round++) {
      groups = grouping()
      if (round === 0) for (const x of items) x.origMed = groups.get(x.key).med
      const usable = [...groups.values()].filter(g => g.items.length >= MIN_GROUP)
      let moved = 0
      for (const x of items) {
        const d = decide(x, groups, usable)
        if (!d) continue
        if (keep.has(x.it.en)) { proposals.set(x, d); continue }
        x.show = true; x.style = d.style; x.key = x.it.cls + '#' + lookKey({ show: true, style: d.style }); x.moved = true; x.target = d.to.sample.it
        moved++
      }
      if (!moved) break
    }
    const finalGroups = groups
    const changes = []
    for (const x of items) {
      const p = proposals.get(x)
      if (x.moved && x.key !== x.orig.key) changes.push({ x, up: x.v > x.origMed, style: x.style, to: { med: finalGroups.get(x.key).med, sample: { it: x.target } }, kept: false })
      else if (p && !x.moved) changes.push({ x, up: x.v > x.origMed, style: p.style, to: { med: p.to.med, sample: p.to.sample }, kept: true })
    }
    const usable = [...finalGroups.values()].filter(g => g.items.length >= MIN_GROUP)

    // 輸出：樣式完全相同的物品合成一條規則，加在最上面
    // 自訂顯示／隱藏：只處理和目前（含價格調整後）不同的物品
    for (const x of all) x.orig ??= { show: x.show, style: x.style }
    const forced = all.filter(x => x.it.en in vis && vis[x.it.en] !== x.show)
    // 自訂顯示的樣式：借作者同類物品的樣式，不帶音效；同類都沒有就用遊戲預設
    //   有價格：挑價位不比它貴、最接近的組（不會讓便宜貨拿到貴重物品的醒目樣式）；沒有這種組或沒價格：挑最不起眼的組
    const showStyle = x => {
      const cand = [...finalGroups.values()].filter(g => g.items.length >= MIN_GROUP && g.sample.show && g.sample.it.cls === x.it.cls)
      if (!cand.length) return { style: {}, sample: null }
      const cheaper = x.v > 0 ? cand.filter(g => g.med <= x.v) : []
      const t = cheaper.length ? cheaper.reduce((a, b) => b.med > a.med ? b : a)
        : cand.reduce((a, b) => loud(true, b.sample.style) < loud(true, a.sample.style) ? b : a)
      return { style: borrow(t, { style: {} }, false), sample: t.sample.it }
    }
    const forcedOut = []
    const byShow = new Map()
    for (const x of forced.filter(x => vis[x.it.en])) { const st = showStyle(x); const k = JSON.stringify(st.style); (byShow.get(k) ?? byShow.set(k, { st, list: [] }).get(k)).list.push(x) }
    for (const { st, list } of byShow.values()) {
      forcedOut.push(`Show # 台服價格調整 - 自訂顯示${st.sample ? `，樣式同「${st.sample.en}」` : ''}`, `    BaseType == ${list.map(x => `"${x.it.en}"`).sort().join(' ')}`, ...Object.values(st.style).map(l => '    ' + l), '')
    }
    const hide = forced.filter(x => !vis[x.it.en])
    if (hide.length) forcedOut.push('Hide # 台服價格調整 - 自訂隱藏', `    BaseType == ${hide.map(x => `"${x.it.en}"`).sort().join(' ')}`, '')
    const byTo = new Map()
    const applied = changes.filter(c => !c.kept)
    for (const c of applied) { const k = c.up + '|' + c.to.sample.it.en + '|' + JSON.stringify(c.style); (byTo.get(k) ?? byTo.set(k, []).get(k)).push(c) }
    const p = n => String(n).padStart(2, '0'), s = new Date(D.updated - 3600e3), e = new Date(D.updated)
    const hour = `${s.getFullYear()}/${p(s.getMonth() + 1)}/${p(s.getDate())} ${p(s.getHours())}:00–${p(e.getHours())}:00`
    const out = [
      '# ==================================================',
      `# 台服價格調整（${D.league}，依 ${hour} 為止的台服通貨交換成交價）`,
      `# 只調整台服價格和原作者分級差 ${ratio} 倍以上的 ${applied.length} 種物品，改用原作者自己同價位物品的樣式；`,
      ...(forced.length ? [`# 另外依玩家自訂，顯示／隱藏 ${forced.length} 種物品（放在最前面，優先套用）。`] : []),
      '# 其他物品、以及以下原過濾器內容都沒有修改。價格會變，想更新請到網站重新產生。',
      '# ==================================================',
      '',
      ...forcedOut,
    ]
    for (const cs of byTo.values()) {
      const t = cs[0].to
      out.push(`Show # 台服價格調整 - ${cs[0].up ? '升級' : '降級'}，改用和「${t.sample.it.en}」相同的樣式（台服約 ${fmtC(t.med)}）`)
      out.push(`    BaseType == ${cs.map(c => `"${c.x.it.en}"`).sort().join(' ')}`)
      for (const line of Object.values(cs[0].style)) out.push('    ' + line)
      out.push('')
    }
    out.push('# ===== 以下為原過濾器 =====', '')
    const nl = /\r\n/.test(body) ? '\r\n' : '\n'
    const name = /\.filter$/i.test(fileName) ? fileName : fileName + '.filter' // 上傳什麼檔名，下載就是什麼檔名；訂閱的過濾器沒有副檔名，補上 .filter 遊戲才讀得到
    return {
      text: (bom ? '﻿' : '') + out.join(nl) + nl + body, name,
      applied: applied.length, forced: forced.length,
      // 每個物品在下載的過濾器裡顯不顯示（自訂前）：author＝原作者、show＝含價格調整
      visibility: all.map(x => ({ item: x.it, value: x.v, author: x.orig.show, show: x.show })),
      changes: changes.map(c => ({ item: c.x.it, value: c.x.v, tier: tierOf(c.x.v, D.divinePrice), up: c.up, kept: c.kept, from: { show: c.x.orig.show, style: c.x.orig.style, med: c.x.origMed },
        to: { show: true, style: c.style, med: c.to.med, sample: c.to.sample.it } })),
      guarded: items.filter(x => x.guard).map(x => x.it.name),
      stats: { rules: blocks.length, items: items.length, groups: usable.length, unmatched: items.filter(x => !x.from).length },
    }
  }
  // 借來的樣式：外觀照那組；音效——整組同一個音效就借，否則升級保留物品自己原本的音效、降級不出聲
  function borrow(t, x, up) {
    const st = {}
    for (const [k, v] of Object.entries(t.sample.style)) if (!SOUND.has(k)) st[k] = v
    const src = t.sound != null ? t.sample.style : up ? x.style : {}
    for (const k of SOUND) if (src[k]) st[k] = src[k]
    return st
  }
  // 醒目程度（只用來比較升級／降級有沒有真的變醒目／變不起眼）：字大小、光柱、小地圖圖示大小、音效、背景色
  function loud(show, st) {
    if (!show) return -1
    const n = l => +(l ?? '').split(' ')[1]
    const sz = st.MinimapIcon ? n(st.MinimapIcon) : -1, mm = sz >= 0 ? 3 - sz : 0 // MinimapIcon -1 是關閉圖示
    return (n(st.SetFontSize) || 32) + (st.PlayEffect ? 15 : 0) + mm * 6 + ([...SOUND].some(k => st[k]) ? 10 : 0) + (st.SetBackgroundColor ? 5 : 0)
  }
  const fmtC = v => v >= 10 ? Math.round(v) + ' 混沌石' : +v.toPrecision(2) + ' 混沌石'

  twFilter.tiers = tiers
  twFilter.DEFAULT_TIERS = DEFAULT_TIERS
  root.twFilter = twFilter
})(typeof window !== 'undefined' ? window : globalThis)
