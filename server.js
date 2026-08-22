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

const Database = require('better-sqlite3');

// ─── 配置 ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DB_PATH = path.join(DATA_DIR, 'fab.db');
const SALT_ROUNDS = 10;
const MODULES = ['dashboard', 'machine', 'daily-handover', 'lt-machine', 'lot-handover', 'sign-in', 'duty-issue', 'ar-handover'];
const ROLES = ['admin', 'dept_admin', 'editor', 'viewer'];

// 确保目录存在
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'machines'), { recursive: true });

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
    console.log('[初始化] 默认管理员已创建 — 工号: admin, 密码: admin123');
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

  // 初始化角色权限（admin 全权限；dept_admin/editor 可查改删；viewer 只读）
  const permCount = db.prepare('SELECT COUNT(*) as c FROM role_permissions').get().c;
  if (permCount === 0) {
    const stmt = db.prepare('INSERT INTO role_permissions (role, module, can_view, can_edit, can_delete) VALUES (?, ?, ?, ?, ?)');
    for (const role of ROLES) {
      for (const mod of MODULES) {
        if (role === 'admin') {
          stmt.run(role, mod, 1, 1, 1);
        } else if (role === 'dept_admin') {
          stmt.run(role, mod, 1, 1, 1);
        } else if (role === 'editor') {
          stmt.run(role, mod, 1, 1, 1);
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
}

initDb();

// ─── Express 应用 ─────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── 工具函数 ─────────────────────────────────────────
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM users u
    JOIN auth_tokens t ON t.user_id = u.id
    WHERE t.token = ? AND u.status = 'active'
  `).get(token);
  return row || null;
}

function logLogin(userId, employeeId, name, action, ip) {
  db.prepare('INSERT INTO login_logs (user_id, employee_id, name, action, ip_address) VALUES (?, ?, ?, ?, ?)')
    .run(userId || null, employeeId || '', name || '', action, ip || '');
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

// 返回部门过滤 SQL 片段（admin 不过滤）
function deptWhere(req, col = 'department') {
  return isAdminUser(req) ? '' : ` AND ${col} = ?`;
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
app.post('/api/auth/login', (req, res) => {
  const { employee_id, password } = req.body;
  if (!employee_id || !password) return res.status(400).json({ error: '请输入工号和密码' });

  const user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employee_id);
  if (!user) return res.status(401).json({ error: '工号不存在' });
  if (user.status !== 'active') return res.status(403).json({ error: '账号已禁用' });

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: '密码错误' });

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
  if (new_password.length < 4) return res.status(400).json({ error: '新密码至少4位' });

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
  const hashed = bcrypt.hashSync(password, SALT_ROUNDS);
  const info = db.prepare('INSERT INTO users (employee_id, name, password, department, role, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employee_id, name, hashed, department || '', finalRole, status || 'active');
  res.json({ id: info.lastInsertRowid });
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
  if (isDeptAdmin && (u.role === 'admin' || u.role === 'dept_admin')) {
    return res.status(403).json({ error: '部门管理员无权修改管理员用户' });
  }

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (department !== undefined && !isDeptAdmin) { updates.push('department = ?'); params.push(department); }
  if (employee_id !== undefined && req.user.role === 'admin') { updates.push('employee_id = ?'); params.push(employee_id); }
  if (role !== undefined && req.user.role === 'admin') { updates.push('role = ?'); params.push(role); }
  if (status !== undefined && req.user.role === 'admin') { updates.push('status = ?'); params.push(status); }
  if (password) { updates.push('password = ?'); params.push(bcrypt.hashSync(password, SALT_ROUNDS)); }

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
  // 部门管理员不能转移管理员角色的用户
  if (u.role === 'admin' || u.role === 'dept_admin') {
    return res.status(403).json({ error: '部门管理员无权转移管理员用户' });
  }
  db.prepare('UPDATE users SET department = ? WHERE id = ?').run(department || '', id);
  res.json({ success: true });
});

// 用户级权限
app.get('/api/users/:id/permissions', authMiddleware, requireRole('admin', 'dept_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });

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
  const totalMachines = db.prepare(`SELECT COUNT(*) as c FROM machines WHERE deleted_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalLtMachines = db.prepare(`SELECT COUNT(*) as c FROM lt_machines WHERE deleted_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalLots = db.prepare(`SELECT COUNT(*) as c FROM lot_handovers WHERE deleted_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;
  const totalSignIns = db.prepare(`SELECT COUNT(*) as c FROM sign_in_sheets WHERE deleted_at IS NULL${deptWhere(req)}`).get(...deptParam(req)).c;

  const machineStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM machines
    WHERE deleted_at IS NULL${deptWhere(req)} GROUP BY status
  `).all(...deptParam(req));

  const recentLots = db.prepare(`
    SELECT lot_id, detail, updated_at FROM lot_handovers
    WHERE deleted_at IS NULL${deptWhere(req)} ORDER BY updated_at DESC LIMIT 10
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
  const { basePath, table, module, fields, hasBatchStatus } = opts;

  // 列表
  app.get(basePath, authMiddleware, checkModulePermission(module, 'view'), (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL${deptWhere(req)} ORDER BY id DESC`).all(...deptParam(req));
    res.json(rows);
  });

  // 新增
  app.post(basePath, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    try {
      const data = {};
      for (const f of fields) {
        if (req.body[f] !== undefined) data[f] = req.body[f];
      }
      // 部门隔离：非 admin 由服务端强制写入归属部门，禁止客户端篡改
      data.department = isAdminUser(req) ? (req.body.department !== undefined ? req.body.department : '') : req.user.department;
      const cols = Object.keys(data);
      if (cols.length === 0) return res.status(400).json({ error: `无有效字段，允许的字段: ${fields.join(', ')}` });

      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map(c => data[c] !== undefined ? data[c] : '');
      const colList = cols.join(', ');

      const info = db.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`).run(...values);
      res.json({ id: info.lastInsertRowid });
    } catch (e) {
      console.error(`[错误] 新增${table}失败:`, e.message);
      res.status(400).json({ error: '新增失败，字段数据无效' });
    }
  });

  // 更新
  app.put(`${basePath}/:id`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = {};
      for (const f of fields) {
        if (req.body[f] !== undefined) data[f] = req.body[f];
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
      res.status(400).json({ error: '更新失败，字段数据无效' });
    }
  });

  // 软删除
  app.delete(`${basePath}/:id`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare(`UPDATE ${table} SET deleted_at = datetime('now', 'localtime') WHERE id = ? AND deleted_at IS NULL${deptWhere(req)}`).run(id, ...deptParam(req));
    res.json({ success: true });
  });

  // 恢复
  app.patch(`${basePath}/:id/restore`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?${deptWhere(req)}`).run(id, ...deptParam(req));
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
    db.prepare(`DELETE FROM ${table} WHERE id = ?${deptWhere(req)}`).run(id, ...deptParam(req));
    res.json({ success: true });
  });

  // 批量软删除
  app.post(`${basePath}/batch-delete`, authMiddleware, checkModulePermission(module, 'delete'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ changes: 0 });
    const placeholders = ids.map(() => '?').join(', ');
    const info = db.prepare(`UPDATE ${table} SET deleted_at = datetime('now', 'localtime') WHERE id IN (${placeholders}) AND deleted_at IS NULL${deptWhere(req)}`).run(...ids, ...deptParam(req));
    res.json({ changes: info.changes });
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

  // 图片上传
  app.post(`${basePath}/upload`, authMiddleware, checkModulePermission(module, 'edit'), (req, res) => {
    upload.array('images', 20)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: '未选择文件' });
      const paths = req.files.map(f => `/uploads/${path.basename(path.dirname(f.path))}/${f.filename}`);
      res.json({ paths });
    });
  });
}

// ─── 注册各业务模块路由 ─────────────────────────────────

// 机台近期交接
registerCrudRoutes({
  basePath: '/api/machines',
  table: 'machines',
  module: 'machine',
  fields: ['machine_id', 'machine_name', 'status', 'area', 'process', 'process_status', 'shift', 'owner', 'alarm_info', 'remark', 'image_path'],
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
  fields: ['machine_id', 'machine_name', 'status', 'area', 'process', 'process_status', 'shift', 'owner', 'alarm_info', 'remark', 'image_path'],
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
  fields: ['lot_id', 'status', 'detail', 'comment', 'follow_up', 'follow_up_images'],
  hasBatchStatus: false
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
  fields: ['category1', 'category2', 'image_path', 'problem_process', 'solution', 'owner_confirm'],
  hasBatchStatus: false
});

// 其他交接
registerCrudRoutes({
  basePath: '/api/daily-handovers',
  table: 'daily_handovers',
  module: 'daily-handover',
  fields: ['title', 'content', 'priority', 'category', 'status', 'created_by', 'due_date', 'image_path'],
  hasBatchStatus: false
});

// AR 交接
registerCrudRoutes({
  basePath: '/api/ar-handovers',
  table: 'ar_handovers',
  module: 'ar-handover',
  fields: ['date', 'ar', 'owner_section', 'due_date', 'status'],
  hasBatchStatus: false
});

// ─── 签到工程师路由 ────────────────────────────────────
// 本部门人员名单（用于签到表人员下拉）：返回与当前用户同部门、启用的非admin用户；admin 返回全部
app.get('/api/sign-in-members', authMiddleware, (req, res) => {
  const rows = isAdminUser(req)
    ? db.prepare("SELECT id, name, employee_id, department FROM users WHERE status = 'active' AND role != 'admin' ORDER BY name").all()
    : db.prepare("SELECT id, name, employee_id, department FROM users WHERE status = 'active' AND role != 'admin' AND department = ? ORDER BY name").all(req.user.department);
  res.json(rows);
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
  console.log(`│  默认管理员: admin / admin123              │`);
  console.log(`└─────────────────────────────────────────────┘\n`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
