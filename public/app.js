const THEME_STORAGE_KEY = 'portal-ui-theme-v1';
const DEFAULT_THEME = {
  mode: 'dark',
  accent: '#59c8ff',
  surfaceTint: '#1f5f7a',
  glass: true,
  serviceCardActions: { style: 'icons-only' },
};
const ACCENT_PRESETS = ['#59c8ff', '#8b7cf6', '#4fd1c5', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#a78bfa'];

const state = {
  data: { servers: [], services: [], meta: {} },
  statuses: {},
  search: '',
  me: null,
  users: [],
  theme: loadThemeSettings(),
  draggingServerId: null,
  draggingServiceId: null,
  discoveryItems: [],
  discoverySearch: '',
};

const el = {
  meBox: document.getElementById('me-box'),
  logoutBtn: document.getElementById('logout-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  searchInput: document.getElementById('search-input'),
  summaryCards: document.getElementById('summary-cards'),
  serversRoot: document.getElementById('servers-root'),
  addServerBtn: document.getElementById('add-server-btn'),
  addServiceBtn: document.getElementById('add-service-btn'),
  checkAllBtn: document.getElementById('check-all-btn'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  serverModal: document.getElementById('server-modal'),
  serverForm: document.getElementById('server-form'),
  serverModalTitle: document.getElementById('server-modal-title'),
  serviceModal: document.getElementById('service-modal'),
  serviceForm: document.getElementById('service-form'),
  serviceModalTitle: document.getElementById('service-modal-title'),
  discoveryBtn: document.getElementById('discovery-btn'),
  discoveryModal: document.getElementById('discovery-modal'),
  discoveryServerSelect: document.getElementById('discovery-server-select'),
  discoveryRefreshBtn: document.getElementById('discovery-refresh-btn'),
  discoveryImportBtn: document.getElementById('discovery-import-btn'),
  discoveryStatus: document.getElementById('discovery-status'),
  discoveryList: document.getElementById('discovery-list'),
  discoverySearchInput: document.getElementById('discovery-search-input'),
  settingsModal: document.getElementById('settings-modal'),
  settingsUserBox: document.getElementById('settings-user-box'),
  themeModeSelect: document.getElementById('theme-mode-select'),
  accentColorInput: document.getElementById('accent-color-input'),
  surfaceColorInput: document.getElementById('surface-color-input'),
  glassToggleInput: document.getElementById('glass-toggle-input'),
  resetThemeBtn: document.getElementById('reset-theme-btn'),
  accentPresets: document.getElementById('accent-presets'),
  actionsStyleSelect: document.getElementById('actions-style-select'),
  usersList: document.getElementById('users-list'),
  userForm: document.getElementById('user-form'),
  userFormError: document.getElementById('user-form-error'),
};

init().catch(handleFatal);

async function init() {
  applyTheme(state.theme);
  renderAccentPresets();
  bindCommonEvents();
  await loadMe();
  await Promise.all([loadState(), loadUsersIfAdmin()]);
  await refreshStatuses();
  render();
}

function bindCommonEvents() {
  el.logoutBtn.addEventListener('click', logout);
  el.settingsBtn.addEventListener('click', openSettingsModal);
  el.searchInput.addEventListener('input', () => {
    state.search = el.searchInput.value.trim().toLowerCase();
    renderServers();
    renderSummary();
  });
  el.addServerBtn.addEventListener('click', () => openServerModal());
  el.addServiceBtn.addEventListener('click', () => openServiceModal());
  el.checkAllBtn.addEventListener('click', async () => {
    await refreshStatuses();
    render();
  });
  el.exportBtn.addEventListener('click', exportStateFile);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', importStateFile);
  el.serverForm.addEventListener('submit', saveServerFromForm);
  el.serviceForm.addEventListener('submit', saveServiceFromForm);
  el.discoveryBtn.addEventListener('click', async () => {
    openDialog(el.discoveryModal);
    await refreshDiscovery();
  });
  el.discoveryRefreshBtn.addEventListener('click', refreshDiscovery);
  el.discoveryImportBtn.addEventListener('click', importSelectedDiscovery);
  el.discoverySearchInput.addEventListener('input', () => {
    state.discoverySearch = el.discoverySearchInput.value.trim().toLowerCase();
    renderDiscoveryList();
  });
  el.themeModeSelect.addEventListener('change', updateThemeFromControls);
  el.accentColorInput.addEventListener('input', updateThemeFromControls);
  el.surfaceColorInput.addEventListener('input', updateThemeFromControls);
  el.glassToggleInput.addEventListener('change', updateThemeFromControls);
  el.actionsStyleSelect.addEventListener('change', updateThemeFromControls);
  el.resetThemeBtn.addEventListener('click', () => {
    state.theme = structuredClone(DEFAULT_THEME);
    syncThemeControls();
    applyTheme(state.theme);
    renderServers();
  });
  el.userForm.addEventListener('submit', createUserFromForm);
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeClosestDialog(btn)));
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', () => {
    if (state.theme.mode === 'system') applyTheme(state.theme);
  });
}

async function loadMe() {
  const response = await fetch('/api/me');
  if (!response.ok) {
    window.location.href = '/login';
    return;
  }
  const payload = await response.json();
  state.me = payload.user;
  el.meBox.textContent = state.me ? `${state.me.username} · ${state.me.role}` : '';
  el.settingsUserBox.textContent = state.me ? `Текущий пользователь: ${state.me.username} (${state.me.role})` : '';
}

async function loadUsersIfAdmin() {
  if (state.me?.role !== 'admin') {
    state.users = [];
    return;
  }
  const payload = await api('/api/users');
  state.users = payload.users || [];
}

async function loadState() {
  state.data = await api('/api/state');
}

async function refreshStatuses() {
  state.statuses = Object.fromEntries(state.data.services.map((item) => [item.id, 'checking']));
  renderServers();
  const payload = await api('/api/statuses');
  state.statuses = payload;
}

function render() {
  syncThemeControls();
  renderSummary();
  renderServers();
  renderServerSelects();
  renderUsers();
}

function renderSummary() {
  const services = getVisibleServicesFlat();
  const online = services.filter((item) => state.statuses[item.id] === 'online').length;
  const offline = services.filter((item) => state.statuses[item.id] === 'offline').length;
  const cards = [
    ['Серверов', state.data.servers.length],
    ['Сервисов', state.data.services.length],
    ['В сети', online],
    ['Не в сети', offline],
  ];
  el.summaryCards.innerHTML = cards.map(([label, value]) => `
    <div class="summary-card glass">
      <div class="muted">${escapeHtml(label)}</div>
      <div class="value">${value}</div>
    </div>
  `).join('');
}

function renderServers() {
  const search = state.search;
  const visibleServers = getSortedServers()
    .map((server) => {
      const services = getServicesByServer(server.id).filter((service) => matchesSearch(server, service, search));
      return { server, services };
    })
    .filter(({ server, services }) => !search || matchesServerSearch(server, search) || services.length > 0);

  if (!visibleServers.length) {
    el.serversRoot.innerHTML = '<div class="server-card glass"><div class="server-body empty-state">Ничего не найдено.</div></div>';
    return;
  }

  el.serversRoot.innerHTML = '';
  for (const { server, services } of visibleServers) {
    const expanded = search ? true : server.expanded;
    const online = services.filter((item) => state.statuses[item.id] === 'online').length;
    const offline = services.filter((item) => state.statuses[item.id] === 'offline').length;
    const card = document.createElement('section');
    card.className = 'server-card glass';
    if (state.me?.role === 'admin') card.draggable = true;
    card.dataset.serverId = server.id;
    card.innerHTML = `
      <div class="server-header">
        <div>
          <div class="server-title">
            <span class="drag-handle ${state.me?.role === 'admin' ? '' : 'hidden'}">⋮⋮</span>
            <div>
              <h2>${escapeHtml(server.name)}</h2>
              <div class="server-meta">
                ${server.ip ? `<span>${escapeHtml(server.ip)}</span>` : ''}
                ${server.baseUrl ? `<span>${escapeHtml(server.baseUrl)}</span>` : ''}
                <span>services: ${services.length}</span>
                <span>online: ${online}</span>
                <span>offline: ${offline}</span>
              </div>
            </div>
          </div>
          ${server.description ? `<div class="muted small">${escapeHtml(server.description)}</div>` : ''}
          <div class="server-meta">${(server.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <div class="server-actions">
          <button class="ghost-btn" data-toggle-server="${server.id}">${expanded ? 'Свернуть' : 'Развернуть'}</button>
          ${state.me?.role === 'admin' ? `<button class="ghost-btn" data-add-service="${server.id}">+ Сервис</button>` : ''}
          ${state.me?.role === 'admin' ? `<button class="ghost-btn" data-edit-server="${server.id}">Редактировать</button>` : ''}
          ${state.me?.role === 'admin' ? `<button class="ghost-btn" data-delete-server="${server.id}">Удалить</button>` : ''}
        </div>
      </div>
      <div class="server-body ${expanded ? '' : 'hidden'}">
        <div class="services-grid" data-services-grid="${server.id}"></div>
      </div>
    `;
    bindServerCardEvents(card, server.id);
    const grid = card.querySelector(`[data-services-grid="${server.id}"]`);
    if (!services.length) {
      grid.innerHTML = '<div class="service-card glass empty-state">Нет сервисов в этой группе.</div>';
    } else {
      services.forEach((service) => grid.appendChild(createServiceCard(server, service)));
    }
    el.serversRoot.appendChild(card);
  }
}

function bindServerCardEvents(card, serverId) {
  if (state.me?.role === 'admin') {
    card.addEventListener('dragstart', () => { state.draggingServerId = serverId; });
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', async (event) => {
      event.preventDefault();
      if (!state.draggingServerId || state.draggingServerId === serverId) return;
      const ordered = getSortedServers().map((item) => item.id);
      const from = ordered.indexOf(state.draggingServerId);
      const to = ordered.indexOf(serverId);
      ordered.splice(to, 0, ordered.splice(from, 1)[0]);
      await api('/api/reorder/servers', { method: 'POST', body: JSON.stringify({ ids: ordered }) });
      state.draggingServerId = null;
      await loadState();
      render();
    });
  }

  card.querySelector('[data-toggle-server]')?.addEventListener('click', async () => {
    const server = state.data.servers.find((item) => item.id === serverId);
    await api(`/api/servers/${serverId}`, { method: 'PUT', body: JSON.stringify({ expanded: !server.expanded }) });
    await loadState();
    renderServers();
  });
  card.querySelector('[data-add-service]')?.addEventListener('click', () => openServiceModal({ serverId }));
  card.querySelector('[data-edit-server]')?.addEventListener('click', () => openServerModal(findServer(serverId)));
  card.querySelector('[data-delete-server]')?.addEventListener('click', async () => {
    if (!window.confirm('Удалить сервер?')) return;
    const response = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
    if (response.status === 409) {
      if (!window.confirm('В сервере есть сервисы. Удалить сервер вместе с ними?')) return;
      await api(`/api/servers/${serverId}?force=true`, { method: 'DELETE' });
    }
    await loadState();
    render();
  });
}

function createServiceCard(server, service) {
  const article = document.createElement('article');
  article.className = `service-card glass actions-${state.theme.serviceCardActions.style}`;
  if (state.me?.role === 'admin') article.draggable = true;
  article.dataset.serviceId = service.id;
  const status = state.statuses[service.id] || 'unknown';
  const icon = service.iconUrl || getSuggestedIcon(service);
  article.innerHTML = `
    <div class="service-top">
      <div class="service-info">
        <div class="service-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="${escapeHtml(service.name)}" onerror="this.parentElement.textContent='${escapeHtml((service.name || 'S').charAt(0).toUpperCase())}'">` : escapeHtml((service.name || 'S').charAt(0).toUpperCase())}</div>
        <div class="service-info-copy">
          <h3 class="service-title">${escapeHtml(service.name)}</h3>
          <div class="service-subtitle">${escapeHtml(service.description || 'Без описания')}</div>
          ${service.url ? `<div class="service-url">${escapeHtml(service.url)}</div>` : ''}
        </div>
      </div>
      <div class="service-side">
        <span class="status-dot status-${escapeHtml(status)}"></span>
        ${service.pinned ? '<span class="tag pin-tag">pinned</span>' : ''}
      </div>
    </div>
    <div class="service-tags">
      ${server.name ? `<span class="tag">${escapeHtml(server.name)}</span>` : ''}
      ${service.category ? `<span class="tag">${escapeHtml(service.category)}</span>` : ''}
      <span class="tag">${escapeHtml(service.checkMethod)}</span>
    </div>
    ${renderCredentials(service.credentials)}
    ${renderLinks(service.links)}
    ${service.notes ? `<div class="service-note">${escapeHtml(service.notes)}</div>` : ''}
    <div class="service-actions">${renderActionButtons(service)}</div>
  `;
  bindServiceCardEvents(article, service);
  return article;
}

function renderActionButtons(service) {
  const style = state.theme.serviceCardActions.style;
  const actions = [
    { kind: 'open', icon: '↗', text: 'Открыть' },
    ...(state.me?.role === 'admin' ? [
      { kind: 'edit', icon: '✎', text: 'Редактировать' },
      { kind: 'delete', icon: '🗑', text: 'Удалить' },
    ] : []),
  ];

  return actions.map((item) => {
    const compactClass = style === 'compact' ? 'compact' : '';
    const label = style === 'icons-only' ? '' : `<span>${item.text}</span>`;
    return `<button class="service-action-btn ${compactClass}" data-action="${item.kind}" type="button"><span class="service-action-icon">${item.icon}</span>${label}</button>`;
  }).join('');
}

function renderCredentials(credentials = []) {
  if (!credentials.length) return '';
  return `
    <div class="credentials-list">
      ${credentials.map((item) => `
        <div class="credential-row">
          <span class="muted">${escapeHtml(item.label)}</span>
          <span class="credential-value">${item.secret ? '••••••••••' : escapeHtml(item.value)}</span>
          ${item.copyable ? `<button class="copy-btn" data-copy="${encodeURIComponent(item.value)}" type="button">⧉</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderLinks(links = []) {
  if (!links.length) return '';
  return `
    <div class="links-list">
      ${links.map((item) => `
        <div class="link-row">
          <span class="muted">${escapeHtml(item.label)}</span>
          <a class="text-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open ↗</a>
        </div>
      `).join('')}
    </div>
  `;
}

function bindServiceCardEvents(article, service) {
  if (state.me?.role === 'admin') {
    article.addEventListener('dragstart', () => { state.draggingServiceId = service.id; });
    article.addEventListener('dragover', (event) => event.preventDefault());
    article.addEventListener('drop', async (event) => {
      event.preventDefault();
      if (!state.draggingServiceId || state.draggingServiceId === service.id) return;
      const ordered = getServicesByServer(service.serverId).map((item) => item.id);
      const from = ordered.indexOf(state.draggingServiceId);
      const to = ordered.indexOf(service.id);
      ordered.splice(to, 0, ordered.splice(from, 1)[0]);
      await api('/api/reorder/services', { method: 'POST', body: JSON.stringify({ serverId: service.serverId, ids: ordered }) });
      state.draggingServiceId = null;
      await loadState();
      renderServers();
    });
  }

  article.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const value = decodeURIComponent(btn.dataset.copy || '');
    await navigator.clipboard.writeText(value);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1200);
  }));

  article.querySelector('[data-action="open"]')?.addEventListener('click', () => {
    if (service.url) window.open(service.url, '_blank', 'noopener,noreferrer');
  });
  article.querySelector('[data-action="edit"]')?.addEventListener('click', () => openServiceModal(service));
  article.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!window.confirm(`Удалить сервис ${service.name}?`)) return;
    await api(`/api/services/${service.id}`, { method: 'DELETE' });
    await loadState();
    render();
  });
}

function renderUsers() {
  if (state.me?.role !== 'admin') {
    el.usersList.innerHTML = '<div class="muted">Недоступно</div>';
    el.userForm.classList.add('hidden');
    return;
  }
  el.userForm.classList.remove('hidden');
  if (!state.users.length) {
    el.usersList.innerHTML = '<div class="muted">Пользователи не найдены.</div>';
    return;
  }
  el.usersList.innerHTML = state.users.map((user) => `
    <div class="user-row">
      <div>
        <div><strong>${escapeHtml(user.username)}</strong> <span class="tag">${escapeHtml(user.role)}</span> ${user.isActive ? '' : '<span class="tag">disabled</span>'}</div>
        <div class="muted small">${escapeHtml(user.createdAt)}</div>
      </div>
      <div class="user-row-actions">
        <button class="ghost-btn compact-btn" data-toggle-user="${user.id}" type="button">${user.isActive ? 'Disable' : 'Enable'}</button>
        <button class="ghost-btn compact-btn" data-pass-user="${user.id}" type="button">Set password</button>
        ${user.id !== state.me?.id ? `<button class="ghost-btn compact-btn" data-delete-user="${user.id}" type="button">Delete</button>` : ''}
      </div>
    </div>
  `).join('');

  el.usersList.querySelectorAll('[data-toggle-user]').forEach((btn) => btn.addEventListener('click', async () => {
    const user = state.users.find((item) => item.id === btn.dataset.toggleUser);
    await api(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !user.isActive }) });
    await loadUsersIfAdmin();
    renderUsers();
  }));
  el.usersList.querySelectorAll('[data-pass-user]').forEach((btn) => btn.addEventListener('click', async () => {
    const password = window.prompt('Новый пароль (минимум 8 символов)');
    if (!password) return;
    await api(`/api/users/${btn.dataset.passUser}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
    window.alert('Пароль обновлен');
  }));
  el.usersList.querySelectorAll('[data-delete-user]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!window.confirm('Удалить пользователя?')) return;
    await api(`/api/users/${btn.dataset.deleteUser}`, { method: 'DELETE' });
    await loadUsersIfAdmin();
    renderUsers();
  }));
}

function renderServerSelects() {
  const options = getSortedServers().map((server) => `<option value="${server.id}">${escapeHtml(server.name)}</option>`).join('');
  el.serviceForm.serverId.innerHTML = options;
  el.discoveryServerSelect.innerHTML = options;
}

function renderAccentPresets() {
  el.accentPresets.innerHTML = ACCENT_PRESETS.map((color) => `<button type="button" class="preset-dot" style="background:${color}" data-accent-preset="${color}" aria-label="${color}"></button>`).join('');
  el.accentPresets.querySelectorAll('[data-accent-preset]').forEach((btn) => btn.addEventListener('click', () => {
    el.accentColorInput.value = btn.dataset.accentPreset;
    updateThemeFromControls();
  }));
}

function syncThemeControls() {
  el.themeModeSelect.value = state.theme.mode;
  el.accentColorInput.value = state.theme.accent;
  el.surfaceColorInput.value = state.theme.surfaceTint;
  el.glassToggleInput.checked = state.theme.glass;
  el.actionsStyleSelect.value = state.theme.serviceCardActions.style;
}

function updateThemeFromControls() {
  state.theme = {
    mode: el.themeModeSelect.value,
    accent: el.accentColorInput.value,
    surfaceTint: el.surfaceColorInput.value,
    glass: el.glassToggleInput.checked,
    serviceCardActions: { style: el.actionsStyleSelect.value },
  };
  applyTheme(state.theme);
  renderServers();
}

function applyTheme(theme) {
  const resolvedMode = resolveThemeMode(theme.mode);
  const root = document.documentElement;
  const palette = resolvedMode === 'dark' ? getDarkPalette(theme) : getLightPalette(theme);
  Object.entries(palette).forEach(([key, value]) => root.style.setProperty(key, value));
  root.dataset.theme = resolvedMode;
  root.dataset.glass = theme.glass ? 'true' : 'false';
  saveThemeSettings(theme);
}

function resolveThemeMode(mode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode === 'light' ? 'light' : 'dark';
}

function getDarkPalette(theme) {
  return {
    '--bg': mix(theme.surfaceTint, '#090b0f', 0.15),
    '--bg-elevated': mix(theme.surfaceTint, '#10131a', 0.18),
    '--panel': theme.glass ? 'rgba(255,255,255,0.06)' : 'rgba(17,19,27,0.92)',
    '--panel-strong': theme.glass ? 'rgba(255,255,255,0.08)' : 'rgba(17,19,27,0.98)',
    '--border': 'rgba(255,255,255,0.12)',
    '--text': '#f3f4f6',
    '--text-strong': '#ffffff',
    '--muted': 'rgba(230,235,241,0.72)',
    '--muted-soft': 'rgba(230,235,241,0.46)',
    '--input-bg': 'rgba(8,10,14,0.56)',
    '--input-text': '#edf2f7',
    '--modal-backdrop': 'rgba(0,0,0,0.64)',
    '--accent': theme.accent,
    '--accent-soft': toAlpha(theme.accent, 0.18),
    '--shadow': 'rgba(0,0,0,0.42)',
    '--bg-layer': `radial-gradient(circle at top, ${toAlpha(theme.accent, 0.18)}, transparent 24%), radial-gradient(circle at 10% 20%, ${toAlpha(theme.surfaceTint, 0.24)}, transparent 18%), linear-gradient(180deg, ${mix(theme.surfaceTint, '#0c0f13', 0.12)} 0%, #07080c 100%)`,
  };
}

function getLightPalette(theme) {
  return {
    '--bg': mix(theme.surfaceTint, '#eef4f8', 0.08),
    '--bg-elevated': '#ffffff',
    '--panel': theme.glass ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.98)',
    '--panel-strong': 'rgba(255,255,255,0.98)',
    '--border': 'rgba(15,23,42,0.10)',
    '--text': '#1f2937',
    '--text-strong': '#111827',
    '--muted': 'rgba(31,41,55,0.76)',
    '--muted-soft': 'rgba(31,41,55,0.48)',
    '--input-bg': 'rgba(255,255,255,0.88)',
    '--input-text': '#111827',
    '--modal-backdrop': 'rgba(15,23,42,0.22)',
    '--accent': theme.accent,
    '--accent-soft': toAlpha(theme.accent, 0.14),
    '--shadow': 'rgba(15,23,42,0.08)',
    '--bg-layer': `radial-gradient(circle at top, ${toAlpha(theme.accent, 0.10)}, transparent 24%), radial-gradient(circle at 10% 20%, ${toAlpha(theme.surfaceTint, 0.16)}, transparent 18%), linear-gradient(180deg, ${mix(theme.surfaceTint, '#f8fbfd', 0.08)} 0%, #eef4f8 100%)`,
  };
}

function openSettingsModal() {
  syncThemeControls();
  renderUsers();
  openDialog(el.settingsModal);
}

function openServerModal(server = null) {
  el.serverModalTitle.textContent = server ? 'Редактировать сервер' : 'Добавить сервер';
  el.serverForm.reset();
  el.serverForm.id.value = server?.id || '';
  el.serverForm.name.value = server?.name || '';
  el.serverForm.ip.value = server?.ip || '';
  el.serverForm.baseUrl.value = server?.baseUrl || '';
  el.serverForm.description.value = server?.description || '';
  el.serverForm.tags.value = (server?.tags || []).join(', ');
  el.serverForm.expanded.checked = server ? server.expanded !== false : true;
  openDialog(el.serverModal);
}

function openServiceModal(service = null) {
  el.serviceModalTitle.textContent = service ? 'Редактировать сервис' : 'Добавить сервис';
  el.serviceForm.reset();
  renderServerSelects();
  el.serviceForm.id.value = service?.id || '';
  el.serviceForm.serverId.value = service?.serverId || getSortedServers()[0]?.id || '';
  el.serviceForm.name.value = service?.name || '';
  el.serviceForm.url.value = service?.url || '';
  el.serviceForm.category.value = service?.category || '';
  el.serviceForm.description.value = service?.description || '';
  el.serviceForm.iconUrl.value = service?.iconUrl || '';
  el.serviceForm.healthUrl.value = service?.healthUrl || '';
  el.serviceForm.checkMethod.value = service?.checkMethod || 'auto';
  el.serviceForm.pinned.checked = !!service?.pinned;
  el.serviceForm.notes.value = service?.notes || '';
  el.serviceForm.credentials.value = service?.credentials?.length ? JSON.stringify(service.credentials, null, 2) : '';
  el.serviceForm.links.value = service?.links?.length ? JSON.stringify(service.links, null, 2) : '';
  openDialog(el.serviceModal);
}

async function saveServerFromForm(event) {
  event.preventDefault();
  const payload = {
    name: el.serverForm.name.value,
    ip: el.serverForm.ip.value,
    baseUrl: el.serverForm.baseUrl.value,
    description: el.serverForm.description.value,
    tags: el.serverForm.tags.value.split(',').map((item) => item.trim()).filter(Boolean),
    expanded: el.serverForm.expanded.checked,
  };
  const id = el.serverForm.id.value;
  await api(id ? `/api/servers/${id}` : '/api/servers', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  closeDialog(el.serverModal);
  await loadState();
  render();
}

async function saveServiceFromForm(event) {
  event.preventDefault();
  let credentials = [];
  let links = [];
  try {
    credentials = el.serviceForm.credentials.value.trim() ? JSON.parse(el.serviceForm.credentials.value) : [];
    links = el.serviceForm.links.value.trim() ? JSON.parse(el.serviceForm.links.value) : [];
  } catch {
    window.alert('Credentials JSON или Links JSON невалидны');
    return;
  }
  const payload = {
    serverId: el.serviceForm.serverId.value,
    name: el.serviceForm.name.value,
    url: el.serviceForm.url.value,
    category: el.serviceForm.category.value,
    description: el.serviceForm.description.value,
    iconUrl: el.serviceForm.iconUrl.value,
    healthUrl: el.serviceForm.healthUrl.value,
    checkMethod: el.serviceForm.checkMethod.value,
    pinned: el.serviceForm.pinned.checked,
    notes: el.serviceForm.notes.value,
    credentials,
    links,
  };
  const id = el.serviceForm.id.value;
  await api(id ? `/api/services/${id}` : '/api/services', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  closeDialog(el.serviceModal);
  await loadState();
  await refreshStatuses();
  render();
}

async function refreshDiscovery() {
  el.discoveryStatus.textContent = 'Загрузка...';
  const payload = await api('/api/discovery/docker');
  state.discoveryItems = payload.containers || [];
  state.discoverySearch = '';
  if (el.discoverySearchInput) el.discoverySearchInput.value = '';
  if (!payload.available) {
    el.discoveryStatus.textContent = payload.error || 'Docker autodiscovery недоступен';
    el.discoveryList.innerHTML = '';
    return;
  }
  renderDiscoveryList();
}

function renderDiscoveryList() {
  const items = getVisibleDiscoveryItems();
  el.discoveryStatus.textContent = `Найдено контейнеров: ${state.discoveryItems.length}${state.discoverySearch ? ` · показано: ${items.length}` : ''}`;
  if (!items.length) {
    el.discoveryList.innerHTML = '<div class="glass-subtle empty-state">Ничего не найдено по текущему фильтру.</div>';
    return;
  }
  el.discoveryList.innerHTML = items.map((item) => {
    const category = item.category || 'Service';
    const typeMeta = getCategoryMeta(category);
    const targetUrl = item.url || item.internalUrl || '';
    return `
      <label class="discovery-item glass-subtle">
        <div class="discovery-row">
          <div class="discovery-check-wrap">
            <input class="discovery-checkbox" type="checkbox" data-discovery-item="${item.id}" />
            <span class="discovery-check-indicator" aria-hidden="true"></span>
          </div>
          <div class="discovery-copy">
            <div class="discovery-title-row">
              <strong class="discovery-title">${escapeHtml(item.name)}</strong>
              ${item.state ? `<span class="tag">${escapeHtml(item.state)}</span>` : ''}
            </div>
            <div class="muted small">${escapeHtml(item.image || '')}</div>
            ${targetUrl ? `<div class="muted small discovery-url">${escapeHtml(targetUrl)}</div>` : ''}
          </div>
          <div class="discovery-type-badge" title="${escapeHtml(category)}">
            <span class="discovery-type-icon">${typeMeta.icon}</span>
            <span class="discovery-type-label">${escapeHtml(category)}</span>
          </div>
        </div>
      </label>
    `;
  }).join('');
}

function getVisibleDiscoveryItems() {
  const q = state.discoverySearch;
  if (!q) return state.discoveryItems;
  return state.discoveryItems.filter((item) => [item.name, item.image, item.url, item.internalUrl, item.category, item.description, item.status].join(' ').toLowerCase().includes(q));
}

async function importSelectedDiscovery() {
  const selected = Array.from(el.discoveryList.querySelectorAll('[data-discovery-item]:checked')).map((input) => state.discoveryItems.find((item) => item.id === input.dataset.discoveryItem)).filter(Boolean);
  if (!selected.length) {
    window.alert('Ничего не выбрано');
    return;
  }
  await api('/api/discovery/import', {
    method: 'POST',
    body: JSON.stringify({ serverId: el.discoveryServerSelect.value, items: selected }),
  });
  closeDialog(el.discoveryModal);
  await loadState();
  await refreshStatuses();
  render();
}

async function createUserFromForm(event) {
  event.preventDefault();
  el.userFormError.textContent = '';
  const form = new FormData(el.userForm);
  const username = String(form.get('username') || '').trim();
  const role = String(form.get('role') || 'admin');
  const password = String(form.get('password') || '');
  const confirmPassword = String(form.get('confirmPassword') || '');
  if (password !== confirmPassword) {
    el.userFormError.textContent = 'Пароли не совпадают';
    return;
  }
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username, role, password }) });
    el.userForm.reset();
    await loadUsersIfAdmin();
    renderUsers();
  } catch (error) {
    el.userFormError.textContent = error.message;
  }
}

async function exportStateFile() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'portal-state.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function importStateFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const parsed = JSON.parse(text);
  await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
  event.target.value = '';
  await loadState();
  await refreshStatuses();
  render();
}

async function logout() {
  await api('/logout', { method: 'POST' });
  window.location.href = '/login';
}

function getSortedServers() {
  return [...state.data.servers].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function getServicesByServer(serverId) {
  return [...state.data.services]
    .filter((item) => item.serverId === serverId)
    .sort((a, b) => a.order - b.order || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

function getVisibleServicesFlat() {
  const result = [];
  getSortedServers().forEach((server) => {
    getServicesByServer(server.id).forEach((service) => {
      if (matchesSearch(server, service, state.search)) result.push(service);
    });
  });
  return result;
}

function findServer(serverId) {
  return state.data.servers.find((item) => item.id === serverId);
}

function matchesServerSearch(server, search) {
  const hay = [server.name, server.ip, server.baseUrl, server.description, ...(server.tags || [])].join(' ').toLowerCase();
  return hay.includes(search);
}

function matchesSearch(server, service, search) {
  if (!search) return true;
  const hay = [
    server.name,
    server.ip,
    server.baseUrl,
    service.name,
    service.url,
    service.description,
    service.category,
    service.notes,
    ...(service.credentials || []).map((item) => item.label),
    ...(service.links || []).map((item) => item.label),
  ].join(' ').toLowerCase();
  return hay.includes(search);
}

function getSuggestedIcon(service) {
  if (service.iconUrl) return service.iconUrl;
  const name = String(service.name || '').toLowerCase();
  const map = {
    'n8n': 'https://cdn.simpleicons.org/n8n',
    'ollama': 'https://cdn.simpleicons.org/ollama',
    'postgresql': 'https://cdn.simpleicons.org/postgresql',
    'redis': 'https://cdn.simpleicons.org/redis',
    'redis (valkey)': 'https://cdn.simpleicons.org/redis',
    'portainer': 'https://cdn.simpleicons.org/portainer',
    'open webui': 'https://cdn.simpleicons.org/openai',
    'weaviate': 'https://cdn.simpleicons.org/weaviate',
    'crawl4ai': 'https://cdn.simpleicons.org/scrapy',
  };
  if (map[name]) return map[name];
  try {
    const host = new URL(service.url).hostname;
    return `https://favicon.yandex.net/favicon/${host}`;
  } catch {
    return '';
  }
}

function loadThemeSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || 'null');
    if (!parsed) return structuredClone(DEFAULT_THEME);
    return {
      ...structuredClone(DEFAULT_THEME),
      ...parsed,
      serviceCardActions: {
        ...DEFAULT_THEME.serviceCardActions,
        ...(parsed.serviceCardActions || {}),
      },
    };
  } catch {
    return structuredClone(DEFAULT_THEME);
  }
}

function saveThemeSettings(theme) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function closeClosestDialog(button) {
  const dialog = button.closest('dialog');
  if (dialog) closeDialog(dialog);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    if (response.redirected) {
      window.location.href = response.url;
      throw new Error('Redirected to login');
    }
    const payload = await safeResponseJson(response);
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return safeResponseJson(response);
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function getCategoryMeta(category) {
  const value = String(category || '').toLowerCase();
  if (value.includes('database')) return { icon: iconDatabase() };
  if (value.includes('infra')) return { icon: iconInfra() };
  if (value.includes('network')) return { icon: iconNetwork() };
  if (value.includes('ai')) return { icon: iconAI() };
  if (value.includes('automation')) return { icon: iconAutomation() };
  return { icon: iconService() };
}

function iconService() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="6" rx="2"></rect><rect x="4" y="14" width="16" height="6" rx="2"></rect></svg>';
}

function iconDatabase() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"></path><path d="M5 11v8c0 1.7 3.1 3 7 3s7-1.3 7-3v-8"></path></svg>';
}

function iconInfra() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"></path><path d="M12 12l8-4.5"></path><path d="M12 12v9"></path><path d="M12 12L4 7.5"></path></svg>';
}

function iconNetwork() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a12 12 0 0 1 16 0"></path><path d="M7 12a8 8 0 0 1 10 0"></path><path d="M10 15a4 4 0 0 1 4 0"></path><circle cx="12" cy="18" r="1"></circle></svg>';
}

function iconAI() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="M4.9 4.9l2.8 2.8"></path><path d="M16.3 16.3l2.8 2.8"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><path d="M4.9 19.1l2.8-2.8"></path><path d="M16.3 7.7l2.8-2.8"></path><circle cx="12" cy="12" r="4"></circle></svg>';
}

function iconAutomation() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-6 6"></path><path d="M20 10H9a5 5 0 1 0 0 10h1"></path><path d="M10 20l-6-6 6-6"></path><path d="M4 14h11a5 5 0 1 0 0-10h-1"></path></svg>';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function mix(hexA, hexB, amount) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const mixValue = (first, second) => Math.round(first + (second - first) * amount);
  return rgbToHex(mixValue(a.r, b.r), mixValue(a.g, b.g), mixValue(a.b, b.b));
}

function toAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgb(hex) {
  const normalized = String(hex || '#000000').replace('#', '');
  const safe = normalized.length === 3 ? normalized.split('').map((char) => char + char).join('') : normalized.padEnd(6, '0').slice(0, 6);
  const value = Number.parseInt(safe, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function handleFatal(error) {
  console.error(error);
  window.alert(`Ошибка: ${error.message}`);
}
