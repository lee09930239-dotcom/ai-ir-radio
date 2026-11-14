// 海釣抽獎台：雲端備份（貼到 Google 試算表的 擴充功能 → Apps Script）
const SHEET = '抽獎紀錄';
const HEAD = ['場次ID', '標題', '日期', '時間', '獎品', '得獎者', '留言', '狀態', '當時人數'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
    if (sh.getLastRow() === 0) sh.appendRow(HEAD);
    const ids = new Set(data.sessions || []);
    // 同一場重送時，先刪掉舊的那幾行再寫入
    const last = sh.getLastRow();
    if (ids.size && last >= 2) {
      const col = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = col.length - 1; i >= 0; i--) if (ids.has(String(col[i][0]))) sh.deleteRow(i + 2);
    }
    const rows = (data.rows || []).map(x => [x.session, x.title, x.date, x.time, x.prize, x.name, x.comment,
      x.status === 'won' ? '得獎' : '重抽', x.pool]);
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEAD.length).setValues(rows);
    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}
