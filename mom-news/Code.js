/**
 * 每日國際新聞（給媽媽） v8  2026-11-23（加台灣民生・經濟 5 則）
 * 每天早上：第一張是當地天氣＋穿衣建議，接著是全世界的新聞（中英日 Google 新聞 → 去重 → Gemini 挑選、翻成中文摘要）
 * → 用大字卡片推到 LINE 官方帳號。每個人傳一次「位置資訊」就會用那裡的天氣。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   LINE_TOKEN  = LINE 官方帳號的 Channel access token（長期）
 *   GEMINI_KEY  = Google AI Studio 的 API 金鑰
 *
 * 第一次：選 setup 按「執行」（會建立每天 7 點的排程）。
 * 測試：  選 preview 執行 → 只在執行記錄裡看結果，不推播。
 *         選 testSend 執行 → 真的推一次到 LINE。
 */

const CFG = {
  COUNT: 10,
  TW_COUNT: 5,              // 台灣民生・經濟新聞幾則                // 每天幾則
  SUMMARY_CHARS: 80,        // 每則摘要大約幾個字
  MAX_AGE_HOURS: 30,        // 只收多久以內的新聞
  REMEMBER_DAYS: 4,         // 推過的新聞記住幾天（這幾天內不會再推同一件事）
  HOUR: 7,                  // 每天幾點推（台灣時間；實際會在 7:00～7:59 之間）
  MODELS: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest'],   // 第一個失敗就換下一個
  USE_SEARCH: false,        // true＝先讓 Gemini 用 Google 搜尋確認內容（免費帳號常被擋 429，所以預設關）
  FEEDS: [
    ['國際', 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
    ['財經', 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
    ['頭條', 'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
    // 全世界的新聞：英文（美國版）和日文，Gemini 會翻成中文
    ['國際・英文', 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en'],
    ['財經・英文', 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en'],
    ['國際・日文', 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=ja&gl=JP&ceid=JP:ja'],
  ],
  // 台灣民生・經濟區塊的來源
  TW_FEEDS: [
    ['台灣', 'https://news.google.com/rss/headlines/section/topic/NATION?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
    ['財經', 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
    ['頭條', 'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'],
  ],
  // 備用來源：Google 新聞抓不到（少於 10 則）時才用
  BACKUP_FEEDS: [
    ['國際', 'https://tw.news.yahoo.com/rss/world'],
    ['財經', 'https://tw.news.yahoo.com/rss/finance'],
  ],
  GEMINI_BUDGET_SEC: 200,   // 超過這個秒數就不再呼叫下一個模型（GAS 一次最多跑 6 分鐘）
  // 第一則固定是天氣＋穿衣建議（Open-Meteo，免費不用金鑰）。
  // 每個人在 LINE 傳一次「位置資訊」，之後就用那裡的天氣；還沒傳過的人用這個預設地點
  WEATHER: { name: '台北市北投區', lat: 25.1316, lon: 121.5017 },
  TZ: 'Asia/Taipei',
};

// ===== 排程與測試 =====
/* 每天的流程（台灣時間）：
 *   5 點、6 點：prepare  先抓新聞＋Gemini 寫好摘要存起來（6 點那次如果 5 點已經做好就跳過）
 *   7 點：dailyNews      推播。有準備好的就推準備好的；沒有就「只推標題」（不等 Gemini，一定推得出去）
 *   8 點：dailyNews      備援。7 點成功就跳過；7 點失敗就再推一次
 *   推播失敗或全部來源都抓不到時，寄 Gmail 通知你。 */
function setup() {
  ScriptApp.getProjectTriggers().filter(t => ['dailyNews', 'prepare'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  [CFG.HOUR - 3, CFG.HOUR - 2, CFG.HOUR - 1].forEach(h => ScriptApp.newTrigger('prepare').timeBased().atHour(h).everyDays(1).inTimezone(CFG.TZ).create());
  [CFG.HOUR, CFG.HOUR + 1].forEach(h => ScriptApp.newTrigger('dailyNews').timeBased().atHour(h).everyDays(1).inTimezone(CFG.TZ).create());
  ['LINE_TOKEN', 'GEMINI_KEY'].forEach(k => { if (!prop(k)) console.warn('⚠️ 還沒設定指令碼屬性 ' + k); });
  console.log('✅ 排程已建立：' + (CFG.HOUR - 3) + '～' + (CFG.HOUR - 1) + ' 點準備，' + CFG.HOUR + ' 點推播，' + (CFG.HOUR + 1) + ' 點備援（台灣時間）');
}
function todayStr() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
// 每次只準備一個還沒好的區塊（國際、台灣各要 3 分鐘左右，一次做兩個會超過 6 分鐘上限）
function prepare() {
  const today = todayStr();
  if (prop('LAST_SENT') === today) return;
  try { prefetchWeather(); } catch (e) { console.warn('prefetch ' + e); }
  const good = k => prop(k + '_DATE') === today && jget(k, { items: [] }).items.some(x => x.summary);
  try {
    if (!good('PREP')) {
      const r = build();
      if (r.items.length) { jset('PREP', r); setProp('PREP_DATE', today); console.log('✅ 國際已準備 ' + r.items.length + ' 則（' + r.mode + '）'); }
    } else if (!good('PREP_TW')) {
      const r = build(true, jget('PREP', { items: [] }).items.map(x => x.event || x.title));
      if (r.items.length) { jset('PREP_TW', r); setProp('PREP_TW_DATE', today); console.log('✅ 台灣已準備 ' + r.items.length + ' 則（' + r.mode + '）'); }
    }
  } catch (e) { console.error('prepare ' + e); }
}
function previewTw() { const r = build(true); console.log(JSON.stringify(r.items, null, 2)); console.log('候選 ' + r.candidates + ' 則，摘要方式：' + r.mode); }
function preview() { const r = build(); console.log(JSON.stringify(r.items, null, 2)); console.log('候選 ' + r.candidates + ' 則，摘要方式：' + r.mode); }
function testSend() { dailyNews(true); }

// ===== 新功能上線公告：群發給所有好友（只發一次；想再發一次就跑 announce）=====
const ANNOUNCE_TEXT = '📍 新功能：天氣跟著你走\n\n' +
  '從現在起，每天早上第一張卡片是「你所在地」的天氣和穿衣建議。\n\n' +
  '① 第一次請先傳任何一句話給我（例如「嗨」），完成登記，不然之後會收不到新聞喔！\n' +
  '② 想換成所在地的天氣：直接打「天氣 地名」，例如「天氣 東京」\n' +
  '③ 換地方了就再傳一次，隔天早上就會用新地點，每天換都可以\n\n' +
  '沒傳過位置的話，預設是台北市北投區的天氣。';
function announce() {
  const c = pushAll([{ type: 'text', text: ANNOUNCE_TEXT }]);
  if (c < 300) { setProp('ANNOUNCED_V7', '1'); console.log('✅ 已群發新功能公告'); }
}

function dailyNews(force) {
  const today = todayStr(), test = force === true;
  if (!test && prop('LAST_SENT') === today) return;   // 一天只推一次
  let r = null;
  if (prop('PREP_DATE') === today) r = jget('PREP', null);              // 4～6 點準備好的
  if (!r || !r.items || !r.items.length) {
    try { r = test ? build() : titlesOnly(); } catch (e) { console.error(e); r = { items: [] }; }   // 排程時沒準備好：只推標題，不等 Gemini
  }
  let rt = prop('PREP_TW_DATE') === today ? jget('PREP_TW', null) : null;      // 台灣區塊
  const worldReady = prop('PREP_DATE') === today;
  if ((!rt || !rt.items || !rt.items.length) && test && worldReady) {      // 測試時國際已經準備好，就現場請 Gemini 寫台灣（時間夠）
    try { rt = build(true, r.items.map(x => x.event || x.title)); jset('PREP_TW', rt); setProp('PREP_TW_DATE', today); } catch (e) { console.error(e); }
  }
  if (!rt || !rt.items || !rt.items.length) { try { rt = titlesOnly(true); } catch (e) { console.error(e); rt = { items: [] }; } }
  // 每個人用自己的天氣地點分開推；還沒有人登記過（沒傳過訊息）就用預設地點群發
  const users = jget('USERS', {}), uids = Object.keys(users), wxCache = {};
  const msgsFor = loc => {
    const k = Number(loc.lat).toFixed(2) + ',' + Number(loc.lon).toFixed(2);
    if (!(k in wxCache)) wxCache[k] = weatherBubble(loc);
    const wx = wxCache[k];
    if (r.items.length) return cards(r.items, wx, rt.items);
    return (wx ? [{ type: 'flex', altText: '今日天氣', contents: wx }] : []).concat([{ type: 'text', text: '☀️ 早安！今天的新聞整理暫時出不來，可以點這裡看最新國際新聞：\nhttps://news.google.com/home?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' }]);
  };
  if (!r.items.length) alertMail('今天抓不到新聞（Google 新聞和備用來源都失敗），已改推早安訊息。');
  let ok = 0, code = 0;
  if (!uids.length) {
    // 還沒人登記：群發。新功能公告沒發過的話，跟著今天的新聞一起發（同一次推播，不多算則數）
    const m = msgsFor(CFG.WEATHER), ann = !prop('ANNOUNCED_V7') && !test;
    code = pushAll(ann ? m.concat([{ type: 'text', text: ANNOUNCE_TEXT }]) : m);
    if (code < 300) { ok = 1; if (ann) setProp('ANNOUNCED_V7', '1'); }
  }
  else uids.forEach(u => { const c = lineApi('message/push', { to: u, messages: msgsFor(users[u]) }); if (c < 300) ok++; else code = c; });
  if (ok) {
    setProp('LAST_SENT', today);
    if (r.items.length) remember(r.items.concat(rt.items));
    console.log('✅ 已推播 ' + r.items.length + ' 則給 ' + (uids.length ? ok + '/' + uids.length + ' 人' : '所有好友') + '（' + r.mode + '）');
    if (uids.length && ok < uids.length) alertMail('有 ' + (uids.length - ok) + ' 個人推播失敗（HTTP ' + code + '），請看執行記錄。');
  } else alertMail('LINE 推播失敗（HTTP ' + code + '）。' + (new Date().getHours() < CFG.HOUR + 1 ? CFG.HOUR + 1 + ' 點會再試一次。' : '今天已經沒有備援了，請看執行記錄。') + '\n常見原因：LINE_TOKEN 錯誤、本月免費則數用完。');
}
function titlesOnly(tw) {
  const cands = dedupe(tw ? fetchCandidates(CFG.TW_FEEDS) : fetchAll());
  const tr = t => { if (/[\u4e00-\u9fff]/.test(t) && !/[\u3040-\u30ff]/.test(t)) return t; try { return LanguageApp.translate(t, '', 'zh-TW'); } catch (e) { return t; } };
  if (tw) {   // 只有標題時，用關鍵字挑民生・經濟相關的放前面
    const kw = /物價|漲價|降價|油價|電價|瓦斯|水價|薪|基本工資|勞|稅|健保|長照|年金|補助|津貼|普發|房|租|股|匯率|央行|利率|通膨|CPI|交通|捷運|高鐵|台鐵|機票|颱風|地震|停電|停水|食安|疫苗|醫療|物流|超商|就業|失業/;
    cands.sort((a, b) => (kw.test(b.title) ? 1 : 0) - (kw.test(a.title) ? 1 : 0));
    return { items: cands.slice(0, CFG.TW_COUNT).map(c => ({ title: c.title, summary: '', oneline: '', src: c.src, time: c.time, link: c.link, orig: c.title, event: c.title })), candidates: cands.length, mode: '僅標題（備案）' };
  }
  return { items: mix(cands, tw ? CFG.TW_COUNT : CFG.COUNT).map(c => ({ title: tr(c.title), summary: '', oneline: '', src: c.src, time: c.time, link: c.link, orig: c.title, event: c.title })), candidates: cands.length, mode: '僅標題（備案）' };
}
function fetchAll() {
  let all = fetchCandidates(CFG.FEEDS);
  if (all.length < 10) { console.warn('Google 新聞只抓到 ' + all.length + ' 則，改用備用來源'); all = all.concat(fetchCandidates(CFG.BACKUP_FEEDS)); }
  return all;
}
function alertMail(msg) {
  try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '⚠️ 每日國際新聞：' + todayStr(), msg); } catch (e) { console.error('mail ' + e); }
}

// ===== 1. 抓新聞 =====
function fetchCandidates(feeds) {
  const now = Date.now(), out = [];
  feeds.forEach(([cat, url]) => {
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) { console.warn(cat + ' HTTP ' + res.getResponseCode()); return; }
      const items = XmlService.parse(res.getContentText()).getRootElement().getChild('channel').getChildren('item');
      items.slice(0, 25).forEach(i => {
        const raw = i.getChildText('title') || '';
        const src = i.getChild('source') ? i.getChild('source').getText() : (cat + '（Yahoo）');
        const title = raw.replace(/\s+-\s+[^-]+$/, '').trim();
        const t = new Date(i.getChildText('pubDate') || 0).getTime();
        if (!title || !t || now - t > CFG.MAX_AGE_HOURS * 3600e3) return;
        // 同一件事的其他媒體標題（Google 新聞的 description 會列出來），給 Gemini 當摘要材料
        const related = (i.getChildText('description') || '').replace(/<\/li>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
          .split('\n').map(s => s.trim()).filter(s => s && s.indexOf(title.slice(0, 10)) < 0).slice(0, 2);
        out.push({ cat, title, src, time: t, link: i.getChildText('link') || '', related });
      });
    } catch (e) { console.warn(cat + ' ' + e); }
  });
  return out;
}

// ===== 2. 去重：去掉相同／相似標題、和前幾天推過的 =====
function norm(s) { return String(s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase(); }
function grams(s) { const n = norm(s), g = new Set(); for (let i = 0; i < n.length - 1; i++) g.add(n.slice(i, i + 2)); return g; }
function similar(a, b) {
  const A = grams(a), B = grams(b); if (!A.size || !B.size) return false;
  let hit = 0; A.forEach(x => { if (B.has(x)) hit++; });
  return hit / Math.min(A.size, B.size) >= 0.6;
}
function dedupe(list) {
  const seen = jget('SEEN', []).map(x => x.t);
  const out = [];
  list.sort((a, b) => b.time - a.time).forEach(it => {
    if (seen.some(s => similar(s, it.title))) return;
    const dup = out.find(o => similar(o.title, it.title));
    if (dup) { if (dup.related.length < 3) dup.related.push(it.title + '（' + it.src + '）'); return; }
    out.push(it);
  });
  return out;
}
// 每個來源輪流拿，避免全部都是中文或全部都是英文
function mix(list, n) {
  const by = {}; list.forEach(x => (by[x.cat] = by[x.cat] || []).push(x));
  const keys = Object.keys(by), out = [];
  for (let i = 0; out.length < n && keys.some(k => by[k][i]); i++) keys.forEach(k => { if (by[k][i] && out.length < n) out.push(by[k][i]); });
  return out;
}
function remember(items) {
  const cut = Date.now() - CFG.REMEMBER_DAYS * 86400e3;
  const keep = jget('SEEN', []).filter(x => x.d > cut);
  items.forEach(it => [it.orig, it.title, it.event].filter(Boolean).forEach(t => keep.push({ t, d: Date.now() })));
  jset('SEEN', keep.slice(-200));
}

// ===== 3. Gemini 挑新聞＋寫摘要 =====
function build(tw, exclude) {
  const start = Date.now(), N = tw ? CFG.TW_COUNT : CFG.COUNT;
  const all = tw ? fetchCandidates(CFG.TW_FEEDS) : fetchAll();
  const cands = mix(dedupe(all), tw ? 35 : 40);
  console.log('抓到新聞 ' + all.length + ' 則，去重後 ' + cands.length + ' 則');
  if (!cands.length) return { items: [], candidates: 0, mode: '無' };
  const pastEvents = jget('SEEN', []).map(x => x.t).slice(-40);
  const list = cands.map((c, i) => i + '. [' + c.cat + '] ' + c.title + '（' + c.src + '，' + fmt(c.time, 'MM/dd HH:mm') + '）' +
    (c.related.length ? '\n   相關報導：' + c.related.join('／') : '')).join('\n');
  const rules = tw ?
    '你是幫長輩整理每日新聞的編輯。以下是過去一天的台灣新聞標題。\n' +
    '請挑出最重要的 ' + N + ' 則「台灣國內」新聞，規則：\n' +
    '- 以民生和經濟為主：物價、油電瓦斯價格、薪資、稅、健保與長照、交通、房市、補助與新政策、台股與匯率、會影響生活的天災。\n' +
    '- 不要國際新聞（另一區已經有了），也不要政治口水、娛樂、八卦、社會案件。\n' +
    (exclude && exclude.length ? '- 這些今天國際區已經選了，不要重複：' + exclude.join('／') + '\n' : '')
    :
    '你是幫長輩整理每日新聞的編輯。以下是過去一天的新聞標題，來自台灣、美國、日本的媒體（有中文、英文、日文）。\n' +
    '請挑出最重要的 ' + N + ' 則，規則：\n' +
    '- 以國際大事為主：各國重大事件、美國政府動向、戰爭與外交、國際經濟。\n' +
    '- 至少要有 1 則股市或金融市場（美股、台股、匯率、利率）。\n' +
    '- 不要選台灣國內新聞（另外有台灣區塊），除非是全世界都在報導的大事。\n';
  const prompt = rules +
    '- 不要娛樂、八卦、社會案件、廣告、天氣小事。\n' +
    '- 優先選全世界都在關注的大事，不要只選台灣媒體的角度。同一件事有中文報導就用中文那則的編號。\n' +
    '- 同一件事只能選一則（不同語言講同一件事也算同一件）。下面這些是前幾天已經推過的，不要再選同一件事（除非有重大新進展）：\n  ' + (pastEvents.join('／') || '（無）') + '\n' +
    '- 背景常識：川普（Trump）是現任美國總統，不要寫成「前總統」。\n' +
    '每則請寫：\n' +
    '- title：重寫成 25 字以內、長輩一看就懂的標題\n' +
    '- summary：約 ' + CFG.SUMMARY_CHARS + ' 字的白話摘要，只寫確定的事實，不要猜測\n' +
    '- oneline：一句話總結（20 字以內，說明這件事對一般人的意義）\n' +
    '- event：10 字以內的事件代號（用來避免之後重複）\n' +
    '- no：所用新聞的編號\n' +
    'title、summary、oneline 全部翻成台灣繁體中文（人名、地名用台灣常見譯名）。只輸出 JSON 陣列，不要其他文字，格式：\n' +
    '[{"no":0,"title":"","summary":"","oneline":"","event":""}]\n\n新聞清單：\n' + list;

  let text = null, mode = '';
  // 先用 Google 搜尋輔助（摘要比較準），失敗就只用標題和相關報導寫
  for (const useSearch of (CFG.USE_SEARCH ? [true, false] : [false])) {
    for (const m of CFG.MODELS) {
      if ((Date.now() - start) / 1000 > CFG.GEMINI_BUDGET_SEC) { console.warn('時間快不夠了，不再換模型'); break; }
      text = gemini(m, prompt + (useSearch ? '\n\n可以用 Google 搜尋確認新聞內容後再寫摘要。' : '\n\n重要：摘要只能用上面標題和相關報導裡「明寫」的事實，不可以自己補地名、數字、原因或細節；資訊不夠就只寫一兩句。標題看不懂在講什麼的新聞不要選。'), useSearch);
      if (text && parseJson(text)) { mode = m + (useSearch ? '＋搜尋' : '＋僅標題'); break; }
      text = null;
      Utilities.sleep(3000);   // 太快重試容易被擋 429
    }
    if (text) break;
  }
  if (!text) {   // Gemini 全部失敗：退回只推標題，至少媽媽還是收得到
    return { items: cands.slice(0, N).map(c => ({ title: c.title, summary: '', oneline: '', src: c.src, time: c.time, link: c.link, event: c.title })), candidates: cands.length, mode: '僅標題（Gemini 失敗）' };
  }
  const picked = parseJson(text).filter(p => cands[p.no]).slice(0, N)
    .map(p => Object.assign({}, p, { orig: cands[p.no].title, src: cands[p.no].src, time: cands[p.no].time, link: cands[p.no].link }));
  return { items: picked, candidates: cands.length, mode };
}
function gemini(model, prompt, useSearch, plain) {
  // 先叫它「少想一點」（回應快很多）；這個模型不支援這個設定 (400) 就改用一般方式再問一次
  const gc = plain ? { temperature: 0.3 } : { temperature: 0.3, thinkingConfig: { thinkingLevel: 'low' } };
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc };
  if (useSearch) body.tools = [{ google_search: {} }];
  const t0 = Date.now();
  console.log('呼叫 ' + model + (useSearch ? '（搜尋）' : '') + '…');
  try {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': prop('GEMINI_KEY') }, payload: JSON.stringify(body) });
    if (r.getResponseCode() === 400 && !plain) { console.log(model + ' 不支援少想模式，改一般模式'); return gemini(model, prompt, useSearch, true); }
    if (r.getResponseCode() !== 200) { console.warn('Gemini ' + model + (useSearch ? ' 搜尋' : '') + ' HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300)); return null; }
    console.log(model + ' 回應 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
    const j = JSON.parse(r.getContentText());
    return ((j.candidates || [])[0] || {}).content ? j.candidates[0].content.parts.map(p => p.text || '').join('') : null;
  } catch (e) { console.warn('Gemini ' + e); return null; }
}
function parseJson(t) {
  const m = String(t).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const a = JSON.parse(m[0]); return Array.isArray(a) && a.length && a.every(x => typeof x.no === 'number' && x.title) ? a : null; } catch (e) { return null; }
}

// ===== 4. 大字卡片 =====
function newsBubbles(items, label, color) {
  return items.map((it, i) => {
    const body = [
      { type: 'text', text: label + ' ' + (i + 1) + ' / ' + items.length + '・' + (it.src || '') + '・' + fmt(it.time, 'M/d HH:mm'), size: 'md', color: '#666666', wrap: true },
      { type: 'text', text: it.title, size: 'xxl', weight: 'bold', wrap: true, color: '#111111', margin: 'md' },
    ];
    if (it.summary) body.push({ type: 'text', text: it.summary, size: 'xl', wrap: true, color: '#222222', margin: 'lg', lineSpacing: '6px' });
    if (it.oneline) body.push({ type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '12px', backgroundColor: '#FFF4D6', cornerRadius: '8px',
      contents: [{ type: 'text', text: '👉 ' + it.oneline, size: 'xl', weight: 'bold', wrap: true, color: '#7A4B00' }] });
    const b = { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: body } };
    if (/^https:\/\//.test(it.link || '')) b.footer = { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'primary', color: color, height: 'md', action: { type: 'uri', label: '看原文', uri: it.link } }] };
    return b;
  });
}
function cards(items, wx, twItems) {
  const d = new Date(), wk = '日一二三四五六'[Number(Utilities.formatDate(d, CFG.TZ, 'u')) % 7];
  const day = Utilities.formatDate(d, CFG.TZ, 'M/d') + '（' + wk + '）';
  const tw = twItems || [];
  // 第一組：天氣＋台灣民生・經濟；第二組：國際新聞
  const out = [
    { type: 'text', text: '☀️ 早安！' + day + '\n第一張是今天的天氣' + (tw.length ? '，接著是 ' + tw.length + ' 則台灣民生・經濟新聞' : '') + '；下一組是 ' + items.length + ' 則國際新聞。往左滑看下一則。' },
    { type: 'flex', altText: day + '天氣' + (tw.length ? '＋台灣民生・經濟：' + tw.map(x => x.title).join('、').slice(0, 300) : ''),
      contents: { type: 'carousel', contents: (wx ? [wx] : []).concat(newsBubbles(tw, '🇹🇼 台灣', '#1B7F3B')).slice(0, 12) } },
  ];
  if (!out[1].contents.contents.length) out.pop();   // 天氣和台灣都沒有：不送空輪播
  if (items.length) out.push({ type: 'flex', altText: day + '國際新聞：' + items.map(x => x.title).join('、').slice(0, 300),
    contents: { type: 'carousel', contents: newsBubbles(items, '🌏 國際', '#0B3D91').slice(0, 12) } });
  return out;
}

// ===== 5. LINE 推播（broadcast：所有加好友的人都收到）=====
function lineApi(path, body) {
  const r = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop('LINE_TOKEN') }, payload: JSON.stringify(body) });
  if (r.getResponseCode() >= 300) console.error('LINE ' + path + ' ' + r.getResponseCode() + ' ' + r.getContentText());
  return r.getResponseCode();
}

// ===== 接收 LINE 訊息（要部署成網頁應用程式，並把網址填到 LINE 的 Webhook）=====
// 傳「位置資訊」→ 換天氣地點；傳其他任何訊息或加好友 → 登記成推播對象＋回說明
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents), users = jget('USERS', {});
    (body.events || []).forEach(ev => {
      const u = ev.source && ev.source.userId;
      if (!u) return;
      if (ev.type === 'unfollow') { delete users[u]; return; }
      const isNew = !users[u];
      if (isNew) users[u] = Object.assign({}, CFG.WEATHER);
      let text = null;
      if (ev.type === 'message' && ev.message.type === 'location') {
        users[u] = { name: placeName(ev.message.address, ev.message.title), lat: ev.message.latitude, lon: ev.message.longitude };
        text = '📍 天氣地點已改成：' + users[u].name + '\n明天早上開始用這裡的天氣。換地方的時候，再傳一次位置就好。';
      } else if (ev.type === 'message' && ev.message.type === 'text' && /^(天氣|地點|位置)\s*[:：]?\s*\S/.test(ev.message.text.trim())) {
        // 打字換地點：「天氣 東京」「天氣 北投」
        const q = ev.message.text.trim().replace(/^(天氣|地點|位置)\s*[:：]?\s*/, '').slice(0, 20);
        const g = geocode(q);
        if (g) { users[u] = g; text = '📍 天氣地點已改成：' + g.name + (g.where ? '（' + g.where + '）' : '') + '\n明天早上開始用這裡的天氣。換地方的時候，再傳一次「天氣 地名」就好。'; }
        else text = '找不到「' + q + '」這個地方 🙏\n可以換個寫法再試一次，例如「天氣 東京」「天氣 台北市北投區」，\n或按左下「＋」→「位置資訊」直接傳位置。';
      } else if (ev.type === 'follow' || ev.type === 'message') {
        text = (isNew ? '✅ 已登記，每天早上 7 點會收到天氣和國際新聞。\n' : '') +
          '目前的天氣地點：' + users[u].name + '\n\n想換地點：直接打「天氣 地名」，例如「天氣 東京」。\n（也可以按左下「＋」→「位置資訊」傳目前位置）';
      }
      if (text && ev.replyToken) lineApi('message/reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text }] });
    });
    jset('USERS', users);
  } catch (err) { console.error('doPost ' + err); }
  return ContentService.createTextOutput('OK');
}
// 地名 → 經緯度（Open-Meteo 地名搜尋，免費）。中文找不到就翻成英文再找一次
function geocode(q) {
  const find = name => {
    try {
      const r = UrlFetchApp.fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=' + encodeURIComponent(name), { muteHttpExceptions: true });
      const x = r.getResponseCode() === 200 ? (JSON.parse(r.getContentText()).results || [])[0] : null;
      return x ? { name: q, lat: x.latitude, lon: x.longitude, where: [x.country, x.admin1].filter(Boolean).join('・') } : null;
    } catch (e) { console.warn('geocode ' + e); return null; }
  };
  // 例：「台北市北投區」→ 台北市北投區、北投區、北投
  const last = q.replace(/^.+?[市縣県都府](?=.{2,})/, ''), names = [];
  [q, last, last.replace(/(市|區|区|縣|県|府|都|町)$/, '')].forEach(n => { if (n.length >= 2 && names.indexOf(n) < 0) names.push(n); });
  for (const n of names) { const g = find(n); if (g) return g; }
  for (const n of names.slice(-1)) {
    try { const en = LanguageApp.translate(n, '', 'en').replace(/ (City|District|Prefecture|Ward)$/i, ''); if (en && en !== n) { const g = find(en); if (g) return g; } } catch (e) {}
  }
  return null;
}
function placeName(addr, title) {
  const a = String(addr || '');
  const tw = a.match(/([^\s\d]{2}[市縣])([^\s\d]{1,3}?[區鄉鎮市])/);
  if (tw) return tw[1] + tw[2];
  const jp = a.match(/([^\s、\d〒-]{2,3}[都道府県])([^\s\d]{1,6}?[市区町村])/);
  if (jp) return jp[1] + jp[2];
  return (title || a || '目前位置').slice(0, 15);
}

function pushAll(messages) {
  const r = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop('LINE_TOKEN') }, payload: JSON.stringify({ messages }) });
  if (r.getResponseCode() >= 300) console.error('LINE ' + r.getResponseCode() + ' ' + r.getContentText());
  return r.getResponseCode();
}

// ===== 小工具 =====
function P() { return PropertiesService.getScriptProperties(); }
function prop(k) { return P().getProperty(k) || ''; }
function setProp(k, v) { P().setProperty(k, v); }
function jget(k, d) { try { return JSON.parse(prop(k)) || d; } catch (e) { return d; } }
function jset(k, v) { setProp(k, JSON.stringify(v)); }
function fmt(t, f) { return Utilities.formatDate(new Date(t), CFG.TZ, f); }

// ===== 天氣＋穿衣建議（規則判斷，不用 AI，一定穩） =====
const WMO = { 0: '晴天', 1: '晴時多雲', 2: '多雲', 3: '陰天', 45: '有霧', 48: '有霧', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '凍雨', 67: '凍雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '陣雨', 81: '陣雨', 82: '大陣雨',
  95: '雷雨', 96: '雷雨', 99: '強烈雷雨' };
// 天氣：Open-Meteo → 失敗重試一次 → 改用 wttr.in → 再不行用今天稍早（準備時）存下來的
function weather(w) {
  const key = 'WX_' + Number(w.lat).toFixed(2) + ',' + Number(w.lon).toFixed(2), today = todayStr();
  const got = openMeteo(w) || (Utilities.sleep(2000), openMeteo(w)) || wttr(w);
  if (got) { jset(key, { d: today, w: got }); return got; }
  const c = jget(key, null);
  if (c && c.d === today) { console.warn('天氣即時抓不到，用今天稍早存的'); return c.w; }
  console.error('天氣三個來源都失敗：' + (w.name || key));
  return null;
}
function openMeteo(w) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.lat + '&longitude=' + w.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_min,precipitation_probability_max,uv_index_max' +
    '&timezone=' + encodeURIComponent(CFG.TZ) + '&forecast_days=1';
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { console.warn('Open-Meteo HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150)); return null; }
    const d = JSON.parse(r.getContentText()).daily, g = k => (d[k] || [])[0];
    if (g('temperature_2m_max') == null) return null;
    return { code: g('weather_code'), max: Math.round(g('temperature_2m_max')), min: Math.round(g('temperature_2m_min')),
      feel: Math.round(g('apparent_temperature_min')), rain: g('precipitation_probability_max') || 0, uv: Math.round(g('uv_index_max') || 0) };
  } catch (e) { console.warn('Open-Meteo ' + e); return null; }
}
function wttr(w) {
  try {
    const r = UrlFetchApp.fetch('https://wttr.in/' + w.lat + ',' + w.lon + '?format=j1&lang=zh-tw', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { console.warn('wttr HTTP ' + r.getResponseCode()); return null; }
    const day = JSON.parse(r.getContentText()).weather[0], hs = day.hourly || [];
    const noon = hs[4] || hs[0] || {};
    const desc = ((noon['lang_zh-tw'] || noon.lang_zh || [])[0] || {}).value || '';
    return { code: null, desc, max: Number(day.maxtempC), min: Number(day.mintempC),
      feel: Math.min.apply(null, hs.map(h => Number(h.FeelsLikeC)).concat([Number(day.mintempC)])),
      rain: Math.max.apply(null, hs.map(h => Number(h.chanceofrain) || 0).concat([0])), uv: Number(day.uvIndex) || 0 };
  } catch (e) { console.warn('wttr ' + e); return null; }
}
// 準備時先把每個人的天氣抓一次存著，推播時抓不到還有備份
function prefetchWeather() {
  const seen = {};
  [CFG.WEATHER].concat(Object.values(jget('USERS', {}))).forEach(l => { const k = Number(l.lat).toFixed(2) + ',' + Number(l.lon).toFixed(2); if (!seen[k]) { seen[k] = 1; weather(l); } });
}
function clothing(w) {
  const t = w.max, tips = [];
  tips.push(t >= 30 ? '短袖、透氣衣服' : t >= 26 ? '短袖或薄長袖' : t >= 21 ? '長袖上衣，帶件薄外套' : t >= 16 ? '長袖＋外套或毛衣' : t >= 11 ? '厚外套、毛衣' : '羽絨衣、圍巾、手套');
  if (w.max - w.min >= 8 || w.feel <= w.min - 3) tips.push('早晚比較涼，出門多帶一件');
  if (w.rain >= 50) tips.push('會下雨，記得帶傘'); else if (w.rain >= 30) tips.push('可能下雨，帶把折傘');
  if (w.uv >= 8) tips.push('紫外線很強，戴帽子、擦防曬'); else if (w.uv >= 6) tips.push('太陽大，注意防曬');
  return tips;
}
function weatherBubble(loc) {
  loc = loc || CFG.WEATHER;
  const w = weather(loc);
  if (!w) return null;
  const desc = w.desc || WMO[w.code] || '';
  const row = (k, v) => ({ type: 'box', layout: 'horizontal', margin: 'md', contents: [
    { type: 'text', text: k, size: 'xl', color: '#666666', flex: 3 }, { type: 'text', text: v, size: 'xl', weight: 'bold', color: '#111111', flex: 5, wrap: true }] });
  return { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
    { type: 'text', text: '今日天氣・' + loc.name, size: 'md', color: '#666666' },
    { type: 'text', text: (desc || '天氣') + '　' + w.min + '～' + w.max + '°C', size: 'xxl', weight: 'bold', wrap: true, color: '#111111', margin: 'md' },
    row('降雨機率', w.rain + '%'), row('體感最低', w.feel + '°C'), row('紫外線', String(w.uv)),
    { type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '12px', backgroundColor: '#E8F3FF', cornerRadius: '8px',
      contents: [{ type: 'text', text: '👕 建議穿著', size: 'xl', weight: 'bold', color: '#0B3D91' }]
        .concat(clothing(w).map(x => ({ type: 'text', text: '・' + x, size: 'xl', wrap: true, color: '#0B3D91', margin: 'sm' }))) },
  ] } };
}
