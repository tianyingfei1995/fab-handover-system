'use strict';

/**
 * FAB 生产日常交接系统 — 后端服务
 *
 * 技术栈：Node.js + Express + better-sqlite3 + bcrypt + multer
 *
 * 启动：node server.js  (或 npm start)
 * 默认端口：3000
 */

const express = require('express');
const bcrypt = require('bcrypt');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const Database = require('better-sqlite3');

// ─── 配置 ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DB_PATH = path.join(DATA_DIR, 'fab.db');
const SALT_ROUNDS = 10;
const MODULES = ['dashboard', 'machine', 'daily-handover', 'lt-machine', 'lot-handover', 'sign-in', 'duty-issue', 'ar-handover'];
const ROLES = ['admin', 'dept_admin', 'editor', 'viewer'];

// ─── 登录防暴力破解 ───────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;            // 连续失败次数上限
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 锁定时长（15 分钟）

// ─── 会话有效期 ──────────────────────────────────────
const SESSION_MAX_HOURS = 24;            // 令牌有效时长（滑动窗口：距创建超时即失效）
const loginAttempts = new Map();         // key: `${ip}:${employee_id}` → { count, lockUntil }

// 确保目录存在
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'machines'), { recursive: true });

// ─── 上传文件归属清单 ────────────────────────────────
// 上传时记录"文件相对路径 -> 归属部门"，用于把孤儿图片/文件安全地界定给对应部门，
// 使部门管理员可以清理本部门的孤儿，同时避免跨部门误删。
const UPLOAD_OWNERSHIP_FILE = path.join(DATA_DIR, 'upload-ownership.json');
let _uploadOwnership = null; // 内存缓存

function loadUploadOwnership() {
  if (_uploadOwnership) return _uploadOwnership;
  try {
    if (fs.existsSync(UPLOAD_OWNERSHIP_FILE)) {
      _uploadOwnership = JSON.parse(fs.readFileSync(UPLOAD_OWNERSHIP_FILE, 'utf8'));
    }
  } catch (e) { /* 损坏则重置 */ }
  _uploadOwnership = _uploadOwnership || {};
  return _uploadOwnership;
}

function saveUploadOwnership(map) {
  try {
    fs.writeFileSync(UPLOAD_OWNERSHIP_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.error('[归属] 保存上传归属清单失败:', e.message);
  }
}

// 记录一批已保存上传文件（相对路径或 /uploads/ 开头路径）归属到当前用户部门
function recordUploadOwnership(paths, req) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const map = loadUploadOwnership();
  // admin 上传的文件归属「公共」部门
  const dept = ((req.user && req.user.department) || '') || (isAdminUser(req) ? '公共' : '');
  const name = (req.user && (req.user.name || req.user.employee_id)) || '';
  const now = new Date().toISOString();
  let changed = false;
  for (const p of paths) {
    const clean = String(p).replace(/^\/uploads\//, '');
    if (!clean) continue;
    // 同一文件二次上传极罕见，保留首个归属即可；空归属性格优先保留有部门的记录
    if (!map[clean]) {
      map[clean] = { department: dept, name, uploadedAt: now };
      changed = true;
    }
  }
  if (changed) { _uploadOwnership = map; saveUploadOwnership(map); }
}

// 清理磁盘上已不存在的文件的归属记录（仅实际清理后调用）
function pruneOwnershipManifest() {
  const map = loadUploadOwnership();
  let changed = false;
  for (const rp of Object.keys(map)) {
    if (!fs.existsSync(path.join(UPLOAD_DIR, rp))) {
      delete map[rp];
      changed = true;
    }
  }
  if (changed) { _uploadOwnership = map; saveUploadOwnership(map); }
}

// 为"上线前上传、无归属记录"的历史文件自动补写归属（幂等）
// 依据：文件被哪张记录引用（含软删记录）来决定归属部门
//  - 被"有效记录"引用 → 取该记录部门（最可靠）
//  - 仅被"软删记录"引用 → 取最近被删记录的部门（次可靠）
//  - 被多条不同部门记录同时引用 → 判定为冲突，不自动归属（保持仅系统管理员可清理）
//  - 无任何引用（真孤儿） → 无法推断，不做归属（仅系统管理员可清理）
function backfillUploadOwnership({ dryRun = false } = {}) {
  const map = loadUploadOwnership();
  const files = scanUploadDir();

  // relPath -> Set<dept>（有效记录）
  const activeDepts = new Map();
  // relPath -> { dept, deletedAt }（软删记录中最近删除的那条）
  const recentDeleted = new Map();

  const considerReferences = (field, rows) => {
    for (const row of rows) {
      const isDeleted = !!row.deleted_at;
      // 从图片字段(逗号分隔)与附件字段(JSON)中提取相对路径
      const rawVal = row[field] ?? '';
      let paths = [];
      if (field === 'attachments') {
        paths = parseAttachmentPaths(rawVal);
      } else {
        paths = String(rawVal).split(',').map(p => p.trim()).filter(p => p);
      }
      for (const p of paths) {
        const rel = String(p).replace(/^\/uploads\//, '');
        if (!rel) continue;
        if (!isDeleted) {
          const s = activeDepts.get(rel) || new Set();
          s.add(row.department || '');
          activeDepts.set(rel, s);
        } else {
          const cur = recentDeleted.get(rel);
          if (!cur || String(row.deleted_at) > String(cur.deletedAt)) {
            recentDeleted.set(rel, { dept: row.department || '', deletedAt: row.deleted_at });
          }
        }
      }
    }
  };

  for (const { table, field } of IMAGE_TABLES) {
    try {
      const rows = db.prepare(`SELECT id, department, deleted_at, ${field} FROM ${table}`).all();
      considerReferences(field, rows);
    } catch (e) { /* ignore */ }
  }
  for (const { table, field } of ATTACHMENT_TABLES) {
    try {
      const rows = db.prepare(`SELECT id, department, deleted_at, ${field} FROM ${table}`).all();
      considerReferences(field, rows);
    } catch (e) { /* ignore */ }
  }

  let skiptExisting = 0, autoAssigned = 0, conflict = 0, trueOrphan = 0;
  const assignedSample = [];
  for (const f of files) {
    const rel = f.relPath;
    if (map[rel]) { skiptExisting++; continue; }
    const actives = activeDepts.get(rel);
    const deleted = recentDeleted.get(rel);
    if (actives && actives.size === 1) {
      const dept = [...actives][0];
      if (!dryRun) {
        map[rel] = { department: dept, name: '[自动回填]', uploadedAt: new Date().toISOString(), backfilled: true };
      }
      autoAssigned++;
      if (assignedSample.length < 100) assignedSample.push({ path: rel, department: dept, source: 'active' });
      continue;
    }
    if (actives && actives.size > 1) { conflict++; continue; }
    if (deleted) {
      if (!dryRun) {
        map[rel] = { department: deleted.dept, name: '[自动回填]', uploadedAt: new Date().toISOString(), backfilled: true };
      }
      autoAssigned++;
      if (assignedSample.length < 100) assignedSample.push({ path: rel, department: deleted.dept, source: 'deleted' });
      continue;
    }
    trueOrphan++;
  }

  if (!dryRun) {
    _uploadOwnership = map;
    saveUploadOwnership(map);
  }

  return { scanned: files.length, skiptExisting, autoAssigned, conflict, trueOrphan, assignedSample };
}

// ─── 数据库初始化 ─────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      department TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'active',
      must_change_pwd INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 认证令牌表
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 登录日志
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      employee_id TEXT,
      name TEXT,
      action TEXT,
      login_time TEXT DEFAULT (datetime('now', 'localtime')),
      ip_address TEXT
    );
  `);

  // 部门表
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 角色级权限表
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      module TEXT NOT NULL,
      can_view INTEGER DEFAULT 1,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      UNIQUE(role, module)
    );
  `);

  // 用户级权限表（覆盖角色权限）
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module TEXT NOT NULL,
      can_view INTEGER DEFAULT 0,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      UNIQUE(user_id, module),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 机台近期交接
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT DEFAULT '',
      machine_name TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT 'idle',
      area TEXT DEFAULT '',
      process TEXT DEFAULT '',
      process_status TEXT DEFAULT 'pending',
      shift TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      alarm_info TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      attachments TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // 机台长期交接
  db.exec(`
    CREATE TABLE IF NOT EXISTS lt_machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT DEFAULT '',
      machine_name TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT 'idle',
      area TEXT DEFAULT '',
      process TEXT DEFAULT '',
      process_status TEXT DEFAULT 'pending',
      shift TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      alarm_info TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      attachments TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // LOT 交接
  db.exec(`
    CREATE TABLE IF NOT EXISTS lot_handovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      detail TEXT DEFAULT '',
      comment TEXT DEFAULT '',
      follow_up TEXT DEFAULT '',
      follow_up_images TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      attachments TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // 交接签到表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sign_in_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_time TEXT DEFAULT '',
      location TEXT DEFAULT '',
      host TEXT DEFAULT '',
      attendees TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // 值班问题
  db.exec(`
    CREATE TABLE IF NOT EXISTS duty_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category1 TEXT DEFAULT '',
      category2 TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      problem_process TEXT DEFAULT '',
      solution TEXT DEFAULT '',
      owner_confirm TEXT DEFAULT '',
      attachments TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // 其他交接
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_handovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium',
      category TEXT DEFAULT 'other',
      status TEXT DEFAULT 'open',
      created_by TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      attachments TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // AR 交接
  db.exec(`
    CREATE TABLE IF NOT EXISTS ar_handovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT DEFAULT '',
      ar TEXT DEFAULT '',
      owner_section TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      deleted_at TEXT
    );
  `);

  // 创建默认管理员
  const admin = db.prepare('SELECT id FROM users WHERE employee_id = ?').get('admin');
  if (!admin) {
    const hashed = bcrypt.hashSync('admin123', SALT_ROUNDS);
    db.prepare('INSERT INTO users (employee_id, name, password, department, role, status, must_change_pwd) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('admin', '系统管理员', hashed, '', 'admin', 'active', 0);
    console.log('[初始化] 默认管理员已创建（工号: admin）');
  }

  // 初始化默认部门
  const deptCount = db.prepare('SELECT COUNT(*) as c FROM departments').get().c;
  if (deptCount === 0) {
    const stmt = db.prepare('INSERT INTO departments (name, description, sort_order) VALUES (?, ?, ?)');
    stmt.run('生产一部', 'FAB产线一部', 1);
    stmt.run('生产二部', 'FAB产线二部', 2);
    stmt.run('设备工程部', '设备维护与工程', 3);
    stmt.run('工艺工程部', '工艺与制程', 4);
  }

  // 初始化角色权限（admin 全权限；dept_admin/editor 可查改不可删；viewer 只读）
  const permCount = db.prepare('SELECT COUNT(*) as c FROM role_permissions').get().c;
  if (permCount === 0) {
    const stmt = db.prepare('INSERT INTO role_permissions (role, module, can_view, can_edit, can_delete) VALUES (?, ?, ?, ?, ?)');
    for (const role of ROLES) {
      for (const mod of MODULES) {
        if (role === 'admin') {
          stmt.run(role, mod, 1, 1, 1);
        } else if (role === 'dept_admin') {
          stmt.run(role, mod, 1, 1, 0);
        } else if (role === 'editor') {
          stmt.run(role, mod, 1, 1, 0);
        } else {
          stmt.run(role, mod, 1, 0, 0);
        }
      }
    }
  }

  // 部门归属字段迁移：为各业务表增加 department 列（幂等）
  const deptTables = ['machines', 'lt_machines', 'lot_handovers', 'sign_in_sheets', 'duty_issues', 'daily_handovers', 'ar_handovers'];
  for (const t of deptTables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === 'department')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN department TEXT DEFAULT ''`);
      console.log(`[迁移] 已为 ${t} 表增加 department 字段`);
    }
  }

  // created_by 字段迁移：为 lot_handovers 增加创建人列（幂等）
  const createdByTables = ['lot_handovers'];
  for (const t of createdByTables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === 'created_by')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN created_by TEXT DEFAULT ''`);
      console.log(`[迁移] 已为 ${t} 表增加 created_by 字段`);
    }
  }

  // attachments 字段迁移：为各业务表增加附件列（幂等）
  const attachmentTables = ['machines', 'lt_machines', 'lot_handovers', 'duty_issues', 'daily_handovers'];
  for (const t of attachmentTables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === 'attachments')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN attachments TEXT DEFAULT ''`);
      console.log(`[迁移] 已为 ${t} 表增加 attachments 字段`);
    }
  }

  // archived_at 字段迁移：为各业务表增加归档时间列（幂等，用于临时隐藏记录）
  const archiveTables = ['machines', 'lt_machines', 'lot_handovers', 'sign_in_sheets', 'duty_issues', 'daily_handovers', 'ar_handovers'];
  for (const t of archiveTables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === 'archived_at')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN archived_at TEXT`);
      console.log(`[迁移] 已为 ${t} 表增加 archived_at 字段`);
    }
  }
}

initDb();

// ─── Express 应用 ─────────────────────────────────────
const app = express();

// CORS：同源应用默认禁止跨域（页面同源请求不受影响）；如需跨域调用，用环境变量 ALLOWED_ORIGINS 配置白名单（逗号分隔）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // 同源/非浏览器请求，不受 CORS 限制
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // 不在白名单的跨域来源：不返回 CORS 头（浏览器将拦截）
  }
}));
// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

// 静态文件
// 开发期优化：静态资源不缓存，避免前端修改后浏览器仍加载旧版本（须置于 express.static 之前生效）
app.use((req, res, next) => {
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/lib/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ─── 文件上传配置 ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = path.join(UPLOAD_DIR, 'machines');
    // 根据 URL 路径决定子目录
    const url = req.originalUrl;
    if (url.includes('long-term-machines')) dir = path.join(UPLOAD_DIR, 'lt_machines');
    else if (url.includes('lot-handovers')) dir = path.join(UPLOAD_DIR, 'lot_handovers');
    else if (url.includes('duty-issues')) dir = path.join(UPLOAD_DIR, 'duty_issues');
    else if (url.includes('daily-handovers')) dir = path.join(UPLOAD_DIR, 'daily_handovers');
    else dir = path.join(UPLOAD_DIR, 'machines');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // 从 URL 提取模块目录名，如 /api/machines/upload -> machines
    const segs = req.originalUrl.replace(/^\/api\//, '').split('/');
    const prefix = (segs[0] || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'img';
    const ext = path.extname(file.originalname) || '.png';
    const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('不支持的文件格式'));
  }
});

// 附件上传（通用文件，2MB 限制）
const attachUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB per file
  fileFilter: (req, file, cb) => {
    // 禁止执行类文件，其他都允许
    const dangerous = /\.(exe|bat|cmd|sh|js|vbs|ps1|msi|dll|so|dylib|apk|jar)$/i;
    if (dangerous.test(file.originalname)) {
      cb(new Error('不支持的文件类型（安全限制）'));
    } else {
      cb(null, true);
    }
  }
});

// ─── 工具函数 ─────────────────────────────────────────
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, t.created_at AS token_created_at FROM users u
    JOIN auth_tokens t ON t.user_id = u.id
    WHERE t.token = ? AND u.status = 'active'
  `).get(token);
  if (!row) return null;
  // 滑动窗口超时校验（created_at 为服务器本地时间，与 JS 本地时间一致）
  if (tokenAgeHours(row.token_created_at) >= SESSION_MAX_HOURS) return null;
  return row;
}

// 令牌创建时间（本地时区字符串 "YYYY-MM-DD HH:MM:SS"）距当前的时长（小时）
function tokenAgeHours(createdAtLocal) {
  const [d, t] = String(createdAtLocal || '').split(' ');
  if (!d || !t) return Infinity;
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m, s] = t.split(':').map(Number);
  const created = new Date(Y, M - 1, D, h, m, s);
  if (Number.isNaN(created.getTime())) return Infinity;
  return (Date.now() - created.getTime()) / 3600000;
}

function logLogin(userId, employeeId, name, action, ip) {
  db.prepare('INSERT INTO login_logs (user_id, employee_id, name, action, ip_address) VALUES (?, ?, ?, ?, ?)')
    .run(userId || null, employeeId || '', name || '', action, ip || '');
}

// ─── 登录限流（防暴力破解）───────────────────────────
// 返回剩余锁定秒数；0 表示未锁定
function loginLockRemain(key) {
  const rec = loginAttempts.get(key);
  if (rec && rec.lockUntil && rec.lockUntil > Date.now()) {
    return Math.ceil((rec.lockUntil - Date.now()) / 1000);
  }
  return 0;
}
// 记录一次失败；达到阈值即触发锁定
function recordLoginFail(key) {
  const rec = loginAttempts.get(key) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockUntil = Date.now() + LOCKOUT_WINDOW_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}
// 登录成功清除计数
function recordLoginSuccess(key) {
  loginAttempts.delete(key);
}

function getRolePermissions(role) {
  const rows = db.prepare('SELECT * FROM role_permissions WHERE role = ?').all(role);
  const result = {};
  for (const r of rows) {
    result[r.module] = { view: !!r.can_view, edit: !!r.can_edit, delete: !!r.can_delete };
  }
  return result;
}

function getUserPermissions(userId, role) {
  if (role === 'admin') {
    // 管理员拥有所有权限
    const result = {};
    for (const mod of MODULES) result[mod] = { view: true, edit: true, delete: true };
    return result;
  }
  // 先取角色权限
  const rolePerms = getRolePermissions(role);
  // 再覆盖用户级权限
  const userPerms = db.prepare('SELECT * FROM user_permissions WHERE user_id = ?').all(userId);
  const userPermMap = {};
  for (const up of userPerms) userPermMap[up.module] = up;

  const result = {};
  for (const mod of MODULES) {
    if (userPermMap[mod]) {
      result[mod] = { view: !!userPermMap[mod].can_view, edit: !!userPermMap[mod].can_edit, delete: !!userPermMap[mod].can_delete };
    } else {
      result[mod] = rolePerms[mod] || { view: false, edit: false, delete: false };
    }
  }
  return result;
}

// ─── 部门隔离辅助函数 ────────────────────────────────
function isAdminUser(req) {
  return req.user && req.user.role === 'admin';
}

// 返回部门过滤 SQL 片段（admin 不过滤；「公共」/空部门记录为公共记录，所有部门可见）
function deptWhere(req, col = 'department') {
  if (isAdminUser(req)) return '';
  return ` AND (${col} = ? OR ${col} = '公共' OR TRIM(IFNULL(${col}, '')) = '')`;
}

// 返回部门过滤参数数组（admin 为空）
function deptParam(req) {
  return isAdminUser(req) ? [] : [req.user.department];
}

// ─── 认证中间件 ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: '未登录或会话过期' });
  req.user = user;
  req.token = token;

  // 首次登录强制改密：仅放行改密/登出/会话/权限相关接口，其余一律拦截
  if (user.must_change_pwd) {
    const allowList = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/session', '/api/auth/permissions'];
    if (!allowList.includes(req.path)) {
      return res.status(403).json({ error: '首次登录请先修改初始密码', mustChangePwd: true });
    }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无操作权限' });
    next();
  };
}

function checkModulePermission(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (req.user.role === 'admin') return next();
    const perms = getUserPermissions(req.user.id, req.user.role);
    const perm = perms[module];
    if (!perm || !perm[action]) return res.status(403).json({ error: '无操作权限' });
    next();
  };
}

// ─── 认证路由 ─────────────────────────────────────────
// 健康检查（无需鉴权，供监控/负载均衡探活）
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: (() => { try { db.prepare('SELECT 1').get(); return 'ok'; } catch (e) { return 'error'; } })() });
});

app.post('/api/auth/login', (req, res) => {
  const { employee_id, password } = req.body;
  if (!employee_id || !password) return res.status(400).json({ error: '请输入工号和密码' });

  // 限流：同一 IP+工号 连续失败过多则锁定
  const lockKey = `${req.ip}:${employee_id}`;
  const remain = loginLockRemain(lockKey);
  if (remain > 0) {
    // 锁定期间也不再验证，直接拒绝并提示
    const mins = Math.ceil(remain / 60);
    return res.status(429).json({ error: `登录失败次数过多，请 ${mins} 分钟后重试` });
  }

  const user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employee_id);
  const valid = user && bcrypt.compareSync(password, user.password);
  // 统一错误提示，避免暴露工号是否存在（防用户枚举）
  if (!user || user.status !== 'active' || !valid) {
    recordLoginFail(lockKey);
    if (user && user.status !== 'active') {
      return res.status(403).json({ error: '账号已禁用' });
    }
    return res.status(401).json({ error: '工号或密码错误' });
  }
  recordLoginSuccess(lockKey);

  const token = genToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)').run(token, user.id);
  logLogin(user.id, user.employee_id, user.name, 'login', req.ip);

  const { password: _, ...safeUser } = user;
  res.json({
    token,
    user: safeUser,
    mustChangePwd: !!user.must_change_pwd
  });
});

app.get('/api/auth/session', authMiddleware, (req, res) => {
  const { password: _, ...safeUser } = req.user;
  res.json({ user: safeUser });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(req.token);
  logLogin(req.user.id, req.user.employee_id, req.user.name, 'logout', req.ip);
  res.json({ success: true });
});

app.get('/api/auth/permissions', authMiddleware, (req, res) => {
  const perms = getUserPermissions(req.user.id, req.user.role);
  res.json({ permissions: perms });
});

app.put('/api/auth/change-password', authMiddleware, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '请填写完整' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });
  if (new_password.length > 64) return res.status(400).json({ error: '新密码过长' });

  const valid = bcrypt.compareSync(old_password, req.user.password);
  if (!valid) return res.status(400).json({ error: '旧密码错误' });
  if (old_password === new_password) return res.status(400).json({ error: '新密码不能与旧密码相同' });

  const hashed = bcrypt.hashSync(new_password, SALT_ROUNDS);
  db.prepare('UPDATE users SET password = ?, must_change_pwd = 0 WHERE id = ?').run(hashed, req.user.id);
  res.json({ message: '密码修改成功' });
});

// ─── 用户管理路由 ──────────────────────────────────────
app.get('/api/users', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  let users;
  if (req.user.role === 'dept_admin') {
    users = db.prepare('SELECT id, employee_id, name, department, role, status, created_at FROM users WHERE department = ? OR id = ? ORDER BY id').all(req.user.department, req.user.id);
  } else {
    users = db.prepare('SELECT id, employee_id, name, department, role, status, created_at FROM users ORDER BY id').all();
  }
  res.json(users);
});

app.post('/api/users', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const { employee_id, name, department, password, role, status } = req.body;
  if (!employee_id || !name) return res.status(400).json({ error: '工号和姓名必填' });
  if (!password) return res.status(400).json({ error: '请设置密码' });

  const exists = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(employee_id);
  if (exists) return res.status(400).json({ error: '工号已存在' });

  const finalRole = req.user.role === 'dept_admin' ? 'viewer' : (role || 'viewer');

  // 部门管理员唯一性校验：同一部门最多一位部门管理员
  if (finalRole === 'dept_admin') {
    const dept = (department || '').trim();
    if (!dept) return res.status(400).json({ error: '部门管理员必须归属部门，请为该员工指定部门' });
    const existsDeptAdmin = db.prepare('SELECT id FROM users WHERE department = ? AND role = ?').get(dept, 'dept_admin');
    if (existsDeptAdmin) return res.status(400).json({ error: `部门“${dept}”已有一位部门管理员，无法再新增部门管理员` });
  }

  const hashed = bcrypt.hashSync(password, SALT_ROUNDS);
  const info = db.prepare('INSERT INTO users (employee_id, name, password, department, role, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employee_id, name, hashed, department || '', finalRole, status || 'active');
  res.json({ id: info.lastInsertRowid });
});

// 批量导入用户（通过表格上传）
app.post('/api/users/import', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: '没有可导入的数据' });
  if (rows.length > 500) return res.status(400).json({ error: '单次最多导入 500 条' });

  const me = req.user;
  const isDeptAdmin = me.role === 'dept_admin';
  const myDept = (me.department || '').trim();
  // 批量导入不允许创建系统管理员（仅系统默认 admin 账号保留该角色）
  const VALID_ROLES = ['viewer', 'editor', 'dept_admin'];
  const DEPT_ADMIN_ROLES = ['viewer', 'editor']; // 部门管理员只能在本部门内创建普通使用者

  const results = [];
  let succCount = 0;
  const seen = new Set();

  const findUser = db.prepare('SELECT id FROM users WHERE employee_id = ?');
  const findDept = db.prepare('SELECT name FROM departments WHERE name = ?');
  const insert = db.prepare('INSERT INTO users (employee_id, name, password, department, role, status, must_change_pwd) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const hashedDefault = bcrypt.hashSync('123456', SALT_ROUNDS); // 未填密码时的默认密码

  const fail = (lineNo, employee_id, name, message) => {
    results.push({ lineNo, employee_id, name, status: 'fail', message });
  };
  const ok = (lineNo, employee_id, name) => {
    results.push({ lineNo, employee_id, name, status: 'ok', message: '导入成功' });
  };

  rows.forEach((r, idx) => {
    const lineNo = idx + 2; // 表头占第 1 行，数据从第 2 行开始
    const employee_id = String(r.employee_id ?? '').trim();
    const name = String(r.name ?? '').trim();
    const departmentRaw = String(r.department ?? '').trim();
    const roleRaw = String(r.role ?? '').trim();
    const passwordRaw = String(r.password ?? '').trim();

    // 1. 必填校验
    if (!employee_id) return fail(lineNo, '', name, `第${lineNo}行：工号不能为空`);
    if (!name) return fail(lineNo, employee_id, '', `第${lineNo}行：工号 ${employee_id} 的姓名为空`);

    // 2. 文件内重复工号
    if (seen.has(employee_id)) return fail(lineNo, employee_id, name, `第${lineNo}行：工号 ${employee_id} 在本文件中重复`);
    seen.add(employee_id);

    // 3. 数据库重号
    if (findUser.get(employee_id)) return fail(lineNo, employee_id, name, `第${lineNo}行：工号 ${employee_id} 已存在`);

    // 4. 部门校验
    let department;
    if (isDeptAdmin) {
      // 部门管理员：只能导入本部门人员；其他部门一律拒绝
      if (departmentRaw && departmentRaw !== myDept) {
        return fail(lineNo, employee_id, name, `第${lineNo}行：你是部门管理员，不能导入其他部门（${departmentRaw}）的人员${employee_id ? '（' + employee_id + '）' : ''}`);
      }
      department = myDept; // 未填部门或不符时强制归本部门
    } else {
      // 系统管理员：部门必须存在于部门表（留空表示无部门）
      if (departmentRaw && !findDept.get(departmentRaw)) {
        return fail(lineNo, employee_id, name, `第${lineNo}行：部门“${departmentRaw}”不存在，请先在部门管理中添加`);
      }
      department = departmentRaw;
    }

    // 5. 角色校验
    let role = 'viewer';
    if (roleRaw) {
      if (isDeptAdmin) {
        if (!DEPT_ADMIN_ROLES.includes(roleRaw)) {
          return fail(lineNo, employee_id, name, `第${lineNo}行：部门管理员只能导入查看者/编辑者角色（当前为“${roleRaw}”），已拒绝`);
        }
        role = roleRaw;
      } else {
        if (!VALID_ROLES.includes(roleRaw)) {
          return fail(lineNo, employee_id, name, `第${lineNo}行：角色“${roleRaw}”非法（可选：viewer/editor/dept_admin），已拒绝`);
        }
        role = roleRaw;
      }
    }

    // 5.1 部门管理员唯一性校验（每部门仅一位部门管理员）
    if (role === 'dept_admin') {
      if (!department) {
        return fail(lineNo, employee_id, name, `第${lineNo}行：部门管理员必须归属部门，请为该员工指定部门`);
      }
      const existsDeptAdmin = db.prepare('SELECT id FROM users WHERE department = ? AND role = ?').get(department, 'dept_admin');
      if (existsDeptAdmin) {
        return fail(lineNo, employee_id, name, `第${lineNo}行：部门“${department}”已有一位部门管理员，无法再导入部门管理员`);
      }
    }

    // 6. 插入（密码留空则默认 123456 并强制首次登录改密）
    try {
      let hashed = hashedDefault;
      let mustChange = 1;
      if (passwordRaw) {
        hashed = bcrypt.hashSync(passwordRaw, SALT_ROUNDS);
        mustChange = 0;
      }
      insert.run(employee_id, name, hashed, department, role, 'active', mustChange);
      succCount++;
      ok(lineNo, employee_id, name);
    } catch (e) {
      console.error(`[导入] 插入 ${employee_id} 失败:`, e.message);
      // 不向前端泄露底层异常原文，给出统一友好提示
      const reason = /UNIQUE/i.test(e.message) ? '工号已存在或存在重复' : '数据保存失败';
      fail(lineNo, employee_id, name, `第${lineNo}行：${reason}`);
    }
  });

  const failedCount = results.filter(x => x.status === 'fail').length;
  res.json({ success: succCount, failed: failedCount, results });
});

app.put('/api/users/:id', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });

  const { name, department, employee_id, role, status, password } = req.body;
  const updates = [];
  const params = [];

  // 部门管理员不能修改管理员角色用户的任何字段
  const isDeptAdmin = req.user.role === 'dept_admin';
  if (isDeptAdmin) {
    if (u.role === 'admin' || u.role === 'dept_admin') {
      return res.status(403).json({ error: '部门管理员无权修改管理员用户' });
    }
    // 部门管理员只能修改本部门用户
    if ((req.user.department || '').trim() !== (u.department || '').trim()) {
      return res.status(403).json({ error: '部门管理员只能修改本部门的用户' });
    }
  }

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (department !== undefined && !isDeptAdmin) { updates.push('department = ?'); params.push(department); }
  if (employee_id !== undefined && req.user.role === 'admin') { updates.push('employee_id = ?'); params.push(employee_id); }
  if (role !== undefined && req.user.role === 'admin') { updates.push('role = ?'); params.push(role); }
  if (status !== undefined && req.user.role === 'admin') { updates.push('status = ?'); params.push(status); }
  if (password) { updates.push('password = ?'); params.push(bcrypt.hashSync(password, SALT_ROUNDS)); }

  // 部门管理员唯一性校验：改角色为 dept_admin 或改部门时，确保目标部门最多一位部门管理员（排除自身）
  const targetRole = (role !== undefined && req.user.role === 'admin') ? role : u.role;
  const targetDept = (department !== undefined && !isDeptAdmin) ? department : u.department;
  if (targetRole === 'dept_admin') {
    const dept = (targetDept || '').trim();
    if (!dept) return res.status(400).json({ error: '部门管理员必须归属部门，请为该员工指定部门' });
    const existsDeptAdmin = db.prepare('SELECT id FROM users WHERE department = ? AND role = ?').get(dept, 'dept_admin');
    if (existsDeptAdmin && existsDeptAdmin.id !== id) {
      return res.status(400).json({ error: `部门“${dept}”已有一位部门管理员，无法重复设置` });
    }
  }

  if (updates.length === 0) return res.json({ success: true });
  params.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

app.delete('/api/users/:id', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.employee_id === 'admin') return res.status(400).json({ error: '不能删除默认管理员' });
  // 部门管理员不能删除管理员角色的用户
  if (req.user.role === 'dept_admin' && (u.role === 'admin' || u.role === 'dept_admin')) {
    return res.status(403).json({ error: '部门管理员无权删除管理员用户' });
  }
  // 部门管理员只能删除本部门用户
  if (req.user.role === 'dept_admin' && (req.user.department || '').trim() !== (u.department || '').trim()) {
    return res.status(403).json({ error: '部门管理员只能删除本部门的用户' });
  }

  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

app.put('/api/users/:id/role', authMiddleware, requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body;
  if (!ROLES.includes(role)) return res.status(400).json({ error: '无效角色' });

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.employee_id === 'admin') return res.status(400).json({ error: '不能修改默认管理员角色' });
  if (id === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  res.json({ role });
});

app.put('/api/users/:id/transfer-dept', authMiddleware, requireRole('dept_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { department } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 部门管理员不能转移管理员角色的用户，且只能在本部门内操作
  if (u.role === 'admin' || u.role === 'dept_admin') {
    return res.status(403).json({ error: '部门管理员无权转移管理员用户' });
  }
  // 部门管理员只能转移本部门的用户，且目标部门必须等于本部门（不允许跨部门调动）
  const targetDept = (department || '').trim();
  const myDept = (req.user.department || '').trim();
  if ((u.department || '').trim() !== myDept) {
    return res.status(403).json({ error: '部门管理员只能操作本部门的用户' });
  }
  if (targetDept && targetDept !== myDept) {
    return res.status(403).json({ error: '部门管理员不能将用户调到其他部门' });
  }
  db.prepare('UPDATE users SET department = ? WHERE id = ?').run(targetDept || myDept, id);
  res.json({ success: true });
});

// 用户级权限
app.get('/api/users/:id/permissions', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });

  // 部门管理员只能读取本部门用户的权限
  if (req.user.role === 'dept_admin' && (req.user.department || '').trim() !== (u.department || '').trim()) {
    return res.status(403).json({ error: '部门管理员只能查看本部门的用户权限' });
  }

  const rolePerms = getRolePermissions(u.role);
  const userPerms = db.prepare('SELECT * FROM user_permissions WHERE user_id = ?').all(id);
  const userPermMap = {};
  for (const up of userPerms) userPermMap[up.module] = up;

  const permissions = {};
  for (const mod of MODULES) {
    if (userPermMap[mod]) {
      permissions[mod] = { view: !!userPermMap[mod].can_view, edit: !!userPermMap[mod].can_edit, delete: !!userPermMap[mod].can_delete, custom: true };
    } else {
      permissions[mod] = { ...rolePerms[mod], custom: false };
    }
  }
  res.json({ role: u.role, userName: u.name, permissions });
});

app.put('/api/users/:id/permissions', authMiddleware, requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '权限数据格式错误' });

  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  const stmt = db.prepare('INSERT INTO user_permissions (user_id, module, can_view, can_edit, can_delete) VALUES (?, ?, ?, ?, ?)');
  for (const p of permissions) {
    stmt.run(id, p.module, p.can_view ? 1 : 0, p.can_edit ? 1 : 0, p.can_delete ? 1 : 0);
  }
  res.json({ success: true });
});

// ─── 角色权限路由 ──────────────────────────────────────
app.get('/api/permissions', authMiddleware, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM role_permissions ORDER BY role, module').all();
  res.json(rows.map(r => ({
    id: r.id, role: r.role, module: r.module,
    can_view: r.can_view, can_edit: r.can_edit, can_delete: r.can_delete
  })));
});

app.put('/api/permissions', authMiddleware, requireRole('admin'), (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '权限数据格式错误' });

  const stmt = db.prepare(`
    INSERT INTO role_permissions (role, module, can_view, can_edit, can_delete)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(role, module) DO UPDATE SET can_view = ?, can_edit = ?, can_delete = ?
  `);
  for (const p of permissions) {
    stmt.run(p.role, p.module, p.can_view ? 1 : 0, p.can_edit ? 1 : 0, p.can_delete ? 1 : 0,
      p.can_view ? 1 : 0, p.can_edit ? 1 : 0, p.can_delete ? 1 : 0);
  }
  res.json({ success: true });
});

// ─── 部门路由 ─────────────────────────────────────────
app.get('/api/departments', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY sort_order, id').all();
  res.json(rows);
});

app.post('/api/departments', authMiddleware, requireRole('admin'), (req, res) => {
  const { name, description, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: '部门名称必填' });
  try {
    const info = db.prepare('INSERT INTO departments (name, description, sort_order) VALUES (?, ?, ?)')
      .run(name, description || '', sort_order || 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '部门名称已存在' });
  }
});

app.put('/api/departments/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const { name, description, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: '部门名称必填' });
  try {
    db.prepare('UPDATE departments SET name = ?, description = ?, sort_order = ? WHERE id = ?')
      .run(name, description || '', sort_order || 0, id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '部门名称已存在' });
  }
});

app.delete('/api/departments/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  res.json({ success: true });
});

// ─── 登录日志路由 ──────────────────────────────────────
app.get('/api/login-logs', authMiddleware, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM login_logs ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
});

// ─── 仪表盘路由 ───────────────────────────────────────
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const totalMachines = db.prepare(`SELECT COUNT(*) as c FROM machines WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalLtMachines = db.prepare(`SELECT COUNT(*) as c FROM lt_machines WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalLots = db.prepare(`SELECT COUNT(*) as c FROM lot_handovers WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalSignIns = db.prepare(`SELECT COUNT(*) as c FROM sign_in_sheets WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;

  const machineStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM machines
    WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)} GROUP BY status
  `).all(...deptParam(req));

  const recentLots = db.prepare(`
    SELECT id, lot_id, detail, updated_at FROM lot_handovers
    WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)} ORDER BY updated_at DESC LIMIT 10
  `).all(...deptParam(req));

  res.json({ totalMachines, totalLtMachines, totalLots, totalSignIns, machineStats, recentLots });
});

// ══════════════════════════════════════════════════════
//  通用 CRUD 工厂
//  为 7 个业务模块生成标准 CRUD + 批量操作 + 回收站路由
// ══════════════════════════════════════════════════════

/**
 * 为业务模块注册完整的 CRUD 路由
 * @param {Object} opts 配置
 * @param {string} opts.basePath  路由前缀，如 /api/machines
 * @param {string} opts.table     数据库表名
 * @param {string} opts.module    权限模块名
 * @param {string[]} opts.fields  允许创建/更新的字段
 * @param {boolean} opts.hasBatchStatus 是否支持批量更新 process_status
 */
function registerCrudRoutes(opts) {
  const { basePath, table, module, fields, hasBatchStatus, hasCreatedBy } = opts;

  // 读取该表实际存在的列，写入前过滤，避免因数据库 schema 漂移（如缺少某列）导致 INSERT/UPDATE 对所有人全部失败
  const tableCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));

  // 列表（排除已删除和已归档）
  app.get(basePath, authMiddleware, checkModulePermission(module, 'view'), (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)} ORDER BY id DESC`).all(...deptParam(req));
    res.json(rows);
  });

  // 新增
  app.post(basePath, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    try {
      const data = {};
      for (const f of fields) {
        // 仅写入真实存在的列，过滤客户端可能携带的非法/缺失字段
        if (req.body[f] !== undefined && tableCols.has(f)) data[f] = req.body[f];
      }
      // 部门隔离：非 admin 由服务端强制写入归属部门，禁止客户端篡改；admin 创建默认归属「公共」
      if (tableCols.has('department')) {
        data.department = isAdminUser(req) ? (req.body.department !== undefined ? req.body.department : '公共') : req.user.department;
      }
      // 自动填充创建人
      if (hasCreatedBy && tableCols.has('created_by')) {
        data.created_by = req.user.name || '';
      }
      const cols = Object.keys(data);
      if (cols.length === 0) return res.status(400).json({ error: `无有效字段，允许的字段: ${fields.join(', ')}` });

      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map(c => data[c] !== undefined ? data[c] : '');
      const colList = cols.join(', ');

      const info = db.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`).run(...values);
      res.json({ id: info.lastInsertRowid });
    } catch (e) {
      console.error(`[错误] 新增${table}失败:`, e.message);
      res.status(400).json({ error: `新增失败：${e.message}` });
    }
  });

  // 更新
  app.put(`${basePath}/:id`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = {};
      for (const f of fields) {
        if (req.body[f] !== undefined && tableCols.has(f)) data[f] = req.body[f];
      }
      const cols = Object.keys(data);
      if (cols.length === 0) return res.status(400).json({ error: `无有效字段，允许的字段: ${fields.join(', ')}` });

      const setClause = cols.map(c => `${c} = ?`).join(', ');
      const values = cols.map(c => data[c]);
      values.push(id);
      values.push(...deptParam(req));

      const info = db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = datetime('now', 'localtime') WHERE id = ? AND deleted_at IS NULL${deptWhere(req)}`).run(...values);
      if (info.changes === 0) return res.status(404).json({ error: '记录不存在或无权限修改' });
      res.json({ success: true });
    } catch (e) {
      console.error(`[错误] 更新${table}失败:`, e.message);
      res.status(400).json({ error: `更新失败：${e.message}` });
    }
  });

  // 软删除
  app.delete(`${basePath}/:id`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: '无效的记录ID' });
    const info = db.prepare(`UPDATE ${table} SET deleted_at = datetime('now', 'localtime'), archived_at = NULL WHERE id = ? AND deleted_at IS NULL${deptWhere(req)}`).run(id, ...deptParam(req));
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在或无权操作' });
    res.json({ success: true });
  });

  // 恢复
  app.patch(`${basePath}/:id/restore`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id);
    const info = db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?${deptWhere(req)}`).run(id, ...deptParam(req));
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在或无权操作' });
    res.json({ success: true });
  });

  // 回收站列表
  app.get(`${basePath}/trash`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NOT NULL${deptWhere(req)} ORDER BY deleted_at DESC`).all(...deptParam(req));
    res.json(rows);
  });

  // 永久删除
  app.delete(`${basePath}/:id/permanent`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id);
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?${deptWhere(req)}`).run(id, ...deptParam(req));
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在或无权操作' });
    res.json({ success: true });
  });

  // 批量软删除
  app.post(`${basePath}/batch-delete`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
    const placeholders = ids.map(() => '?').join(', ');
    const info = db.prepare(`UPDATE ${table} SET deleted_at = datetime('now', 'localtime'), archived_at = NULL WHERE id IN (${placeholders}) AND deleted_at IS NULL${deptWhere(req)}`).run(...ids, ...deptParam(req));
    res.json({ changes: info.changes });
  });

  // ===== 归档功能（临时隐藏记录，不进回收站） =====

  // 单个/批量归档
  app.post(`${basePath}/batch-archive`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
    const placeholders = ids.map(() => '?').join(', ');
    const info = db.prepare(`UPDATE ${table} SET archived_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id IN (${placeholders}) AND deleted_at IS NULL AND archived_at IS NULL${deptWhere(req)}`).run(...ids, ...deptParam(req));
    res.json({ changes: info.changes });
  });

  // 撤销归档
  app.patch(`${basePath}/:id/unarchive`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id);
    const info = db.prepare(`UPDATE ${table} SET archived_at = NULL, updated_at = datetime('now', 'localtime') WHERE id = ? AND deleted_at IS NULL${deptWhere(req)}`).run(id, ...deptParam(req));
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在或无权操作' });
    res.json({ success: true });
  });

  // 批量撤销归档
  app.post(`${basePath}/batch-unarchive`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
    const placeholders = ids.map(() => '?').join(', ');
    const info = db.prepare(`UPDATE ${table} SET archived_at = NULL, updated_at = datetime('now', 'localtime') WHERE id IN (${placeholders}) AND deleted_at IS NULL AND archived_at IS NOT NULL${deptWhere(req)}`).run(...ids, ...deptParam(req));
    res.json({ changes: info.changes });
  });

  // 归档列表
  app.get(`${basePath}/archived`, authMiddleware, checkModulePermission(module, 'view'), (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND archived_at IS NOT NULL${deptWhere(req)} ORDER BY archived_at DESC`).all(...deptParam(req));
    res.json(rows);
  });

  // 批量恢复
  app.post(`${basePath}/batch-restore`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
    const placeholders = ids.map(() => '?').join(', ');
    const info = db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id IN (${placeholders})${deptWhere(req)}`).run(...ids, ...deptParam(req));
    res.json({ changes: info.changes });
  });

  // 批量更新处理状态
  if (hasBatchStatus) {
    app.post(`${basePath}/batch-update-status`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
      const { ids, process_status } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
      const placeholders = ids.map(() => '?').join(', ');
      const info = db.prepare(`UPDATE ${table} SET process_status = ?, updated_at = datetime('now', 'localtime') WHERE id IN (${placeholders}) AND deleted_at IS NULL${deptWhere(req)}`).run(process_status, ...ids, ...deptParam(req));
      res.json({ changes: info.changes, message: `成功更新 ${info.changes} 条记录` });
    });
  }

  // 图片文件头校验：读取文件真实格式，防止以伪装扩展名上传非图片文件
function sniffImageType(filepath) {
  const fd = fs.openSync(filepath, 'r');
  const buf = Buffer.alloc(16);
  let bytes = 0;
  try { bytes = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  if (bytes < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// 图片上传
app.post(`${basePath}/upload`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
  upload.array('images', 20)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: '未选择文件' });

    const saved = [];   // 已写入的正式路径
    const toDelete = []; // 需清理的临时文件
    for (const f of req.files) {
      const realType = sniffImageType(f.path);
      if (!realType) {
        toDelete.push(f.path);
        continue;
      }
      // 统一扩展名为真实类型
      let finalName = f.filename;
      const origExt = path.extname(finalName) || '';
      const safeExt = '.' + realType;
      if (origExt.toLowerCase() !== safeExt) {
        finalName = path.basename(finalName, origExt) + safeExt;
        fs.renameSync(f.path, path.join(path.dirname(f.path), finalName));
      }
      saved.push(`/uploads/${path.basename(path.dirname(f.path))}/${finalName}`);
    }

    // 清理被拒绝的伪装文件
    for (const p of toDelete) { try { fs.unlinkSync(p); } catch (e) {} }

    // 全部文件均非法则报错
    if (saved.length === 0) return res.status(400).json({ error: '上传的图片文件无效或不支持该格式' });

    // 记录文件归属部门（供部门管理员界定/清理本部门孤儿图片）
    recordUploadOwnership(saved, req);

    // 部分文件非法（理论上不多见），返回成功保存的路径并附带提示信息
    res.json({ paths: saved, skipped: toDelete.length ? toDelete.length : undefined });
  });
});

  // 附件上传
  app.post(`${basePath}/upload-attachment`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    attachUpload.array('files', 50)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: '未选择文件' });

      const saved = [];
      for (const f of req.files) {
        saved.push({
          path: `/uploads/${path.basename(path.dirname(f.path))}/${f.filename}`,
          name: f.originalname,
          size: f.size
        });
      }
      // 记录附件归属部门（供部门管理员界定/清理本部门孤儿附件）
      recordUploadOwnership(saved.map(s => s.path), req);
      res.json({ files: saved });
    });
  });
}

// ─── 注册各业务模块路由 ─────────────────────────────────

// 机台近期交接
registerCrudRoutes({
  basePath: '/api/machines',
  table: 'machines',
  module: 'machine',
  fields: ['machine_id', 'machine_name', 'status', 'area', 'process', 'process_status', 'shift', 'owner', 'alarm_info', 'remark', 'image_path', 'attachments'],
  hasBatchStatus: true
});

// 按 owner 删除机台
app.delete('/api/machines/owner/:owner', authMiddleware, checkModulePermission('machine', 'delete'), (req, res) => {
  const owner = decodeURIComponent(req.params.owner);
  const info = db.prepare(`UPDATE machines SET deleted_at = datetime('now', 'localtime') WHERE owner = ? AND deleted_at IS NULL${deptWhere(req)}`).run(owner, ...deptParam(req));
  res.json({ changes: info.changes });
});

// 按 name 删除机台
app.delete('/api/machines/name/:name', authMiddleware, checkModulePermission('machine', 'delete'), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const info = db.prepare(`UPDATE machines SET deleted_at = datetime('now', 'localtime') WHERE machine_name = ? AND deleted_at IS NULL${deptWhere(req)}`).run(name, ...deptParam(req));
  res.json({ changes: info.changes });
});

// 机台长期交接
registerCrudRoutes({
  basePath: '/api/long-term-machines',
  table: 'lt_machines',
  module: 'lt-machine',
  fields: ['machine_id', 'machine_name', 'status', 'area', 'process', 'process_status', 'shift', 'owner', 'alarm_info', 'remark', 'image_path', 'attachments'],
  hasBatchStatus: true
});

// 按 owner 删除长期机台
app.delete('/api/long-term-machines/owner/:owner', authMiddleware, checkModulePermission('lt-machine', 'delete'), (req, res) => {
  const owner = decodeURIComponent(req.params.owner);
  const info = db.prepare(`UPDATE lt_machines SET deleted_at = datetime('now', 'localtime') WHERE owner = ? AND deleted_at IS NULL${deptWhere(req)}`).run(owner, ...deptParam(req));
  res.json({ changes: info.changes });
});

app.delete('/api/long-term-machines/name/:name', authMiddleware, checkModulePermission('lt-machine', 'delete'), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const info = db.prepare(`UPDATE lt_machines SET deleted_at = datetime('now', 'localtime') WHERE machine_name = ? AND deleted_at IS NULL${deptWhere(req)}`).run(name, ...deptParam(req));
  res.json({ changes: info.changes });
});

// LOT 交接
registerCrudRoutes({
  basePath: '/api/lot-handovers',
  table: 'lot_handovers',
  module: 'lot-handover',
  fields: ['lot_id', 'status', 'detail', 'comment', 'follow_up', 'follow_up_images', 'created_by', 'attachments'],
  hasBatchStatus: false,
  hasCreatedBy: true
});

// 交接签到表
registerCrudRoutes({
  basePath: '/api/sign-in-sheets',
  table: 'sign_in_sheets',
  module: 'sign-in',
  fields: ['shift_time', 'location', 'host', 'attendees'],
  hasBatchStatus: false
});

// 值班问题
registerCrudRoutes({
  basePath: '/api/duty-issues',
  table: 'duty_issues',
  module: 'duty-issue',
  fields: ['category1', 'category2', 'image_path', 'problem_process', 'solution', 'owner_confirm', 'attachments'],
  hasBatchStatus: false
});

// 其他交接
registerCrudRoutes({
  basePath: '/api/daily-handovers',
  table: 'daily_handovers',
  module: 'daily-handover',
  fields: ['title', 'content', 'priority', 'category', 'status', 'created_by', 'due_date', 'image_path', 'attachments'],
  hasBatchStatus: false,
  hasCreatedBy: true
});

// AR 交接
registerCrudRoutes({
  basePath: '/api/ar-handovers',
  table: 'ar_handovers',
  module: 'ar-handover',
  fields: ['date', 'ar', 'owner_section', 'due_date', 'status'],
  hasBatchStatus: false
});

// ─── Excel 导出（一张总表，每个模块一个 Sheet） ─────────
// 导出范围：未删除记录（含已归档）；非 admin 仅导出本部门数据
const EXPORT_STATUS_MAP = {
  machine: { running: '运行中', down: '停机', idle: '待机', maintenance: '保养维护中', abnormal_pending: '异常待处理', repairing: '维修中', standby: '备用' },
  processStatus: { pending: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' },
  handover: { open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' },
  priority: { high: '高', medium: '中', low: '低' },
  category: { equipment: '设备', process: '工艺', quality: '质量', safety: '安全', other: '其他' },
  confirm: { confirmed: '已确认', unconfirmed: '未确认' },
  signInStatus: { present: '出席', late: '迟到', absent: '缺席', leave: '请假', night_shift: '夜班' }
};

// 去除富文本 HTML 标签
function exportStripHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim();
}

// 解析附件 JSON 为 {name, path} 列表
function exportAttachList(str) {
  try {
    const arr = JSON.parse(str || '[]');
    return Array.isArray(arr) ? arr.filter(a => a && a.path) : [];
  } catch (e) { return []; }
}

// 附件单元格占位标记：写入时替换为超链接（文本=附件名，链接=服务器文件地址）
function exportAttachCell(r) {
  return { __attach__: exportAttachList(r.attachments) };
}

// 各模块导出配置：sheet 名、SQL、行数据构造（返回普通单元格值数组 + 图片路径列表）
const EXPORT_MODULES = [
  {
    sheet: '机台近期交接', table: 'machines',
    sql: `SELECT * FROM machines WHERE deleted_at IS NULL`,
    columns: ['ID', '机台ID', '机台名称', '机台状态', '区域', '工艺', '处理状态', '班次', '负责人', '机台交接信息', '备注', '附件', '创建时间', '更新时间'],
    row: r => [
      r.id, r.machine_id, r.machine_name, EXPORT_STATUS_MAP.machine[r.status] || r.status || '', r.area, r.process,
      EXPORT_STATUS_MAP.processStatus[r.process_status] || r.process_status || '', r.shift, r.owner,
      exportStripHtml(r.alarm_info), exportStripHtml(r.remark), exportAttachCell(r), r.created_at, r.updated_at
    ],
    images: r => String(r.image_path || '').split(',').map(p => p.trim()).filter(Boolean)
  },
  {
    sheet: '机台长期交接', table: 'lt_machines',
    sql: `SELECT * FROM lt_machines WHERE deleted_at IS NULL`,
    columns: ['ID', '机台ID', '机台名称', '机台状态', '区域', '工艺', '处理状态', '班次', '负责人', '机台交接信息', '备注', '附件', '创建时间', '更新时间'],
    row: r => [
      r.id, r.machine_id, r.machine_name, EXPORT_STATUS_MAP.machine[r.status] || r.status || '', r.area, r.process,
      EXPORT_STATUS_MAP.processStatus[r.process_status] || r.process_status || '', r.shift, r.owner,
      exportStripHtml(r.alarm_info), exportStripHtml(r.remark), exportAttachCell(r), r.created_at, r.updated_at
    ],
    images: r => String(r.image_path || '').split(',').map(p => p.trim()).filter(Boolean)
  },
  {
    sheet: '日常交接', table: 'daily_handovers',
    sql: `SELECT * FROM daily_handovers WHERE deleted_at IS NULL`,
    columns: ['ID', '标题', '内容', '优先级', '类别', '状态', '创建人', '截止日期', '附件', '创建时间', '更新时间'],
    row: r => [
      r.id, exportStripHtml(r.title), exportStripHtml(r.content),
      EXPORT_STATUS_MAP.priority[r.priority] || r.priority || '', EXPORT_STATUS_MAP.category[r.category] || r.category || '',
      EXPORT_STATUS_MAP.handover[r.status] || r.status || '', r.created_by, r.due_date,
      exportAttachCell(r), r.created_at, r.updated_at
    ],
    images: r => String(r.image_path || '').split(',').map(p => p.trim()).filter(Boolean)
  },
  {
    sheet: 'LOT交接', table: 'lot_handovers',
    sql: `SELECT * FROM lot_handovers WHERE deleted_at IS NULL`,
    columns: ['ID', 'Lot ID', '状态', 'Detail', 'Comment', 'Follow up', '创建人', '附件', '创建时间', '更新时间'],
    row: r => [
      r.id, r.lot_id, EXPORT_STATUS_MAP.handover[r.status] || r.status || '',
      exportStripHtml(r.detail), exportStripHtml(r.comment), exportStripHtml(r.follow_up),
      r.created_by, exportAttachCell(r), r.created_at, r.updated_at
    ],
    images: r => String(r.follow_up_images || '').split(',').map(p => p.trim()).filter(Boolean)
  },
  {
    sheet: '签到表', table: 'sign_in_sheets',
    sql: `SELECT * FROM sign_in_sheets WHERE deleted_at IS NULL`,
    columns: ['ID', '班次时间', '地点', '主持人', '参会人数', '参会人明细', '创建时间', '更新时间'],
    row: (r) => {
      let attendees = [];
      try { attendees = JSON.parse(r.attendees || '[]'); } catch (e) {}
      const detail = (Array.isArray(attendees) ? attendees : [])
        .map(a => `${a.engineer || '-'}(${EXPORT_STATUS_MAP.signInStatus[a.status] || a.status || '-'})`).join('、');
      return [r.id, r.shift_time, r.location, r.host, attendees.length, detail, r.created_at, r.updated_at];
    },
    images: () => []
  },
  {
    sheet: '值班问题', table: 'duty_issues',
    sql: `SELECT * FROM duty_issues WHERE deleted_at IS NULL`,
    columns: ['ID', '问题归类1', '问题归类2', '问题识别过程', '解决办法', 'Owner确认', '附件', '创建时间', '更新时间'],
    row: r => [
      r.id, exportStripHtml(r.category1), exportStripHtml(r.category2),
      exportStripHtml(r.problem_process), exportStripHtml(r.solution),
      EXPORT_STATUS_MAP.confirm[r.owner_confirm] || exportStripHtml(r.owner_confirm) || '',
      exportAttachCell(r), r.created_at, r.updated_at
    ],
    images: r => String(r.image_path || '').split(',').map(p => p.trim()).filter(Boolean)
  },
  {
    sheet: 'AR交接', table: 'ar_handovers',
    sql: `SELECT * FROM ar_handovers WHERE deleted_at IS NULL`,
    columns: ['ID', '日期', 'AR内容', 'Owner-Section', '截止日期', '状态', '创建时间', '更新时间'],
    row: r => [
      r.id, r.date, exportStripHtml(r.ar), exportStripHtml(r.owner_section), r.due_date,
      EXPORT_STATUS_MAP.handover[r.status] || r.status || '', r.created_at, r.updated_at
    ],
    images: () => []
  }
];

// 图片以超链接形式展示（点击打开服务器上的原图）
const EXPORT_IMG_COL_WIDTH = 22;   // 图片列宽（字符）

app.get('/api/export/excel', authMiddleware, async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FAB 生产日常交接系统';
    // 图片完整 URL 前缀（Excel 中点击直接打开）
    const host = req.headers.host || `localhost:${PORT}`;

    for (const mod of EXPORT_MODULES) {
      const rows = db.prepare(`${mod.sql}${deptWhere(req)} ORDER BY id DESC`).all(...deptParam(req));

      // 先算出图片列/附件列总数（决定表头宽度）
      const imgCounts = rows.map(r => mod.images(r).length);
      const maxImgs = Math.max(0, ...imgCounts);
      const attachCounts = rows.map(r => Math.max(0, exportAttachList(r.attachments).length - 1)); // 首个附件在「附件」列内
      const maxExtraAttachs = Math.max(0, ...attachCounts);
      const ws = wb.addWorksheet(mod.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });

      const headers = [...mod.columns];
      for (let i = 1; i <= maxImgs; i++) headers.push(`图片${i}`);
      for (let i = 1; i <= maxExtraAttachs; i++) headers.push(`附件${i + 1}`);
      const headerRow = ws.addRow(headers);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
      ws.columns.forEach((col, i) => { col.width = i >= mod.columns.length ? EXPORT_IMG_COL_WIDTH : 16; });

      rows.forEach((r, ri) => {
        const imgPaths = mod.images(r);
        const row = ws.addRow(mod.row(r));
        row.alignment = { vertical: 'middle', wrapText: true };

        // 图片列：一图一列超链接
        imgPaths.forEach((p, pi) => {
          const cell = row.getCell(mod.columns.length + pi + 1); // 1 基列号
          cell.value = { text: `图片${pi + 1}`, hyperlink: `http://${host}${p}` };
          cell.font = { color: { argb: 'FF0563C1' }, underline: true };
        });

        // 附件列：占位标记替换为超链接单元格（文本=附件名，点击下载服务器文件）
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (cell.value && typeof cell.value === 'object' && cell.value.__attach__) {
            const list = cell.value.__attach__;
            if (list.length === 0) { cell.value = ''; return; }
            if (list.length === 1) {
              cell.value = { text: list[0].name || '附件', hyperlink: `http://${host}${list[0].path}` };
            } else {
              // 多附件：ExcelJS 单元格仅支持一个超链接，文本列出全部附件名，链接指向首个附件；
              // 其余附件依次追加在图片列之后（附件2、附件3...列），每个都可独立点击
              cell.value = { text: list.map(a => a.name || '附件').join('\n'), hyperlink: `http://${host}${list[0].path}` };
              list.slice(1).forEach((a, ai) => {
                const ac = ws.getRow(ri + 2).getCell(mod.columns.length + maxImgs + 1 + ai);
                ac.value = { text: a.name || `附件${ai + 2}`, hyperlink: `http://${host}${a.path}` };
                ac.font = { color: { argb: 'FF0563C1' }, underline: true };
                ac.alignment = { vertical: 'middle', wrapText: true };
              });
            }
            cell.font = { color: { argb: 'FF0563C1' }, underline: true };
          }
        });
      });
      if (rows.length === 0) ws.addRow(['（暂无数据）']);
    }

    const buf = await wb.xlsx.writeBuffer();
    const fileName = `交接总表_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[导出Excel失败]', err);
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// ─── 签到工程师路由 ────────────────────────────────────
// 本部门人员名单（用于签到表人员下拉）：返回与当前用户同部门、启用的非admin用户；admin 返回全部
app.get('/api/sign-in-members', authMiddleware, (req, res) => {
  const rows = isAdminUser(req)
    ? db.prepare("SELECT id, name, employee_id, department FROM users WHERE status = 'active' AND role != 'admin' ORDER BY name").all()
    : db.prepare("SELECT id, name, employee_id, department FROM users WHERE status = 'active' AND role != 'admin' AND department = ? ORDER BY name").all(req.user.department);
  res.json(rows);
});



// ─── 孤儿图片清理 ─────────────────────────────────────
// 定期扫描 uploads 目录，删除数据库中不再引用的图片文件
const CLEANUP_LOG_DIR = path.join(__dirname, 'data', 'cleanup-logs');
fs.mkdirSync(CLEANUP_LOG_DIR, { recursive: true });

// 清理条件：只要磁盘空间低于阈值就清理，软删记录无时间保留期，全量过期
// 因此不设置过期间隔，任何软删记录都立即进入可清理范围
const CLEANUP_INTERVAL_DAYS = 0;

// 各表的图片字段配置（包含软删除记录，因为回收站恢复后图片还要用）
const IMAGE_TABLES = [
  { table: 'machines',       field: 'image_path'        },
  { table: 'lt_machines',    field: 'image_path'        },
  { table: 'lot_handovers',  field: 'follow_up_images'  },
  { table: 'duty_issues',    field: 'image_path'        },
  { table: 'daily_handovers', field: 'image_path'       },
];

// 各表的附件字段配置（JSON 数组格式，存 path/name/size）
const ATTACHMENT_TABLES = [
  { table: 'machines',        field: 'attachments' },
  { table: 'lt_machines',     field: 'attachments' },
  { table: 'lot_handovers',   field: 'attachments' },
  { table: 'duty_issues',     field: 'attachments' },
  { table: 'daily_handovers', field: 'attachments' },
];

// 从附件 JSON 中提取文件路径列表
function parseAttachmentPaths(val) {
  if (!val || !val.trim()) return [];
  try {
    const arr = JSON.parse(val);
    if (Array.isArray(arr)) {
      return arr.map(a => a.path || '').filter(Boolean);
    }
  } catch (e) { /* 旧格式可能是逗号分隔 */ }
  return val.split(',').map(p => p.trim()).filter(p => p);
}

// 收集有效记录（未删除）引用的图片
// department 为 null 时收集全部
function collectActiveReferencedImages(department = null) {
  const referenced = new Set();
  const deptCondition = department ? ` AND department = ?` : '';
  const deptParam = department ? [department] : [];
  for (const { table, field } of IMAGE_TABLES) {
    try {
      const rows = db.prepare(
        `SELECT ${field} FROM ${table} WHERE deleted_at IS NULL${deptCondition}`
      ).all(...deptParam);
      for (const row of rows) {
        const val = row[field];
        if (!val || !val.trim()) continue;
        const paths = val.split(',').map(p => p.trim()).filter(p => p);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath) referenced.add(cleanPath);
        }
      }
    } catch (e) {
      console.error(`[清理] 读取 ${table}.${field} 失败:`, e.message);
    }
  }
  // 收集附件引用
  for (const { table, field } of ATTACHMENT_TABLES) {
    try {
      const rows = db.prepare(
        `SELECT ${field} FROM ${table} WHERE deleted_at IS NULL${deptCondition}`
      ).all(...deptParam);
      for (const row of rows) {
        const paths = parseAttachmentPaths(row[field]);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath) referenced.add(cleanPath);
        }
      }
    } catch (e) {
      console.error(`[清理] 读取 ${table}.${field} 失败:`, e.message);
    }
  }
  return referenced;
}

// 收集"软删除已满半年"的记录对应的图片
// department 为 null 时收集全部部门
// 返回 Map: 图片相对路径 -> { table, recordId, department, deletedAt }
function collectExpiredDeletedImages(department = null) {
  const result = new Map();
  const deptCondition = department ? ` AND department = ?` : '';
  const deptParam = department ? [department] : [];
  const cutoffDate = new Date(Date.now() - CLEANUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  
  for (const { table, field } of IMAGE_TABLES) {
    try {
      const rows = db.prepare(
        `SELECT id, department, deleted_at, ${field} FROM ${table} 
         WHERE deleted_at IS NOT NULL AND deleted_at <= ?${deptCondition}`
      ).all(cutoffDate, ...deptParam);
      
      for (const row of rows) {
        const val = row[field];
        if (!val || !val.trim()) continue;
        const paths = val.split(',').map(p => p.trim()).filter(p => p);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath && !result.has(cleanPath)) {
            result.set(cleanPath, {
              table,
              recordId: row.id,
              department: row.department,
              deletedAt: row.deleted_at,
            });
          }
        }
      }
    } catch (e) {
      console.error(`[清理] 查询 ${table} 过期删除记录失败:`, e.message);
    }
  }
  // 收集过期删除记录的附件
  for (const { table, field } of ATTACHMENT_TABLES) {
    try {
      const rows = db.prepare(
        `SELECT id, department, deleted_at, ${field} FROM ${table}
         WHERE deleted_at IS NOT NULL AND deleted_at <= ?${deptCondition}`
      ).all(cutoffDate, ...deptParam);
      for (const row of rows) {
        const paths = parseAttachmentPaths(row[field]);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath && !result.has(cleanPath)) {
            result.set(cleanPath, {
              table,
              recordId: row.id,
              department: row.department,
              deletedAt: row.deleted_at,
            });
          }
        }
      }
    } catch (e) {
      console.error(`[清理] 查询 ${table} 过期附件失败:`, e.message);
    }
  }
  return result;
}

// 收集真正的孤儿图片（不被任何记录引用，包括软删除记录）
// 这些是编辑记录时被移除的图片，或者上传后没用到的图片
// department 参数：如果指定，则只返回该部门记录中曾经出现过的孤儿图片
//                  如果为 null，返回全部孤儿图片
function collectTrueOrphanImages(department = null) {
  const allFiles = scanUploadDir();
  const allReferenced = new Set();
  
  // 收集所有被引用的图片（包括软删除）
  for (const { table, field } of IMAGE_TABLES) {
    try {
      const rows = db.prepare(`SELECT ${field} FROM ${table}`).all();
      for (const row of rows) {
        const val = row[field];
        if (!val || !val.trim()) continue;
        const paths = val.split(',').map(p => p.trim()).filter(p => p);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath) allReferenced.add(cleanPath);
        }
      }
    } catch (e) { /* ignore */ }
  }
  // 收集所有被引用的附件（包括软删除）
  for (const { table, field } of ATTACHMENT_TABLES) {
    try {
      const rows = db.prepare(`SELECT ${field} FROM ${table}`).all();
      for (const row of rows) {
        const paths = parseAttachmentPaths(row[field]);
        for (const p of paths) {
          const cleanPath = p.replace(/^\/uploads\//, '');
          if (cleanPath) allReferenced.add(cleanPath);
        }
      }
    } catch (e) { /* ignore */ }
  }
  
  // 找出孤儿
  const orphans = allFiles.filter(f => !allReferenced.has(f.relPath));

  // 如果指定了部门，进一步按归属清单过滤：只返回明确归属本部门的孤儿文件
  // 无归属记录的文件（本功能上线前上传的）不界定给任何部门，交由系统管理员清理，避免跨部门误删
  if (department) {
    const map = loadUploadOwnership();
    return orphans.filter(f => map[f.relPath] && map[f.relPath].department === department);
  }

  return orphans;
}

// 递归扫描 uploads 目录下的所有图片文件
function scanUploadDir(dir = UPLOAD_DIR, baseDir = UPLOAD_DIR) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanUploadDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      // 扫描全部上传文件（图片 + 附件），保证磁盘告警时的清理能同时覆盖附件
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      files.push({ relPath, fullPath });
    }
  }
  return files;
}

// 写入清理日志
function writeCleanupLog(result) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const scope = result.department ? `-${result.department}` : '';
  const logFile = path.join(CLEANUP_LOG_DIR, `cleanup-${dateStr}${scope}.log`);
  const lines = [];
  const scopeText = result.department ? `[${result.department}]` : '[全局]';
  lines.push(`===== 图片清理报告 ${scopeText} =====`);
  lines.push(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`清理范围: ${result.department || '全部部门'}`);
  lines.push(`扫描文件总数: ${result.totalScanned}`);
  lines.push(`数据库引用数(有效记录): ${result.totalReferenced}`);
  lines.push(`删除文件总数: ${result.deletedCount}`);
  lines.push(`  - 过期软删记录图片: ${result.expiredDeletedCount || 0} 个`);
  lines.push(`  - 无主孤儿图片: ${result.trueOrphanCount || 0} 个`);
  lines.push(`释放磁盘空间: ${(result.freedBytes / 1024 / 1024).toFixed(2)} MB`);
  if (result.deletedFiles && result.deletedFiles.length > 0) {
    lines.push('');
    lines.push('--- 删除文件列表 ---');
    for (const f of result.deletedFiles) {
      lines.push(`  ${f.path} (${(f.size / 1024).toFixed(1)} KB)`);
    }
  }
  lines.push('');
  try {
    fs.appendFileSync(logFile, lines.join('\n'), 'utf8');
  } catch (e) {
    console.error('[清理] 写入日志失败:', e.message);
  }
  return lines.join('\n');
}

// 主清理函数
// dryRun=true 时只扫描不删除，返回将要删除的列表
// department 为 null 时清理全部（系统管理员），为部门名时只清理该部门过期软删记录的图片
// 清理范围说明：
//   - 系统管理员：过期软删记录图片（全部部门）+ 真正的孤儿图片（无任何数据库引用）
//   - 部门管理员：仅本部门过期软删记录对应的图片（不清理无主孤儿，因无法确定归属）
function cleanupOrphanImages(dryRun = false, department = null) {
  const result = {
    totalScanned: 0,
    totalReferenced: 0,
    deletedCount: 0,
    freedBytes: 0,
    deletedFiles: [],
    skippedDirs: [],
    department: department,
    expiredDeletedCount: 0,   // 过期软删记录图片数
    trueOrphanCount: 0,       // 真正孤儿图片数
  };

  try {
    // 1. 收集"过期软删除记录"的图片（按部门过滤）
    const expiredDeletedMap = collectExpiredDeletedImages(department);
    result.expiredDeletedCount = expiredDeletedMap.size;

    // 2. 收集"真正孤儿"（系统管理员 department=null 清全部；部门管理员按非空部门清本部门归属的孤儿）
    // 注意：department 为空字符串时（异常数据）不清理任何孤儿，避免部门权限升级为全局清理
    let trueOrphans = [];
    if (department === null) {
      trueOrphans = collectTrueOrphanImages(null);
      result.trueOrphanCount = trueOrphans.length;
    } else if (department && department.trim()) {
      trueOrphans = collectTrueOrphanImages(department);
      result.trueOrphanCount = trueOrphans.length;
    } else {
      result.trueOrphanCount = 0;
    }

    // 3. 扫描磁盘文件（用于计算统计和获取文件大小）
    const files = scanUploadDir();
    result.totalScanned = files.length;

    // 构建磁盘文件路径 -> fullPath 的映射
    const fileMap = new Map();
    for (const f of files) {
      fileMap.set(f.relPath, f.fullPath);
    }

    // 统计有效引用数（用于展示）
    const activeRefs = collectActiveReferencedImages(department);
    result.totalReferenced = activeRefs.size;

    // 4. 合并待删除列表，去重
    const toDelete = new Map(); // relPath -> { size, source: 'expired'|'orphan', meta? }

    // 4a. 过期软删记录的图片
    // 注意：若某文件仍被"有效记录"（未删除）引用，即使同时出现在过期软删记录中也不能删除，
    // 否则会破坏仍在展示中的记录（详情图片/附件打不开）。
    for (const [relPath, meta] of expiredDeletedMap) {
      if (activeRefs.has(relPath)) continue;
      if (!toDelete.has(relPath)) {
        const fullPath = fileMap.get(relPath);
        let fileSize = 0;
        if (fullPath) {
          try {
            const stat = fs.statSync(fullPath);
            fileSize = stat.size;
          } catch (_) {}
        }
        toDelete.set(relPath, { size: fileSize, source: 'expired', meta });
      }
    }

    // 4b. 真正的孤儿图片（系统管理员清全部；部门管理员清本部门归属的孤儿）
    const ownershipMap = loadUploadOwnership();
    for (const orphan of trueOrphans) {
      if (!toDelete.has(orphan.relPath)) {
        let fileSize = 0;
        try {
          const stat = fs.statSync(orphan.fullPath);
          fileSize = stat.size;
        } catch (_) {}
        const owner = ownershipMap[orphan.relPath] || {};
        toDelete.set(orphan.relPath, {
          size: fileSize,
          source: 'orphan',
          meta: owner.department ? { department: owner.department } : null,
        });
      }
    }

    // 5. 执行删除（或只统计，dryRun）
    for (const [relPath, info] of toDelete) {
      const fullPath = fileMap.get(relPath);
      if (!fullPath) continue; // 磁盘上不存在就跳过

      if (!dryRun) {
        try {
          fs.unlinkSync(fullPath);
          result.deletedCount++;
          result.freedBytes += info.size;
          result.deletedFiles.push({
            path: relPath,
            size: info.size,
            source: info.source,
            department: info.meta ? info.meta.department : null,
          });
        } catch (e) {
          console.error(`[清理] 删除失败 ${relPath}:`, e.message);
        }
      } else {
        result.deletedCount++;
        result.freedBytes += info.size;
        result.deletedFiles.push({
          path: relPath,
          size: info.size,
          source: info.source,
          department: info.meta ? info.meta.department : null,
        });
      }
    }

    // 6. 清理空子目录（自底向上）——仅系统管理员全量清理时执行
    if (!dryRun && !department) {
      cleanupEmptyDirs(UPLOAD_DIR);
    }

    // 6.5 清理归属清单中已不存在的文件记录（仅实际执行后）
    if (!dryRun) {
      pruneOwnershipManifest();
    }

    // 7. 写日志（仅实际执行时）
    if (!dryRun) {
      const logText = writeCleanupLog(result);
      const scope = department ? `[${department}]` : '[全局]';
      console.log(`[清理] ${scope}孤儿图片清理完成:`, 
        `扫描${result.totalScanned}个, 删除${result.deletedCount}个`,
        `(过期软删${result.expiredDeletedCount}个 + 孤儿${result.trueOrphanCount}个),`,
        `释放${(result.freedBytes/1024/1024).toFixed(2)}MB`);
    }

  } catch (e) {
    console.error('[清理] 孤儿图片清理异常:', e.message);
  }

  return result;
}

// 递归清理空子目录
function cleanupEmptyDirs(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        cleanupEmptyDirs(path.join(dir, entry.name));
      }
    }
    // 重新读取（子目录可能已被删空）
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0 && dir !== UPLOAD_DIR) {
      try {
        fs.rmdirSync(dir);
      } catch (_) {}
    }
  } catch (_) {}
}

// ─── 磁盘空间监控驱动的孤儿图片清理 ───
// 当磁盘剩余空间低于阈值时，提醒管理员清理无用图片
// 清理范围不变：过期软删记录图片 + 无主孤儿图片

// 磁盘空间阈值（字节）
const DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;  // 10GB — 开始提醒并自动触发清理
const DISK_URGENT_BYTES  = 2 * 1024 * 1024 * 1024;  // 2GB — 升级通知部门管理员

// 获取指定路径所在磁盘的剩余空间（字节）
function getDiskFreeSpace(targetPath = UPLOAD_DIR) {
  try {
    const { execSync } = require('child_process');
    // -k 表示 KB，-P 保证输出格式一致
    const output = execSync(`df -kP "${targetPath}"`, { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    // df -k 输出：Filesystem 1024-blocks Used Available Capacity Mounted on
    const availKb = parseInt(parts[3], 10);
    if (isNaN(availKb)) return null;
    return availKb * 1024; // 转成字节
  } catch (e) {
    console.error('[清理] 获取磁盘空间失败:', e.message);
    return null;
  }
}

// 格式化字节数为可读形式
function formatDiskSpace(bytes) {
  if (bytes === null) return '未知';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 清理通知状态文件
const CLEANUP_STATUS_FILE = path.join(CLEANUP_LOG_DIR, '.cleanup-notice-status.json');

// 读取通知状态
function getCleanupNoticeStatus() {
  const defaultStatus = {
    lastCheckDiskFree: null,  // 上次检查时的剩余空间
    adminApproved: false,     // 系统管理员是否已同意清理
    adminApprovedAt: null,
    adminApprovedBy: null,
    deptAdminsDismissed: {},  // 部门管理员已读记录 { dept: { userId: { at, name } } }
  };
  try {
    if (fs.existsSync(CLEANUP_STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLEANUP_STATUS_FILE, 'utf8'));
      return { ...defaultStatus, ...data };
    }
  } catch (_) {}
  return defaultStatus;
}

// 写入通知状态
function saveCleanupNoticeStatus(status) {
  try {
    fs.writeFileSync(CLEANUP_STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// 定期检查磁盘空间（每小时一次）
function scheduleDiskMonitor() {
  const check = () => {
    const freeBytes = getDiskFreeSpace();
    if (freeBytes === null) return;
    
    const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
    
    if (freeBytes < DISK_URGENT_BYTES) {
      console.log(`[清理] ⚠️ 磁盘剩余 ${freeGB}GB，已低于紧急阈值 2GB，自动触发清理...`);
      // 自动清理：系统管理员范围（全量），不传 department 即全量
      try {
        const result = cleanupOrphanImages(false, null);
        if (result.deletedCount > 0) {
          console.log(`[清理] 自动清理完成：删除 ${result.deletedCount} 个文件，释放 ${(result.freedBytes / 1024 / 1024).toFixed(2)}MB`);
        }
      } catch (e) {
        console.error('[清理] 自动清理失败:', e.message);
      }
    } else if (freeBytes < DISK_WARNING_BYTES) {
      console.log(`[清理] 磁盘剩余 ${freeGB}GB，低于预警阈值 10GB，自动触发清理...`);
      try {
        const result = cleanupOrphanImages(false, null);
        if (result.deletedCount > 0) {
          console.log(`[清理] 自动清理完成：删除 ${result.deletedCount} 个文件，释放 ${(result.freedBytes / 1024 / 1024).toFixed(2)}MB`);
        }
      } catch (e) {
        console.error('[清理] 自动清理失败:', e.message);
      }
    }
  };
  
  // 启动时先检查一次
  check();
  
  // 每小时检查一次
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(check, ONE_HOUR);
  
  const freeBytes = getDiskFreeSpace();
  console.log(`[清理] 磁盘空间监控已启动（当前剩余: ${formatDiskSpace(freeBytes)}，预警: 10GB，紧急: 2GB）`);
}

// 启动磁盘监控
scheduleDiskMonitor();

// 清理预告 API（所有管理员登录后检查，根据磁盘剩余空间决定是否通知）
app.get('/api/cleanup-notice', authMiddleware, (req, res) => {
  const freeBytes = getDiskFreeSpace();
  const userRole = req.user.role;
  const userId = req.user.id;
  const userDept = req.user.department || '';
  
  // 空间充足，不需要通知
  if (freeBytes === null || freeBytes >= DISK_WARNING_BYTES) {
    return res.json({ needNotify: false, diskFreeBytes: freeBytes });
  }
  
  // 读取状态
  let status = getCleanupNoticeStatus();
  
  // 判断紧急程度
  const isUrgent = freeBytes < DISK_URGENT_BYTES;
  
  // 根据角色决定是否通知（通知顺序：先部门管理员，最后系统管理员）
  let shouldNotify = false;
  let notifyLevel = 'warning'; // warning | urgent
  
  if (userRole === 'dept_admin') {
    // 部门管理员：预警阶段（<10GB）先通知，各自清理本部门
    // 先部门、后系统：部门管理员先处理，系统管理员最后才兜底
    const deptDismissed = status.deptAdminsDismissed[userDept] && 
                         status.deptAdminsDismissed[userDept][String(userId)];
    shouldNotify = !isUrgent && !deptDismissed;
    notifyLevel = 'warning';
  } else if (userRole === 'admin') {
    // 系统管理员：仅紧急阶段（<2GB）最后通知，全局兜底
    shouldNotify = isUrgent && !status.adminApproved;
    notifyLevel = 'urgent';
  }
  
  if (!shouldNotify) {
    return res.json({ needNotify: false, diskFreeBytes: freeBytes });
  }
  
  // 做一次 dry-run 预览（部门管理员只看本部门的）
  const previewDept = userRole === 'dept_admin' ? userDept : null;
  const preview = cleanupOrphanImages(true, previewDept);
  
  res.json({
    needNotify: true,
    role: userRole,
    department: userDept,
    diskFreeBytes: freeBytes,
    diskFreeFormatted: formatDiskSpace(freeBytes),
    warningThreshold: DISK_WARNING_BYTES,
    urgentThreshold: DISK_URGENT_BYTES,
    orphanCount: preview.deletedCount,
    freedBytes: preview.freedBytes,
    totalScanned: preview.totalScanned,
    expiredDeletedCount: preview.expiredDeletedCount,
    trueOrphanCount: preview.trueOrphanCount,
    notifyLevel,
    isUrgent,
    adminApproved: status.adminApproved,
  });
});

// 系统管理员同意清理
app.post('/api/cleanup-notice/approve', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅系统管理员可操作' });
  }
  let status = getCleanupNoticeStatus();
  
  status.adminApproved = true;
  status.adminApprovedAt = new Date().toISOString();
  status.adminApprovedBy = req.user.name || req.user.employee_id;
  status.lastCheckDiskFree = getDiskFreeSpace();
  
  if (saveCleanupNoticeStatus(status)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '操作失败' });
  }
});

// 部门管理员确认已知悉
app.post('/api/cleanup-notice/dept-acknowledge', authMiddleware, (req, res) => {
  if (req.user.role !== 'dept_admin') {
    return res.status(403).json({ error: '仅部门管理员可操作' });
  }
  const userDept = req.user.department || '';
  const userId = String(req.user.id);
  
  let status = getCleanupNoticeStatus();
  
  if (!status.deptAdminsDismissed[userDept]) {
    status.deptAdminsDismissed[userDept] = {};
  }
  status.deptAdminsDismissed[userDept][userId] = {
    at: new Date().toISOString(),
    name: req.user.name || req.user.employee_id,
  };
  
  if (saveCleanupNoticeStatus(status)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '操作失败' });
  }
});

// 手动触发清理 API（系统管理员 - 全部部门）
app.get('/api/admin/cleanup-images/dry-run', authMiddleware, requireRole('admin'), (req, res) => {
  const result = cleanupOrphanImages(true);
  res.json({
    totalScanned: result.totalScanned,
    totalReferenced: result.totalReferenced,
    orphanCount: result.deletedCount,
    freedBytes: result.freedBytes,
    expiredDeletedCount: result.expiredDeletedCount,
    trueOrphanCount: result.trueOrphanCount,
    orphanFiles: result.deletedFiles.slice(0, 100),
    hasMore: result.deletedFiles.length > 100,
    scope: 'all',
  });
});

app.post('/api/admin/cleanup-images/execute', authMiddleware, requireRole('admin'), (req, res) => {
  const result = cleanupOrphanImages(false);
  res.json({
    success: true,
    totalScanned: result.totalScanned,
    totalReferenced: result.totalReferenced,
    deletedCount: result.deletedCount,
    freedBytes: result.freedBytes,
    expiredDeletedCount: result.expiredDeletedCount,
    trueOrphanCount: result.trueOrphanCount,
    scope: 'all',
  });
});

// 历史文件归属回填（仅系统管理员，dry-run 预览 / 实际执行）
// 依据数据库引用为上线前上传、无归属记录的历史文件自动补写归属部门
app.get('/api/admin/cleanup/backfill-ownership/dry-run', authMiddleware, requireRole('admin'), (req, res) => {
  const r = backfillUploadOwnership({ dryRun: true });
  res.json({ dryRun: true, ...r });
});

app.post('/api/admin/cleanup/backfill-ownership', authMiddleware, requireRole('admin'), (req, res) => {
  const r = backfillUploadOwnership({ dryRun: false });
  res.json({ success: true, ...r });
});

// 部门管理员手动清理（仅限本部门）
app.get('/api/dept/cleanup-images/dry-run', authMiddleware, requireRole('dept_admin'), (req, res) => {
  const result = cleanupOrphanImages(true, req.user.department);
  res.json({
    totalScanned: result.totalScanned,
    totalReferenced: result.totalReferenced,
    orphanCount: result.deletedCount,
    freedBytes: result.freedBytes,
    expiredDeletedCount: result.expiredDeletedCount,
    trueOrphanCount: result.trueOrphanCount,
    orphanFiles: result.deletedFiles.slice(0, 100),
    hasMore: result.deletedFiles.length > 100,
    scope: req.user.department,
  });
});

app.post('/api/dept/cleanup-images/execute', authMiddleware, requireRole('dept_admin'), (req, res) => {
  const result = cleanupOrphanImages(false, req.user.department);
  res.json({
    success: true,
    totalScanned: result.totalScanned,
    totalReferenced: result.totalReferenced,
    deletedCount: result.deletedCount,
    freedBytes: result.freedBytes,
    expiredDeletedCount: result.expiredDeletedCount,
    trueOrphanCount: result.trueOrphanCount,
    scope: req.user.department,
  });
});

// 获取清理日志列表
app.get('/api/cleanup-logs', authMiddleware, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userDept = req.user.department || '';
    const files = fs.readdirSync(CLEANUP_LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .filter(f => {
        // 系统管理员看全部；部门管理员只看自己部门的
        if (isAdmin) return true;
        return f.includes(`-${userDept}.log`);
      })
      .sort()
      .reverse()
      .slice(0, 20);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: '读取日志失败' });
  }
});

// ─── 静态资源 & 前端路由 ──────────────────────────────
// 上传的图片静态访问
app.use('/uploads', express.static(path.join(UPLOAD_DIR)));

// 前端 SPA 回退（所有非 /api 请求返回 index.html）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 全局错误处理 ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[错误]', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: '服务器内部错误' });
});

// ─── 启动 ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────────┐`);
  console.log(`│  FAB 生产日常交接系统已启动                  │`);
  console.log(`│  地址: http://localhost:${PORT}              │`);
  console.log(`│  默认管理员: admin（请及时修改初始密码）   │`);
  console.log(`└─────────────────────────────────────────────┘\n`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

// ─── 周期性清理 ─────────────────────────────────────
// 每 1 小时清理一次过期令牌与 30 天前的登录日志，防止数据无限膨胀
setInterval(() => {
  try {
    db.prepare("DELETE FROM auth_tokens WHERE (julianday('now') - julianday(created_at)) * 24 > ?").run(SESSION_MAX_HOURS);
  } catch (e) { /* 忽略清理失败 */ }
  try {
    db.prepare("DELETE FROM login_logs WHERE julianday('now') - julianday(login_time) > 30").run();
  } catch (e) { /* 忽略清理失败 */ }
}, 3600 * 1000).unref();
