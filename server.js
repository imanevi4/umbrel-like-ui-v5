const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const session = require('express-session');
const FileStoreFactory = require('session-file-store');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const crypto = require('crypto');

const app = express();
const FileStore = FileStoreFactory(session);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SSL_ENABLED = String(process.env.SSL_ENABLED || 'false').toLowerCase() === 'true';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'fullchain.pem');
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'privkey.pem');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const ADMIN_BOOTSTRAP_USERNAME = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
const ADMIN_BOOTSTRAP_PASSWORD_HASH = process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH || '';
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 5000);
const HEALTH_CONCURRENCY = Number(process.env.HEALTH_CONCURRENCY || 8);
const VALID_CHECK_METHODS = new Set(['auto', 'http', 'ping', 'disabled']);
const VALID_USER_ROLES = new Set(['admin', 'viewer']);

ensureDir(DATA_DIR);
ensureDir(SESSIONS_DIR);
ensureFile(USERS_FILE, '[]\n');
ensureStateFiles();
bootstrapAdminUser();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, retries: 0, ttl: 60 * 60 * 24 * 7 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SSL_ENABLED,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));
app.get('/login.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const users = loadUsers();
  const user = users.find((item) => item.username === username && item.isActive !== false);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role || 'admin',
  };
  return res.json({ ok: true, user: req.session.user });
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ssl: SSL_ENABLED, time: new Date().toISOString() });
});

app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/app.js', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  const users = loadUsers().map(sanitizeUserForClient);
  res.json({ users });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const users = loadUsers();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = VALID_USER_ROLES.has(String(req.body.role || 'admin')) ? String(req.body.role || 'admin') : 'admin';

  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  if (users.some((item) => item.username === username)) return res.status(409).json({ error: 'Username already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = normalizeUser({
    id: generateId('usr'),
    username,
    passwordHash,
    role,
    isActive: true,
    createdAt: new Date().toISOString(),
  });
  users.push(user);
  saveUsers(users);
  res.status(201).json({ user: sanitizeUserForClient(user) });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const users = loadUsers();
  const index = users.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'User not found' });

  const current = users[index];
  const nextUsername = String(req.body.username ?? current.username).trim();
  const nextRole = VALID_USER_ROLES.has(String(req.body.role || current.role)) ? String(req.body.role || current.role) : current.role;
  const nextActive = req.body.isActive === undefined ? current.isActive : Boolean(req.body.isActive);

  if (!nextUsername) return res.status(400).json({ error: 'Username is required' });
  if (users.some((item) => item.id !== current.id && item.username === nextUsername)) return res.status(409).json({ error: 'Username already exists' });

  users[index] = normalizeUser({ ...current, username: nextUsername, role: nextRole, isActive: nextActive });
  saveUsers(users);
  if (req.session.user?.id === current.id) {
    req.session.user.username = users[index].username;
    req.session.user.role = users[index].role;
  }
  res.json({ user: sanitizeUserForClient(users[index]) });
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  const users = loadUsers();
  const index = users.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'User not found' });
  users[index].passwordHash = await bcrypt.hash(password, 12);
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const users = loadUsers();
  const target = users.find((item) => item.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.session.user?.id) return res.status(400).json({ error: 'Cannot delete current session user' });
  const admins = users.filter((item) => item.role === 'admin' && item.isActive !== false);
  if (target.role === 'admin' && admins.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last active admin' });
  }
  saveUsers(users.filter((item) => item.id !== target.id));
  res.json({ ok: true });
});

app.get('/api/state', requireAuth, (_req, res) => {
  res.json(loadState());
});

app.put('/api/state', requireAuth, requireAdmin, (req, res) => {
  const normalized = normalizeIncomingState(req.body);
  saveState(normalized);
  res.json(normalized);
});

app.post('/api/servers', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const payload = normalizeServer({
    id: req.body.id || generateId('srv'),
    name: req.body.name,
    ip: req.body.ip,
    baseUrl: req.body.baseUrl,
    description: req.body.description,
    expanded: req.body.expanded,
    order: nextServerOrder(state),
    tags: req.body.tags,
  }, nextServerOrder(state));
  state.servers.push(payload);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.status(201).json(payload);
});

app.put('/api/servers/:id', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const index = state.servers.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Server not found' });
  const current = state.servers[index];
  state.servers[index] = normalizeServer({ ...current, ...req.body, id: current.id }, current.order);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json(normalized.servers.find((item) => item.id === current.id));
});

app.delete('/api/servers/:id', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const force = String(req.query.force || '').toLowerCase() === 'true';
  const server = state.servers.find((item) => item.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const relatedServices = state.services.filter((item) => item.serverId === server.id);
  if (relatedServices.length && !force) {
    return res.status(409).json({ error: 'Server has services', code: 'SERVER_NOT_EMPTY', servicesCount: relatedServices.length });
  }
  state.servers = state.servers.filter((item) => item.id !== server.id);
  state.services = state.services.filter((item) => item.serverId !== server.id);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.post('/api/services', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const serverId = String(req.body.serverId || getDefaultServerId(state));
  if (!state.servers.some((item) => item.id === serverId)) return res.status(400).json({ error: 'serverId is invalid' });
  const payload = normalizeService({
    ...req.body,
    id: req.body.id || generateId('svc'),
    serverId,
    order: nextServiceOrderForServer(state, serverId),
  }, nextServiceOrderForServer(state, serverId));
  state.services.push(payload);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.status(201).json(payload);
});

app.put('/api/services/:id', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const index = state.services.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Service not found' });
  const current = state.services[index];
  const serverId = String(req.body.serverId || current.serverId);
  if (!state.servers.some((item) => item.id === serverId)) return res.status(400).json({ error: 'serverId is invalid' });
  state.services[index] = normalizeService({ ...current, ...req.body, id: current.id, serverId }, current.order);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json(normalized.services.find((item) => item.id === current.id));
});

app.delete('/api/services/:id', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  state.services = state.services.filter((item) => item.id !== req.params.id);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.post('/api/reorder/servers', requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const state = loadState();
  const orderMap = new Map(ids.map((id, index) => [id, index + 1]));
  state.servers = state.servers.map((item, index) => ({ ...item, order: orderMap.get(item.id) || index + 1000 }));
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true, servers: normalized.servers });
});

app.post('/api/reorder/services', requireAuth, requireAdmin, (req, res) => {
  const serverId = String(req.body.serverId || '');
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const orderMap = new Map(ids.map((id, index) => [id, index + 1]));
  const state = loadState();
  state.services = state.services.map((item, index) => {
    if (item.serverId !== serverId) return item;
    return { ...item, order: orderMap.get(item.id) || index + 1000 };
  });
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, (_req, res) => {
  res.json(loadState());
});

app.post('/api/import', requireAuth, requireAdmin, (req, res) => {
  const normalized = normalizeIncomingState(req.body);
  saveState(normalized);
  res.json(normalized);
});

app.get('/api/statuses', requireAuth, async (_req, res) => {
  const state = loadState();
  const items = await mapLimit(state.services, HEALTH_CONCURRENCY, async (service) => [service.id, await checkService(service)]);
  res.json(Object.fromEntries(items));
});

app.get('/api/discovery/docker', requireAuth, async (_req, res) => {
  try {
    const containers = await discoverDockerContainers();
    res.json({ ok: true, available: true, containers });
  } catch (error) {
    res.json({ ok: false, available: false, error: error.message, containers: [] });
  }
});

app.post('/api/discovery/import', requireAuth, requireAdmin, (req, res) => {
  const state = loadState();
  const serverId = String(req.body.serverId || getDefaultServerId(state));
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!state.servers.some((item) => item.id === serverId)) return res.status(400).json({ error: 'serverId is invalid' });

  let nextOrder = nextServiceOrderForServer(state, serverId);
  for (const item of items) {
    state.services.push(normalizeService({
      id: item.id || generateId('svc'),
      serverId,
      name: item.name || item.containerName || 'Discovered Service',
      url: item.url || '',
      description: item.description || '',
      category: item.category || 'Service',
      iconUrl: item.iconUrl || '',
      healthUrl: item.healthUrl || item.url || '',
      checkMethod: item.checkMethod || 'auto',
      pinned: false,
      order: nextOrder++,
      credentials: [],
      links: [],
      notes: item.containerName ? `Docker: ${item.containerName}` : '',
    }, nextOrder));
  }
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true, imported: items.length, state: normalized });
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureFile(targetPath, fallbackContent) {
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, fallbackContent, 'utf8');
  }
}

function ensureStateFiles() {
  if (fs.existsSync(STATE_FILE)) return;
  if (fs.existsSync(LEGACY_SERVICES_FILE)) {
    const legacy = safeJsonParse(fs.readFileSync(LEGACY_SERVICES_FILE, 'utf8'), []);
    saveState(migrateLegacyServicesIfNeeded(legacy));
    return;
  }
  saveState(normalizeIncomingState({ servers: [], services: [], meta: {} }));
}

function bootstrapAdminUser() {
  if (!ADMIN_BOOTSTRAP_PASSWORD_HASH) return;
  const users = loadUsers();
  if (!users.some((item) => item.username === ADMIN_BOOTSTRAP_USERNAME)) {
    users.push(normalizeUser({
      id: generateId('usr'),
      username: ADMIN_BOOTSTRAP_USERNAME,
      passwordHash: ADMIN_BOOTSTRAP_PASSWORD_HASH,
      role: 'admin',
      isActive: true,
      createdAt: new Date().toISOString(),
    }));
    saveUsers(users);
  }
}

function loadUsers() {
  return safeJsonParse(fs.readFileSync(USERS_FILE, 'utf8'), []).map(normalizeUser);
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, `${JSON.stringify(users.map(normalizeUser), null, 2)}\n`, 'utf8');
}

function normalizeUser(user) {
  const role = String(user.role || 'admin').trim().toLowerCase();
  return {
    id: sanitizeId(user.id || generateId('usr')),
    username: String(user.username || '').trim(),
    passwordHash: String(user.passwordHash || '').trim(),
    role: VALID_USER_ROLES.has(role) ? role : 'admin',
    isActive: user.isActive !== false,
    createdAt: String(user.createdAt || new Date().toISOString()),
  };
}

function sanitizeUserForClient(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

function loadState() {
  const raw = safeJsonParse(fs.readFileSync(STATE_FILE, 'utf8'), null);
  return normalizeIncomingState(raw || { servers: [], services: [], meta: {} });
}

function saveState(state) {
  const normalized = normalizeIncomingState(state);
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function normalizeIncomingState(input) {
  if (Array.isArray(input)) return migrateLegacyServicesIfNeeded(input);

  const state = {
    servers: Array.isArray(input?.servers) ? input.servers : [],
    services: Array.isArray(input?.services) ? input.services : [],
    meta: typeof input?.meta === 'object' && input.meta ? input.meta : {},
  };

  if (!state.servers.length) {
    state.servers.push({
      id: 'srv-default',
      name: 'Default Server',
      ip: '',
      baseUrl: '',
      description: 'Default group',
      expanded: true,
      order: 1,
      tags: [],
    });
  }

  state.servers = state.servers
    .map((server, index) => normalizeServer(server, index + 1))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const serverIds = new Set(state.servers.map((item) => item.id));
  const defaultServerId = state.servers[0].id;

  state.services = state.services
    .map((service, index) => normalizeService({ ...service, serverId: serverIds.has(service.serverId) ? service.serverId : defaultServerId }, index + 1))
    .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.order - b.order || a.name.localeCompare(b.name));

  state.meta = {
    version: 3,
    updatedAt: new Date().toISOString(),
    ...state.meta,
  };

  return state;
}

function normalizeServer(server, fallbackOrder) {
  return {
    id: sanitizeId(server.id || generateId('srv')),
    name: String(server.name || 'Untitled Server').trim(),
    ip: String(server.ip || '').trim(),
    baseUrl: String(server.baseUrl || '').trim(),
    description: String(server.description || '').trim(),
    expanded: server.expanded !== false,
    order: Number.isFinite(Number(server.order)) ? Number(server.order) : fallbackOrder,
    tags: Array.isArray(server.tags) ? server.tags.map((item) => String(item).trim()).filter(Boolean) : [],
  };
}

function normalizeService(service, fallbackOrder) {
  const method = String(service.checkMethod || 'auto').trim().toLowerCase();
  return {
    id: sanitizeId(service.id || generateId('svc')),
    serverId: sanitizeId(service.serverId || 'srv-default'),
    name: String(service.name || 'Untitled Service').trim(),
    url: String(service.url || '').trim(),
    description: String(service.description || '').trim(),
    category: String(service.category || '').trim(),
    iconUrl: String(service.iconUrl || '').trim(),
    healthUrl: String(service.healthUrl || '').trim(),
    checkMethod: VALID_CHECK_METHODS.has(method) ? method : 'auto',
    pinned: Boolean(service.pinned),
    order: Number.isFinite(Number(service.order)) ? Number(service.order) : fallbackOrder,
    credentials: normalizeCredentials(service.credentials),
    links: normalizeLinks(service.links),
    notes: String(service.notes || '').trim(),
  };
}

function normalizeCredentials(credentials) {
  if (!Array.isArray(credentials)) return [];
  return credentials.map((item, index) => ({
    id: sanitizeId(item.id || `cred-${index + 1}`),
    label: String(item.label || '').trim(),
    value: String(item.value || '').trim(),
    secret: Boolean(item.secret),
    copyable: item.copyable !== false,
  })).filter((item) => item.label);
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map((item, index) => ({
    id: sanitizeId(item.id || `link-${index + 1}`),
    label: String(item.label || '').trim(),
    url: String(item.url || '').trim(),
  })).filter((item) => item.label && item.url);
}

function migrateLegacyServicesIfNeeded(legacyServices) {
  return normalizeIncomingState({
    servers: [{
      id: 'srv-default',
      name: 'Default Server',
      ip: '',
      baseUrl: '',
      description: 'Migrated from flat services list',
      expanded: true,
      order: 1,
      tags: [],
    }],
    services: (Array.isArray(legacyServices) ? legacyServices : []).map((item, index) => ({
      ...item,
      serverId: 'srv-default',
      order: index + 1,
      credentials: Array.isArray(item.credentials) ? item.credentials : [],
      links: Array.isArray(item.links) ? item.links : [],
      notes: item.notes || '',
    })),
    meta: { version: 3, migratedFromLegacy: true },
  });
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || generateId('id');
}

function generateId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getDefaultServerId(state) {
  return state.servers[0]?.id || 'srv-default';
}

function nextServerOrder(state) {
  return Math.max(0, ...state.servers.map((item) => Number(item.order) || 0)) + 1;
}

function nextServiceOrderForServer(state, serverId) {
  return Math.max(0, ...state.services.filter((item) => item.serverId === serverId).map((item) => Number(item.order) || 0)) + 1;
}

async function mapLimit(items, limit, mapper) {
  const result = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      result[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
  return result;
}

async function checkService(service) {
  if (service.checkMethod === 'disabled') return 'unknown';
  if (service.checkMethod === 'ping') return pingTarget(pickHost(service.healthUrl || service.url));
  if (service.checkMethod === 'http') return httpTarget(service.healthUrl || service.url);
  const httpStatus = await httpTarget(service.healthUrl || service.url);
  if (httpStatus === 'online') return 'online';
  return pingTarget(pickHost(service.healthUrl || service.url));
}

async function httpTarget(targetUrl) {
  if (!targetUrl) return 'unknown';
  try {
    const url = new URL(targetUrl);
    return await new Promise((resolve) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        timeout: HEALTH_TIMEOUT_MS,
        rejectUnauthorized: false,
      }, (response) => {
        response.resume();
        resolve(response.statusCode && response.statusCode < 500 ? 'online' : 'offline');
      });
      req.on('timeout', () => {
        req.destroy();
        resolve('offline');
      });
      req.on('error', () => resolve('offline'));
      req.end();
    });
  } catch {
    return 'offline';
  }
}

async function pingTarget(host) {
  if (!host) return 'unknown';
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', host], { timeout: HEALTH_TIMEOUT_MS }, (error) => {
      resolve(error ? 'offline' : 'online');
    });
  });
}

function pickHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || '').trim();
  }
}

async function discoverDockerContainers() {
  if (!fs.existsSync(DOCKER_SOCKET_PATH)) {
    throw new Error(`Docker socket not found at ${DOCKER_SOCKET_PATH}`);
  }
  const containers = await dockerRequest('/containers/json?all=0');
  const detailed = [];
  for (const container of containers) {
    const inspect = await dockerRequest(`/containers/${container.Id}/json`);
    const ports = Array.isArray(container.Ports) ? container.Ports : [];
    const names = Array.isArray(container.Names) ? container.Names.map((item) => item.replace(/^\//, '')) : [];
    const name = names[0] || inspect.Name?.replace(/^\//, '') || container.Id.slice(0, 12);
    const hostPort = ports.find((item) => item.PublicPort)?.PublicPort || null;
    const privatePort = ports[0]?.PrivatePort || guessPort(Object.keys(inspect.Config?.ExposedPorts || {}));
    detailed.push({
      id: generateId('svc-discovered'),
      containerId: container.Id,
      containerName: name,
      name: prettifyName(name),
      image: container.Image,
      state: container.State,
      status: container.Status,
      url: hostPort ? `http://HOST:${hostPort}` : '',
      healthUrl: hostPort ? `http://HOST:${hostPort}` : '',
      internalUrl: privatePort ? `http://${name}:${privatePort}` : '',
      category: inferCategory(name),
      checkMethod: hostPort ? 'auto' : 'disabled',
      description: `Docker image: ${container.Image}`,
      ports,
    });
  }
  return detailed.sort((a, b) => a.name.localeCompare(b.name));
}

function dockerRequest(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET_PATH, path: pathname, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Docker API error ${res.statusCode}: ${body}`));
        try {
          resolve(JSON.parse(body || 'null'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function guessPort(exposed) {
  const first = String(exposed?.[0] || '');
  const match = first.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function prettifyName(name) {
  return String(name || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferCategory(name) {
  const value = String(name || '').toLowerCase();
  if (/(postgres|redis|valkey|mysql|mongo|weaviate|qdrant|db)/.test(value)) return 'Database';
  if (/(n8n|automation|workflow)/.test(value)) return 'Automation';
  if (/(ollama|openwebui|rag|llm|ai|crawl)/.test(value)) return 'AI';
  if (/(portainer|proxy|nginx|infra|docker)/.test(value)) return 'Infra';
  return 'Service';
}

function start() {
  if (SSL_ENABLED) {
    if (!fs.existsSync(SSL_CERT_PATH) || !fs.existsSync(SSL_KEY_PATH)) {
      throw new Error(`SSL_ENABLED=true but cert/key not found: ${SSL_CERT_PATH}, ${SSL_KEY_PATH}`);
    }
    const server = https.createServer({ cert: fs.readFileSync(SSL_CERT_PATH), key: fs.readFileSync(SSL_KEY_PATH) }, app);
    server.listen(PORT, HOST, () => {
      console.log(`Self-hosted portal listening on https://${HOST}:${PORT}`);
    });
    return;
  }
  const server = http.createServer(app);
  server.listen(PORT, HOST, () => {
    console.log(`Self-hosted portal listening on http://${HOST}:${PORT}`);
  });
}

start();
