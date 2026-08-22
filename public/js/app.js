// ===== 全局状态 =====
let machines = [];

// ===== 主题切换功能 =====
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('fab-theme', theme);
  // 更新选中状态
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.theme === theme);
  });
  // 关闭面板
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.remove('active');
}

function toggleThemePanel() {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  panel.classList.toggle('active');
}

// 点击外部关闭主题面板
document.addEventListener('click', function(e) {
  const switcher = document.getElementById('themeSwitcher');
  const panel = document.getElementById('themePanel');
  if (!switcher || !panel) return;
  if (!switcher.contains(e.target) && panel.classList.contains('active')) {
    panel.classList.remove('active');
  }
});

// 初始化主题选中状态
function initThemeSelector() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.theme === current);
  });
}

let dailyHandovers = [];
let ltMachines = []; // 长期交接机台（独立数据库）
let lotHandovers = []; // LOT交接（独立数据库）
let selectedLotHIds = new Set();
let signInSheets = []; // 交接签到表（独立数据库）
let selectedSignInIds = new Set();
let currentAttendees = []; // 当前编辑的到会人员列表
let signInEngineers = []; // 固定工程师列表
let _engineerListCache = null;
let dutyIssues = []; // 值班问题（独立数据库）
let selectedDiIds = new Set();
let arHandovers = []; // AR交接（独立数据库）
let departments = []; // 部门列表
let selectedArIds = new Set();
let arSortKey = 'updated_at';
let arSortDir = 'desc';
let _cachedArFilteredIds = null;
let dashboardData = null;
let machineChart = null;
let pendingDelete = null;

const API_BASE = '/api';

// ===== 状态映射 =====
const STATUS_MAP = {
  machine: {
    running: '运行中', down: '停机', idle: '待机', maintenance: '保养维护中',
    abnormal_pending: '异常待处理', repairing: '维修中', standby: '备用'
  },
  processStatus: {
    pending: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭'
  },
  handover: {
    open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭'
  },
  priority: { high: '高', medium: '中', low: '低' },
  category: {
    equipment: '设备', process: '工艺', quality: '质量', safety: '安全', other: '其他'
  }
};

// ===== 工具函数 =====
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// 用于 HTML 属性上下文（src/href/title 等），额外转义引号，防止属性逃逸注入
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 用于富文本字段（来自富文本编辑器），剥离危险标签/属性同时保留安全格式
function sanitizeHtml(html) {
  if (!html) return '';
  // 使用 DOMParser 解析并清理
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 移除 script 标签
  doc.querySelectorAll('script').forEach(el => el.remove());
  // 移除所有 on* 事件属性
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
      if (attr.name === 'href' && (attr.value || '').toLowerCase().startsWith('javascript:')) {
        el.removeAttribute('href');
      }
    });
  });
  return doc.body.innerHTML;
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2800);
}

// 带撤销按钮的 Toast
function showToastWithUndo(msg, undoCallback, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-undo ${type}`;
  toast.innerHTML = `<span class="toast-msg">${escapeHtml(msg)}</span>`;
  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo-btn';
  undoBtn.textContent = '撤销';
  toast.appendChild(undoBtn);
  container.appendChild(toast);
  let restored = false;
  undoBtn.addEventListener('click', () => {
    restored = true;
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
    if (undoCallback) undoCallback();
  });
  // 5秒后自动消失
  setTimeout(() => {
    if (!restored) {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

function openModal(id) { document.getElementById(id).classList.add('active'); document.body.classList.add('modal-open'); }
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal && modal.dataset.forceChange === 'true') {
    showToast('请先修改密码才能继续使用系统', 'error');
    return;
  }
  modal.classList.remove('active');
  document.body.classList.remove('modal-open');
}

function formatDateTime(dt) {
  if (!dt) return '-';
  return dt.replace('T', ' ').substring(0, 16);
}

// 获取中国时间(UTC+8)字符串，格式 YYYY-MM-DD HH:MM:SS
function getChinaTimeStr() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 获取中国时间(UTC+8)的Date对象
function getChinaDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

function getCurrentShift() {
  const now = getChinaDate();
  const minutes = now.getHours() * 60 + now.getMinutes();
  // 白班：08:30 ~ 20:30，其余为夜班
  if (minutes >= 8 * 60 + 30 && minutes < 20 * 60 + 30) return '白班';
  return '夜班';
}

function getTodayDateStr() {
  const d = getChinaDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 班次组合框同步到隐藏字段
function syncShiftCombo() {
  const date = document.getElementById('mShiftDate')?.value || '';
  const type = document.getElementById('mShiftType')?.value || '';
  const combined = date && type ? `${date} ${type}` : '';
  const hidden = document.getElementById('mShift');
  if (hidden) hidden.value = combined;
}

// 从班次字符串拆分到组合框
function parseShiftValue(shiftStr) {
  if (!shiftStr) return { date: getTodayDateStr(), type: '白班' };
  const parts = shiftStr.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { date: parts[0], type: parts.slice(1).join(' ') };
  }
  // 兼容旧数据 A/B/C
  const legacy = { A: '白班', B: '夜班', C: '夜班' };
  return { date: getTodayDateStr(), type: legacy[shiftStr] || '白班' };
}

// ===== 时间显示 =====
function updateClock() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const timeStr = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  document.getElementById('currentDate').textContent = dateStr;
  document.getElementById('currentTime').textContent = timeStr;
  document.getElementById('shiftBadge').textContent = `班次: ${getCurrentShift()}`;
}
setInterval(updateClock, 1000);
updateClock();

// ===== 班次组合框事件绑定 =====
document.addEventListener('change', (e) => {
  if (e.target.id === 'mShiftDate' || e.target.id === 'mShiftType') {
    syncShiftCombo();
  }
});

// ===== 移动端侧边栏控制 =====
function toggleSidebar(forceState) {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const isOpen = forceState !== undefined ? forceState : !sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.add('open');
    overlay.classList.add('active');
  } else {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  }
}

// ===== 导航切换 =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`view-${item.dataset.view}`).classList.add('active');
    if (item.dataset.view === 'dashboard') loadDashboard();
    if (item.dataset.view === 'user-mgmt') { loadUsers(); loadPermissions(); loadLoginLogs(); }
    if (item.dataset.view === 'dept-mgmt') { loadDepartments(); renderDeptTable(); }
    // 移动端点击导航后自动收起侧边栏
    if (window.innerWidth <= 768) toggleSidebar(false);
  });
});

// ===== API 调用 =====
// 请求去重：相同 GET 请求在飞行中时复用
const _inflightGets = new Map();

async function apiCall(method, path, body) {
  // GET 请求去重
  if (method === 'GET') {
    const cacheKey = `${method} ${path}`;
    if (_inflightGets.has(cacheKey)) return _inflightGets.get(cacheKey);
    const promise = _doFetch(method, path, body).finally(() => _inflightGets.delete(cacheKey));
    _inflightGets.set(cacheKey, promise);
    return promise;
  }
  return _doFetch(method, path, body);
}

async function _doFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  // 添加认证token
  const token = getAuthToken();
  if (token) opts.headers['x-auth-token'] = token;
  if (body) opts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, signal: controller.signal });
    if (res.status === 401 && !path.startsWith('/auth/')) {
      // 会话过期，跳转登录
      handleSessionExpired();
      throw new Error('会话过期');
    }
    if (res.status === 403) {
      throw new Error('无操作权限');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ===== 认证 & 用户管理 & 权限管理 =====
let currentUser = null;
let userPermissions = {};
let allUsers = [];
let loginLogs = [];

const ROLE_MAP = {
  admin: '系统管理员',
  dept_admin: '部门管理员',
  editor: '编辑者',
  viewer: '查看者'
};

// 角色固有约束：前端用于禁用不允许的复选框
const ROLE_CONSTRAINTS = {
  admin:      { canEdit: true,  canDelete: true  },
  dept_admin: { canEdit: true,  canDelete: false },
  editor:     { canEdit: true,  canDelete: false },
  viewer:     { canEdit: false, canDelete: false }
};

const MODULE_LABELS = {
  'dashboard': '仪表盘',
  'machine': '机台近期交接',
  'daily-handover': '其他交接',
  'lt-machine': '机台长期交接',
  'lot-handover': 'LOT交接',
  'sign-in': '交接签到表',
  'duty-issue': '值班问题',
  'ar-handover': 'AR交接'
};

function getAuthToken() {
  return localStorage.getItem('auth_token') || '';
}

function setAuthToken(token) {
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
}

function handleSessionExpired() {
  setAuthToken('');
  currentUser = null;
  showLoginOverlay();
  showToast('会话已过期，请重新登录', 'error');
}

function showLoginOverlay() {
  document.getElementById('loginOverlay').classList.add('active');
  document.getElementById('loginEmployeeId').focus();
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay').classList.remove('active');
}

async function checkSession() {
  const token = getAuthToken();
  if (!token) {
    showLoginOverlay();
    return false;
  }
  try {
    const data = await apiCall('GET', '/auth/session');
    if (data.user) {
      currentUser = data.user;
      updateUserInfo();
      await loadUserPermissions();
      return true;
    } else {
      showLoginOverlay();
      return false;
    }
  } catch (e) {
    showLoginOverlay();
    return false;
  }
}

async function loadUserPermissions() {
  if (!currentUser) return;
  try {
    const data = await apiCall('GET', '/auth/permissions');
    userPermissions = data.permissions || {};
    applyPermissions();
  } catch (e) {
    console.error('加载权限失败:', e);
  }
}

function applyPermissions() {
  // 管理员(系统管理员+部门管理员)显示管理菜单
  const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'dept_admin');
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  // 根据权限控制导航可见性
  document.querySelectorAll('.nav-item[data-view]').forEach(nav => {
    const mod = nav.dataset.view;
    if (mod === 'user-mgmt' || mod === 'dept-mgmt') return; // 管理菜单单独处理
    const perm = userPermissions[mod];
    if (perm && !perm.view) {
      nav.style.display = 'none';
    } else {
      nav.style.display = '';
    }
  });
  // 控制新增按钮显示（需要编辑权限才能新增）
  document.querySelectorAll('.perm-add-btn').forEach(btn => {
    const mod = btn.dataset.permModule;
    const perm = userPermissions[mod];
    if (isAdmin || (perm && perm.edit)) {
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  });
  // 控制各表格中的编辑/删除按钮显示
  applyTableActionPermissions();
}

// 权限检查辅助函数
function hasPermission(module, action) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;  // 仅超级管理员拥有全部权限
  const perm = userPermissions[module];
  if (!perm) return false;
  return perm[action] === true;
}

// 控制表格中编辑/删除按钮的显示
function applyTableActionPermissions() {
  // 映射：view-section id -> module name
  const viewModuleMap = {
    'view-machines': 'machine',
    'view-handovers': 'lt-machine',
    'view-daily-handovers': 'daily-handover',
    'view-lot-handover': 'lot-handover',
    'view-sign-in': 'sign-in',
    'view-duty-issues': 'duty-issue',
    'view-ar-handovers': 'ar-handover'
  };
  for (const [viewId, mod] of Object.entries(viewModuleMap)) {
    const section = document.getElementById(viewId);
    if (!section) continue;
    const canEdit = hasPermission(mod, 'edit');
    const canDelete = hasPermission(mod, 'delete');
    section.querySelectorAll('.action-btn.edit').forEach(btn => {
      btn.style.display = canEdit ? '' : 'none';
    });
    section.querySelectorAll('.action-btn.delete').forEach(btn => {
      btn.style.display = canDelete ? '' : 'none';
    });
  }
}

function updateUserInfo() {
  if (!currentUser) return;
  document.getElementById('userInfoBox').style.display = 'flex';
  document.getElementById('userName').textContent = currentUser.name;
  document.getElementById('currentUserRole').textContent = ROLE_MAP[currentUser.role] || currentUser.role;
  document.getElementById('userAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
}

async function doLogin() {
  const employeeId = document.getElementById('loginEmployeeId').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  if (!employeeId || !password) {
    errorEl.textContent = '请输入工号和密码';
    return;
  }

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '登录中...';

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || '登录失败';
      btn.disabled = false;
      btn.textContent = '登 录';
      return;
    }
    setAuthToken(data.token);
    currentUser = data.user;
    updateUserInfo();
    await loadUserPermissions();
    hideLoginOverlay();
    showToast(`欢迎回来，${currentUser.name}！`);
    // 首次登录强制修改密码
    if (data.mustChangePwd) {
      showToast('首次登录，请修改密码', 'warning');
      setTimeout(() => openChangePwdModal(true), 500);
    }
    // 重新加载数据
    if (typeof init === 'function') await init();
  } catch (e) {
    errorEl.textContent = '网络错误，请稍后重试';
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

async function doLogout() {
  try {
    await apiCall('POST', '/auth/logout');
  } catch (e) {}
  setAuthToken('');
  currentUser = null;
  userPermissions = {};
  document.getElementById('userInfoBox').style.display = 'none';
  showLoginOverlay();
  showToast('已安全登出');
}

// 回车登录
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('loginOverlay').classList.contains('active')) {
    doLogin();
  }
});

// ===== 用户与权限 Tab 切换 =====
function switchUserPermTab(tabName) {
  // 切换内容显示
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  const target = document.getElementById('tab-' + tabName);
  if (target) target.style.display = 'block';
  // 切换按钮样式
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.dataset.tab === tabName) {
      b.style.color = 'var(--accent-blue)';
      b.style.borderBottom = '2px solid var(--accent-blue)';
      b.classList.add('active');
    } else {
      b.style.color = 'var(--text-faint)';
      b.style.borderBottom = '2px solid transparent';
      b.classList.remove('active');
    }
  });
  // 按需加载数据
  if (tabName === 'users') loadUsers();
  if (tabName === 'role-perm' && allRolePerms.length === 0) loadPermissions();
  if (tabName === 'user-perm' && allUsers.length === 0) loadPermissions();
  if (tabName === 'logs') loadLoginLogs();
}

// ===== 用户管理 CRUD =====
async function loadUsers() {
  try {
    allUsers = await apiCall('GET', '/users');
    renderUserTable();
  } catch (e) {
    showToast('加载用户列表失败', 'error');
  }
}

function renderUserTable() {
  const tbody = document.getElementById('userMgmtTableBody');
  if (!tbody) return;
  if (allUsers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">暂无用户数据</td></tr>';
    return;
  }
  tbody.innerHTML = allUsers.map(u => {
    const roleBadge = u.role === 'admin' ? 'status-resolved' : (u.role === 'dept_admin' ? 'status-resolved' : (u.role === 'editor' ? 'status-in_progress' : 'status-open'));
    const statusBadge = u.status === 'active' ? 'status-running' : 'status-down';
    const statusLabel = u.status === 'active' ? '启用' : '禁用';
    const isSelf = currentUser && u.id === currentUser.id;
    const selfBadge = isSelf ? '<span class="status-badge status-info" style="margin-left:6px;">本人</span>' : '';
    const isDefaultAdmin = u.employee_id === 'admin';
    const isDeptAdminUser = currentUser && currentUser.role === 'dept_admin';
    const isSysAdmin = currentUser && currentUser.role === 'admin';
    const isTargetAdmin = u.role === 'admin' || u.role === 'dept_admin';
    const canDelete = !isDefaultAdmin && !isSelf && !(isDeptAdminUser && isTargetAdmin);
    // 只去掉"系统管理员"(admin)的转部门功能；部门管理员对普通用户转部门仍保留
    const canTransferDept = !isSysAdmin && !(isDeptAdminUser && isTargetAdmin);
    // 角色转换下拉：默认管理员和自己不能转换
    const canConvertRole = !isDefaultAdmin && !isSelf;
    let roleSelectHtml;
    if (canConvertRole) {
      const isSysAdmin = currentUser && currentUser.role === 'admin';
      let roleOptions;
      if (isSysAdmin) {
        // 系统管理员可以设置 dept_admin/editor/viewer（admin 角色仅限系统默认账号，不可通过转换新增）
        roleOptions = `<option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>查看者</option>
          <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>编辑者</option>
          <option value="dept_admin" ${u.role === 'dept_admin' ? 'selected' : ''}>部门管理员</option>`;
      } else {
        // 部门管理员只能 viewer↔editor
        roleOptions = `<option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>查看者</option>
          <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>编辑者</option>`;
      }
      roleSelectHtml = `<div class="role-convert-wrap">
        <select class="role-select" data-user-id="${u.id}" data-original-role="${u.role}" onchange="onRoleSelectChange(${u.id}, this.value, '${u.role}')" title="选择角色">
          ${roleOptions}
        </select>
        <button class="role-save-btn" data-user-id="${u.id}" data-original-role="${u.role}" onclick="saveRoleChange(${u.id}, '${u.role}')" style="display:none;" title="保存角色转换">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          保存
        </button>
      </div>`;
    } else if (isDefaultAdmin) {
      roleSelectHtml = '<span style="font-size:12px;color:var(--text-faint);">系统管理员</span>';
    } else if (isSelf) {
      roleSelectHtml = `<span class="status-badge ${roleBadge}">${ROLE_MAP[u.role] || u.role}</span><span style="font-size:11px;color:var(--text-faint);display:block;">不可自助转换</span>`;
    }
    return `
    <tr${isSelf ? ' style="background:rgba(30,80,224,0.04);"' : ''}>
      <td>${u.id}</td>
      <td><strong>${escapeHtml(u.employee_id)}</strong></td>
      <td>${escapeHtml(u.name)}${selfBadge}</td>
      <td>${escapeHtml(u.department || '-')}</td>
      <td>${roleSelectHtml}</td>
      <td><span class="status-badge ${statusBadge}">${statusLabel}</span></td>
      <td>${(u.created_at || '').substring(0, 16)}</td>
      <td>
        <div class="action-btns">
          <button class="action-btn edit" onclick="editUser(${u.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${canTransferDept ? `<button class="action-btn" onclick="openTransferDeptModal(${u.id})" title="转部门" style="color:var(--accent-blue);">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3l4 4-4 4"/><path d="M20 7H8a4 4 0 0 0-4 4v0"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h12a4 4 0 0 0 4-4v0"/></svg>
          </button>` : ''}
          ${canDelete ? `<button class="action-btn delete" onclick="deleteUser(${u.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openUserModal(id) {
  const modal = document.getElementById('userModal');
  const title = document.getElementById('userModalTitle');
  const pwdRequired = document.getElementById('passwordRequired');
  const pwdInput = document.getElementById('userPassword');
  const empIdInput = document.getElementById('userEmployeeId');
  const roleInput = document.getElementById('userRole');
  const statusInput = document.getElementById('userStatus');
  // 重置所有字段的禁用状态
  empIdInput.disabled = false;
  roleInput.disabled = false;
  statusInput.disabled = false;

  if (id) {
    const u = allUsers.find(x => x.id === id);
    if (!u) return;
    title.textContent = '编辑用户';
    document.getElementById('userEditId').value = u.id;
    document.getElementById('userEmployeeId').value = u.employee_id;
    document.getElementById('userNameInput').value = u.name;
    document.getElementById('userDepartment').value = u.department || '';
    document.getElementById('userRole').value = u.role;
    document.getElementById('userStatus').value = u.status;
    pwdInput.value = '';
    pwdInput.placeholder = '留空则不修改密码';
    pwdRequired.style.display = 'none';

    // 编辑自己时禁用危险字段
    const isSelf = currentUser && u.id === currentUser.id;
    if (isSelf) {
      empIdInput.disabled = true;
      roleInput.disabled = true;
      statusInput.disabled = true;
      // 添加提示
      const hint = document.getElementById('userSelfHint');
      if (hint) hint.style.display = 'block';
    } else {
      const hint = document.getElementById('userSelfHint');
      if (hint) hint.style.display = 'none';
    }

    // 部门管理员限制：不能修改用户部门，不能设置 admin/dept_admin 角色
    const deptSelect = document.getElementById('userDepartment');
    if (u.role === 'admin') {
      // 超级管理员是系统级的，不需要部门分类，禁用部门字段
      deptSelect.value = '';
      deptSelect.disabled = true;
      // 禁用角色降级选项（防止误操作，只能由系统管理员操作）
      Array.from(roleInput.options).forEach(opt => {
        if (opt.value === 'admin') {
          opt.disabled = false;
        } else {
          opt.disabled = true;
        }
      });
    } else if (currentUser.role === 'dept_admin') {
      // 部门管理员不能修改部门字段（转部门需系统管理员）
      deptSelect.disabled = true;
      // 如果编辑的用户已经是管理员角色，禁止部门管理员修改
      if (u.role === 'admin' || u.role === 'dept_admin') {
        empIdInput.disabled = true;
        roleInput.disabled = true;
        statusInput.disabled = true;
        document.getElementById('userNameInput').disabled = true;
        document.getElementById('userPassword').disabled = true;
        const hintEl = document.getElementById('userSelfHint');
        if (hintEl) {
          hintEl.textContent = '⚠ 该用户是管理员角色，部门管理员无权修改，请联系系统管理员';
          hintEl.style.display = 'block';
        }
      } else {
        // 只能选择 viewer/editor 角色
        Array.from(roleInput.options).forEach(opt => {
          if (opt.value === 'admin' || opt.value === 'dept_admin') {
            opt.disabled = true;
          } else {
            opt.disabled = false;
          }
        });
      }
    } else {
      // 系统管理员：编辑非admin用户时，admin角色禁用（不可升级为超级管理员）
      deptSelect.disabled = false;
      Array.from(roleInput.options).forEach(opt => {
        opt.disabled = (opt.value === 'admin');
      });
    }
  } else {
    title.textContent = '新增用户';
    document.getElementById('userEditId').value = '';
    document.getElementById('userEmployeeId').value = '';
    document.getElementById('userNameInput').value = '';
    document.getElementById('userDepartment').value = '';
    document.getElementById('userRole').value = 'viewer';
    document.getElementById('userStatus').value = 'active';
    pwdInput.value = '';
    pwdInput.placeholder = '密码';
    pwdRequired.style.display = '';
    const hint = document.getElementById('userSelfHint');
    if (hint) hint.style.display = 'none';

    // 新增用户时：admin 角色始终不可选（超级管理员仅限系统默认账号，不可新增）
    // 部门管理员额外限制：默认本部门 + 锁定部门 + 禁用 dept_admin 角色
    const deptSelect = document.getElementById('userDepartment');
    if (currentUser.role === 'dept_admin') {
      deptSelect.value = currentUser.department || '';
      deptSelect.disabled = true;
      Array.from(roleInput.options).forEach(opt => {
        if (opt.value === 'admin' || opt.value === 'dept_admin') {
          opt.disabled = true;
        } else {
          opt.disabled = false;
        }
      });
    } else {
      deptSelect.disabled = false;
      Array.from(roleInput.options).forEach(opt => {
        opt.disabled = (opt.value === 'admin'); // 新增用户时 admin 角色不可选
      });
    }
  }
  openModal('userModal');
}

function editUser(id) {
  openUserModal(id);
}

async function saveUser() {
  const id = document.getElementById('userEditId').value;
  const empIdInput = document.getElementById('userEmployeeId');
  const roleInput = document.getElementById('userRole');
  const statusInput = document.getElementById('userStatus');
  const nameInput = document.getElementById('userNameInput');
  const deptInput = document.getElementById('userDepartment');
  const passwordInput = document.getElementById('userPassword');

  const data = {};
  // 只有未禁用的字段才提交
  if (!nameInput.disabled) data.name = nameInput.value.trim();
  if (!deptInput.disabled) data.department = deptInput.value.trim();
  if (!empIdInput.disabled) data.employee_id = empIdInput.value.trim();
  if (!roleInput.disabled) data.role = roleInput.value;
  if (!statusInput.disabled) data.status = statusInput.value;

  const password = !passwordInput.disabled ? passwordInput.value.trim() : '';

  if (!id && !data.employee_id) {
    showToast('请填写工号', 'error');
    return;
  }
  if (!id && !data.name) {
    showToast('请填写姓名', 'error');
    return;
  }
  if (!id && !password) {
    showToast('请设置密码', 'error');
    return;
  }
  if (password) data.password = password;

  try {
    if (id) {
      await apiCall('PUT', `/users/${id}`, data);
      showToast('用户更新成功');
    } else {
      await apiCall('POST', '/users', data);
      showToast('用户创建成功');
    }
    closeModal('userModal');
    await loadUsers();
  } catch (e) {
    showToast('操作失败: ' + e.message, 'error');
    await loadUsers();
  }
}

async function deleteUser(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`确认删除用户 ${u.name} (${u.employee_id})？其自定义权限将一并清除。`)) return;
  try {
    await apiCall('DELETE', `/users/${id}`);
    showToast('用户删除成功');
    await loadUsers();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ===== 角色转换 =====
function onRoleSelectChange(id, newRole, oldRole) {
  // 不立即转换，只控制保存按钮的显示/隐藏
  const saveBtn = document.querySelector(`button.role-save-btn[data-user-id="${id}"]`);
  if (!saveBtn) return;
  if (newRole !== oldRole) {
    saveBtn.style.display = 'inline-flex';
    saveBtn.dataset.newRole = newRole;
  } else {
    saveBtn.style.display = 'none';
  }
}

async function saveRoleChange(id, oldRole) {
  const saveBtn = document.querySelector(`button.role-save-btn[data-user-id="${id}"]`);
  if (!saveBtn) return;
  const newRole = saveBtn.dataset.newRole;
  if (!newRole || newRole === oldRole) return;
  await changeUserRole(id, newRole, oldRole);
}

async function changeUserRole(id, newRole, oldRole) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  const roleLabels = { admin: '系统管理员', dept_admin: '部门管理员', editor: '编辑者', viewer: '查看者' };
  const oldLabel = roleLabels[u.role] || u.role;
  const newLabel = roleLabels[newRole] || newRole;

  let confirmMsg = `确认将用户 ${u.name} (${u.employee_id}) 的角色从【${oldLabel}】转换为【${newLabel}】？\n`;

  // 升级提示
  if (newRole === 'admin') {
    confirmMsg += '\n⚠ 转为系统管理员后将获得系统全部权限，请谨慎操作。';
  }
  if (newRole === 'dept_admin') {
    confirmMsg += '\n⚠ 转为部门管理员后，将可管理本部门用户和查看全部模块数据。';
  }
  // 降级提示
  if ((u.role === 'admin' || u.role === 'dept_admin') && newRole !== 'admin' && newRole !== 'dept_admin') {
    confirmMsg += '\n⚠ 从管理员降级后，该用户将失去管理权限，其自定义权限中超出新角色的部分将被自动清除。';
  }
  if (newRole === 'viewer') {
    confirmMsg += '\n转为查看者后，该用户的编辑和删除权限将被清除。';
  } else if (newRole === 'editor') {
    confirmMsg += '\n转为编辑者后，该用户的删除权限将被清除。';
  }

  // 用户取消确认时，恢复下拉框到原值并隐藏保存按钮
  if (!confirm(confirmMsg)) {
    const select = document.querySelector(`select.role-select[data-user-id="${id}"]`);
    if (select) select.value = oldRole || u.role;
    const saveBtn = document.querySelector(`button.role-save-btn[data-user-id="${id}"]`);
    if (saveBtn) saveBtn.style.display = 'none';
    return;
  }

  try {
    const result = await apiCall('PUT', `/users/${id}/role`, { role: newRole });
    showToast(result.message || '角色转换成功');
    await loadUsers();
  } catch (e) {
    showToast('角色转换失败: ' + e.message, 'error');
    // API 失败时恢复下拉框并隐藏保存按钮
    const select = document.querySelector(`select.role-select[data-user-id="${id}"]`);
    if (select) select.value = oldRole || u.role;
    const saveBtn = document.querySelector(`button.role-save-btn[data-user-id="${id}"]`);
    if (saveBtn) saveBtn.style.display = 'none';
  }
}

// ===== 修改自己的密码 =====
function openChangePwdModal(forceChange = false) {
  document.getElementById('oldPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmNewPassword').value = '';
  const modal = document.getElementById('changePwdModal');
  const closeBtn = modal.querySelector('.modal-close');
  if (forceChange) {
    modal.dataset.forceChange = 'true';
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    modal.dataset.forceChange = 'false';
    if (closeBtn) closeBtn.style.display = '';
  }
  openModal('changePwdModal');
}

async function saveNewPassword() {
  const oldPwd = document.getElementById('oldPassword').value.trim();
  const newPwd = document.getElementById('newPassword').value.trim();
  const confirmPwd = document.getElementById('confirmNewPassword').value.trim();

  if (!oldPwd || !newPwd || !confirmPwd) {
    showToast('请填写所有字段', 'error');
    return;
  }
  if (newPwd.length < 4) {
    showToast('新密码至少4位', 'error');
    return;
  }
  if (newPwd !== confirmPwd) {
    showToast('两次输入的新密码不一致', 'error');
    return;
  }
  if (oldPwd === newPwd) {
    showToast('新密码不能与旧密码相同', 'error');
    return;
  }

  try {
    const res = await apiCall('PUT', '/auth/change-password', { old_password: oldPwd, new_password: newPwd });
    showToast(res.message || '密码修改成功');
    // 清除强制修改标志
    const modal = document.getElementById('changePwdModal');
    if (modal) {
      modal.dataset.forceChange = 'false';
      const closeBtn = modal.querySelector('.modal-close');
      if (closeBtn) closeBtn.style.display = '';
    }
    closeModal('changePwdModal');
  } catch (e) {
    showToast('修改失败: ' + e.message, 'error');
  }
}

// ===== 转部门（仅管理员） =====
async function openTransferDeptModal(userId) {
  const u = allUsers.find(x => x.id === userId);
  if (!u) {
    showToast('用户不存在', 'error');
    return;
  }
  document.getElementById('transferUserId').value = userId;
  document.getElementById('transferUserName').textContent = `${u.name}（${u.employee_id}）`;
  document.getElementById('transferCurrentDept').textContent = u.department || '未分配';

  // 加载部门列表到下拉框
  const targetSelect = document.getElementById('transferTargetDept');
  targetSelect.innerHTML = '';
  try {
    const depts = await apiCall('GET', '/departments');
    depts.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.name;
      if (d.name === u.department) opt.selected = true;
      targetSelect.appendChild(opt);
    });
    // 添加"未分配"选项
    const noDeptOpt = document.createElement('option');
    noDeptOpt.value = '';
    noDeptOpt.textContent = '（未分配部门）';
    targetSelect.appendChild(noDeptOpt);
  } catch (e) {
    showToast('加载部门列表失败', 'error');
  }

  openModal('transferDeptModal');
}

async function saveTransferDept() {
  const userId = document.getElementById('transferUserId').value;
  const targetDept = document.getElementById('transferTargetDept').value;

  if (!userId) {
    showToast('请选择用户', 'error');
    return;
  }

  const u = allUsers.find(x => x.id === parseInt(userId));
  if (u && u.department === targetDept) {
    showToast('新部门与当前部门相同', 'error');
    return;
  }

  if (!confirm(`确认将「${u ? u.name : ''}」转入「${targetDept || '未分配'}」？转入后仅可查看该部门数据。`)) {
    return;
  }

  try {
    const res = await apiCall('PUT', `/users/${userId}/transfer-dept`, { department: targetDept });
    showToast(res.message || '转部门成功');
    closeModal('transferDeptModal');
    await loadUsers(); // 刷新用户列表
  } catch (e) {
    showToast('转部门失败: ' + e.message, 'error');
  }
}

// ===== 权限管理 =====
let currentUserPerms = null; // 当前选中的用户权限
let selectedPermUserId = null;
let allRolePerms = []; // 角色级权限缓存

async function loadPermissions() {
  // 加载用户列表填充下拉框 + 加载角色级权限
  try {
    allUsers = await apiCall('GET', '/users');
    renderPermUserSelect();
    // 加载角色级权限
    allRolePerms = await apiCall('GET', '/permissions');
    onRolePermChange();
  } catch (e) {
    showToast('加载权限数据失败', 'error');
  }
}

// ===== 角色级权限管理 =====
function onRolePermChange() {
  const role = document.getElementById('rolePermSelect').value;
  const wrap = document.getElementById('rolePermWrap');
  const saveWrap = document.getElementById('rolePermSaveWrap');
  if (!role) {
    wrap.style.display = 'none';
    saveWrap.style.display = 'none';
    return;
  }
  renderRolePermTable(role);
  wrap.style.display = '';
  saveWrap.style.display = '';
}

function renderRolePermTable(role) {
  const body = document.getElementById('rolePermTableBody');
  if (!body) return;
  const modules = Object.keys(MODULE_LABELS);
  const constraints = ROLE_CONSTRAINTS[role] || { canEdit: false, canDelete: false };
  body.innerHTML = modules.map(mod => {
    const p = allRolePerms.find(x => x.role === role && x.module === mod) || { can_view: 0, can_edit: 0, can_delete: 0 };
    const disableEdit = !constraints.canEdit;
    const disableDelete = !constraints.canDelete;
    return `
    <tr>
      <td><strong>${MODULE_LABELS[mod]}</strong></td>
      <td><input type="checkbox" class="role-perm-check" data-role="${role}" data-module="${mod}" data-action="view" ${p.can_view ? 'checked' : ''} onchange="onRolePermCheckChange(this)"></td>
      <td><input type="checkbox" class="role-perm-check" data-role="${role}" data-module="${mod}" data-action="edit" ${p.can_edit ? 'checked' : ''} ${disableEdit ? 'disabled' : ''} onchange="onRolePermCheckChange(this)"></td>
      <td><input type="checkbox" class="role-perm-check" data-role="${role}" data-module="${mod}" data-action="delete" ${p.can_delete ? 'checked' : ''} ${disableDelete ? 'disabled' : ''} onchange="onRolePermCheckChange(this)"></td>
    </tr>`;
  }).join('');
}

// 权限层级联动：查看→编辑→删除
function onRolePermCheckChange(checkbox) {
  const row = checkbox.closest('tr');
  if (!row) return;
  const viewCb = row.querySelector('[data-action="view"]');
  const editCb = row.querySelector('[data-action="edit"]');
  const delCb = row.querySelector('[data-action="delete"]');

  if (checkbox.dataset.action === 'view' && !checkbox.checked) {
    // 取消查看 → 自动取消编辑和删除
    if (editCb && !editCb.disabled) editCb.checked = false;
    if (delCb && !delCb.disabled) delCb.checked = false;
  } else if (checkbox.dataset.action === 'edit') {
    if (checkbox.checked) {
      // 勾选编辑 → 自动勾选查看
      if (viewCb) viewCb.checked = true;
    } else {
      // 取消编辑 → 自动取消删除
      if (delCb && !delCb.disabled) delCb.checked = false;
    }
  } else if (checkbox.dataset.action === 'delete' && checkbox.checked) {
    // 勾选删除 → 自动勾选编辑和查看
    if (editCb && !editCb.disabled) editCb.checked = true;
    if (viewCb) viewCb.checked = true;
  }
}

async function saveRolePermissions() {
  const role = document.getElementById('rolePermSelect').value;
  if (!role) {
    showToast('请先选择角色', 'error');
    return;
  }
  const checks = document.querySelectorAll('.role-perm-check');
  const permMap = {};
  checks.forEach(c => {
    if (!permMap[c.dataset.module]) permMap[c.dataset.module] = { role, module: c.dataset.module, can_view: false, can_edit: false, can_delete: false };
    if (c.dataset.action === 'view') permMap[c.dataset.module].can_view = c.checked;
    if (c.dataset.action === 'edit') permMap[c.dataset.module].can_edit = c.checked;
    if (c.dataset.action === 'delete') permMap[c.dataset.module].can_delete = c.checked;
  });
  const permissions = Object.values(permMap);
  try {
    await apiCall('PUT', '/permissions', { permissions });
    showToast('角色权限保存成功');
    // 重新加载缓存
    allRolePerms = await apiCall('GET', '/permissions');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ===== 用户级权限管理 =====

function renderPermUserSelect() {
  const sel = document.getElementById('permUserSelect');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- 请选择用户 --</option>' +
    allUsers.map(u => {
      const isSuperAdmin = u.role === 'admin';
      return `<option value="${u.id}" ${isSuperAdmin ? 'disabled' : ''}>${u.name} (${u.employee_id}) - ${ROLE_MAP[u.role] || u.role}${isSuperAdmin ? ' [全部权限]' : ''}</option>`;
    }).join('');
  if (currentVal) sel.value = currentVal;
}

async function onPermUserChange() {
  const userId = document.getElementById('permUserSelect').value;
  selectedPermUserId = userId;
  const infoEl = document.getElementById('permUserInfo');
  const wrapEl = document.getElementById('userPermWrap');
  const bodyEl = document.getElementById('userPermTableBody');

  if (!userId) {
    infoEl.textContent = '';
    wrapEl.style.display = 'none';
    bodyEl.innerHTML = '';
    document.getElementById('userPermSaveWrap').style.display = 'none';
    return;
  }

  try {
    const data = await apiCall('GET', `/users/${userId}/permissions`);
    currentUserPerms = data;
    infoEl.innerHTML = `<span class="status-badge status-open">${ROLE_MAP[data.role] || data.role}</span> ${data.userName} 的权限配置`;
    renderUserPermTable(data.permissions);
    wrapEl.style.display = '';
    document.getElementById('userPermSaveWrap').style.display = '';
  } catch (e) {
    showToast('加载用户权限失败: ' + e.message, 'error');
  }
}

function renderUserPermTable(perms) {
  const body = document.getElementById('userPermTableBody');
  if (!body) return;
  const modules = Object.keys(MODULE_LABELS);
  const role = currentUserPerms ? currentUserPerms.role : 'viewer';
  const constraints = ROLE_CONSTRAINTS[role] || { canEdit: false, canDelete: false };

  body.innerHTML = modules.map(mod => {
    const p = perms[mod] || { view: false, edit: false, delete: false, custom: false };
    const sourceBadge = p.custom
      ? '<span class="status-badge status-resolved" style="font-size:11px;">自定义</span>'
      : '<span class="status-badge status-open" style="font-size:11px;">角色默认</span>';
    const disableEdit = !constraints.canEdit;
    const disableDelete = !constraints.canDelete;
    return `
    <tr>
      <td><strong>${MODULE_LABELS[mod]}</strong></td>
      <td><input type="checkbox" class="perm-check-input" data-module="${mod}" data-action="view" ${p.view ? 'checked' : ''} onchange="onUserPermCheckChange(this)"></td>
      <td><input type="checkbox" class="perm-check-input" data-module="${mod}" data-action="edit" ${p.edit ? 'checked' : ''} ${disableEdit ? 'disabled' : ''} onchange="onUserPermCheckChange(this)"></td>
      <td><input type="checkbox" class="perm-check-input" data-module="${mod}" data-action="delete" ${p.delete ? 'checked' : ''} ${disableDelete ? 'disabled' : ''} onchange="onUserPermCheckChange(this)"></td>
      <td>${sourceBadge}</td>
    </tr>`;
  }).join('');
}

// 用户权限层级联动：查看→编辑→删除
function onUserPermCheckChange(checkbox) {
  const row = checkbox.closest('tr');
  if (!row) return;
  const viewCb = row.querySelector('[data-action="view"]');
  const editCb = row.querySelector('[data-action="edit"]');
  const delCb = row.querySelector('[data-action="delete"]');

  if (checkbox.dataset.action === 'view' && !checkbox.checked) {
    // 取消查看 → 自动取消编辑和删除
    if (editCb && !editCb.disabled) editCb.checked = false;
    if (delCb && !delCb.disabled) delCb.checked = false;
  } else if (checkbox.dataset.action === 'edit') {
    if (checkbox.checked) {
      // 勾选编辑 → 自动勾选查看
      if (viewCb) viewCb.checked = true;
    } else {
      // 取消编辑 → 自动取消删除
      if (delCb && !delCb.disabled) delCb.checked = false;
    }
  } else if (checkbox.dataset.action === 'delete' && checkbox.checked) {
    // 勾选删除 → 自动勾选编辑和查看
    if (editCb && !editCb.disabled) editCb.checked = true;
    if (viewCb) viewCb.checked = true;
  }
}

async function saveUserPermissions() {
  if (!selectedPermUserId) {
    showToast('请先选择用户', 'error');
    return;
  }
  const checks = document.querySelectorAll('.perm-check-input');
  const permMap = {};
  checks.forEach(c => {
    if (!permMap[c.dataset.module]) permMap[c.dataset.module] = { module: c.dataset.module, can_view: false, can_edit: false, can_delete: false };
    if (c.dataset.action === 'view') permMap[c.dataset.module].can_view = c.checked;
    if (c.dataset.action === 'edit') permMap[c.dataset.module].can_edit = c.checked;
    if (c.dataset.action === 'delete') permMap[c.dataset.module].can_delete = c.checked;
  });
  const permissions = Object.values(permMap);
  try {
    await apiCall('PUT', `/users/${selectedPermUserId}/permissions`, { permissions });
    showToast('用户权限保存成功');
    await onPermUserChange(); // 重新加载显示
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ===== 部门管理 =====
async function loadDepartments() {
  try {
    departments = await apiCall('GET', '/departments');
    // 同步更新用户表单中的部门下拉框
    updateUserDeptSelect();
  } catch (e) {
    showToast('加载部门列表失败', 'error');
  }
}

function updateUserDeptSelect() {
  const sel = document.getElementById('userDepartment');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- 请选择部门 --</option>' +
    departments.map(d => `<option value="${escapeAttr(d.name)}">${escapeHtml(d.name)}</option>`).join('');
  if (currentVal) sel.value = currentVal;
}

function renderDeptTable() {
  const tbody = document.getElementById('deptMgmtTableBody');
  if (!tbody) return;
  if (departments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无部门数据</td></tr>';
    return;
  }
  tbody.innerHTML = departments.map(d => `
    <tr>
      <td>${d.id}</td>
      <td><strong>${escapeHtml(d.name)}</strong></td>
      <td>${escapeHtml(d.description || '-')}</td>
      <td>${d.sort_order || 0}</td>
      <td>${(d.created_at || '').substring(0, 16)}</td>
      <td>
        <div class="action-btns">
          <button class="action-btn edit" onclick="editDept(${d.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteDept(${d.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function openDeptModal(id) {
  const modal = document.getElementById('deptModal');
  const title = document.getElementById('deptModalTitle');
  if (id) {
    const d = departments.find(x => x.id === id);
    if (!d) return;
    title.textContent = '编辑部门';
    document.getElementById('deptEditId').value = d.id;
    document.getElementById('deptName').value = d.name;
    document.getElementById('deptDescription').value = d.description || '';
    document.getElementById('deptSortOrder').value = d.sort_order || 0;
  } else {
    title.textContent = '新增部门';
    document.getElementById('deptEditId').value = '';
    document.getElementById('deptName').value = '';
    document.getElementById('deptDescription').value = '';
    document.getElementById('deptSortOrder').value = 0;
  }
  openModal('deptModal');
}

function editDept(id) {
  openDeptModal(id);
}

async function saveDept() {
  const id = document.getElementById('deptEditId').value;
  const data = {
    name: document.getElementById('deptName').value.trim(),
    description: document.getElementById('deptDescription').value.trim(),
    sort_order: parseInt(document.getElementById('deptSortOrder').value) || 0
  };
  if (!data.name) {
    showToast('请填写部门名称', 'error');
    return;
  }
  closeModal('deptModal');
  try {
    if (id) {
      await apiCall('PUT', `/departments/${id}`, data);
      showToast('部门更新成功');
    } else {
      await apiCall('POST', '/departments', data);
      showToast('部门创建成功');
    }
    closeModal('deptModal');
    await loadDepartments();
    renderDeptTable();
  } catch (e) {
    showToast('操作失败: ' + e.message, 'error');
    await loadDepartments();
    renderDeptTable();
  }
}

async function deleteDept(id) {
  const d = departments.find(x => x.id === id);
  if (!d) return;
  if (!confirm(`确认删除部门「${d.name}」？`)) return;
  try {
    await apiCall('DELETE', `/departments/${id}`);
    showToast('部门删除成功');
    await loadDepartments();
    renderDeptTable();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ===== 登录日志 =====
async function loadLoginLogs() {
  try {
    loginLogs = await apiCall('GET', '/login-logs');
    renderLoginLogs();
  } catch (e) {
    showToast('加载登录日志失败', 'error');
  }
}

function renderLoginLogs() {
  const tbody = document.getElementById('loginLogTableBody');
  if (!tbody) return;
  if (loginLogs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无登录日志</td></tr>';
    return;
  }
  tbody.innerHTML = loginLogs.map(l => {
    const actionBadge = l.action === 'login' ? 'status-running' : 'status-open';
    const actionLabel = l.action === 'login' ? '登录' : '登出';
    return `
    <tr>
      <td>${l.id}</td>
      <td><strong>${escapeHtml(l.employee_id || '-')}</strong></td>
      <td>${escapeHtml(l.name || '-')}</td>
      <td><span class="status-badge ${actionBadge}">${actionLabel}</span></td>
      <td>${(l.login_time || '').substring(0, 19)}</td>
      <td>${escapeHtml(l.ip_address || '-')}</td>
    </tr>`;
  }).join('');
}

// ===== 仪表盘 =====
const _chartLabels = ['运行中', '停机', '待机', '保养维护中', '异常待处理', '维修中', '备用'];
const _chartStatuses = ['running', 'down', 'idle', 'maintenance', 'abnormal_pending', 'repairing', 'standby'];
const _chartColors = ['#059669', '#dc2626', '#2563eb', '#d97706', '#dc2626', '#d97706', '#64748b'];

async function loadDashboard() {
  try {
    dashboardData = await apiCall('GET', '/dashboard');
    // 统计卡片
    document.getElementById('statTotalMachines').textContent = dashboardData.totalMachines;
    document.getElementById('statTotalLtMachines').textContent = dashboardData.totalLtMachines;
    document.getElementById('statTotalLots').textContent = dashboardData.totalLots;
    document.getElementById('statTotalSignIns').textContent = dashboardData.totalSignIns;

    // 图表（Chart.js未加载时跳过，不影响其他功能）
    if (typeof Chart !== 'undefined') {
      renderMachineStatusChart('machineChart', dashboardData.machineStats, machineChart, (chart) => { machineChart = chart; });
    }
    // 机台状态图总量标注
    const chartTotalEl = document.getElementById('machineChartTotal');
    if (chartTotalEl) {
      const sum = (dashboardData.machineStats || []).reduce((a, s) => a + (s.count || 0), 0);
      chartTotalEl.textContent = sum;
    }

    // 数据概览列表
    renderLotSummary();
    // 高优先级提醒
    renderAlerts();
    // 高优先级提醒数量标注
    const alertCountEl = document.getElementById('alertCount');
    if (alertCountEl) {
      const high = dailyHandovers.filter(h => h.priority === 'high' && h.status !== 'closed').length;
      alertCountEl.textContent = high + ' 条';
    }
  } catch (e) { console.error('Dashboard error:', e); showToast('仪表盘加载失败', 'error'); }
}

function renderMachineStatusChart(canvasId, stats, existingChart, setter) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const data = _chartLabels.map((_, i) => {
    const found = stats.find(s => s.status === _chartStatuses[i]);
    return found ? found.count : 0;
  });
  if (existingChart) existingChart.destroy();
  setter(new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels: _chartLabels, datasets: [{ data, backgroundColor: _chartColors, borderColor: '#e8eef5', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#334155', font: { size: 12, weight: '600' }, padding: 10 } } } }
  }));
}

function renderLotSummary() {
  const body = document.getElementById('lotSummaryBody');
  const countEl = document.getElementById('lotSummaryCount');
  const lots = dashboardData.recentLots || [];
  countEl.textContent = dashboardData.totalLots || 0;
  if (lots.length === 0) { body.innerHTML = '<div class="empty-state">暂无LOT交接数据</div>'; return; }
  body.innerHTML = lots.map(lot => `
    <div class="dash-summary-item">
      <div class="dash-summary-main">
        <span class="dash-summary-tag">${escapeHtml(lot.lot_id)}</span>
        <span class="dash-summary-text">${stripHtml(lot.detail).substring(0, 60)}${stripHtml(lot.detail).length > 60 ? '...' : ''}</span>
      </div>
      <span class="dash-summary-time">${(lot.updated_at || '').substring(0, 10)}</span>
    </div>
  `).join('');
}

function renderAlerts() {
  const alertList = document.getElementById('alertList');
  const highPriority = dailyHandovers.filter(h => h.priority === 'high' && h.status !== 'closed');
  if (highPriority.length === 0) {
    alertList.innerHTML = '<div class="empty-state">暂无高优先级事项</div>';
    return;
  }
  alertList.innerHTML = highPriority.map(h => `
    <div class="alert-item">
      <div class="alert-priority high"></div>
      <div class="alert-content">
        <div class="alert-title">${stripHtml(h.title)}</div>
        <div class="alert-desc">${stripHtml(h.content).substring(0, 80)}${stripHtml(h.content).length > 80 ? '...' : ''}</div>
      </div>
      <div class="alert-date">${escapeHtml(h.due_date || (h.created_at ? h.created_at.substring(0, 10) : ''))}</div>
    </div>
  `).join('');
}

// ===== 机台状态 CRUD =====
async function loadMachines() {
  try {
    machines = await apiCall('GET', '/machines');
    _cachedFilteredMachineIds = null;
    updateOwnerList();
    updateMachineNameList();
    renderMachineTable();
  } catch (e) { console.error('Load machines error:', e); showToast('机台数据加载失败', 'error'); }
}

// 更新 Owner 下拉选项（去重）- 缓存列表避免每次按键重新计算
let _ownerListCache = [];
let _machineNameListCache = [];

function getOwnerList() {
  return _ownerListCache || [];
}

function updateOwnerList() {
  _ownerListCache = [...new Set(machines.map(m => m.owner).filter(o => o && o.trim()))].sort();
  renderOwnerDropdown('');
}

// 渲染 Owner 下拉面板
function renderOwnerDropdown(filter) {
  const dropdown = document.getElementById('ownerDropdown');
  if (!dropdown) return;
  // 过滤掉待删除的 owner（仅在保存后才真正删除）
  const owners = getOwnerList().filter(o => !pendingDeleteOwners.includes(o));
  const filtered = filter
    ? owners.filter(o => o.toLowerCase().includes(filter.toLowerCase()))
    : owners;

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div class="owner-dropdown-empty">暂无 Owner 记录</div>';
    return;
  }

  dropdown.innerHTML = filtered.map(o => `
    <div class="owner-dropdown-item">
      <span class="owner-name" onclick="selectOwner('${o.replace(/'/g, "\\'")}')">${escapeHtml(o)}</span>
      <button type="button" class="owner-delete" onclick="event.stopPropagation(); deleteOwner('${o.replace(/'/g, "\\'")}')" title="删除此 Owner">&times;</button>
    </div>
  `).join('');
}

// 选择 Owner 填入输入框
function selectOwner(name) {
  const input = document.getElementById('mOwner');
  input.value = name;
  document.getElementById('ownerDropdown').classList.remove('active');
}

// 删除 Owner
// 待删除的 owner / 机台名称列表（保存机台时统一执行）
let pendingDeleteOwners = [];
let pendingDeleteMachineNames = [];

// 删除 Owner（延迟到保存时执行，不修改缓存）
function deleteOwner(name) {
  if (!pendingDeleteOwners.includes(name)) pendingDeleteOwners.push(name);
  // 从下拉列表 DOM 中移除显示（不修改缓存，取消时可恢复）
  const dropdown = document.getElementById('ownerDropdown');
  if (dropdown) {
    const items = dropdown.querySelectorAll('.owner-dropdown-item');
    items.forEach(item => {
      const nameSpan = item.querySelector('.owner-name');
      if (nameSpan && nameSpan.textContent.trim() === name) item.remove();
    });
  }
  showToast(`已移除 Owner「${name}」，保存后生效`);
}

// 删除机台名称（延迟到保存时执行，不修改缓存）
function deleteMachineName(name) {
  if (!pendingDeleteMachineNames.includes(name)) pendingDeleteMachineNames.push(name);
  // 从下拉列表 DOM 中移除显示（不修改缓存，取消时可恢复）
  const dropdown = document.getElementById('machineNameDropdown');
  if (dropdown) {
    const items = dropdown.querySelectorAll('.owner-dropdown-item');
    items.forEach(item => {
      const nameSpan = item.querySelector('.owner-name');
      if (nameSpan && nameSpan.textContent.trim() === name) item.remove();
    });
  }
  showToast(`已移除机台「${name}」，保存后生效`);
}

// 防抖工具函数
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Owner 输入框交互绑定
document.addEventListener('DOMContentLoaded', () => {
  const ownerInput = document.getElementById('mOwner');
  const dropdown = document.getElementById('ownerDropdown');
  if (!ownerInput || !dropdown) return;

  const debouncedRender = debounce((val) => {
    renderOwnerDropdown(val);
    dropdown.classList.add('active');
  }, 150);

  ownerInput.addEventListener('focus', () => {
    renderOwnerDropdown(ownerInput.value);
    dropdown.classList.add('active');
  });
  ownerInput.addEventListener('input', () => {
    debouncedRender(ownerInput.value);
  });
  ownerInput.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.remove('active'), 200);
  });
});

// ===== 机台名称下拉（逻辑同 Owner） =====
function getMachineNameList() {
  return _machineNameListCache || [];
}

function updateMachineNameList() {
  _machineNameListCache = [...new Set(machines.map(m => m.machine_name).filter(n => n && n.trim()))].sort();
  renderMachineNameDropdown('');
}

function renderMachineNameDropdown(filter) {
  const dropdown = document.getElementById('machineNameDropdown');
  if (!dropdown) return;
  // 过滤掉待删除的机台名称（仅在保存后才真正删除）
  const names = getMachineNameList().filter(n => !pendingDeleteMachineNames.includes(n));
  const filtered = filter
    ? names.filter(n => n.toLowerCase().includes(filter.toLowerCase()))
    : names;

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div class="owner-dropdown-empty">暂无机台名称记录</div>';
    return;
  }

  dropdown.innerHTML = filtered.map(n => `
    <div class="owner-dropdown-item">
      <span class="owner-name" onclick="selectMachineName('${n.replace(/'/g, "\\'")}')">${escapeHtml(n)}</span>
      <button type="button" class="owner-delete" onclick="event.stopPropagation(); deleteMachineName('${n.replace(/'/g, "\\'")}')" title="删除此机台名称">&times;</button>
    </div>
  `).join('');
}

function selectMachineName(name) {
  const input = document.getElementById('mMachineName');
  input.value = name;
  document.getElementById('machineNameDropdown').classList.remove('active');
}

// 机台名称输入框交互绑定
document.addEventListener('DOMContentLoaded', () => {
  const nameInput = document.getElementById('mMachineName');
  const dropdown = document.getElementById('machineNameDropdown');
  if (!nameInput || !dropdown) return;

  const debouncedRender = debounce((val) => {
    renderMachineNameDropdown(val);
    dropdown.classList.add('active');
  }, 150);

  nameInput.addEventListener('focus', () => {
    renderMachineNameDropdown(nameInput.value);
    dropdown.classList.add('active');
  });
  nameInput.addEventListener('input', () => {
    debouncedRender(nameInput.value);
  });
  nameInput.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.remove('active'), 200);
  });
});

// ===== 机台排序 =====
let machineSortKey = 'shift';
let machineSortDir = 'desc'; // 'asc' | 'desc'

function applyMachineSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = (a[machineSortKey] || '').toString();
    const vb = (b[machineSortKey] || '').toString();
    // 班次特殊处理：拆分日期和班次类型
    if (machineSortKey === 'shift') {
      const pa = parseShiftValue(va);
      const pb = parseShiftValue(vb);
      // 先按日期排序
      if (pa.date !== pb.date) {
        if (machineSortDir === 'asc') return pa.date < pb.date ? -1 : 1;
        return pa.date < pb.date ? 1 : -1;
      }
      // 同一天：白班 < 夜班，降序时夜班在前
      const typeOrder = { '白班': 0, '夜班': 1 };
      const ta = typeOrder[pa.type] ?? 0;
      const tb = typeOrder[pb.type] ?? 0;
      return machineSortDir === 'asc' ? ta - tb : tb - ta;
    }
    if (va < vb) return machineSortDir === 'asc' ? -1 : 1;
    if (va > vb) return machineSortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function sortMachineTable(key) {
  if (machineSortKey === key) {
    machineSortDir = machineSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    machineSortKey = key;
    machineSortDir = 'asc';
  }
  // 更新表头样式
  document.querySelectorAll('#machineTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) {
      th.classList.add(machineSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
  renderMachineTable();
}

// ===== 机台批量选择 =====
let selectedMachineIds = new Set();
let _cachedFilteredMachineIds = null; // 缓存过滤后的ID列表

function toggleSelectAll(checked) {
  if (checked) {
    filteredMachineIds().forEach(id => selectedMachineIds.add(id));
  } else {
    selectedMachineIds.clear();
  }
  const head1 = document.getElementById('selectAllMachines');
  const head2 = document.getElementById('selectAllMachinesHead');
  if (head1) head1.checked = checked;
  if (head2) head2.checked = checked;
  renderMachineTable();
}

function filteredMachineIds() {
  // 如果缓存有效，直接返回
  if (_cachedFilteredMachineIds) return _cachedFilteredMachineIds;
  const search = document.getElementById('machineSearch').value.toLowerCase();
  const statusFilter = document.getElementById('machineStatusFilter').value;
  let filtered = machines.filter(m => {
    const matchSearch = !search ||
      m.machine_name.toLowerCase().includes(search) ||
      (m.owner || '').toLowerCase().includes(search);
    const matchStatus = !statusFilter || m.status === statusFilter;
    return matchSearch && matchStatus;
  });
  _cachedFilteredMachineIds = applyMachineSort(filtered).map(m => m.id);
  return _cachedFilteredMachineIds;
}

function toggleMachineSelect(id, checked) {
  if (checked) {
    selectedMachineIds.add(id);
  } else {
    selectedMachineIds.delete(id);
  }
  updateBatchCount();
}

function updateBatchCount() {
  const count = selectedMachineIds.size;
  const el = document.getElementById('batchCount');
  if (el) el.textContent = `已选 ${count} 项`;
  const visibleIds = new Set(filteredMachineIds());
  const allVisible = [...visibleIds].every(id => selectedMachineIds.has(id));
  const head1 = document.getElementById('selectAllMachines');
  const head2 = document.getElementById('selectAllMachinesHead');
  if (head1) head1.checked = allVisible && visibleIds.size > 0;
  if (head2) head2.checked = allVisible && visibleIds.size > 0;
}

function clearSelection() {
  selectedMachineIds.clear();
  const head1 = document.getElementById('selectAllMachines');
  const head2 = document.getElementById('selectAllMachinesHead');
  if (head1) head1.checked = false;
  if (head2) head2.checked = false;
  renderMachineTable();
}

async function batchUpdateProcessStatus() {
  if (selectedMachineIds.size === 0) {
    showToast('请先选择要操作的记录', 'error');
    return;
  }
  const newStatus = document.getElementById('batchProcessStatus').value;
  if (!newStatus) {
    showToast('请选择操作类型', 'error');
    return;
  }
  const ids = [...selectedMachineIds];

  // 删除选中记录（软删除，可撤销）
  if (newStatus === 'delete') {
    if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
    // 乐观更新：先从本地移除
    const removedItems = machines.filter(m => ids.includes(m.id)).map(m => ({ ...m }));
    machines = machines.filter(m => !ids.includes(m.id));
    selectedMachineIds.clear();
    document.getElementById('batchProcessStatus').value = '';
    _cachedFilteredMachineIds = null;
    renderMachineTable();
    try {
      const result = await apiCall('POST', '/machines/batch-delete', { ids });
      // 显示带撤销的 Toast
      showToastWithUndo(`已删除 ${result.changes} 条记录，可撤销`, async () => {
        try {
          await apiCall('POST', '/machines/batch-restore', { ids });
          showToast('已恢复删除的记录');
          await loadMachines();
        } catch (e) {
          showToast('恢复失败', 'error');
          await loadMachines();
        }
      });
    } catch (e) {
      // 失败回滚
      machines = [...machines, ...removedItems];
      renderMachineTable();
      showToast('批量删除失败', 'error');
    }
    return;
  }

  // 批量更新处理状态
  try {
    const result = await apiCall('POST', '/machines/batch-update-status', { ids, process_status: newStatus });
    showToast(result.message || `成功更新 ${result.changes} 条记录`);
    selectedMachineIds.clear();
    document.getElementById('batchProcessStatus').value = '';
    _cachedFilteredMachineIds = null;
    await loadMachines();
  } catch (e) {
    console.error('Batch update error:', e);
    showToast('批量更新失败', 'error');
  }
}

function renderMachineTable() {
  const tbody = document.getElementById('machineTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('machineSearch');
  const statusEl = document.getElementById('machineStatusFilter');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';
  const statusFilter = statusEl ? statusEl.value : '';

  let filtered = machines.filter(m => {
    const matchSearch = !search ||
      m.machine_name.toLowerCase().includes(search) ||
      (m.owner || '').toLowerCase().includes(search);
    const matchStatus = !statusFilter || m.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // 应用排序
  filtered = applyMachineSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">暂无机台数据，点击"新增机台"添加</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(m => `
    <tr class="clickable-row${m.process_status === 'closed' ? ' row-closed' : ''}${selectedMachineIds.has(m.id) ? ' row-selected' : ''}" onclick="showMachineDetail(${m.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedMachineIds.has(m.id) ? 'checked' : ''} onchange="toggleMachineSelect(${m.id}, this.checked)"></td>
      <td><strong>${escapeHtml(m.machine_name)}</strong></td>
      <td><span class="status-badge status-${escapeAttr(m.status)}">${STATUS_MAP.machine[m.status] || escapeHtml(m.status)}</span></td>
      <td>${escapeHtml(m.shift || '-')}</td>
      <td>${escapeHtml(m.owner || '-')}</td>
      <td class="td-alarm">${m.alarm_info ? `<div class="cell-expandable cell-html">${sanitizeHtml(m.alarm_info)}</div>` : '<span class="cell-empty">-</span>'}</td>
      <td class="td-remark">${m.remark ? `<div class="cell-expandable">${escapeHtml(m.remark)}</div>` : '<span class="cell-empty">-</span>'}</td>
      <td>${(() => {
        const imgs = parseImagePaths(m.image_path);
        if (imgs.length === 0) return `<div class="machine-thumb-placeholder"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`;
        return `<div class="multi-thumb-wrapper">
          <img class="machine-thumb" src="${escapeAttr(imgs[0])}" onclick="event.stopPropagation(); openLightboxGallery(${m.id})" title="点击查看图片" draggable="false">
          ${imgs.length > 1 ? `<span class="multi-thumb-count">${imgs.length}</span>` : ''}
        </div>`;
      })()}</td>
      <td><span class="status-badge status-${escapeAttr(m.process_status || 'pending')}">${STATUS_MAP.processStatus[m.process_status || 'pending']}</span></td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editMachine(${m.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteMachine(${m.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
  updateBatchCount();
}

function openMachineModal() {
  // 清空待删除列表
  pendingDeleteOwners = [];
  pendingDeleteMachineNames = [];
  imageContext = 'machine';
  document.getElementById('machineModalTitle').textContent = '新增机台';
  document.getElementById('machineEditId').value = '';
  document.getElementById('mMachineName').value = '';
  document.getElementById('mStatus').value = 'idle';
  document.getElementById('mProcessStatus').value = 'pending';
  const todayShift = getCurrentShift();
  document.getElementById('mShiftDate').value = getTodayDateStr();
  document.getElementById('mShiftType').value = todayShift;
  syncShiftCombo();
  document.getElementById('mOwner').value = '';
  document.getElementById('mAlarmInfo').innerHTML = 'R：\nA：\nF：';
  document.getElementById('mRemark').value = '';
  resetMachineImage();
  openModal('machineModal');
}

// ===== 机台交接信息富文本编辑 =====
function execAlarmCmd(command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById('mAlarmInfo').focus();
}

function setAlarmFontSize(size) {
  document.execCommand('fontSize', false, size);
  document.getElementById('mAlarmInfo').focus();
}

// 初始化机台交接信息编辑器聚焦
document.addEventListener('focusin', (e) => {
  if (e.target.id === 'mAlarmInfo' || e.target.id === 'lotHFollowUp') {
    e.target.classList.add('focused');
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target.id === 'mAlarmInfo' || e.target.id === 'lotHFollowUp') {
    e.target.classList.remove('focused');
  }
});

function editMachine(id) {
  const m = machines.find(x => x.id === id);
  if (!m) return;
  // 清空待删除列表（每次打开编辑都重新开始）
  pendingDeleteOwners = [];
  pendingDeleteMachineNames = [];
  imageContext = 'machine';
  document.getElementById('machineModalTitle').textContent = '编辑机台';
  document.getElementById('machineEditId').value = m.id;
  document.getElementById('mMachineName').value = m.machine_name;
  document.getElementById('mStatus').value = m.status;
  document.getElementById('mProcessStatus').value = m.process_status || 'pending';
  const shiftParts = parseShiftValue(m.shift);
  document.getElementById('mShiftDate').value = shiftParts.date;
  document.getElementById('mShiftType').value = shiftParts.type;
  syncShiftCombo();
  document.getElementById('mOwner').value = m.owner || '';
  document.getElementById('mAlarmInfo').innerHTML = m.alarm_info || '';
  document.getElementById('mRemark').value = m.remark || '';
  loadMachineImages(parseImagePaths(m.image_path));
  openModal('machineModal');
}

async function saveMachine() {
  syncShiftCombo();
  const id = document.getElementById('machineEditId').value;
  const data = {
    machine_name: document.getElementById('mMachineName').value.trim(),
    status: document.getElementById('mStatus').value,
    process_status: document.getElementById('mProcessStatus').value,
    shift: document.getElementById('mShift').value,
    owner: document.getElementById('mOwner').value.trim(),
    alarm_info: document.getElementById('mAlarmInfo').innerHTML.trim(),
    remark: document.getElementById('mRemark').value.trim(),
    image_path: document.getElementById('mImagePath').value || ''
  };
  if (!data.machine_name) { showToast('请填写机台名称', 'error'); return; }

  // 乐观更新：先关闭弹窗并更新本地数据
  closeModal('machineModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = machines.findIndex(m => m.id == id);
    if (idx >= 0) {
      machines[idx] = { ...machines[idx], ...data, updated_at: getChinaTimeStr() };
    }
  } else {
    // 新增：临时插入，等服务器返回真实ID
    const tempId = Date.now();
    machines.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  _cachedFilteredMachineIds = null;
  _ownerListCache = null;
  _machineNameListCache = null;
  renderMachineTable();
  showToast(isEdit ? '机台更新中...' : '机台创建中...', 'success');

  // 后台同步服务器
  try {
    if (isEdit) {
      await apiCall('PUT', `/machines/${id}`, data);
    } else {
      const result = await apiCall('POST', '/machines', data);
      // 用服务器返回的真实ID替换临时ID
      const idx = machines.findIndex(m => m.id === tempId);
      if (idx >= 0) machines[idx].id = result.id;
      renderMachineTable();
    }
    showToast(isEdit ? '机台更新成功' : '机台创建成功');
    // 执行待删除的 owner / 机台名称
    for (const owner of pendingDeleteOwners) {
      try { await apiCall('DELETE', `/machines/owner/${encodeURIComponent(owner)}`); } catch (e) {}
    }
    for (const name of pendingDeleteMachineNames) {
      try { await apiCall('DELETE', `/machines/name/${encodeURIComponent(name)}`); } catch (e) {}
    }
    // 清空待删除列表
    pendingDeleteOwners = [];
    pendingDeleteMachineNames = [];
    // 后台静默刷新，确保数据一致
    loadMachines();
  } catch (e) {
    // 失败时也清空待删除列表，避免重复操作
    pendingDeleteOwners = [];
    pendingDeleteMachineNames = [];
    showToast('操作失败，正在恢复数据', 'error');
    await loadMachines();
  }
}

async function deleteMachine(id) {
  pendingDelete = { type: 'machine', id };
  openModal('confirmModal');
}

// ===== 机台详情查看 =====
function showMachineDetail(id) {
  const m = machines.find(x => x.id === id);
  if (!m) return;

  const statusText = STATUS_MAP.machine[m.status] || m.status;
  const processStatusText = STATUS_MAP.processStatus[m.process_status || 'pending'];
  const shiftText = m.shift || '-';

  const infoRows = [
    { label: '机台名称', value: escapeHtml(m.machine_name) },
    { label: '机台状态', value: `<span class="status-badge status-${escapeAttr(m.status)}">${escapeHtml(statusText)}</span>` },
    { label: '处理状态', value: `<span class="status-badge status-${escapeAttr(m.process_status || 'pending')}">${escapeHtml(processStatusText)}</span>` },
    { label: '班次', value: escapeHtml(shiftText) },
    { label: '机台Owner', value: escapeHtml(m.owner || '-') },
    { label: '更新时间', value: escapeHtml(formatDateTime(m.updated_at) || '-') }
  ];

  const imagePaths = parseImagePaths(m.image_path);
  const imagePathsJson = JSON.stringify(imagePaths).replace(/'/g, "&#39;");
  const imageHtml = imagePaths.length > 0
    ? `<div class="detail-gallery">${imagePaths.map((p, i) => `<div class="detail-gallery-item"><img src="${escapeAttr(p)}" onclick='openLightboxArray(${imagePathsJson}, ${i})' title="点击查看大图" draggable="false"></div>`).join('')}</div>`
    : `<div class="detail-image-placeholder">
         <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         <span>暂无图片</span>
       </div>`;

  const alarmHtml = m.alarm_info
    ? `<div class="detail-alarm-content">${sanitizeHtml(m.alarm_info)}</div>`
    : `<div class="detail-remark-empty">暂无机台交接信息</div>`;
  const remarkHtml = m.remark
    ? `<div class="detail-remark-content">${escapeHtml(m.remark)}</div>`
    : `<div class="detail-remark-empty">暂无备注信息</div>`;

  document.getElementById('machineDetailBody').innerHTML = `
    <div class="detail-layout">
      <div class="detail-info-section">
        <div class="detail-info-grid">
          ${infoRows.map(r => `
            <div class="detail-info-item">
              <span class="detail-info-label">${r.label}</span>
              <span class="detail-info-value">${r.value}</span>
            </div>
          `).join('')}
        </div>
        <div class="detail-remark-section">
          <div class="detail-section-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            机台交接信息
          </div>
          ${alarmHtml}
        </div>
        <div class="detail-remark-section">
          <div class="detail-section-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            备注
          </div>
          ${remarkHtml}
        </div>
      </div>
      <div class="detail-image-section">
        <div class="detail-section-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          机台图片异常记录
        </div>
        ${imageHtml}
      </div>
    </div>
  `;

  document.getElementById('machineDetailEditBtn').onclick = () => {
    closeModal('machineDetailModal');
    editMachine(id);
  };
  openModal('machineDetailModal');
}

// ===== AR交接 CRUD（独立数据库，交互逻辑同机台长期交接） =====

// 富文本编辑器命令
function execArCmd(editorId, command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById(editorId).focus();
}

function setArFontSize(editorId, size) {
  document.execCommand('fontSize', false, size);
  document.getElementById(editorId).focus();
}

async function loadArHandovers() {
  try {
    arHandovers = await apiCall('GET', '/ar-handovers');
    _cachedArFilteredIds = null;
    renderArHandoverTable();
  } catch (e) { console.error('Load arHandovers error:', e); showToast('AR交接数据加载失败', 'error'); }
}

function applyArSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = (a[arSortKey] || '').toString();
    const vb = (b[arSortKey] || '').toString();
    if (arSortKey === 'updated_at') {
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return arSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    }
    const ta = va.replace(/<[^>]+>/g, '');
    const tb = vb.replace(/<[^>]+>/g, '');
    if (ta < tb) return arSortDir === 'asc' ? -1 : 1;
    if (ta > tb) return arSortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function sortArHandoverTable(key) {
  if (arSortKey === key) {
    arSortDir = arSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    arSortKey = key;
    arSortDir = 'asc';
  }
  document.querySelectorAll('#arHandoverTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) th.classList.add(arSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });
  _cachedArFilteredIds = null;
  renderArHandoverTable();
}

function filteredArIds() {
  if (_cachedArFilteredIds) return _cachedArFilteredIds;
  const search = document.getElementById('arHandoverSearch').value.toLowerCase();
  const statusFilter = document.getElementById('arHandoverStatusFilter').value;
  let filtered = arHandovers.filter(a => {
    const matchSearch = !search ||
      stripHtml(a.ar).toLowerCase().includes(search) ||
      stripHtml(a.owner_section).toLowerCase().includes(search);
    const matchStatus = !statusFilter || a.status === statusFilter;
    return matchSearch && matchStatus;
  });
  filtered = applyArSort(filtered);
  _cachedArFilteredIds = filtered.map(a => a.id);
  return _cachedArFilteredIds;
}

function toggleArSelect(id, checked) {
  if (checked) selectedArIds.add(id);
  else selectedArIds.delete(id);
  updateArBatchCount();
}

function toggleArSelectAll(checked) {
  if (checked) {
    filteredArIds().forEach(id => selectedArIds.add(id));
  } else {
    selectedArIds.clear();
  }
  renderArHandoverTable();
}

function updateArBatchCount() {
  const count = selectedArIds.size;
  document.getElementById('arBatchCount').textContent = `已选 ${count} 项`;
  const visibleIds = new Set(filteredArIds());
  const allVisible = [...visibleIds].every(id => selectedArIds.has(id));
  document.getElementById('arSelectAll').checked = allVisible;
  document.getElementById('arSelectAllHead').checked = allVisible;
}

function clearArSelection() {
  selectedArIds.clear();
  renderArHandoverTable();
}

async function batchDeleteArHandovers() {
  if (selectedArIds.size === 0) { showToast('请先选择要操作的记录', 'error'); return; }
  if (!confirm(`确定要删除选中的 ${selectedArIds.size} 条记录吗？`)) return;
  const ids = [...selectedArIds];
  const removedItems = arHandovers.filter(a => ids.includes(a.id)).map(a => ({ ...a }));
  arHandovers = arHandovers.filter(a => !ids.includes(a.id));
  selectedArIds.clear();
  _cachedArFilteredIds = null;
  renderArHandoverTable();
  try {
    await apiCall('POST', '/ar-handovers/batch-delete', { ids });
    showToastWithUndo(`已删除 ${ids.length} 条记录，可撤销`, async () => {
      try {
        await apiCall('POST', '/ar-handovers/batch-restore', { ids });
        await loadArHandovers();
      } catch (e) { showToast('恢复失败', 'error'); await loadArHandovers(); }
    });
    setTimeout(() => loadArHandovers(), 100);
  } catch (e) {
    showToast('删除失败，正在恢复', 'error');
    arHandovers = [...arHandovers, ...removedItems];
    _cachedArFilteredIds = null;
    renderArHandoverTable();
  }
}

function renderArHandoverTable() {
  const tbody = document.getElementById('arHandoverTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('arHandoverSearch');
  const statusEl = document.getElementById('arHandoverStatusFilter');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';
  const statusFilter = statusEl ? statusEl.value : '';

  let filtered = arHandovers.filter(a => {
    const matchSearch = !search ||
      stripHtml(a.ar).toLowerCase().includes(search) ||
      stripHtml(a.owner_section).toLowerCase().includes(search);
    const matchStatus = !statusFilter || a.status === statusFilter;
    return matchSearch && matchStatus;
  });

  filtered = applyArSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">暂无AR交接数据，点击"新增AR"添加</td></tr>`;
    updateArBatchCount();
    return;
  }

  tbody.innerHTML = filtered.map((a, i) => `
    <tr class="clickable-row${a.status === 'closed' ? ' row-closed' : ''}${selectedArIds.has(a.id) ? ' row-selected' : ''}" onclick="showArHandoverDetail(${a.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedArIds.has(a.id) ? 'checked' : ''} onchange="toggleArSelect(${a.id}, this.checked)"></td>
      <td style="text-align:center;"><strong>${i + 1}</strong></td>
      <td>${escapeHtml(a.date || '-')}</td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(a.ar) || '<span class="cell-empty">-</span>'}</div></td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(a.owner_section) || '<span class="cell-empty">-</span>'}</div></td>
      <td>${escapeHtml(a.due_date || '-')}</td>
      <td><span class="status-badge ${a.status === 'closed' ? 'status-resolved' : (a.status === 'in_progress' ? 'status-in_progress' : (a.status === 'resolved' ? 'status-resolved' : 'status-open'))}">${STATUS_MAP.handover[a.status] || escapeHtml(a.status) || '待处理'}</span></td>
      <td>${escapeHtml((a.updated_at || '').substring(0, 16))}</td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editArHandover(${a.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteArHandover(${a.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
  updateArBatchCount();
}

function openArHandoverModal() {
  document.getElementById('arHandoverModalTitle').textContent = '新增AR交接';
  document.getElementById('arEditId').value = '';
  document.getElementById('arDate').value = '';
  document.getElementById('arDueDate').value = '';
  document.getElementById('arStatus').value = 'open';
  document.getElementById('arContent').innerHTML = '';
  document.getElementById('arOwnerSection').innerHTML = '';
  openModal('arHandoverModal');
}

function editArHandover(id) {
  const a = arHandovers.find(x => x.id === id);
  if (!a) return;
  document.getElementById('arHandoverModalTitle').textContent = '编辑AR交接';
  document.getElementById('arEditId').value = a.id;
  document.getElementById('arDate').value = a.date || '';
  document.getElementById('arDueDate').value = a.due_date || '';
  document.getElementById('arStatus').value = a.status || 'open';
  document.getElementById('arContent').innerHTML = sanitizeHtml(a.ar) || '';
  document.getElementById('arOwnerSection').innerHTML = sanitizeHtml(a.owner_section) || '';
  openModal('arHandoverModal');
}

async function saveArHandover() {
  const id = document.getElementById('arEditId').value;
  const data = {
    date: document.getElementById('arDate').value || '',
    ar: document.getElementById('arContent').innerHTML.trim(),
    owner_section: document.getElementById('arOwnerSection').innerHTML.trim(),
    due_date: document.getElementById('arDueDate').value || '',
    status: document.getElementById('arStatus').value
  };

  closeModal('arHandoverModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = arHandovers.findIndex(a => a.id == id);
    if (idx >= 0) arHandovers[idx] = { ...arHandovers[idx], ...data, updated_at: getChinaTimeStr() };
  } else {
    const tempId = Date.now();
    arHandovers.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  _cachedArFilteredIds = null;
  renderArHandoverTable();
  showToast(isEdit ? 'AR更新中...' : 'AR创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/ar-handovers/${id}`, data);
    } else {
      const result = await apiCall('POST', '/ar-handovers', data);
      const idx = arHandovers.findIndex(a => a.id === tempId);
      if (idx >= 0) arHandovers[idx].id = result.id;
      renderArHandoverTable();
    }
    showToast(isEdit ? 'AR更新成功' : 'AR创建成功');
    loadArHandovers();
  } catch (e) {
    showToast('操作失败，正在恢复', 'error');
    await loadArHandovers();
  }
}

async function deleteArHandover(id) {
  pendingDelete = { type: 'ar-handover', id };
  openModal('confirmModal');
}

function showArHandoverDetail(id) {
  const a = arHandovers.find(x => x.id === id);
  if (!a) return;

  const body = document.getElementById('arHandoverDetailBody');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-row">
        <span class="detail-label">Date</span>
        <span class="detail-value">${escapeHtml(a.date || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Due date</span>
        <span class="detail-value">${escapeHtml(a.due_date || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <span class="detail-value"><span class="status-badge ${a.status === 'closed' ? 'status-resolved' : 'status-open'}">${a.status === 'closed' ? '已关闭' : escapeHtml(a.status || '待处理')}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">更新时间</span>
        <span class="detail-value">${escapeHtml(formatDateTime(a.updated_at) || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">AR</span>
        <span class="detail-value cell-html">${sanitizeHtml(a.ar) || '-'}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">Owner-Section</span>
        <span class="detail-value cell-html">${sanitizeHtml(a.owner_section) || '-'}</span>
      </div>
    </div>
  `;

  document.getElementById('arHandoverDetailEditBtn').onclick = () => {
    closeModal('arHandoverDetailModal');
    editArHandover(id);
  };
  openModal('arHandoverDetailModal');
}

// ===== 长期交接机台 CRUD（独立数据库，功能同机台近期交接） =====

async function loadLtMachines() {
  try {
    ltMachines = await apiCall('GET', '/long-term-machines');
    _cachedLtFilteredMachineIds = null;
    updateLtOwnerList();
    updateLtMachineNameList();
    renderLtMachineTable();
  } catch (e) { console.error('Load ltMachines error:', e); showToast('长期机台数据加载失败', 'error'); }
}

// ===== 长期机台 Owner 下拉 =====
let _ltOwnerListCache = [];
let _ltMachineNameListCache = [];
let pendingDeleteLtOwners = [];
let pendingDeleteLtMachineNames = [];

function getLtOwnerList() { return _ltOwnerListCache || []; }
function getLtMachineNameList() { return _ltMachineNameListCache || []; }

function updateLtOwnerList() {
  _ltOwnerListCache = [...new Set(ltMachines.map(m => m.owner).filter(o => o && o.trim()))].sort();
  renderLtOwnerDropdown('');
}

function updateLtMachineNameList() {
  _ltMachineNameListCache = [...new Set(ltMachines.map(m => m.machine_name).filter(n => n && n.trim()))].sort();
  renderLtMachineNameDropdown('');
}

function renderLtOwnerDropdown(filter) {
  const dropdown = document.getElementById('ltOwnerDropdown');
  if (!dropdown) return;
  const owners = getLtOwnerList().filter(o => !pendingDeleteLtOwners.includes(o));
  const filtered = filter ? owners.filter(o => o.toLowerCase().includes(filter.toLowerCase())) : owners;
  if (filtered.length === 0) { dropdown.innerHTML = '<div class="owner-dropdown-empty">暂无 Owner 记录</div>'; return; }
  dropdown.innerHTML = filtered.map(o => `
    <div class="owner-dropdown-item">
      <span class="owner-name" onclick="selectLtOwner('${o.replace(/'/g, "\\'")}')">${escapeHtml(o)}</span>
      <button type="button" class="owner-delete" onclick="event.stopPropagation(); deleteLtOwner('${o.replace(/'/g, "\\'")}')" title="删除此 Owner">&times;</button>
    </div>
  `).join('');
}

function selectLtOwner(name) {
  document.getElementById('ltMOwner').value = name;
  document.getElementById('ltOwnerDropdown').classList.remove('active');
}

function deleteLtOwner(name) {
  if (!pendingDeleteLtOwners.includes(name)) pendingDeleteLtOwners.push(name);
  const dropdown = document.getElementById('ltOwnerDropdown');
  if (dropdown) {
    dropdown.querySelectorAll('.owner-dropdown-item').forEach(item => {
      const nameSpan = item.querySelector('.owner-name');
      if (nameSpan && nameSpan.textContent.trim() === name) item.remove();
    });
  }
  showToast(`已移除 Owner「${name}」，保存后生效`);
}

function renderLtMachineNameDropdown(filter) {
  const dropdown = document.getElementById('ltMachineNameDropdown');
  if (!dropdown) return;
  const names = getLtMachineNameList().filter(n => !pendingDeleteLtMachineNames.includes(n));
  const filtered = filter ? names.filter(n => n.toLowerCase().includes(filter.toLowerCase())) : names;
  if (filtered.length === 0) { dropdown.innerHTML = '<div class="owner-dropdown-empty">暂无机台名称记录</div>'; return; }
  dropdown.innerHTML = filtered.map(n => `
    <div class="owner-dropdown-item">
      <span class="owner-name" onclick="selectLtMachineName('${n.replace(/'/g, "\\'")}')">${escapeHtml(n)}</span>
      <button type="button" class="owner-delete" onclick="event.stopPropagation(); deleteLtMachineName('${n.replace(/'/g, "\\'")}')" title="删除此机台名称">&times;</button>
    </div>
  `).join('');
}

function selectLtMachineName(name) {
  document.getElementById('ltMMachineName').value = name;
  document.getElementById('ltMachineNameDropdown').classList.remove('active');
}

function deleteLtMachineName(name) {
  if (!pendingDeleteLtMachineNames.includes(name)) pendingDeleteLtMachineNames.push(name);
  const dropdown = document.getElementById('ltMachineNameDropdown');
  if (dropdown) {
    dropdown.querySelectorAll('.owner-dropdown-item').forEach(item => {
      const nameSpan = item.querySelector('.owner-name');
      if (nameSpan && nameSpan.textContent.trim() === name) item.remove();
    });
  }
  showToast(`已移除机台「${name}」，保存后生效`);
}

// ===== 长期机台排序 =====
let ltMachineSortKey = 'shift';
let ltMachineSortDir = 'desc';

function applyLtMachineSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = (a[ltMachineSortKey] || '').toString();
    const vb = (b[ltMachineSortKey] || '').toString();
    if (ltMachineSortKey === 'shift') {
      // 预计到期时间：直接使用日期字符串比较，空值排到最后
      if (!va && !vb) return 0;
      if (!va) return 1; // 空值排最后
      if (!vb) return -1;
      if (ltMachineSortDir === 'asc') return va < vb ? -1 : va > vb ? 1 : 0;
      return va > vb ? -1 : va < vb ? 1 : 0;
    }
    if (va < vb) return ltMachineSortDir === 'asc' ? -1 : 1;
    if (va > vb) return ltMachineSortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function sortLtMachineTable(key) {
  if (ltMachineSortKey === key) {
    ltMachineSortDir = ltMachineSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    ltMachineSortKey = key;
    ltMachineSortDir = 'asc';
  }
  document.querySelectorAll('#ltMachineTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) th.classList.add(ltMachineSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });
  _cachedLtFilteredMachineIds = null;
  renderLtMachineTable();
}

// ===== 长期机台批量选择 =====
let selectedLtMachineIds = new Set();
let _cachedLtFilteredMachineIds = null;

function toggleLtSelectAll(checked) {
  if (checked) {
    filteredLtMachineIds().forEach(id => selectedLtMachineIds.add(id));
  } else {
    selectedLtMachineIds.clear();
  }
  const head1 = document.getElementById('ltSelectAllMachines');
  const head2 = document.getElementById('ltSelectAllMachinesHead');
  if (head1) head1.checked = checked;
  if (head2) head2.checked = checked;
  renderLtMachineTable();
}

function filteredLtMachineIds() {
  if (_cachedLtFilteredMachineIds) return _cachedLtFilteredMachineIds;
  const searchEl = document.getElementById('ltMachineSearch');
  const statusEl = document.getElementById('ltMachineStatusFilter');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';
  const statusFilter = statusEl ? statusEl.value : '';
  let filtered = ltMachines.filter(m => {
    const matchSearch = !search ||
      m.machine_name.toLowerCase().includes(search) ||
      (m.owner || '').toLowerCase().includes(search);
    const matchStatus = !statusFilter || m.status === statusFilter;
    return matchSearch && matchStatus;
  });
  _cachedLtFilteredMachineIds = applyLtMachineSort(filtered).map(m => m.id);
  return _cachedLtFilteredMachineIds;
}

function toggleLtMachineSelect(id, checked) {
  if (checked) selectedLtMachineIds.add(id);
  else selectedLtMachineIds.delete(id);
  updateLtBatchCount();
}

function updateLtBatchCount() {
  const count = selectedLtMachineIds.size;
  const el = document.getElementById('ltBatchCount');
  if (el) el.textContent = `已选 ${count} 项`;
  const visibleIds = new Set(filteredLtMachineIds());
  const allVisible = [...visibleIds].every(id => selectedLtMachineIds.has(id));
  const head1 = document.getElementById('ltSelectAllMachines');
  const head2 = document.getElementById('ltSelectAllMachinesHead');
  if (head1) head1.checked = allVisible && visibleIds.size > 0;
  if (head2) head2.checked = allVisible && visibleIds.size > 0;
}

function clearLtSelection() {
  selectedLtMachineIds.clear();
  const head1 = document.getElementById('ltSelectAllMachines');
  const head2 = document.getElementById('ltSelectAllMachinesHead');
  if (head1) head1.checked = false;
  if (head2) head2.checked = false;
  renderLtMachineTable();
}

async function batchUpdateLtProcessStatus() {
  if (selectedLtMachineIds.size === 0) { showToast('请先选择要操作的记录', 'error'); return; }
  const newStatus = document.getElementById('ltBatchProcessStatus').value;
  if (!newStatus) { showToast('请选择操作类型', 'error'); return; }
  const ids = [...selectedLtMachineIds];

  if (newStatus === 'delete') {
    if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
    const removedItems = ltMachines.filter(m => ids.includes(m.id)).map(m => ({ ...m }));
    ltMachines = ltMachines.filter(m => !ids.includes(m.id));
    selectedLtMachineIds.clear();
    document.getElementById('ltBatchProcessStatus').value = '';
    _cachedLtFilteredMachineIds = null;
    renderLtMachineTable();
    try {
      const result = await apiCall('POST', '/long-term-machines/batch-delete', { ids });
      showToastWithUndo(`已删除 ${result.changes} 条记录，可撤销`, async () => {
        try {
          await apiCall('POST', '/long-term-machines/batch-restore', { ids });
          showToast('已恢复删除的记录');
          await loadLtMachines();
        } catch (e) { showToast('恢复失败', 'error'); await loadLtMachines(); }
      });
    } catch (e) {
      ltMachines = [...ltMachines, ...removedItems];
      renderLtMachineTable();
      showToast('批量删除失败', 'error');
    }
    return;
  }

  try {
    const result = await apiCall('POST', '/long-term-machines/batch-update-status', { ids, process_status: newStatus });
    showToast(result.message || `成功更新 ${result.changes} 条记录`);
    selectedLtMachineIds.clear();
    document.getElementById('ltBatchProcessStatus').value = '';
    _cachedLtFilteredMachineIds = null;
    await loadLtMachines();
  } catch (e) { showToast('批量更新失败', 'error'); }
}

// ===== 长期机台表格渲染 =====
function renderLtMachineTable() {
  const tbody = document.getElementById('ltMachineTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('ltMachineSearch');
  const statusEl = document.getElementById('ltMachineStatusFilter');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';
  const statusFilter = statusEl ? statusEl.value : '';

  let filtered = ltMachines.filter(m => {
    const matchSearch = !search ||
      m.machine_name.toLowerCase().includes(search) ||
      (m.owner || '').toLowerCase().includes(search);
    const matchStatus = !statusFilter || m.status === statusFilter;
    return matchSearch && matchStatus;
  });

  filtered = applyLtMachineSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">暂无机台数据，点击"新增机台"添加</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(m => `
    <tr class="clickable-row${m.process_status === 'closed' ? ' row-closed' : ''}${selectedLtMachineIds.has(m.id) ? ' row-selected' : ''}" onclick="showLtMachineDetail(${m.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedLtMachineIds.has(m.id) ? 'checked' : ''} onchange="toggleLtMachineSelect(${m.id}, this.checked)"></td>
      <td><strong>${escapeHtml(m.machine_name)}</strong></td>
      <td><span class="status-badge status-${escapeAttr(m.status)}">${STATUS_MAP.machine[m.status] || escapeHtml(m.status)}</span></td>
      <td>${escapeHtml(m.shift || '-')}</td>
      <td>${escapeHtml(m.owner || '-')}</td>
      <td class="td-alarm">${m.alarm_info ? `<div class="cell-expandable cell-html">${sanitizeHtml(m.alarm_info)}</div>` : '<span class="cell-empty">-</span>'}</td>
      <td class="td-remark">${m.remark ? `<div class="cell-expandable">${escapeHtml(m.remark)}</div>` : '<span class="cell-empty">-</span>'}</td>
      <td>${(() => {
        const imgs = parseImagePaths(m.image_path);
        if (imgs.length === 0) return `<div class="machine-thumb-placeholder"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`;
        return `<div class="multi-thumb-wrapper">
          <img class="machine-thumb" src="${escapeAttr(imgs[0])}" onclick="event.stopPropagation(); openLtLightboxGallery(${m.id})" title="点击查看图片" draggable="false">
          ${imgs.length > 1 ? `<span class="multi-thumb-count">${imgs.length}</span>` : ''}
        </div>`;
      })()}</td>
      <td><span class="status-badge status-${escapeAttr(m.process_status || 'pending')}">${STATUS_MAP.processStatus[m.process_status || 'pending']}</span></td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editLtMachine(${m.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteLtMachine(${m.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
  updateLtBatchCount();
}

// ===== 长期机台弹窗 =====
function openLtMachineModal() {
  pendingDeleteLtOwners = [];
  pendingDeleteLtMachineNames = [];
  document.getElementById('ltMachineModalTitle').textContent = '新增机台';
  document.getElementById('ltMachineEditId').value = '';
  document.getElementById('ltMMachineName').value = '';
  document.getElementById('ltMStatus').value = 'idle';
  document.getElementById('ltMProcessStatus').value = 'pending';
  document.getElementById('ltMShiftDate').value = '';
  syncLtShiftCombo();
  document.getElementById('ltMOwner').value = '';
  document.getElementById('ltMAlarmInfo').innerHTML = 'R：\nA：\nF：';
  document.getElementById('ltMRemark').value = '';
  imageContext = 'ltMachine';
  resetLtMachineImage();
  openModal('ltMachineModal');
}

function syncLtShiftCombo() {
  const date = document.getElementById('ltMShiftDate').value;
  document.getElementById('ltMShift').value = date || '';
}

function execLtAlarmCmd(command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById('ltMAlarmInfo').focus();
}

function setLtAlarmFontSize(size) {
  document.execCommand('fontSize', false, size);
  document.getElementById('ltMAlarmInfo').focus();
}

function editLtMachine(id) {
  const m = ltMachines.find(x => x.id === id);
  if (!m) return;
  pendingDeleteLtOwners = [];
  pendingDeleteLtMachineNames = [];
  document.getElementById('ltMachineModalTitle').textContent = '编辑机台';
  document.getElementById('ltMachineEditId').value = m.id;
  document.getElementById('ltMMachineName').value = m.machine_name;
  document.getElementById('ltMStatus').value = m.status;
  document.getElementById('ltMProcessStatus').value = m.process_status || 'pending';
  // 预计到期时间：直接取日期部分，兼容纯日期和旧格式（"2026-08-20 白班"）
  const ltShiftVal = (m.shift || '').trim();
  document.getElementById('ltMShiftDate').value = ltShiftVal ? ltShiftVal.split(/\s+/)[0] : '';
  syncLtShiftCombo();
  document.getElementById('ltMOwner').value = m.owner || '';
  document.getElementById('ltMAlarmInfo').innerHTML = m.alarm_info || '';
  document.getElementById('ltMRemark').value = m.remark || '';
  imageContext = 'ltMachine';
  loadLtMachineImages(parseImagePaths(m.image_path));
  openModal('ltMachineModal');
}

async function saveLtMachine() {
  syncLtShiftCombo();
  const id = document.getElementById('ltMachineEditId').value;
  const data = {
    machine_name: document.getElementById('ltMMachineName').value.trim(),
    status: document.getElementById('ltMStatus').value,
    process_status: document.getElementById('ltMProcessStatus').value,
    shift: document.getElementById('ltMShift').value,
    owner: document.getElementById('ltMOwner').value.trim(),
    alarm_info: document.getElementById('ltMAlarmInfo').innerHTML.trim(),
    remark: document.getElementById('ltMRemark').value.trim(),
    image_path: document.getElementById('ltMImagePath').value || ''
  };
  if (!data.machine_name) { showToast('请填写机台名称', 'error'); return; }

  closeModal('ltMachineModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = ltMachines.findIndex(m => m.id == id);
    if (idx >= 0) ltMachines[idx] = { ...ltMachines[idx], ...data, updated_at: getChinaTimeStr() };
  } else {
    const tempId = Date.now();
    ltMachines.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  _cachedLtFilteredMachineIds = null;
  _ltOwnerListCache = null;
  _ltMachineNameListCache = null;
  renderLtMachineTable();
  showToast(isEdit ? '机台更新中...' : '机台创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/long-term-machines/${id}`, data);
    } else {
      const result = await apiCall('POST', '/long-term-machines', data);
      const idx = ltMachines.findIndex(m => m.id === tempId);
      if (idx >= 0) ltMachines[idx].id = result.id;
      renderLtMachineTable();
    }
    showToast(isEdit ? '机台更新成功' : '机台创建成功');
    // 执行待删除的 owner / 机台名称
    for (const owner of pendingDeleteLtOwners) {
      try { await apiCall('DELETE', `/long-term-machines/owner/${encodeURIComponent(owner)}`); } catch (e) {}
    }
    for (const name of pendingDeleteLtMachineNames) {
      try { await apiCall('DELETE', `/long-term-machines/name/${encodeURIComponent(name)}`); } catch (e) {}
    }
    pendingDeleteLtOwners = [];
    pendingDeleteLtMachineNames = [];
    loadLtMachines();
  } catch (e) {
    pendingDeleteLtOwners = [];
    pendingDeleteLtMachineNames = [];
    showToast('操作失败，正在恢复数据', 'error');
    await loadLtMachines();
  }
}

async function deleteLtMachine(id) {
  pendingDelete = { type: 'lt-machine', id };
  openModal('confirmModal');
}

function showLtMachineDetail(id) {
  const m = ltMachines.find(x => x.id === id);
  if (!m) return;

  const statusText = STATUS_MAP.machine[m.status] || m.status;
  const processStatusText = STATUS_MAP.processStatus[m.process_status || 'pending'];
  const shiftText = m.shift || '-';

  const infoRows = [
    { label: '机台名称', value: escapeHtml(m.machine_name) },
    { label: '机台状态', value: `<span class="status-badge status-${escapeAttr(m.status)}">${escapeHtml(statusText)}</span>` },
    { label: '处理状态', value: `<span class="status-badge status-${escapeAttr(m.process_status || 'pending')}">${escapeHtml(processStatusText)}</span>` },
    { label: '预计到期时间', value: escapeHtml(shiftText) },
    { label: '机台Owner', value: escapeHtml(m.owner || '-') },
    { label: '更新时间', value: escapeHtml(formatDateTime(m.updated_at) || '-') }
  ];

  const imagePaths = parseImagePaths(m.image_path);
  const imagePathsJson = JSON.stringify(imagePaths).replace(/'/g, "&#39;");
  const imageHtml = imagePaths.length > 0
    ? `<div class="detail-gallery">${imagePaths.map((p, i) => `<div class="detail-gallery-item"><img src="${escapeAttr(p)}" onclick='openLightboxArray(${imagePathsJson}, ${i})' title="点击查看大图" draggable="false"></div>`).join('')}</div>`
    : `<div class="detail-image-placeholder"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>暂无图片</span></div>`;

  const alarmHtml = m.alarm_info ? `<div class="detail-alarm-content">${sanitizeHtml(m.alarm_info)}</div>` : `<div class="detail-remark-empty">暂无机台交接信息</div>`;
  const remarkHtml = m.remark ? `<div class="detail-remark-content">${escapeHtml(m.remark)}</div>` : `<div class="detail-remark-empty">暂无备注信息</div>`;

  document.getElementById('ltMachineDetailBody').innerHTML = `
    <div class="detail-layout">
      <div class="detail-info-section">
        <div class="detail-info-grid">
          ${infoRows.map(r => `<div class="detail-info-item"><span class="detail-info-label">${r.label}</span><span class="detail-info-value">${r.value}</span></div>`).join('')}
        </div>
        <div class="detail-remark-section">
          <div class="detail-section-title"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>机台交接信息</div>
          ${alarmHtml}
        </div>
        <div class="detail-remark-section">
          <div class="detail-section-title"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>备注</div>
          ${remarkHtml}
        </div>
      </div>
      <div class="detail-image-section">
        <div class="detail-section-title"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>机台图片异常记录</div>
        ${imageHtml}
      </div>
    </div>
  `;

  document.getElementById('ltMachineDetailEditBtn').onclick = () => {
    closeModal('ltMachineDetailModal');
    editLtMachine(id);
  };
  openModal('ltMachineDetailModal');
}

// 长期机台图片操作辅助函数
function resetLtMachineImage() {
  currentImages = [];
  syncImagePath();
  renderGallery();
}

function loadLtMachineImages(paths) {
  currentImages = Array.isArray(paths) ? [...paths] : [];
  syncImagePath();
  renderGallery();
}

function openLtLightboxGallery(machineId) {
  const m = ltMachines.find(x => x.id === machineId);
  if (!m) return;
  const imgs = parseImagePaths(m.image_path);
  if (imgs.length === 0) return;
  openLightboxArray(imgs, 0);
}

// 长期机台 Owner/Name 输入框交互绑定
document.addEventListener('DOMContentLoaded', () => {
  const ownerInput = document.getElementById('ltMOwner');
  const ownerDropdown = document.getElementById('ltOwnerDropdown');
  if (ownerInput && ownerDropdown) {
    const debouncedRender = debounce((val) => {
      renderLtOwnerDropdown(val);
      ownerDropdown.classList.add('active');
    }, 150);
    ownerInput.addEventListener('focus', () => {
      renderLtOwnerDropdown(ownerInput.value);
      ownerDropdown.classList.add('active');
    });
    ownerInput.addEventListener('input', () => debouncedRender(ownerInput.value));
    ownerInput.addEventListener('blur', () => setTimeout(() => ownerDropdown.classList.remove('active'), 200));
  }

  const nameInput = document.getElementById('ltMMachineName');
  const nameDropdown = document.getElementById('ltMachineNameDropdown');
  if (nameInput && nameDropdown) {
    const debouncedRender = debounce((val) => {
      renderLtMachineNameDropdown(val);
      nameDropdown.classList.add('active');
    }, 150);
    nameInput.addEventListener('focus', () => {
      renderLtMachineNameDropdown(nameInput.value);
      nameDropdown.classList.add('active');
    });
    nameInput.addEventListener('input', () => debouncedRender(nameInput.value));
    nameInput.addEventListener('blur', () => setTimeout(() => nameDropdown.classList.remove('active'), 200));
  }

  // 班次联动
  const ltShiftDate = document.getElementById('ltMShiftDate');
  const ltShiftType = document.getElementById('ltMShiftType');
  if (ltShiftDate) ltShiftDate.addEventListener('change', syncLtShiftCombo);
  if (ltShiftType) ltShiftType.addEventListener('change', syncLtShiftCombo);
});

// ===== LOT交接 CRUD（独立数据库，交互逻辑同机台近期交接） =====

// 排序状态
let lotHSortKey = 'updated_at';
let lotHSortDir = 'desc';

function applyLotHSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    let va = (a[lotHSortKey] || '').toString();
    let vb = (b[lotHSortKey] || '').toString();
    // 更新时间降序优先空值排末尾
    if (lotHSortKey === 'updated_at') {
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return lotHSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    }
    return lotHSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
  });
  return sorted;
}

function sortLotHTable(key) {
  if (lotHSortKey === key) {
    lotHSortDir = lotHSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    lotHSortKey = key;
    lotHSortDir = 'desc';
  }
  // 更新表头排序图标
  document.querySelectorAll('#lotHandoverTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    th.querySelector('.sort-icon').textContent = '';
  });
  const activeTh = document.querySelector(`#lotHandoverTable th[data-key="${key}"]`);
  if (activeTh) {
    activeTh.classList.add(lotHSortDir === 'desc' ? 'sorted-desc' : 'sorted-asc');
    const icon = activeTh.querySelector('.sort-icon');
    if (icon) icon.textContent = lotHSortDir === 'desc' ? '▼' : '▲';
  }
  renderLotHandoverTable();
}

async function loadLotHandovers() {
  try {
    lotHandovers = await apiCall('GET', '/lot-handovers');
    renderLotHandoverTable();
  } catch (e) { console.error('Load lot handovers error:', e); showToast('LOT交接数据加载失败', 'error'); }
}

function filteredLotHIds() {
  const search = document.getElementById('lotHandoverSearch').value.toLowerCase();
  return lotHandovers.filter(h => {
    const matchSearch = !search ||
      (h.lot_id || '').toLowerCase().includes(search) ||
      (h.detail || '').toLowerCase().includes(search) ||
      (h.comment || '').toLowerCase().includes(search) ||
      (h.follow_up || '').toLowerCase().includes(search);
    return matchSearch;
  }).map(h => h.id);
}

function renderLotHandoverTable() {
  const tbody = document.getElementById('lotHandoverTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('lotHandoverSearch');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';

  let filtered = lotHandovers.filter(h => {
    const matchSearch = !search ||
      (h.lot_id || '').toLowerCase().includes(search) ||
      (h.detail || '').toLowerCase().includes(search) ||
      (h.comment || '').toLowerCase().includes(search) ||
      (h.follow_up || '').toLowerCase().includes(search);
    return matchSearch;
  });

  filtered = applyLotHSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">暂无LOT交接数据，点击"新增交接"添加</td></tr>`;
    updateLotHBatchCount();
    return;
  }

  tbody.innerHTML = filtered.map(h => {
    const imgs = parseImagePaths(h.follow_up_images);
    const imgBadge = imgs.length > 0
      ? `<span class="img-count-pill" title="${imgs.length}张图片">📷 ${imgs.length}</span>`
      : '';
    const statusClass = h.status === 'closed' ? 'status-closed' : 'status-open';
    const statusLabel = h.status === 'closed' ? '已关闭' : (h.status === 'resolved' ? '已解决' : (h.status === 'in_progress' ? '处理中' : '待处理'));
    return `
    <tr class="clickable-row${h.status === 'closed' ? ' row-closed' : ''}${selectedLotHIds.has(h.id) ? ' row-selected' : ''}" onclick="showLotHandoverDetail(${h.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedLotHIds.has(h.id) ? 'checked' : ''} onchange="toggleLotHSelect(${h.id}, this.checked)"></td>
      <td><strong>${escapeHtml(h.lot_id || '-')}</strong></td>
      <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
      <td><div class="cell-expandable">${escapeHtml(h.detail || '-')}</div></td>
      <td><div class="cell-expandable">${escapeHtml(h.comment || '-')}</div></td>
      <td><div class="cell-expandable cell-html">${h.follow_up ? sanitizeHtml(h.follow_up) : '-'}${imgBadge}</div></td>
      <td>${(h.updated_at || '').substring(0, 16)}</td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editLotHandover(${h.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteLotHandover(${h.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
  updateLotHBatchCount();
}

// 批量选择
function toggleLotHSelectAll(checked) {
  if (checked) {
    filteredLotHIds().forEach(id => selectedLotHIds.add(id));
  } else {
    selectedLotHIds.clear();
  }
  renderLotHandoverTable();
}

function toggleLotHSelect(id, checked) {
  if (checked) selectedLotHIds.add(id);
  else selectedLotHIds.delete(id);
  renderLotHandoverTable();
}

function updateLotHBatchCount() {
  const countEl = document.getElementById('lotHBatchCount');
  if (countEl) countEl.textContent = `已选 ${selectedLotHIds.size} 项`;
}

function clearLotHSelection() {
  selectedLotHIds.clear();
  renderLotHandoverTable();
}

async function batchDeleteLotHandovers() {
  const ids = Array.from(selectedLotHIds);
  if (ids.length === 0) { showToast('请先选择要删除的记录', 'error'); return; }
  if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
  // 乐观删除
  const removedItems = [];
  ids.forEach(id => {
    const idx = lotHandovers.findIndex(h => h.id == id);
    if (idx >= 0) removedItems.push({ idx, item: lotHandovers.splice(idx, 1)[0] });
  });
  selectedLotHIds.clear();
  renderLotHandoverTable();
  showToast(`已删除 ${ids.length} 条记录，可撤销`, 'success');
  try {
    await apiCall('POST', '/lot-handovers/batch-delete', { ids });
    showToastWithUndo(`已删除 ${ids.length} 条记录，可撤销`, async () => {
      try {
        await apiCall('POST', '/lot-handovers/batch-restore', { ids });
        removedItems.reverse().forEach(({ idx, item }) => lotHandovers.splice(idx, 0, item));
        renderLotHandoverTable();
        showToast('已恢复删除的记录');
        loadLotHandovers();
      } catch (e) {
        showToast('恢复失败', 'error');
        loadLotHandovers();
      }
    });
  } catch (e) {
    // 回滚
    removedItems.reverse().forEach(({ idx, item }) => lotHandovers.splice(idx, 0, item));
    renderLotHandoverTable();
    showToast('删除失败', 'error');
  }
}

// 弹窗
function openLotHandoverModal() {
  imageContext = 'lotHandover';
  document.getElementById('lotHandoverModalTitle').textContent = '新增LOT交接';
  document.getElementById('lotHEditId').value = '';
  document.getElementById('lotHLotId').value = '';
  document.getElementById('lotHDetail').value = '';
  document.getElementById('lotHComment').value = '';
  document.getElementById('lotHFollowUp').innerHTML = '';
  document.getElementById('lotHFollowUpImages').value = '';
  currentImages = [];
  renderGallery();
  openModal('lotHandoverModal');
}

function editLotHandover(id) {
  const h = lotHandovers.find(x => x.id === id);
  if (!h) return;
  imageContext = 'lotHandover';
  document.getElementById('lotHandoverModalTitle').textContent = '编辑LOT交接';
  document.getElementById('lotHEditId').value = h.id;
  document.getElementById('lotHLotId').value = h.lot_id || '';
  document.getElementById('lotHStatus').value = h.status || 'open';
  document.getElementById('lotHDetail').value = h.detail || '';
  document.getElementById('lotHComment').value = h.comment || '';
  document.getElementById('lotHFollowUp').innerHTML = sanitizeHtml(h.follow_up) || '';
  document.getElementById('lotHFollowUpImages').value = h.follow_up_images || '';
  currentImages = parseImagePaths(h.follow_up_images);
  renderGallery();
  openModal('lotHandoverModal');
}

// Follow up 富文本编辑器命令
function execLotHCmd(command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById('lotHFollowUp').focus();
}

function setLotHFontSize(size) {
  document.execCommand('fontSize', false, size);
  document.getElementById('lotHFollowUp').focus();
}

async function saveLotHandover() {
  const id = document.getElementById('lotHEditId').value;
  const data = {
    lot_id: document.getElementById('lotHLotId').value.trim(),
    status: document.getElementById('lotHStatus').value,
    detail: document.getElementById('lotHDetail').value.trim(),
    comment: document.getElementById('lotHComment').value.trim(),
    follow_up: document.getElementById('lotHFollowUp').innerHTML.trim(),
    follow_up_images: document.getElementById('lotHFollowUpImages').value.trim()
  };
  if (!data.lot_id) { showToast('请填写 Lot ID', 'error'); return; }

  // 乐观更新
  closeModal('lotHandoverModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = lotHandovers.findIndex(h => h.id == id);
    if (idx >= 0) {
      lotHandovers[idx] = { ...lotHandovers[idx], ...data, updated_at: getChinaTimeStr() };
    }
  } else {
    const tempId = Date.now();
    lotHandovers.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  renderLotHandoverTable();
  showToast(isEdit ? '更新中...' : '创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/lot-handovers/${id}`, data);
    } else {
      const result = await apiCall('POST', '/lot-handovers', data);
      const idx = lotHandovers.findIndex(h => h.id === tempId);
      if (idx >= 0) lotHandovers[idx].id = result.id;
      renderLotHandoverTable();
    }
    showToast(isEdit ? 'LOT交接更新成功' : 'LOT交接创建成功');
    loadLotHandovers();
  } catch (e) {
    showToast('操作失败，正在恢复数据', 'error');
    await loadLotHandovers();
  }
}

async function deleteLotHandover(id) {
  pendingDelete = { type: 'lot-handover', id };
  openModal('confirmModal');
}

// LOT交接详情查看
function showLotHandoverDetail(id) {
  const h = lotHandovers.find(x => x.id === id);
  if (!h) return;

  const imagePaths = parseImagePaths(h.follow_up_images);
  const imagePathsJson = JSON.stringify(imagePaths).replace(/'/g, "&#39;");
  const imageHtml = imagePaths.length > 0
    ? `<div class="detail-gallery">${imagePaths.map((p, i) => `<div class="detail-gallery-item"><img src="${escapeAttr(p)}" onclick='openLightboxArray(${imagePathsJson}, ${i})' title="点击查看大图" draggable="false"></div>`).join('')}</div>`
    : `<div class="detail-image-placeholder">
         <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         <span>暂无图片</span>
       </div>`;

  const body = document.getElementById('lotHandoverDetailBody');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-row">
        <span class="detail-label">Lot ID</span>
        <span class="detail-value">${escapeHtml(h.lot_id || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">状态</span>
        <span class="detail-value"><span class="status-badge ${h.status === 'closed' ? 'status-closed' : 'status-open'}">${h.status === 'closed' ? '已关闭' : (h.status === 'resolved' ? '已解决' : (h.status === 'in_progress' ? '处理中' : '待处理'))}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">更新时间</span>
        <span class="detail-value">${escapeHtml(formatDateTime(h.updated_at) || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">Detail</span>
        <span class="detail-value">${escapeHtml(h.detail || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">Comment</span>
        <span class="detail-value">${escapeHtml(h.comment || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">Follow up</span>
        <div class="detail-value detail-alarm-content">${h.follow_up ? sanitizeHtml(h.follow_up) : '-'}</div>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">图片</span>
        <div class="detail-value">${imageHtml}</div>
      </div>
    </div>
  `;

  const editBtn = document.getElementById('lotHandoverDetailEditBtn');
  editBtn.onclick = () => {
    closeModal('lotHandoverDetailModal');
    editLotHandover(id);
  };
  openModal('lotHandoverDetailModal');
}

// ===== 交接签到表 CRUD（独立数据库，交互逻辑同机台长期交接） =====

const SIGN_IN_STATUS_MAP = {
  'present': '出席',
  'late': '迟到',
  'absent': '缺席',
  'leave': '请假',
  'night_shift': '夜班'
};

let signInSortKey = 'shift_time';
let signInSortDir = 'desc';

function applySignInSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = (a[signInSortKey] || '').toString();
    const vb = (b[signInSortKey] || '').toString();
    // 班次特殊处理：拆分日期和班次类型（与机台近期交接一致）
    if (signInSortKey === 'shift_time') {
      const pa = parseShiftValue(va);
      const pb = parseShiftValue(vb);
      // 先按日期排序
      if (pa.date !== pb.date) {
        if (signInSortDir === 'asc') return pa.date < pb.date ? -1 : 1;
        return pa.date < pb.date ? 1 : -1;
      }
      // 同一天：白班 < 夜班，降序时夜班在前
      const typeOrder = { '白班': 0, '夜班': 1 };
      const ta = typeOrder[pa.type] ?? 0;
      const tb = typeOrder[pb.type] ?? 0;
      return signInSortDir === 'asc' ? ta - tb : tb - ta;
    }
    if (signInSortKey === 'updated_at') {
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return signInSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    }
    return signInSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
  });
  return sorted;
}

function sortSignInTable(key) {
  if (signInSortKey === key) {
    signInSortDir = signInSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    signInSortKey = key;
    signInSortDir = 'desc';
  }
  document.querySelectorAll('#signInTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = '';
  });
  const activeTh = document.querySelector(`#signInTable th[data-key="${key}"]`);
  if (activeTh) {
    activeTh.classList.add(signInSortDir === 'desc' ? 'sorted-desc' : 'sorted-asc');
    const icon = activeTh.querySelector('.sort-icon');
    if (icon) icon.textContent = signInSortDir === 'desc' ? '▼' : '▲';
  }
  renderSignInTable();
}

async function loadSignInSheets() {
  try {
    signInSheets = await apiCall('GET', '/sign-in-sheets');
    renderSignInTable();
  } catch (e) { console.error('Load sign-in sheets error:', e); showToast('签到表数据加载失败', 'error'); }
}

function parseAttendees(attendeesStr) {
  try {
    const parsed = JSON.parse(attendeesStr || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function summarizeAttendees(attendees) {
  const summary = {};
  attendees.forEach(a => { summary[a.status] = (summary[a.status] || 0) + 1; });
  const parts = [];
  for (const [key, label] of Object.entries(SIGN_IN_STATUS_MAP)) {
    if (summary[key]) parts.push(`${label}:${summary[key]}`);
  }
  return parts.join(' / ') || '无记录';
}

function renderSignInTable() {
  const tbody = document.getElementById('signInTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('signInSearch');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';

  let filtered = signInSheets.filter(s => {
    const matchSearch = !search ||
      (s.shift_time || '').toLowerCase().includes(search) ||
      (s.location || '').toLowerCase().includes(search) ||
      (s.host || '').toLowerCase().includes(search);
    return matchSearch;
  });

  filtered = applySignInSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">暂无签到表数据，点击"新增签到表"添加</td></tr>`;
    updateSignInBatchCount();
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const attendees = parseAttendees(s.attendees);
    const count = attendees.length;
    const summary = summarizeAttendees(attendees);
    return `
    <tr class="clickable-row${selectedSignInIds.has(s.id) ? ' row-selected' : ''}" onclick="showSignInDetail(${s.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedSignInIds.has(s.id) ? 'checked' : ''} onchange="toggleSignInSelect(${s.id}, this.checked)"></td>
      <td><strong>${escapeHtml(s.shift_time || '-')}</strong></td>
      <td>${escapeHtml(s.location || '-')}</td>
      <td>${escapeHtml(s.host || '-')}</td>
      <td>${count}</td>
      <td><div class="cell-expandable">${escapeHtml(summary)}</div></td>
      <td>${(s.updated_at || '').substring(0, 16)}</td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editSignInSheet(${s.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteSignInSheet(${s.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
  updateSignInBatchCount();
}

// 批量选择
function toggleSignInSelectAll(checked) {
  if (checked) {
    const search = (document.getElementById('signInSearch').value || '').toLowerCase();
    signInSheets.filter(s => {
      const matchSearch = !search ||
        (s.shift_time || '').toLowerCase().includes(search) ||
        (s.location || '').toLowerCase().includes(search) ||
        (s.host || '').toLowerCase().includes(search);
      return matchSearch;
    }).forEach(s => selectedSignInIds.add(s.id));
  } else {
    selectedSignInIds.clear();
  }
  renderSignInTable();
}

function toggleSignInSelect(id, checked) {
  if (checked) selectedSignInIds.add(id);
  else selectedSignInIds.delete(id);
  renderSignInTable();
}

function updateSignInBatchCount() {
  const countEl = document.getElementById('signInBatchCount');
  if (countEl) countEl.textContent = `已选 ${selectedSignInIds.size} 项`;
}

function clearSignInSelection() {
  selectedSignInIds.clear();
  renderSignInTable();
}

async function batchDeleteSignInSheets() {
  const ids = Array.from(selectedSignInIds);
  if (ids.length === 0) { showToast('请先选择要删除的记录', 'error'); return; }
  if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
  const removedItems = [];
  ids.forEach(id => {
    const idx = signInSheets.findIndex(s => s.id == id);
    if (idx >= 0) removedItems.push({ idx, item: signInSheets.splice(idx, 1)[0] });
  });
  selectedSignInIds.clear();
  renderSignInTable();
  showToast(`已删除 ${ids.length} 条记录，可撤销`, 'success');
  try {
    await apiCall('POST', '/sign-in-sheets/batch-delete', { ids });
    showToastWithUndo(`已删除 ${ids.length} 条记录，可撤销`, async () => {
      try {
        await apiCall('POST', '/sign-in-sheets/batch-restore', { ids });
        removedItems.reverse().forEach(({ idx, item }) => signInSheets.splice(idx, 0, item));
        renderSignInTable();
        showToast('已恢复删除的记录');
        loadSignInSheets();
      } catch (e) {
        showToast('恢复失败', 'error');
        loadSignInSheets();
      }
    });
  } catch (e) {
    removedItems.reverse().forEach(({ idx, item }) => signInSheets.splice(idx, 0, item));
    renderSignInTable();
    showToast('删除失败', 'error');
  }
}

// 弹窗
function setModalTitle(elId, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  // 保留第一个子节点（图标 SVG），仅更新其后文本
  let textNode = null;
  el.childNodes.forEach(n => { if (n.nodeType === 3) textNode = n; });
  if (el.firstElementChild) {
    if (textNode) textNode.nodeValue = text;
    else el.appendChild(document.createTextNode(text));
  } else {
    el.textContent = text;
  }
}

function openSignInModal() {
  setModalTitle('signInModalTitle', '新增交接签到表');
  document.getElementById('signInEditId').value = '';
  // 班次默认：今天 + 当前班次类型
  document.getElementById('siShiftDate').value = getTodayDateStr();
  document.getElementById('siShiftType').value = getCurrentShift();
  document.getElementById('siLocation').value = '';
  document.getElementById('siHost').value = '';
  // 默认生成固定工程师列表，状态默认为"出席"
  currentAttendees = getEngineerList().map(name => ({ engineer: name, status: 'present' }));
  renderAttendeeTable();
  openModal('signInModal');
}

function editSignInSheet(id) {
  const s = signInSheets.find(x => x.id === id);
  if (!s) return;
  setModalTitle('signInModalTitle', '编辑交接签到表');
  document.getElementById('signInEditId').value = s.id;
  // 解析班次字符串为日期+类型
  const shiftParts = parseShiftValue(s.shift_time);
  document.getElementById('siShiftDate').value = shiftParts.date;
  document.getElementById('siShiftType').value = shiftParts.type;
  document.getElementById('siLocation').value = s.location || '';
  document.getElementById('siHost').value = s.host || '';
  currentAttendees = parseAttendees(s.attendees);
  if (currentAttendees.length === 0) {
    currentAttendees = getEngineerList().map(name => ({ engineer: name, status: 'present' }));
  }
  renderAttendeeTable();
  openModal('signInModal');
}

// 工程师列表管理（与机台长期交接的机台名称管理逻辑一致）
function getEngineerList() {
  if (_engineerListCache) return _engineerListCache;
  return signInEngineers.map(e => e.name);
}

async function loadSignInEngineers() {
  try {
    // 改为读取本部门人员（users 表同部门 active 用户），admin 返回全部
    const members = await apiCall('GET', '/sign-in-members');
    signInEngineers = members.map(m => ({ name: m.name, employee_id: m.employee_id }));
    _engineerListCache = members.map(m => m.name).sort();
    // 填充主持人下拉
    const hostSelect = document.getElementById('siHost');
    if (hostSelect) {
      const cur = hostSelect.value;
      hostSelect.innerHTML = '<option value="">请选择主持人</option>' + members.map(m =>
        `<option value="${escapeAttr(m.name)}">${escapeHtml(m.name)}${m.employee_id ? '（' + escapeHtml(m.employee_id) + '）' : ''}</option>`
      ).join('');
      if (cur) hostSelect.value = cur;
    }
  } catch (e) { console.error('Load members error:', e); showToast('人员列表加载失败', 'error'); }
}

// 到会人员管理 - 工程师列为本部门人员下拉（不允许自由输入）
function renderAttendeeTable() {
  const tbody = document.getElementById('attendeeTableBody');
  if (currentAttendees.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">暂无人员，点击"添加人员"</td></tr>`;
    return;
  }
  // 本部门成员：姓名（工号）
  const members = signInEngineers;
  const knownNames = new Set(members.map(m => m.name));
  // 历史数据可能含已不在本部门名单内的人员，需保留其姓名以便回显
  const extras = new Set();
  currentAttendees.forEach(a => { if (a.engineer && !knownNames.has(a.engineer)) extras.add(a.engineer); });
  const baseOpts = members.map(m =>
    `<option value="${escapeAttr(m.name)}">${escapeHtml(m.name)}${m.employee_id ? ' · ' + escapeHtml(m.employee_id) : ''}</option>`
  ).join('');
  const extraOpts = Array.from(extras).map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');

  tbody.innerHTML = currentAttendees.map((a, i) => `
    <tr>
      <td class="attendee-idx">${i + 1}</td>
      <td>
        <div class="attendee-field">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" class="attendee-field-icn"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <select class="attendee-select attendee-name-select" onchange="updateAttendee(${i}, 'engineer', this.value)">
            <option value="">请选择人员</option>${baseOpts}${extraOpts}
          </select>
        </div>
      </td>
      <td>
        <select class="attendee-select attendee-status-select status-${a.status || 'present'}" data-status="${a.status || 'present'}" onchange="updateAttendee(${i}, 'status', this.value)">
          ${Object.entries(SIGN_IN_STATUS_MAP).map(([k, v]) =>
            `<option value="${k}" data-dot="${k}" ${a.status === k ? 'selected' : ''}>${v}</option>`
          ).join('')}
        </select>
      </td>
      <td style="text-align:center;">
        <button class="action-btn delete" onclick="removeAttendee(${i})" title="删除">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
  // 回填当前选择
  document.querySelectorAll('.attendee-name-select').forEach((sel, i) => {
    if (currentAttendees[i] && currentAttendees[i].engineer) sel.value = currentAttendees[i].engineer;
  });
}

function addAttendeeRow() {
  currentAttendees.push({ engineer: '', status: 'present' });
  renderAttendeeTable();
  setTimeout(() => {
    const wrapper = document.querySelector('.minutes-table-wrapper');
    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    const selects = document.querySelectorAll('.attendee-name-select');
    if (selects.length > 0) selects[selects.length - 1].focus();
  }, 50);
}

function updateAttendee(index, field, value) {
  if (currentAttendees[index]) {
    currentAttendees[index][field] = value;
  }
  // 状态切换时同步更新状态下拉的色彩样式
  if (field === 'status') {
    const sel = document.querySelector(`#attendeeTableBody tr:nth-child(${index + 1}) .attendee-status-select`);
    if (sel) {
      sel.className = sel.className.replace(/status-\w+/g, '').trim() + ` status-${value}`;
      sel.dataset.status = value;
    }
  }
}

function removeAttendee(index) {
  currentAttendees.splice(index, 1);
  renderAttendeeTable();
}

async function saveSignInSheet() {
  const id = document.getElementById('signInEditId').value;
  const siDate = document.getElementById('siShiftDate').value || getTodayDateStr();
  const siType = document.getElementById('siShiftType').value || '白班';
  const shift_time = `${siDate} ${siType}`;
  const location = document.getElementById('siLocation').value.trim();
  const host = document.getElementById('siHost').value.trim();

  // ★ 捕获快照，防止 await 期间 currentAttendees 被 openSignInModal() 覆盖
  const attendeesSnapshot = currentAttendees.map(a => ({ engineer: a.engineer, status: a.status }));

  const attendees = JSON.stringify(attendeesSnapshot.filter(a => a.engineer.trim()));

  if (!shift_time) { showToast('请选择时间', 'error'); return; }

  const data = { shift_time, location, host, attendees };
  closeModal('signInModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = signInSheets.findIndex(s => s.id == id);
    if (idx >= 0) {
      signInSheets[idx] = { ...signInSheets[idx], ...data, updated_at: getChinaTimeStr() };
    }
  } else {
    const tempId = Date.now();
    signInSheets.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  renderSignInTable();
  showToast(isEdit ? '更新中...' : '创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/sign-in-sheets/${id}`, data);
    } else {
      const result = await apiCall('POST', '/sign-in-sheets', data);
      const idx = signInSheets.findIndex(s => s.id === tempId);
      if (idx >= 0) signInSheets[idx].id = result.id;
      renderSignInTable();
    }
    _engineerListCache = null;
    showToast(isEdit ? '签到表更新成功' : '签到表创建成功');
    loadSignInSheets();
  } catch (e) {
    showToast('操作失败，正在恢复数据', 'error');
    await loadSignInSheets();
  }
}

async function deleteSignInSheet(id) {
  pendingDelete = { type: 'sign-in', id };
  openModal('confirmModal');
}

// 签到表详情查看
function showSignInDetail(id) {
  const s = signInSheets.find(x => x.id === id);
  if (!s) return;

  const attendees = parseAttendees(s.attendees);
  const statusBadgeClass = {
    'present': 'signin-present',
    'late': 'signin-late',
    'absent': 'signin-absent',
    'leave': 'signin-leave',
    'night_shift': 'signin-night'
  };

  // 出席统计
  const counts = { present: 0, late: 0, absent: 0, leave: 0, night_shift: 0 };
  attendees.forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });
  const statConfig = {
    present: ['出席', counts.present, 'present', '\u2714'],
    late: ['迟到', counts.late, 'late', '\u23F3'],
    absent: ['缺席', counts.absent, 'absent', '\u2716'],
    leave: ['请假', counts.leave, 'leave', '...']
  };
  const statCards = Object.entries(statConfig).map(([k, v]) => `
    <div class="si-stat ${v[2]}">
      <span class="si-stat-label">${v[0]}</span>
      <span class="si-stat-num">${v[1]}</span>
    </div>
  `).join('');

  const attendeeRows = attendees.length > 0
    ? attendees.map((a, i) => `
      <tr>
        <td style="text-align:center;">${i + 1}</td>
        <td>${escapeHtml(a.engineer || '-')}</td>
        <td><span class="signin-status-badge ${statusBadgeClass[a.status] || ''}">${SIGN_IN_STATUS_MAP[a.status] || '-'}</span></td>
      </tr>
    `).join('')
    : `<tr><td colspan="3" class="empty-state">暂无到会人员</td></tr>`;

  const shiftParts = parseShiftValue(s.shift_time);
  const heroTitle = shiftParts.date || s.shift_time || '交接签到表';
  const heroSub = (shiftParts.type ? shiftParts.type + '班' : '') + (attendees.length ? ` · 共 ${attendees.length} 人` : '');

  const body = document.getElementById('signInDetailBody');
  body.innerHTML = `
    <div class="si-detail-wrap">
      <div class="si-hero">
        <div class="si-hero-main">
          <div class="si-hero-icn">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 15l2 2 4-4"/></svg>
          </div>
          <div>
            <div class="si-hero-shift">${escapeHtml(heroTitle)}</div>
            <div class="si-hero-sub">${escapeHtml(heroSub)}</div>
          </div>
        </div>
        <div class="si-hero-host">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
          <div>
            <span>主持</span><br>
            <b>${escapeHtml(s.host || '未指定')}</b>
          </div>
        </div>
      </div>

      <div class="si-stats">${statCards}</div>

      <div class="detail-grid">
        <div class="detail-row">
          <span class="detail-label">班次</span>
          <span class="detail-value">${escapeHtml(s.shift_time || '-')}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">地点</span>
          <span class="detail-value">${escapeHtml(s.location || '-')}</span>
        </div>
      </div>

      <div class="si-roster-card">
        <div class="detail-section-title">到会人员花名册 (${attendees.length}人)</div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:50px;">序号</th>
                <th>工程师</th>
                <th style="width:110px;">Status</th>
              </tr>
            </thead>
            <tbody>${attendeeRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const editBtn = document.getElementById('signInDetailEditBtn');
  editBtn.onclick = () => {
    closeModal('signInDetailModal');
    editSignInSheet(id);
  };
  openModal('signInDetailModal');
}

// ===== 值班问题 CRUD（独立数据库，交互逻辑同机台长期交接） =====
let diSortKey = 'updated_at';
let diSortDir = 'desc';

function applyDiSort(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = (a[diSortKey] || '').toString();
    const vb = (b[diSortKey] || '').toString();
    if (diSortKey === 'updated_at') {
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return diSortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    }
    // 去除HTML标签后比较纯文本
    const ta = va.replace(/<[^>]+>/g, '');
    const tb = vb.replace(/<[^>]+>/g, '');
    if (ta < tb) return diSortDir === 'asc' ? -1 : 1;
    if (ta > tb) return diSortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function sortDutyIssueTable(key) {
  if (diSortKey === key) {
    diSortDir = diSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    diSortKey = key;
    diSortDir = 'asc';
  }
  document.querySelectorAll('#dutyIssueTable th.sortable').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) th.classList.add(diSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });
  renderDutyIssueTable();
}

async function loadDutyIssues() {
  try {
    dutyIssues = await apiCall('GET', '/duty-issues');
    renderDutyIssueTable();
  } catch (e) { console.error('Load dutyIssues error:', e); showToast('值班问题数据加载失败', 'error'); }
}

function stripHtml(html) {
  if (html === null || html === undefined) return '';
  // 使用 DOMParser 解析，避免直接 innerHTML 赋值触发 <img onerror> 等事件处理器
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return doc.body.textContent || '';
}

function renderDutyIssueTable() {
  const tbody = document.getElementById('dutyIssueTableBody');
  if (!tbody) return;
  const searchEl = document.getElementById('dutyIssueSearch');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';

  let filtered = dutyIssues.filter(d => {
    const matchSearch = !search ||
      stripHtml(d.category1).toLowerCase().includes(search) ||
      stripHtml(d.category2).toLowerCase().includes(search) ||
      stripHtml(d.problem_process).toLowerCase().includes(search) ||
      stripHtml(d.solution).toLowerCase().includes(search) ||
      stripHtml(d.owner_confirm).toLowerCase().includes(search);
    return matchSearch;
  });

  filtered = applyDiSort(filtered);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">暂无值班问题数据，点击"新增问题"添加</td></tr>`;
    updateDiBatchCount();
    return;
  }

  tbody.innerHTML = filtered.map((d, i) => `
    <tr class="clickable-row${selectedDiIds.has(d.id) ? ' row-selected' : ''}" onclick="showDutyIssueDetail(${d.id})">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-checkbox" ${selectedDiIds.has(d.id) ? 'checked' : ''} onchange="toggleDiSelect(${d.id}, this.checked)"></td>
      <td style="text-align:center;"><strong>${i + 1}</strong></td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(d.category1) || '-'}</div></td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(d.category2) || '-'}</div></td>
      <td>${(() => {
        const imgs = parseImagePaths(d.image_path);
        if (imgs.length === 0) return `<div class="machine-thumb-placeholder"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`;
        return `<div class="multi-thumb-wrapper">
          <img class="machine-thumb" src="${escapeAttr(imgs[0])}" onclick="event.stopPropagation(); openDiLightboxGallery(${d.id})" title="点击查看图片" draggable="false">
          ${imgs.length > 1 ? `<span class="multi-thumb-count">${imgs.length}</span>` : ''}
        </div>`;
      })()}</td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(d.problem_process) || '<span class="cell-empty">-</span>'}</div></td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(d.solution) || '<span class="cell-empty">-</span>'}</div></td>
      <td><div class="cell-expandable cell-html">${sanitizeHtml(d.owner_confirm) || '-'}</div></td>
      <td>${escapeHtml((d.updated_at || '').substring(0, 16))}</td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="action-btn edit" onclick="editDutyIssue(${d.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="deleteDutyIssue(${d.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
  updateDiBatchCount();
}

// 批量选择
function toggleDiSelectAll(checked) {
  if (checked) {
    const search = (document.getElementById('dutyIssueSearch').value || '').toLowerCase();
    dutyIssues.filter(d => {
      const matchSearch = !search ||
        stripHtml(d.category1).toLowerCase().includes(search) ||
        stripHtml(d.category2).toLowerCase().includes(search) ||
        stripHtml(d.solution).toLowerCase().includes(search);
      return matchSearch;
    }).forEach(d => selectedDiIds.add(d.id));
  } else {
    selectedDiIds.clear();
  }
  const head1 = document.getElementById('diSelectAll');
  const head2 = document.getElementById('diSelectAllHead');
  if (head1) head1.checked = checked;
  if (head2) head2.checked = checked;
  renderDutyIssueTable();
}

function toggleDiSelect(id, checked) {
  if (checked) selectedDiIds.add(id);
  else selectedDiIds.delete(id);
  updateDiBatchCount();
}

function updateDiBatchCount() {
  const count = selectedDiIds.size;
  const el = document.getElementById('diBatchCount');
  if (el) el.textContent = `已选 ${count} 项`;
}

function clearDiSelection() {
  selectedDiIds.clear();
  const head1 = document.getElementById('diSelectAll');
  const head2 = document.getElementById('diSelectAllHead');
  if (head1) head1.checked = false;
  if (head2) head2.checked = false;
  renderDutyIssueTable();
}

async function batchDeleteDutyIssues() {
  const ids = Array.from(selectedDiIds);
  if (ids.length === 0) { showToast('请先选择要删除的记录', 'error'); return; }
  if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
  const removedItems = dutyIssues.filter(d => ids.includes(d.id)).map(d => ({ ...d }));
  dutyIssues = dutyIssues.filter(d => !ids.includes(d.id));
  selectedDiIds.clear();
  renderDutyIssueTable();
  try {
    const result = await apiCall('POST', '/duty-issues/batch-delete', { ids });
    showToastWithUndo(`已删除 ${result.changes} 条记录，可撤销`, async () => {
      try {
        await apiCall('POST', '/duty-issues/batch-restore', { ids });
        showToast('已恢复删除的记录');
        await loadDutyIssues();
      } catch (e) { showToast('恢复失败', 'error'); await loadDutyIssues(); }
    });
  } catch (e) {
    dutyIssues = [...dutyIssues, ...removedItems];
    renderDutyIssueTable();
    showToast('批量删除失败', 'error');
  }
}

// 富文本编辑器命令
function execDiCmd(editorId, command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById(editorId).focus();
}

function setDiFontSize(editorId, size) {
  document.execCommand('fontSize', false, size);
  document.getElementById(editorId).focus();
}

// 图片操作
function resetDutyIssueImage() {
  currentImages = [];
  syncImagePath();
  renderGallery();
}

function loadDutyIssueImages(paths) {
  currentImages = Array.isArray(paths) ? [...paths] : [];
  syncImagePath();
  renderGallery();
}

function openDiLightboxGallery(issueId) {
  const d = dutyIssues.find(x => x.id === issueId);
  if (!d) return;
  const imgs = parseImagePaths(d.image_path);
  if (imgs.length === 0) return;
  openLightboxArray(imgs, 0);
}

// 弹窗
function openDutyIssueModal() {
  document.getElementById('dutyIssueModalTitle').textContent = '新增值班问题';
  document.getElementById('diEditId').value = '';
  document.getElementById('diCategory1').innerHTML = '';
  document.getElementById('diCategory2').innerHTML = '';
  document.getElementById('diProblemProcess').innerHTML = '';
  document.getElementById('diSolution').innerHTML = '';
  document.getElementById('diOwnerConfirm').innerHTML = '';
  imageContext = 'dutyIssue';
  resetDutyIssueImage();
  openModal('dutyIssueModal');
}

function editDutyIssue(id) {
  const d = dutyIssues.find(x => x.id === id);
  if (!d) return;
  document.getElementById('dutyIssueModalTitle').textContent = '编辑值班问题';
  document.getElementById('diEditId').value = d.id;
  document.getElementById('diCategory1').innerHTML = sanitizeHtml(d.category1) || '';
  document.getElementById('diCategory2').innerHTML = sanitizeHtml(d.category2) || '';
  document.getElementById('diProblemProcess').innerHTML = sanitizeHtml(d.problem_process) || '';
  document.getElementById('diSolution').innerHTML = sanitizeHtml(d.solution) || '';
  document.getElementById('diOwnerConfirm').innerHTML = sanitizeHtml(d.owner_confirm) || '';
  imageContext = 'dutyIssue';
  loadDutyIssueImages(parseImagePaths(d.image_path));
  openModal('dutyIssueModal');
}

async function saveDutyIssue() {
  const id = document.getElementById('diEditId').value;
  const data = {
    category1: document.getElementById('diCategory1').innerHTML.trim(),
    category2: document.getElementById('diCategory2').innerHTML.trim(),
    image_path: document.getElementById('diImagePath').value || '',
    problem_process: document.getElementById('diProblemProcess').innerHTML.trim(),
    solution: document.getElementById('diSolution').innerHTML.trim(),
    owner_confirm: document.getElementById('diOwnerConfirm').innerHTML.trim()
  };

  if (!stripHtml(data.category1) && !stripHtml(data.category2) && !stripHtml(data.problem_process)) {
    showToast('请至少填写一项内容', 'error'); return;
  }

  closeModal('dutyIssueModal');
  const isEdit = !!id;
  if (isEdit) {
    const idx = dutyIssues.findIndex(d => d.id == id);
    if (idx >= 0) dutyIssues[idx] = { ...dutyIssues[idx], ...data, updated_at: getChinaTimeStr() };
  } else {
    const tempId = Date.now();
    dutyIssues.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  renderDutyIssueTable();
  showToast(isEdit ? '更新中...' : '创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/duty-issues/${id}`, data);
    } else {
      const result = await apiCall('POST', '/duty-issues', data);
      const idx = dutyIssues.findIndex(d => d.id === tempId);
      if (idx >= 0) dutyIssues[idx].id = result.id;
      renderDutyIssueTable();
    }
    showToast(isEdit ? '值班问题更新成功' : '值班问题创建成功');
    loadDutyIssues();
  } catch (e) {
    showToast('操作失败，正在恢复数据', 'error');
    await loadDutyIssues();
  }
}

async function deleteDutyIssue(id) {
  pendingDelete = { type: 'duty-issue', id };
  openModal('confirmModal');
}

function showDutyIssueDetail(id) {
  const d = dutyIssues.find(x => x.id === id);
  if (!d) return;

  const imagePaths = parseImagePaths(d.image_path);
  const imagePathsJson = JSON.stringify(imagePaths).replace(/'/g, "&#39;");
  const imageHtml = imagePaths.length > 0
    ? `<div class="detail-gallery">${imagePaths.map((p, i) => `<div class="detail-gallery-item"><img src="${escapeAttr(p)}" onclick='openLightboxArray(${imagePathsJson}, ${i})' title="点击查看大图" draggable="false"></div>`).join('')}</div>`
    : `<div class="detail-image-placeholder"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>暂无图片</span></div>`;

  const body = document.getElementById('dutyIssueDetailBody');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-row">
        <span class="detail-label">问题归类1</span>
        <span class="detail-value cell-html">${sanitizeHtml(d.category1) || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">问题归类2</span>
        <span class="detail-value cell-html">${sanitizeHtml(d.category2) || '-'}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">识别问题过程</span>
        <span class="detail-value cell-html">${sanitizeHtml(d.problem_process) || '-'}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">解决办法</span>
        <span class="detail-value cell-html">${sanitizeHtml(d.solution) || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Owner confirm</span>
        <span class="detail-value cell-html">${sanitizeHtml(d.owner_confirm) || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">更新时间</span>
        <span class="detail-value">${escapeHtml(formatDateTime(d.updated_at) || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">截图 (${imagePaths.length}张)</span>
        <div class="detail-value">${imageHtml}</div>
      </div>
    </div>
  `;

  const editBtn = document.getElementById('dutyIssueDetailEditBtn');
  editBtn.onclick = () => {
    closeModal('dutyIssueDetailModal');
    editDutyIssue(id);
  };
  openModal('dutyIssueDetailModal');
}

// ===== 其他交接 CRUD =====
// 富文本编辑器命令
function execDhCmd(editorId, command, value = null) {
  document.execCommand(command, false, value);
  document.getElementById(editorId).focus();
}

function setDhFontSize(editorId, size) {
  document.execCommand('fontSize', false, size);
  document.getElementById(editorId).focus();
}

// 图片操作
function resetDhImage() {
  currentImages = [];
  syncImagePath();
  renderGallery();
}

function loadDhImages(paths) {
  currentImages = Array.isArray(paths) ? [...paths] : [];
  syncImagePath();
  renderGallery();
}

function openDhLightboxGallery(handoverId) {
  const h = dailyHandovers.find(x => x.id === handoverId);
  if (!h) return;
  const imgs = parseImagePaths(h.image_path);
  if (imgs.length === 0) return;
  openLightboxArray(imgs, 0);
}

async function loadDailyHandovers() {
  try {
    dailyHandovers = await apiCall('GET', '/daily-handovers');
    renderDailyHandoverCards();
  } catch (e) { console.error('Load daily handovers error:', e); showToast('其他交接数据加载失败', 'error'); }
}

function renderDailyHandoverCards() {
  const grid = document.getElementById('dailyHandoverGrid');
  if (!grid) return;
  const searchEl = document.getElementById('dailyHandoverSearch');
  const priorityEl = document.getElementById('dailyHandoverPriorityFilter');
  const statusEl = document.getElementById('dailyHandoverStatusFilter');
  const search = searchEl ? (searchEl.value || '').toLowerCase() : '';
  const priorityFilter = priorityEl ? priorityEl.value : '';
  const statusFilter = statusEl ? statusEl.value : '';

  let filtered = dailyHandovers.filter(h => {
    const titleText = stripHtml(h.title).toLowerCase();
    const contentText = stripHtml(h.content || '').toLowerCase();
    const matchSearch = !search ||
      titleText.includes(search) ||
      contentText.includes(search);
    const matchPriority = !priorityFilter || h.priority === priorityFilter;
    const matchStatus = !statusFilter || h.status === statusFilter;
    return matchSearch && matchPriority && matchStatus;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state">暂无其他交接事项，点击"新增交接"添加</div>';
    return;
  }

  grid.innerHTML = filtered.map(h => {
    const imgs = parseImagePaths(h.image_path);
    const imageHtml = imgs.length > 0
      ? `<div class="handover-card-images">
           <img class="handover-card-thumb" src="${escapeAttr(imgs[0])}" onclick="event.stopPropagation(); openDhLightboxGallery(${h.id})" title="点击查看图片" draggable="false">
           ${imgs.length > 1 ? `<span class="handover-card-img-count">${imgs.length}</span>` : ''}
         </div>`
      : '';
    return `
    <div class="handover-card priority-${h.priority}${h.status === 'closed' ? ' card-closed' : ''}" onclick="showDailyHandoverDetail(${h.id})" style="cursor:pointer;">
      <div class="handover-card-header">
        <div class="handover-card-title cell-html">${sanitizeHtml(h.title)}</div>
        <div class="handover-card-tags">
          <span class="tag tag-${h.priority}">${STATUS_MAP.priority[h.priority]}</span>
          <span class="tag tag-${h.category}">${STATUS_MAP.category[h.category]}</span>
          <span class="status-badge status-${h.status}" style="font-size:11px;">${STATUS_MAP.handover[h.status]}</span>
        </div>
      </div>
      <div class="handover-card-content cell-html">${sanitizeHtml(h.content) || '无详细内容'}</div>
      ${imageHtml}
      <div class="handover-card-footer">
        <div class="handover-meta">
          ${h.created_by ? `<span>创建人: ${escapeHtml(h.created_by)}</span>` : ''}
          ${h.due_date ? `<span>截止: ${escapeHtml(h.due_date)}</span>` : ''}
          <span>${h.created_at ? h.created_at.substring(0, 10) : ''}</span>
        </div>
        <div class="handover-card-actions">
          <button class="action-btn edit" onclick="event.stopPropagation(); editDailyHandover(${h.id})" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn delete" onclick="event.stopPropagation(); deleteDailyHandover(${h.id})" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>
  `}).join('');
}

// 其他交接详情弹窗
function showDailyHandoverDetail(id) {
  const h = dailyHandovers.find(x => x.id === id);
  if (!h) return;
  const imgs = parseImagePaths(h.image_path);
  const imgsJson = JSON.stringify(imgs);
  const imageHtml = imgs.length > 0
    ? `<div class="detail-gallery">${imgs.map((p, i) => `<div class="detail-gallery-item"><img src="${escapeAttr(p)}" onclick='openLightboxArray(${imgsJson}, ${i})' title="点击查看大图" draggable="false"></div>`).join('')}</div>`
    : `<div class="detail-image-placeholder"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>暂无图片</span></div>`;

  const body = document.getElementById('dhDetailBody');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-row detail-row-full">
        <span class="detail-label">标题</span>
        <span class="detail-value cell-html">${sanitizeHtml(h.title) || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">优先级</span>
        <span class="detail-value">${STATUS_MAP.priority[h.priority] || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">类别</span>
        <span class="detail-value">${STATUS_MAP.category[h.category] || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">状态</span>
        <span class="detail-value">${STATUS_MAP.handover[h.status] || '-'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">创建人</span>
        <span class="detail-value">${escapeHtml(h.created_by || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">截止日期</span>
        <span class="detail-value">${escapeHtml(h.due_date || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">创建时间</span>
        <span class="detail-value">${escapeHtml(formatDateTime(h.created_at) || '-')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">更新时间</span>
        <span class="detail-value">${escapeHtml(formatDateTime(h.updated_at) || '-')}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">详细内容</span>
        <span class="detail-value cell-html">${sanitizeHtml(h.content) || '-'}</span>
      </div>
      <div class="detail-row detail-row-full">
        <span class="detail-label">截图 (${imgs.length}张)</span>
        <div class="detail-value">${imageHtml}</div>
      </div>
    </div>
  `;
  const editBtn = document.getElementById('dhDetailEditBtn');
  editBtn.onclick = () => {
    closeModal('dhDetailModal');
    editDailyHandover(id);
  };
  openModal('dhDetailModal');
}

function openDailyHandoverModal() {
  document.getElementById('dailyHandoverModalTitle').textContent = '新增其他交接事项';
  document.getElementById('dhEditId').value = '';
  document.getElementById('dhTitle').innerHTML = '';
  document.getElementById('dhContent').innerHTML = '';
  document.getElementById('dhPriority').value = 'medium';
  document.getElementById('dhCategory').value = 'other';
  document.getElementById('dhStatus').value = 'open';
  document.getElementById('dhCreatedBy').value = '';
  document.getElementById('dhDueDate').value = '';
  imageContext = 'dailyHandover';
  resetDhImage();
  openModal('dailyHandoverModal');
}

function editDailyHandover(id) {
  const h = dailyHandovers.find(x => x.id === id);
  if (!h) return;
  document.getElementById('dailyHandoverModalTitle').textContent = '编辑其他交接事项';
  document.getElementById('dhEditId').value = h.id;
  document.getElementById('dhTitle').innerHTML = sanitizeHtml(h.title) || '';
  document.getElementById('dhContent').innerHTML = sanitizeHtml(h.content) || '';
  document.getElementById('dhPriority').value = h.priority;
  document.getElementById('dhCategory').value = h.category || 'other';
  document.getElementById('dhStatus').value = h.status;
  document.getElementById('dhCreatedBy').value = h.created_by || '';
  document.getElementById('dhDueDate').value = h.due_date || '';
  imageContext = 'dailyHandover';
  loadDhImages(parseImagePaths(h.image_path));
  openModal('dailyHandoverModal');
}

async function saveDailyHandover() {
  const id = document.getElementById('dhEditId').value;
  const data = {
    title: document.getElementById('dhTitle').innerHTML.trim(),
    content: document.getElementById('dhContent').innerHTML.trim(),
    priority: document.getElementById('dhPriority').value,
    category: document.getElementById('dhCategory').value,
    status: document.getElementById('dhStatus').value,
    created_by: document.getElementById('dhCreatedBy').value.trim(),
    due_date: document.getElementById('dhDueDate').value || '',
    image_path: document.getElementById('dhImagePath').value || ''
  };
  if (!stripHtml(data.title).trim()) { showToast('请填写标题', 'error'); return; }

  // 乐观更新
  closeModal('dailyHandoverModal');
  const isEdit = !!id;
  const tempId = Date.now();
  if (isEdit) {
    const idx = dailyHandovers.findIndex(h => h.id == id);
    if (idx >= 0) dailyHandovers[idx] = { ...dailyHandovers[idx], ...data, updated_at: getChinaTimeStr() };
  } else {
    dailyHandovers.unshift({ id: tempId, ...data, created_at: getChinaTimeStr(), updated_at: getChinaTimeStr() });
  }
  renderDailyHandoverCards();
  showToast(isEdit ? '更新中...' : '创建中...', 'success');

  try {
    if (isEdit) {
      await apiCall('PUT', `/daily-handovers/${id}`, data);
    } else {
      const result = await apiCall('POST', '/daily-handovers', data);
      const idx = dailyHandovers.findIndex(h => h.id === tempId);
      if (idx >= 0) dailyHandovers[idx].id = result.id;
      renderDailyHandoverCards();
    }
    showToast(isEdit ? '其他交接更新成功' : '其他交接创建成功');
    loadDailyHandovers();
  } catch (e) { showToast('操作失败，正在恢复', 'error'); await loadDailyHandovers(); }
}

async function deleteDailyHandover(id) {
  pendingDelete = { type: 'daily-handover', id };
  openModal('confirmModal');
}

// ===== 确认删除（软删除 + 撤销） =====
document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (!pendingDelete) return;
  const { type, id } = pendingDelete;
  const pathMap = {
    'machine': 'machines',
    'daily-handover': 'daily-handovers',
    'lt-machine': 'long-term-machines',
    'lot-handover': 'lot-handovers',
    'sign-in': 'sign-in-sheets',
    'duty-issue': 'duty-issues',
    'ar-handover': 'ar-handovers'
  };
  const path = pathMap[type];
  // 乐观更新：先关闭弹窗并从本地数据移除
  closeModal('confirmModal');
  const listMap = {
    'machine': machines,
    'daily-handover': dailyHandovers,
    'lt-machine': ltMachines,
    'lot-handover': lotHandovers,
    'sign-in': signInSheets,
    'duty-issue': dutyIssues,
    'ar-handover': arHandovers
  };
  const list = listMap[type];
  const removedIdx = list.findIndex(x => x.id == id);
  const removedItem = removedIdx >= 0 ? list.splice(removedIdx, 1)[0] : null;
  // 立即重新渲染
  if (type === 'machine') { _cachedFilteredMachineIds = null; renderMachineTable(); }
  else if (type === 'daily-handover') renderDailyHandoverCards();
  else if (type === 'lt-machine') { _cachedLtFilteredMachineIds = null; renderLtMachineTable(); }
  else if (type === 'lot-handover') renderLotHandoverTable();
  else if (type === 'sign-in') renderSignInTable();
  else if (type === 'duty-issue') renderDutyIssueTable();
  else if (type === 'ar-handover') { _cachedArFilteredIds = null; renderArHandoverTable(); }

  // 后台同步服务器（软删除）
  try {
    await apiCall('DELETE', `/${path}/${id}`);
    // 显示带撤销按钮的 Toast
    const typeLabel = { 'machine': '机台', 'daily-handover': '其他交接', 'lt-machine': '长期机台', 'lot-handover': 'LOT交接', 'sign-in': '签到表', 'duty-issue': '值班问题', 'ar-handover': 'AR交接' }[type];
    showToastWithUndo(`${typeLabel}已删除，可撤销`, async () => {
      try {
        await apiCall('PATCH', `/${path}/${id}/restore`);
        // 恢复到本地数据
        if (removedItem) {
          list.splice(Math.min(removedIdx, list.length), 0, removedItem);
        }
        if (type === 'machine') { _cachedFilteredMachineIds = null; renderMachineTable(); }
        else if (type === 'daily-handover') renderDailyHandoverCards();
        else if (type === 'lt-machine') { _cachedLtFilteredMachineIds = null; renderLtMachineTable(); }
        else if (type === 'lot-handover') renderLotHandoverTable();
        else if (type === 'sign-in') renderSignInTable();
        else if (type === 'duty-issue') renderDutyIssueTable();
        else if (type === 'ar-handover') { _cachedArFilteredIds = null; renderArHandoverTable(); }
        showToast('已恢复删除的记录');
        // 静默刷新确保一致
        if (type === 'machine') loadMachines();
        else if (type === 'daily-handover') loadDailyHandovers();
        else if (type === 'lt-machine') loadLtMachines();
        else if (type === 'lot-handover') loadLotHandovers();
        else if (type === 'sign-in') loadSignInSheets();
        else if (type === 'duty-issue') loadDutyIssues();
        else if (type === 'ar-handover') loadArHandovers();
      } catch (e) {
        showToast('恢复失败', 'error');
        if (type === 'machine') loadMachines();
        else if (type === 'daily-handover') loadDailyHandovers();
        else if (type === 'lt-machine') loadLtMachines();
        else if (type === 'lot-handover') loadLotHandovers();
        else if (type === 'sign-in') loadSignInSheets();
        else if (type === 'duty-issue') loadDutyIssues();
        else if (type === 'ar-handover') loadArHandovers();
      }
    });
  } catch (e) {
    // 失败回滚
    if (removedItem && removedIdx >= 0) list.splice(removedIdx, 0, removedItem);
    if (type === 'machine') { _cachedFilteredMachineIds = null; renderMachineTable(); }
    else if (type === 'daily-handover') renderDailyHandoverCards();
    else if (type === 'lt-machine') { _cachedLtFilteredMachineIds = null; renderLtMachineTable(); }
    else if (type === 'lot-handover') renderLotHandoverTable();
    else if (type === 'sign-in') renderSignInTable();
    else if (type === 'duty-issue') renderDutyIssueTable();
    else if (type === 'ar-handover') { _cachedArFilteredIds = null; renderArHandoverTable(); }
    showToast('删除失败', 'error');
  }
  pendingDelete = null;
});

// ===== 回收站功能 =====
const trashConfig = {
  'machine': {
    path: 'machines', label: '机台', renderItem: (item) => ({
      title: item.machine_name || '未知机台',
      desc: `${item.shift || '-'} | ${item.owner || '-'} | ${item.alarm_info ? item.alarm_info.substring(0, 50) : '-'}`
    }),
    reload: loadMachines
  },
  'daily-handover': {
    path: 'daily-handovers', label: '其他交接', renderItem: (item) => ({
      title: stripHtml(item.title) || '无标题',
      desc: stripHtml(item.content ? item.content.substring(0, 80) : '无内容')
    }),
    reload: loadDailyHandovers
  },
  'lt-machine': {
    path: 'long-term-machines', label: '长期机台', renderItem: (item) => ({
      title: item.machine_name || '未知机台',
      desc: `${item.shift || '-'} | ${item.owner || '-'} | ${item.alarm_info ? item.alarm_info.substring(0, 50) : '-'}`
    }),
    reload: loadLtMachines
  },
  'lot-handover': {
    path: 'lot-handovers', label: 'LOT交接', renderItem: (item) => ({
      title: item.lot_id || '未知LOT',
      desc: `${item.detail ? item.detail.substring(0, 60) : '-'} | ${item.follow_up ? '有Follow up' : '无Follow up'}`
    }),
    reload: loadLotHandovers
  },
  'sign-in': {
    path: 'sign-in-sheets', label: '签到表', renderItem: (item) => {
      let count = 0;
      try { count = JSON.parse(item.attendees || '[]').length; } catch (e) {}
      return {
        title: `签到表 ${formatDateTime(item.shift_time) || '未知时间'}`,
        desc: `${item.location || '-'} | ${item.host || '-'} | ${count}人`
      };
    },
    reload: loadSignInSheets
  },
  'duty-issue': {
    path: 'duty-issues', label: '值班问题', renderItem: (item) => ({
      title: stripHtml(item.category1) || stripHtml(item.category2) || '未知问题',
      desc: `${stripHtml(item.problem_process).substring(0, 60) || '-'} | ${stripHtml(item.solution).substring(0, 40) || '-'}`
    }),
    reload: loadDutyIssues
  },
  'ar-handover': {
    path: 'ar-handovers', label: 'AR交接', renderItem: (item) => ({
      title: stripHtml(item.ar) || '无AR内容',
      desc: `${item.date || '-'} | ${item.due_date || '-'} | ${item.status || '-'}`
    }),
    reload: loadArHandovers
  }
};

async function openTrashModal(type) {
  const config = trashConfig[type];
  if (!config) return;
  document.getElementById('trashModalTitle').textContent = `${config.label}回收站`;
  const body = document.getElementById('trashModalBody');
  body.innerHTML = '<div class="trash-loading">加载中...</div>';
  openModal('trashModal');

  try {
    const items = await apiCall('GET', `/${config.path}/trash`);
    if (!items || items.length === 0) {
      body.innerHTML = `
        <div class="trash-empty">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span>回收站为空</span>
        </div>`;
      return;
    }
    body.innerHTML = items.map(item => {
      const info = config.renderItem(item);
      return `
        <div class="trash-item">
          <div class="trash-item-info">
            <div class="trash-item-title">${escapeHtml(info.title)}</div>
            <div class="trash-item-desc">${escapeHtml(info.desc)}</div>
            <div class="trash-item-time">删除时间: ${formatDateTime(item.deleted_at)}</div>
          </div>
          <div class="trash-item-actions">
            <button class="btn btn-primary btn-sm" onclick="restoreTrashItem('${type}', ${item.id})">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              恢复
            </button>
            <button class="btn btn-danger btn-sm" onclick="permanentlyDelete('${type}', ${item.id})">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              彻底删除
            </button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<div class="trash-empty">加载失败，请重试</div>';
  }
}

async function restoreTrashItem(type, id) {
  const config = trashConfig[type];
  if (!config) return;
  try {
    await apiCall('PATCH', `/${config.path}/${id}/restore`);
    showToast('已恢复记录');
    // 刷新回收站列表和主数据
    openTrashModal(type);
    config.reload();
  } catch (e) {
    showToast('恢复失败', 'error');
  }
}

async function permanentlyDelete(type, id) {
  const config = trashConfig[type];
  if (!config) return;
  if (!confirm('彻底删除后无法恢复，确定要删除吗？')) return;
  try {
    await apiCall('DELETE', `/${config.path}/${id}/permanent`);
    showToast('已彻底删除');
    openTrashModal(type);
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

// ===== 搜索与筛选事件 =====
// 搜索框使用防抖，避免每次按键触发全表重渲染
const debouncedMachineSearch = debounce(() => { _cachedFilteredMachineIds = null; renderMachineTable(); }, 200);
const debouncedDailyHandoverSearch = debounce(renderDailyHandoverCards, 200);
const debouncedLtMachineSearch = debounce(() => { _cachedLtFilteredMachineIds = null; renderLtMachineTable(); }, 200);
const debouncedLotHSearch = debounce(renderLotHandoverTable, 200);
const debouncedSignInSearch = debounce(renderSignInTable, 200);
const debouncedArSearch = debounce(() => { _cachedArFilteredIds = null; renderArHandoverTable(); }, 200);

document.getElementById('machineSearch').addEventListener('input', debouncedMachineSearch);
document.getElementById('machineStatusFilter').addEventListener('change', () => { _cachedFilteredMachineIds = null; renderMachineTable(); });
document.getElementById('dailyHandoverSearch').addEventListener('input', debouncedDailyHandoverSearch);
document.getElementById('dailyHandoverPriorityFilter').addEventListener('change', renderDailyHandoverCards);
document.getElementById('dailyHandoverStatusFilter').addEventListener('change', renderDailyHandoverCards);
document.getElementById('ltMachineSearch').addEventListener('input', debouncedLtMachineSearch);
document.getElementById('ltMachineStatusFilter').addEventListener('change', () => { _cachedLtFilteredMachineIds = null; renderLtMachineTable(); });
document.getElementById('lotHandoverSearch').addEventListener('input', debouncedLotHSearch);
document.getElementById('signInSearch').addEventListener('input', debouncedSignInSearch);
document.getElementById('arHandoverSearch').addEventListener('input', debouncedArSearch);
document.getElementById('arHandoverStatusFilter').addEventListener('change', () => { _cachedArFilteredIds = null; renderArHandoverTable(); });

// 点击遮罩关闭弹窗
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

// ===== 机台多图片：剪贴板粘贴 & 文件上传 =====

// 当前编辑中的图片列表
let currentImages = [];
// 当前图片编辑上下文：'machine' 或 'ltMachine'
let imageContext = 'machine';
// 灯箱状态
let lightboxImages = [];
let lightboxIndex = 0;

// 根据上下文获取图片相关元素 ID
function imgCtx() {
  if (imageContext === 'ltMachine') {
    return {
      gallery: 'ltMachineImageGallery',
      badge: 'ltImageCountBadge',
      hint: 'ltUploadHint',
      path: 'ltMImagePath',
      area: 'ltMachineImageArea',
      uploadUrl: '/api/long-term-machines/upload'
    };
  }
  if (imageContext === 'lotHandover') {
    return {
      gallery: 'lotHImageGallery',
      badge: 'lotHImageCountBadge',
      hint: 'lotHUploadHint',
      path: 'lotHFollowUpImages',
      area: 'lotHImageArea',
      uploadUrl: '/api/lot-handovers/upload'
    };
  }
  if (imageContext === 'dutyIssue') {
    return {
      gallery: 'dutyIssueImageGallery',
      badge: 'diImageCountBadge',
      hint: 'diUploadHint',
      path: 'diImagePath',
      area: 'dutyIssueImageArea',
      uploadUrl: '/api/duty-issues/upload'
    };
  }
  if (imageContext === 'dailyHandover') {
    return {
      gallery: 'dhImageGallery',
      badge: 'dhImageCountBadge',
      hint: 'dhUploadHint',
      path: 'dhImagePath',
      area: 'dhImageArea',
      uploadUrl: '/api/daily-handovers/upload'
    };
  }
  return {
    gallery: 'machineImageGallery',
    badge: 'imageCountBadge',
    hint: 'uploadHint',
    path: 'mImagePath',
    area: 'machineImageArea',
    uploadUrl: '/api/machines/upload'
  };
}

// 解析图片路径（兼容单图旧数据和多图逗号分隔）
function parseImagePaths(pathStr) {
  if (!pathStr || !pathStr.trim()) return [];
  return pathStr.split(',').map(p => p.trim()).filter(p => p);
}

// 同步 hidden 字段
function syncImagePath() {
  const ctx = imgCtx();
  const el = document.getElementById(ctx.path);
  if (el) el.value = currentImages.join(',');
}

// 更新图片数量徽章
function updateImageCount() {
  const ctx = imgCtx();
  const badge = document.getElementById(ctx.badge);
  const hint = document.getElementById(ctx.hint);
  if (currentImages.length > 0) {
    if (badge) { badge.textContent = `${currentImages.length} 张`; badge.style.display = 'inline-block'; }
    if (hint) hint.style.display = 'none';
  } else {
    if (badge) badge.style.display = 'none';
    if (hint) hint.style.display = 'flex';
  }
}

// 渲染图片画廊
function renderGallery() {
  const ctx = imgCtx();
  const gallery = document.getElementById(ctx.gallery);
  if (!gallery) return;
  gallery.innerHTML = currentImages.map((src, i) => `
    <div class="gallery-item" draggable="true" data-index="${i}">
      <img src="${escapeAttr(src)}" onclick="openLightboxArray(currentImages, ${i})" title="点击查看大图" draggable="false">
      <button type="button" class="gallery-remove" onclick="removeGalleryImage(${i})" title="移除">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <span class="gallery-index">${i + 1}</span>
      <div class="gallery-drag-handle" title="拖拽排序">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>
        <span class="gallery-drag-text">拖动排序</span>
      </div>
    </div>
  `).join('');
  updateImageCount();
  bindGalleryDragSort();
}

// 画廊拖拽排序
let dragSrcIndex = null;

function bindGalleryDragSort() {
  const ctx = imgCtx();
  const gallery = document.getElementById(ctx.gallery);
  if (!gallery) return;
  const items = gallery.querySelectorAll('.gallery-item');

  items.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = parseInt(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrcIndex);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      gallery.querySelectorAll('.gallery-item').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetIndex = parseInt(item.dataset.index);
      if (targetIndex === dragSrcIndex) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      if (e.clientY < midY) item.classList.add('drag-over-top');
      else item.classList.add('drag-over-bottom');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIndex = parseInt(item.dataset.index);
      if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      let insertIndex = e.clientY < midY ? targetIndex : targetIndex + 1;
      reorderGallery(dragSrcIndex, insertIndex);
    });
  });
}

// 重新排序图片
function reorderGallery(fromIndex, toIndex) {
  const moved = currentImages.splice(fromIndex, 1)[0];
  if (toIndex > fromIndex) toIndex--;
  currentImages.splice(toIndex, 0, moved);
  syncImagePath();
  renderGallery();
  showToast('图片顺序已更新');
}

// 重置图片区域
function resetMachineImage() {
  currentImages = [];
  syncImagePath();
  renderGallery();
}

// 加载已有图片（编辑时）
function loadMachineImages(paths) {
  currentImages = Array.isArray(paths) ? [...paths] : [];
  syncImagePath();
  renderGallery();
}

// 从剪贴板粘贴图片（按钮触发，支持多图）
async function pasteFromClipboard() {
  // 尝试读取剪贴板；受浏览器安全策略限制（需 HTTPS/localhost + 用户授权），
  // 读取失败或读取不到图片时，给出清晰的 Ctrl+V 引导而非“点了没反应”。
  let blobs = [];
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            blobs.push(await item.getType(type));
          }
        }
      }
    }
  } catch (e) {
    console.log('Clipboard API 读取失败:', e.message);
  }

  if (blobs.length > 0) {
    uploadMachineImages(blobs);
    return;
  }

  // 读取失败或剪贴板内没有图片：引导用户按 Ctrl+V 粘贴
  showToast('请按 Ctrl+V 粘贴图片', 'error');
}

// 全局粘贴事件监听（机台弹窗打开时生效，支持多图）
// 使用捕获阶段确保最先收到事件
document.addEventListener('paste', handlePasteEvent, true);

function handlePasteEvent(e) {
  // 检查哪个弹窗打开
  const machineModal = document.getElementById('machineModal');
  const ltMachineModal = document.getElementById('ltMachineModal');
  const lotHandoverModal = document.getElementById('lotHandoverModal');
  const dutyIssueModal = document.getElementById('dutyIssueModal');
  const dailyHandoverModal = document.getElementById('dailyHandoverModal');
  if (machineModal && machineModal.classList.contains('active')) {
    imageContext = 'machine';
  } else if (ltMachineModal && ltMachineModal.classList.contains('active')) {
    imageContext = 'ltMachine';
  } else if (lotHandoverModal && lotHandoverModal.classList.contains('active')) {
    imageContext = 'lotHandover';
  } else if (dutyIssueModal && dutyIssueModal.classList.contains('active')) {
    imageContext = 'dutyIssue';
  } else if (dailyHandoverModal && dailyHandoverModal.classList.contains('active')) {
    imageContext = 'dailyHandover';
  } else {
    return;
  }

  console.log('[Paste] 粘贴事件触发, clipboardData:', e.clipboardData);

  const imageBlobs = [];

  // 方式1: 通过 clipboardData.items 获取
  if (e.clipboardData && e.clipboardData.items) {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`[Paste] item[${i}].type =`, item.kind, item.type);
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          imageBlobs.push(blob);
          console.log('[Paste] 获取到图片:', blob.name, blob.size, 'bytes');
        }
      }
    }
  }

  // 方式2: 通过 clipboardData.files 获取（备用）
  if (imageBlobs.length === 0 && e.clipboardData && e.clipboardData.files) {
    const files = e.clipboardData.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        imageBlobs.push(file);
        console.log('[Paste] 通过files获取图片:', file.name, file.size, 'bytes');
      }
    }
  }

  if (imageBlobs.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    const ctx = imgCtx();
    const area = document.getElementById(ctx.area);
    if (area) {
      area.classList.add('paste-active');
      setTimeout(() => area.classList.remove('paste-active'), 400);
    }
    uploadMachineImages(imageBlobs);
  } else {
    console.log('[Paste] 剪贴板中未找到图片数据');
  }
}

// 文件选择处理（支持多选）
function handleFileSelect(event) {
  // 根据触发文件输入的 ID 设置正确的图片上下文
  const inputId = event.target.id;
  if (inputId === 'ltMachineFileInput') {
    imageContext = 'ltMachine';
  } else if (inputId === 'lotHFileInput') {
    imageContext = 'lotHandover';
  } else if (inputId === 'dutyIssueFileInput') {
    imageContext = 'dutyIssue';
  } else if (inputId === 'dhFileInput') {
    imageContext = 'dailyHandover';
  } else {
    imageContext = 'machine';
  }
  const files = Array.from(event.target.files).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    showToast('请选择图片文件', 'error');
    event.target.value = '';
    return;
  }
  uploadMachineImages(files);
  event.target.value = '';
}

// 上传多张图片到服务器
async function uploadMachineImages(files) {
  const fileList = Array.isArray(files) ? files : [files];
  if (fileList.length === 0) return;

  // 检查数量上限
  if (currentImages.length + fileList.length > 20) {
    showToast(`最多上传20张图片，当前已有${currentImages.length}张`, 'error');
    return;
  }

  const ctx = imgCtx();
  // 显示上传中状态
  const hint = document.getElementById(ctx.hint);
  const originalHint = hint ? hint.innerHTML : '';
  if (hint) {
    hint.innerHTML = `<div class="upload-spinner"></div><span>正在上传 ${fileList.length} 张图片...</span>`;
    hint.classList.add('upload-loading');
    hint.style.display = 'flex';
  }

  const formData = new FormData();
  fileList.forEach(f => formData.append('images', f));

  try {
    const token = getAuthToken();
    const headers = {};
    if (token) headers['x-auth-token'] = token;
    const res = await fetch(ctx.uploadUrl, { method: 'POST', headers, body: formData });
    if (res.status === 401) { handleSessionExpired(); throw new Error('会话过期'); }
    const data = await res.json();
    if (data.error) {
      showToast(data.error, 'error');
      if (hint) { hint.innerHTML = originalHint; hint.classList.remove('upload-loading'); }
      updateImageCount();
      return;
    }
    // 添加新上传的图片路径
    currentImages.push(...data.paths);
    syncImagePath();
    renderGallery();
    showToast(`成功上传 ${data.paths.length} 张图片`);
    // 恢复提示区域
    if (hint) { hint.innerHTML = originalHint; hint.classList.remove('upload-loading'); }
    updateImageCount();
  } catch (e) {
    showToast('图片上传失败', 'error');
    if (hint) { hint.innerHTML = originalHint; hint.classList.remove('upload-loading'); }
    updateImageCount();
  }
}

// 移除单张图片
function removeGalleryImage(index) {
  currentImages.splice(index, 1);
  syncImagePath();
  renderGallery();
  showToast('已移除图片');
}

// 拖拽上传支持（多文件，支持三个弹窗）
['machineImageArea', 'ltMachineImageArea', 'lotHImageArea', 'dutyIssueImageArea', 'dhImageArea'].forEach(areaId => {
  const dragArea = document.getElementById(areaId);
  if (!dragArea) return;
  ['dragenter', 'dragover'].forEach(evt => {
    dragArea.addEventListener(evt, (e) => { e.preventDefault(); dragArea.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dragArea.addEventListener(evt, (e) => { e.preventDefault(); dragArea.classList.remove('drag-over'); });
  });
  dragArea.addEventListener('drop', (e) => {
    if (dragSrcIndex !== null) return;
    if (areaId === 'ltMachineImageArea') imageContext = 'ltMachine';
    else if (areaId === 'lotHImageArea') imageContext = 'lotHandover';
    else if (areaId === 'dutyIssueImageArea') imageContext = 'dutyIssue';
    else if (areaId === 'dhImageArea') imageContext = 'dailyHandover';
    else imageContext = 'machine';
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) uploadMachineImages(files);
  });
});

// ===== 图片灯箱（支持多图导航） =====
function openLightboxArray(images, startIndex = 0) {
  lightboxImages = images;
  lightboxIndex = startIndex;
  updateLightbox();
  document.getElementById('imageLightbox').classList.add('active');
}

function openLightboxGallery(machineId) {
  const m = machines.find(x => x.id === machineId);
  if (!m) return;
  const imgs = parseImagePaths(m.image_path);
  if (imgs.length === 0) return;
  openLightboxArray(imgs, 0);
}

function updateLightbox() {
  document.getElementById('lightboxImg').src = lightboxImages[lightboxIndex];
  const prev = document.getElementById('lightboxPrev');
  const next = document.getElementById('lightboxNext');
  const counter = document.getElementById('lightboxCounter');
  if (lightboxImages.length > 1) {
    prev.style.display = 'flex';
    next.style.display = 'flex';
    counter.style.display = 'block';
    counter.textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
  } else {
    prev.style.display = 'none';
    next.style.display = 'none';
    counter.style.display = 'none';
  }
}

function lightboxNav(direction) {
  lightboxIndex += direction;
  if (lightboxIndex < 0) lightboxIndex = lightboxImages.length - 1;
  if (lightboxIndex >= lightboxImages.length) lightboxIndex = 0;
  updateLightbox();
}

function closeLightbox() {
  document.getElementById('imageLightbox').classList.remove('active');
}

// ESC 关闭灯箱 & 左右键导航
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
  if (document.getElementById('imageLightbox').classList.contains('active')) {
    if (e.key === 'ArrowLeft') lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(1);
  }
});

// ===== 初始化 =====
async function init() {
  // 初始化主题选择器
  initThemeSelector();
  // 先检查登录会话
  const loggedIn = await checkSession();
  if (!loggedIn) return;
  await loadDepartments();
  await Promise.all([loadMachines(), loadLtMachines(), loadDailyHandovers(), loadLotHandovers(), loadSignInEngineers(), loadSignInSheets(), loadArHandovers(), loadDashboard()]);
  // 数据加载完成后应用表格权限控制
  applyTableActionPermissions();
}
init();
