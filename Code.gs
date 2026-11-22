/**
 * ระบบส่งงานและดูคะแนน — วิชาการเขียนโปรแกรมคอมพิวเตอร์ ม.2/2569
 * Google Apps Script Web App (Backend)
 *
 * ชีตที่ใช้ (อ่านจากแท็บแรกของแต่ละไฟล์ หรือระบุชื่อแท็บใน *_TAB):
 *   1) Login  : Number | Name | Username | Password | Class
 *   2) สถานะ  : Number | STD_ID | Name | Class | W1... | W2... | ...
 *   3) คะแนน  : Number | STD_ID | Name | Class | W1... (3) | ... | Mid Test (20) | ...
 *
 * จับคู่ภาระงานระหว่างชีตสถานะและชีตคะแนนด้วย "รหัสงาน" = ข้อความก่อนเครื่องหมาย :
 *   เช่น "W1:ใบงานที่ 1.1" กับ "W1:ใบงานที่ 1.1 (3)" → รหัส W1, คะแนนเต็ม 3
 */

const CONFIG = {
  LOGIN_SHEET_ID:  '1lPC9ueFH1FVSBiSC_erp1eZGASi7EtmF1KUi-K5rfIE',
  STATUS_SHEET_ID: '1n5-IxePWdAiUkJMuHD725WFTBmzOq09jGAfZp_EMrgg',
  SCORE_SHEET_ID:  '1jN1R_NomnCVPaW2Vou9qvU6H7r_WeZEJf0Iigyh8unE',

  // เว้นว่าง = ใช้แท็บแรกของไฟล์
  LOGIN_TAB: '',
  STATUS_TAB: '',
  SCORE_TAB: '',

  // บัญชีครูเริ่มต้น (เปลี่ยนได้จากหน้า Admin > ตั้งค่า ซึ่งจะเก็บไว้ใน Script Properties)
  DEFAULT_ADMIN_USER: 'khanapot',
  // ไม่เก็บรหัสผ่านเป็นข้อความ: ค่านี้คือ SHA-256 ของ "username:password" (ตรงกับ ADMIN_HASH ใน Index.html)
  DEFAULT_ADMIN_HASH: '2d4e0268132efa02f2bfab2cbdb746ea359aa2f575a36138613041c5a1d5ce1a',

  SESSION_SECONDS: 6 * 60 * 60, // อายุการเข้าสู่ระบบ (สูงสุด 6 ชั่วโมง)

  APP: {
    title: 'ระบบส่งงานและดูคะแนน',
    subject: 'การเขียนโปรแกรมคอมพิวเตอร์',
    level: 'ชั้นมัธยมศึกษาปีที่ 2  ภาคเรียนที่ 2  ปีการศึกษา 2569',
    school: 'โรงเรียนวิทยาศาสตร์จุฬาภรณราชวิทยาลัย เชียงราย',
    // ใส่ URL รูปตราโรงเรียน (PNG/SVG ที่เปิดดูได้สาธารณะ) หรือเว้นว่างเพื่อใช้โลโก้โค้ด
    logoUrl: ''
  }
};

const STATUS_OPTIONS = ['ตรวจแล้ว', 'ส่งแล้ว', 'ส่งช้า', 'ส่งใหม่']; // ช่องว่าง = ยังไม่ส่ง

/* ======================================================================
 *  Web app entry
 * ==================================================================== */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ระบบส่งงาน | การเขียนโปรแกรมคอมพิวเตอร์ ม.2')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** JSON API สำหรับหน้าเว็บที่โฮสต์ภายนอก (เช่น GitHub Pages)
 *  POST body (text/plain): {"fn":"adminLogin","args":["user","pass"]} → {"ok":true,"data":...} */
const API_FNS = {
  getPublicInfo: getPublicInfo, studentLogin: studentLogin, getStudentData: getStudentData, logout: logout,
  adminLogin: adminLogin, adminGetData: adminGetData, adminSaveChanges: adminSaveChanges,
  adminAddAssignment: adminAddAssignment, adminUpdateAssignment: adminUpdateAssignment,
  adminDeleteAssignment: adminDeleteAssignment, adminSaveStudent: adminSaveStudent,
  adminDeleteStudent: adminDeleteStudent, adminSetAnnouncement: adminSetAnnouncement,
  adminChangeCredentials: adminChangeCredentials
};
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API_FNS[req.fn];
    if (!fn) throw new Error('ไม่รู้จักคำสั่ง ' + req.fn);
    out = { ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** รันฟังก์ชันนี้ 1 ครั้งใน Editor เพื่ออนุญาตสิทธิ์และตรวจการเชื่อมต่อชีต */
function testConnection() {
  ['login', 'status', 'score'].forEach(function (k) {
    const t = readTable_(k);
    Logger.log('%s: %s แถว | หัวตาราง: %s', k, t.rows.length, t.headers.join(' | '));
  });
  const items = mergeItems_(readTable_('status'), readTable_('score'));
  Logger.log('ภาระงาน: %s', items.map(function (x) { return x.key + (x.max ? '(' + x.max + ')' : ''); }).join(', '));
}

function getPublicInfo() {
  return { app: CONFIG.APP, announce: props_().getProperty('ANNOUNCE') || '' };
}

/* ======================================================================
 *  Student
 * ==================================================================== */
/** นักเรียนเข้าสู่ระบบด้วย "รหัสนักเรียน" อย่างเดียว
 *  ค้นจากคอลัมน์ Password ในชีต Login (ซึ่งเก็บรหัสนักเรียน) ถ้าไม่พบจะค้น STD_ID ในชีตสถานะ/คะแนน */
function studentLogin(studentId) {
  const id = String(studentId || '').trim().replace(/\s+/g, '');
  if (!id) throw new Error('กรุณากรอกรหัสนักเรียน');
  if (!/^\d{3,10}$/.test(id)) throw new Error('รหัสนักเรียนต้องเป็นตัวเลขเท่านั้น');
  checkRate_('stu', 40); // กันการสุ่มรหัส: ผิดรวมเกิน 40 ครั้งใน 5 นาที จะพักการ login ชั่วคราว

  let sess = null;
  const lg = readTable_('login');
  if (lg.col.password >= 0) {
    const row = lg.rows.find(function (r) { return samePass_(r[lg.col.password], id); });
    if (row) {
      sess = {
        role: 'student', name: cell_(lg, row, 'name'), cls: cell_(lg, row, 'cls'),
        number: cell_(lg, row, 'number'), username: cell_(lg, row, 'username'), password: id
      };
    }
  }
  if (!sess) {
    ['status', 'score'].some(function (k) {
      const t = readTable_(k);
      const i = findRow_(t, { stdId: id });
      if (i < 0) return false;
      const r = t.rows[i];
      sess = { role: 'student', name: cell_(t, r, 'name'), cls: cell_(t, r, 'cls'), number: cell_(t, r, 'number'), username: '', password: id };
      return true;
    });
  }
  if (!sess || !sess.name) {
    failRate_('stu');
    throw new Error('ไม่พบรหัสนักเรียน ' + id + ' ในระบบ');
  }
  return { token: newSession_(sess), data: buildStudentData_(sess) };
}

function getStudentData(token) {
  return buildStudentData_(getSession_(token, 'student'));
}

function buildStudentData_(sess) {
  const st = readTable_('status');
  const sc = readTable_('score');
  const items = mergeItems_(st, sc);

  let si = findRow_(st, { name: sess.name });
  if (si < 0) si = findRow_(st, { stdId: sess.password });
  let ci = findRow_(sc, { name: sess.name });
  if (ci < 0) ci = findRow_(sc, { stdId: sess.password });

  const sRow = si >= 0 ? st.rows[si] : null;
  const cRow = ci >= 0 ? sc.rows[ci] : null;
  const stdId = (sRow && cell_(st, sRow, 'stdId')) || (cRow && cell_(sc, cRow, 'stdId')) || '';

  return {
    profile: {
      number: sess.number || (sRow ? cell_(st, sRow, 'number') : ''),
      stdId: stdId,
      name: sess.name,
      cls: sess.cls || (sRow ? cell_(st, sRow, 'cls') : ''),
      username: sess.username
    },
    items: items.map(function (x) {
      return {
        key: x.key, title: x.title, max: x.max, link: x.link,
        hasStatus: x.stCol >= 0,
        hasScore: x.scCol >= 0,
        status: x.stCol >= 0 && sRow ? String(sRow[x.stCol]).trim() : '',
        score: x.scCol >= 0 && cRow ? String(cRow[x.scCol]).trim() : ''
      };
    }),
    found: { status: !!sRow, score: !!cRow },
    announce: props_().getProperty('ANNOUNCE') || '',
    updatedAt: new Date().toISOString()
  };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('S_' + token);
  return true;
}

/* ======================================================================
 *  Admin
 * ==================================================================== */
function adminLogin(username, password) {
  checkRate_('admin');
  const cr = adminCreds_();
  if (String(username || '').trim() !== cr.user || !checkAdminPass_(cr, password)) {
    failRate_('admin');
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านครูไม่ถูกต้อง');
  }
  return { token: newSession_({ role: 'admin', user: cr.user }) };
}

function adminGetData(token) {
  getSession_(token, 'admin');
  const lg = readTable_('login');
  const st = readTable_('status');
  const sc = readTable_('score');
  const items = mergeItems_(st, sc);

  const students = [];
  const usedLogin = {}, usedScore = {};

  st.rows.forEach(function (r) {
    const name = cell_(st, r, 'name');
    if (!name) return;
    const rec = {
      number: cell_(st, r, 'number'), stdId: cell_(st, r, 'stdId'), name: name, cls: cell_(st, r, 'cls'),
      username: '', password: '', status: {}, score: {}, inStatus: true, inScore: false, inLogin: false
    };
    items.forEach(function (x) { if (x.stCol >= 0) rec.status[x.key] = String(r[x.stCol]).trim(); });

    const ci = findRow_(sc, { stdId: rec.stdId, name: name });
    if (ci >= 0 && !usedScore[ci]) {
      usedScore[ci] = true; rec.inScore = true;
      items.forEach(function (x) { if (x.scCol >= 0) rec.score[x.key] = String(sc.rows[ci][x.scCol]).trim(); });
    }
    let li = findRow_(lg, { name: name });
    // ชื่อในชีต Login อาจสะกดต่างจากชีตสถานะ → จับคู่ด้วยรหัส (Password = STD_ID)
    if ((li < 0 || usedLogin[li]) && rec.stdId && lg.col.password >= 0) {
      li = lg.rows.findIndex(function (r, i) { return !usedLogin[i] && normId_(r[lg.col.password]) === normId_(rec.stdId); });
    }
    if (li >= 0 && !usedLogin[li]) {
      usedLogin[li] = true; rec.inLogin = true;
      rec.username = cell_(lg, lg.rows[li], 'username');
      rec.password = cell_(lg, lg.rows[li], 'password');
      if (!rec.number) rec.number = cell_(lg, lg.rows[li], 'number');
    }
    students.push(rec);
  });

  // นักเรียนที่มีในชีตคะแนน/ชีต Login แต่ไม่มีในชีตสถานะ
  sc.rows.forEach(function (r, i) {
    const name = cell_(sc, r, 'name');
    if (!name || usedScore[i]) return;
    const rec = {
      number: cell_(sc, r, 'number'), stdId: cell_(sc, r, 'stdId'), name: name, cls: cell_(sc, r, 'cls'),
      username: '', password: '', status: {}, score: {}, inStatus: false, inScore: true, inLogin: false
    };
    items.forEach(function (x) { if (x.scCol >= 0) rec.score[x.key] = String(r[x.scCol]).trim(); });
    const li = findRow_(lg, { name: name });
    if (li >= 0 && !usedLogin[li]) {
      usedLogin[li] = true; rec.inLogin = true;
      rec.username = cell_(lg, lg.rows[li], 'username');
      rec.password = cell_(lg, lg.rows[li], 'password');
    }
    students.push(rec);
  });
  lg.rows.forEach(function (r, i) {
    const name = cell_(lg, r, 'name');
    if (!name || usedLogin[i]) return;
    students.push({
      number: cell_(lg, r, 'number'), stdId: '', name: name, cls: cell_(lg, r, 'cls'),
      username: cell_(lg, r, 'username'), password: cell_(lg, r, 'password'),
      status: {}, score: {}, inStatus: false, inScore: false, inLogin: true
    });
  });

  const classes = Array.from(new Set(students.map(function (s) { return s.cls; }).filter(String))).sort();

  return {
    app: CONFIG.APP,
    items: items.map(function (x) {
      return { key: x.key, title: x.title, max: x.max, link: x.link, inStatus: x.stCol >= 0, inScore: x.scCol >= 0 };
    }),
    students: students,
    classes: classes,
    statusOptions: STATUS_OPTIONS,
    announce: props_().getProperty('ANNOUNCE') || '',
    adminUser: adminCreds_().user,
    sheets: {
      login: sheetUrl_(CONFIG.LOGIN_SHEET_ID),
      status: sheetUrl_(CONFIG.STATUS_SHEET_ID),
      score: sheetUrl_(CONFIG.SCORE_SHEET_ID)
    },
    updatedAt: new Date().toISOString()
  };
}

/** changes: [{type:'status'|'score', stdId, name, key, value}] */
function adminSaveChanges(token, changes) {
  getSession_(token, 'admin');
  if (!Array.isArray(changes) || !changes.length) return { saved: 0, failed: 0 };
  return withLock_(function () {
    const tables = { status: readTable_('status'), score: readTable_('score') };
    let saved = 0;
    const failed = [];
    changes.forEach(function (ch) {
      const t = tables[ch.type];
      if (!t) { failed.push(ch); return; }
      const col = findColByKey_(t, ch.key);
      const ri = findRow_(t, { stdId: ch.stdId, name: ch.name });
      if (col < 0 || ri < 0) { failed.push(ch); return; }
      let v = ch.value == null ? '' : String(ch.value).trim();
      if (ch.type === 'score' && v !== '') {
        const n = Number(v);
        if (isNaN(n)) { failed.push(ch); return; }
        v = n;
      }
      t.sh.getRange(ri + 2, col + 1).setValue(v);
      saved++;
    });
    SpreadsheetApp.flush();
    return { saved: saved, failed: failed.length };
  });
}

/** a: {title, max, link, toStatus, toScore} */
function adminAddAssignment(token, a) {
  getSession_(token, 'admin');
  const title = cleanTitle_(a && a.title);
  if (!title) throw new Error('กรุณาระบุชื่อภาระงาน');
  const key = keyOf_(title);
  const max = a.max === '' || a.max == null ? null : Number(a.max);
  if (max != null && (isNaN(max) || max < 0)) throw new Error('คะแนนเต็มไม่ถูกต้อง');
  return withLock_(function () {
    const st = readTable_('status');
    const sc = readTable_('score');
    if (findColByKey_(st, key) >= 0 || findColByKey_(sc, key) >= 0) throw new Error('มีภาระงานรหัส "' + key + '" อยู่แล้ว');
    if (a.toStatus !== false) appendHeader_(st.sh, title);
    if (a.toScore !== false) appendHeader_(sc.sh, max != null ? title + ' (' + max + ')' : title);
    setLink_(key, a.link);
    return { key: key };
  });
}

/** a: {key, title, max, link} */
function adminUpdateAssignment(token, a) {
  getSession_(token, 'admin');
  const title = cleanTitle_(a && a.title);
  if (!title) throw new Error('กรุณาระบุชื่อภาระงาน');
  const newKey = keyOf_(title);
  const max = a.max === '' || a.max == null ? null : Number(a.max);
  if (max != null && (isNaN(max) || max < 0)) throw new Error('คะแนนเต็มไม่ถูกต้อง');
  return withLock_(function () {
    const st = readTable_('status');
    const sc = readTable_('score');
    if (newKey !== a.key && (findColByKey_(st, newKey) >= 0 || findColByKey_(sc, newKey) >= 0)) {
      throw new Error('มีภาระงานรหัส "' + newKey + '" อยู่แล้ว');
    }
    const c1 = findColByKey_(st, a.key);
    if (c1 >= 0) st.sh.getRange(1, c1 + 1).setValue(title);
    const c2 = findColByKey_(sc, a.key);
    if (c2 >= 0) sc.sh.getRange(1, c2 + 1).setValue(max != null ? title + ' (' + max + ')' : title);
    if (newKey !== a.key) setLink_(a.key, '');
    setLink_(newKey, a.link);
    return { key: newKey };
  });
}

function adminDeleteAssignment(token, key) {
  getSession_(token, 'admin');
  return withLock_(function () {
    ['status', 'score'].forEach(function (k) {
      const t = readTable_(k);
      const c = findColByKey_(t, key);
      if (c >= 0) t.sh.deleteColumn(c + 1);
    });
    setLink_(key, '');
    return true;
  });
}

/** s: {number, stdId, name, cls, username, password}; orig: {name, stdId} | null (เพิ่มใหม่) */
function adminSaveStudent(token, s, orig) {
  getSession_(token, 'admin');
  const rec = {
    number: String(s.number || '').trim(),
    stdId: String(s.stdId || '').trim(),
    name: String(s.name || '').replace(/\s+/g, ' ').trim(),
    cls: String(s.cls || '').trim(),
    username: String(s.username || '').trim(),
    password: String(s.password || '').trim()
  };
  if (!rec.name || !rec.cls || !rec.username || !rec.password) {
    throw new Error('กรุณากรอก ชื่อ-สกุล, ห้อง, Username และ Password ให้ครบ');
  }
  return withLock_(function () {
    const lg = readTable_('login'), st = readTable_('status'), sc = readTable_('score');
    if (!orig && findRow_(lg, { name: rec.name }) >= 0) throw new Error('มีนักเรียนชื่อนี้อยู่แล้ว');
    // นักเรียนเข้าสู่ระบบด้วยรหัสอย่างเดียว จึงห้ามรหัสซ้ำกัน
    if (lg.col.password >= 0) {
      const dup = lg.rows.find(function (r) {
        return samePass_(r[lg.col.password], rec.password) && normName_(cell_(lg, r, 'name')) !== normName_(orig ? orig.name : '');
      });
      if (dup) throw new Error('รหัส ' + rec.password + ' ซ้ำกับ ' + cell_(lg, dup, 'name'));
    }

    const num = rec.number !== '' && !isNaN(Number(rec.number)) ? Number(rec.number) : rec.number;
    const txt = function (v) { return v === '' ? '' : "'" + v; }; // คงเลข 0 นำหน้า

    writeRow_(lg, orig ? findRow_(lg, { name: orig.name }) : -1,
      { number: num, name: rec.name, username: rec.username, password: txt(rec.password), cls: rec.cls });
    [st, sc].forEach(function (t) {
      writeRow_(t, orig ? findRow_(t, { stdId: orig.stdId, name: orig.name }) : -1,
        { number: num, stdId: txt(rec.stdId), name: rec.name, cls: rec.cls });
    });
    SpreadsheetApp.flush();
    return true;
  });
}

function adminDeleteStudent(token, orig) {
  getSession_(token, 'admin');
  return withLock_(function () {
    ['login', 'status', 'score'].forEach(function (k) {
      const t = readTable_(k);
      const ri = findRow_(t, { stdId: orig.stdId, name: orig.name });
      if (ri >= 0) t.sh.deleteRow(ri + 2);
    });
    return true;
  });
}

function adminSetAnnouncement(token, text) {
  getSession_(token, 'admin');
  props_().setProperty('ANNOUNCE', String(text || '').slice(0, 1000));
  return true;
}

function adminChangeCredentials(token, currentPass, newUser, newPass) {
  getSession_(token, 'admin');
  const cr = adminCreds_();
  if (!checkAdminPass_(cr, currentPass)) throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  const u = String(newUser || '').trim();
  const p = String(newPass || '');
  if (u.length < 3) throw new Error('Username ต้องมีอย่างน้อย 3 ตัวอักษร');
  if (p.length < 6) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  props_().setProperties({ ADMIN_USER: u, ADMIN_PASS: p });
  return true;
}

/* ======================================================================
 *  Helpers
 * ==================================================================== */
function props_() { return PropertiesService.getScriptProperties(); }

function adminCreds_() {
  const p = props_();
  return {
    user: p.getProperty('ADMIN_USER') || CONFIG.DEFAULT_ADMIN_USER,
    pass: p.getProperty('ADMIN_PASS') || '' // ว่าง = ยังใช้รหัสเริ่มต้น (ตรวจด้วย hash)
  };
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function checkAdminPass_(cr, password) {
  password = String(password || '');
  if (cr.pass) return password === cr.pass; // ตั้งรหัสใหม่แล้ว (เก็บใน Script Properties)
  return sha256Hex_(cr.user + ':' + password) === CONFIG.DEFAULT_ADMIN_HASH;
}

function newSession_(data) {
  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  CacheService.getScriptCache().put('S_' + token, JSON.stringify(data), CONFIG.SESSION_SECONDS);
  return token;
}

function getSession_(token, role) {
  const raw = token ? CacheService.getScriptCache().get('S_' + token) : null;
  if (!raw) throw new Error('SESSION_EXPIRED');
  const s = JSON.parse(raw);
  if (role && s.role !== role) throw new Error('ไม่มีสิทธิ์เข้าถึงข้อมูลนี้');
  return s;
}

function checkRate_(k, limit) {
  const n = Number(CacheService.getScriptCache().get('F_' + k) || 0);
  if (n >= (limit || 8)) throw new Error('เข้าสู่ระบบผิดหลายครั้ง กรุณารอ 5 นาทีแล้วลองใหม่');
}
function failRate_(k) {
  const c = CacheService.getScriptCache();
  c.put('F_' + k, String(Number(c.get('F_' + k) || 0) + 1), 300);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheetUrl_(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }

function openTab_(id, tabName) {
  const ss = SpreadsheetApp.openById(id);
  const sh = tabName ? ss.getSheetByName(tabName) : ss.getSheets()[0];
  if (!sh) throw new Error('ไม่พบแท็บชีต "' + tabName + '"');
  return sh;
}

function readTable_(kind) {
  const cfg = {
    login: [CONFIG.LOGIN_SHEET_ID, CONFIG.LOGIN_TAB],
    status: [CONFIG.STATUS_SHEET_ID, CONFIG.STATUS_TAB],
    score: [CONFIG.SCORE_SHEET_ID, CONFIG.SCORE_TAB]
  }[kind];
  const sh = openTab_(cfg[0], cfg[1]);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const values = lastRow > 0 && lastCol > 0 ? sh.getRange(1, 1, lastRow, lastCol).getDisplayValues() : [[]];
  const headers = values[0].map(function (h) { return String(h).replace(/\s+/g, ' ').trim(); });
  return { kind: kind, sh: sh, headers: headers, rows: values.slice(1), col: fixedCols_(headers) };
}

function fixedCols_(headers) {
  const low = headers.map(function (h) { return h.toLowerCase().replace(/[\s_\-.]/g, ''); });
  const find = function (names) {
    for (let i = 0; i < names.length; i++) { const j = low.indexOf(names[i]); if (j >= 0) return j; }
    return -1;
  };
  return {
    number: find(['number', 'no', 'เลขที่']),
    stdId: find(['stdid', 'studentid', 'รหัสนักเรียน', 'รหัส']),
    name: find(['name', 'ชื่อสกุล', 'ชื่อนามสกุล', 'ชื่อ']),
    cls: find(['class', 'ห้อง', 'ชั้น']),
    username: find(['username', 'user']),
    password: find(['password', 'pass', 'รหัสผ่าน'])
  };
}

function cell_(t, row, k) { return t.col[k] >= 0 ? String(row[t.col[k]] == null ? '' : row[t.col[k]]).trim() : ''; }

function assignmentCols_(t) {
  const fixed = Object.keys(t.col).map(function (k) { return t.col[k]; });
  const out = [];
  t.headers.forEach(function (h, i) { if (h && fixed.indexOf(i) < 0) out.push(i); });
  return out;
}

function cleanTitle_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function parseHeader_(h) {
  h = cleanTitle_(h);
  let title = h, max = null;
  const m = h.match(/\(\s*(\d+(?:\.\d+)?)\s*\)\s*$/);
  if (m) { max = Number(m[1]); title = h.slice(0, m.index).trim(); }
  return { key: keyOf_(title), title: title, max: max };
}

function keyOf_(title) {
  const t = String(title).replace(/\(\s*\d+(?:\.\d+)?\s*\)\s*$/, '').trim();
  const i = t.indexOf(':');
  return (i > 0 ? t.slice(0, i) : t).toUpperCase().replace(/\s+/g, '');
}

function findColByKey_(t, key) {
  const cols = assignmentCols_(t);
  for (let i = 0; i < cols.length; i++) if (parseHeader_(t.headers[cols[i]]).key === key) return cols[i];
  return -1;
}

/** รวมรายการภาระงานจากชีตสถานะ + ชีตคะแนน (คงลำดับ และแทรกงานที่มีเฉพาะคะแนน เช่น Mid Test) */
function mergeItems_(st, sc) {
  const list = [];
  assignmentCols_(st).forEach(function (c) {
    const p = parseHeader_(st.headers[c]);
    if (list.some(function (x) { return x.key === p.key; })) return;
    list.push({ key: p.key, title: p.title, max: p.max, stCol: c, scCol: -1 });
  });
  let last = -1;
  assignmentCols_(sc).forEach(function (c) {
    const p = parseHeader_(sc.headers[c]);
    const i = list.findIndex(function (x) { return x.key === p.key; });
    if (i >= 0) {
      if (list[i].scCol < 0) list[i].scCol = c;
      if (p.max != null) list[i].max = p.max;
      last = i;
    } else {
      list.splice(last + 1, 0, { key: p.key, title: p.title, max: p.max, stCol: -1, scCol: c });
      last++;
    }
  });
  const links = getLinks_();
  list.forEach(function (x) { x.link = links[x.key] || ''; });
  return list;
}

function normName_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normId_(s) { return String(s || '').trim().replace(/^'/, '').replace(/^0+(?=\d)/, ''); }

function samePass_(stored, input) {
  const a = String(stored).trim();
  if (a === input) return true;
  return /^\d+$/.test(a) && /^\d+$/.test(input) && normId_(a) === normId_(input);
}

/** q: {stdId?, name?} → index ใน t.rows หรือ -1 */
function findRow_(t, q) {
  if (q.stdId && t.col.stdId >= 0) {
    const id = normId_(q.stdId);
    const i = t.rows.findIndex(function (r) { return normId_(r[t.col.stdId]) === id; });
    if (i >= 0) return i;
  }
  if (q.name && t.col.name >= 0) {
    const n = normName_(q.name);
    const i = t.rows.findIndex(function (r) { return normName_(r[t.col.name]) === n; });
    if (i >= 0) return i;
  }
  return -1;
}

function writeRow_(t, ri, map) {
  if (ri >= 0) {
    Object.keys(map).forEach(function (k) {
      const c = t.col[k];
      if (c >= 0) t.sh.getRange(ri + 2, c + 1).setValue(map[k]);
    });
  } else {
    const arr = new Array(Math.max(t.headers.length, 1)).fill('');
    Object.keys(map).forEach(function (k) { const c = t.col[k]; if (c >= 0) arr[c] = map[k]; });
    t.sh.appendRow(arr);
  }
}

function appendHeader_(sh, text) {
  const lc = Math.max(sh.getLastColumn(), 1);
  if (lc >= sh.getMaxColumns()) sh.insertColumnAfter(lc);
  sh.getRange(1, lc).copyFormatToRange(sh, lc + 1, lc + 1, 1, 1);
  sh.getRange(1, lc + 1).setValue(text);
}

function getLinks_() {
  try { return JSON.parse(props_().getProperty('LINKS') || '{}'); } catch (e) { return {}; }
}
function setLink_(key, url) {
  const links = getLinks_();
  url = String(url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw new Error('ลิงก์ส่งงานต้องขึ้นต้นด้วย http:// หรือ https://');
  if (url) links[key] = url; else delete links[key];
  props_().setProperty('LINKS', JSON.stringify(links));
}
