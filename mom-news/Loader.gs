/**
 * 每日國際新聞 Loader：GAS 裡只放這個檔案。
 * 每次執行都去 GitHub 抓最新的 mom-news/Code.js（5 分鐘快取），
 * 抓不到的時候用上一次成功抓到的備份（存在指令碼屬性 SRC_BAK_*），所以 GitHub 掛了照樣會推。
 * 程式改版：只要改 GitHub 上的 Code.js，這裡不用動。
 */
const SRC_URL = 'https://raw.githubusercontent.com/lee09930239-dotcom/ai-ir-radio/main/mom-news/Code.js';

function load_() {
  const cache = CacheService.getScriptCache(), props = PropertiesService.getScriptProperties();
  let code = cache.get('SRC');
  if (!code) {
    try {
      const r = UrlFetchApp.fetch(SRC_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
      if (r.getResponseCode() === 200 && r.getContentText().indexOf('function dailyNews') >= 0) {
        code = r.getContentText();
        try { cache.put('SRC', code, 300); } catch (e) {}
        saveBackup_(props, code);
      } else console.warn('GitHub HTTP ' + r.getResponseCode() + '，改用備份');
    } catch (e) { console.warn('GitHub 抓不到：' + e + '，改用備份'); }
  }
  if (!code) code = readBackup_(props);
  if (!code) throw new Error('GitHub 抓不到程式，也沒有備份。請確認網路後再執行一次。');
  return new Function(code + '\nreturn { setup, preview, testSend, dailyNews, prepare, doPost };')();
}
function saveBackup_(props, code) {
  const n = Math.ceil(code.length / 2500), o = { SRC_BAK_N: String(n) };
  for (let i = 0; i < n; i++) o['SRC_BAK_' + i] = code.slice(i * 2500, (i + 1) * 2500);
  if (readBackup_(props) !== code) props.setProperties(o);
}
function readBackup_(props) {
  const n = Number(props.getProperty('SRC_BAK_N') || 0);
  let s = ''; for (let i = 0; i < n; i++) s += props.getProperty('SRC_BAK_' + i) || '';
  return s;
}

// ===== 給你按「執行」和給排程呼叫的入口 =====
function setup() { load_().setup(); }
function preview() { load_().preview(); }
function testSend() { load_().testSend(); }
function dailyNews() { load_().dailyNews(); }
function prepare() { load_().prepare(); }
function doPost(e) { return load_().doPost(e); }   // LINE 傳訊息進來（換天氣地點）
function refreshCode() { CacheService.getScriptCache().remove('SRC'); load_(); console.log('✅ 已抓最新版程式'); }

// 不會被執行：只是讓 Google 知道程式需要哪些權限（程式碼是從 GitHub 載入的，Google 看不到）
function permissions_() {
  ScriptApp.newTrigger('dailyNews'); ScriptApp.getProjectTriggers(); UrlFetchApp.fetch('');
  XmlService.parse(''); MailApp.sendEmail('', '', ''); Session.getEffectiveUser().getEmail();
  LanguageApp.translate('', '', 'zh-TW'); Utilities.sleep(0); ContentService.createTextOutput('');
}
