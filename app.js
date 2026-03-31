// ============================================================
//  FIELDCONTROL — Sistema de Gestão de Equipamentos em Campo
//  Banco de Dados: Firebase Firestore (nuvem, multi-usuário)
// ============================================================

// ---- FIREBASE CONFIG ----
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC5Z3v5esf3iwTlr7Ak4JNTTxtagBbIp8Q",
  authDomain:        "controle-bypass.firebaseapp.com",
  projectId:         "controle-bypass",
  storageBucket:     "controle-bypass.firebasestorage.app",
  messagingSenderId: "584322033067",
  appId:             "1:584322033067:web:9b75d8d4db86665e755eee"
};

// ---- FIREBASE STATE ----
let fbDb = null;
let fbUnsubscribe = null;

// ---- APP STATE ----
let currentUser    = null;
let equipamentos   = [];
let map            = null;
let miniMap        = null;
let markers        = {};
let capturedGPS    = null;
let capturedPhotoB64 = null;
let currentTileLayer = null;

const TILES = {
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

// ============================================================
//  FIREBASE INIT
// ============================================================
function initFirebase() {
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    fbDb = firebase.firestore();
    console.log('✅ Firebase conectado — controle-bypass');
    return true;
  } catch (e) {
    console.error('❌ Firebase init error:', e);
    return false;
  }
}

// ============================================================
//  FIRESTORE CRUD
// ============================================================
async function fsGetEquipamentos() {
  try {
    const snap = await fbDb.collection('equipamentos').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('fsGetEquipamentos error:', e);
    return [];
  }
}

async function fsAddEquipamento(eq) {
  const { id, ...data } = eq;
  await fbDb.collection('equipamentos').doc(id).set(data);
}

async function fsUpdateEquipamento(id, updates) {
  await fbDb.collection('equipamentos').doc(id).update(updates);
}

async function fsDeleteEquipamento(id) {
  await fbDb.collection('equipamentos').doc(id).delete();
}

// Users — armazenados no Firestore para sincronizar entre dispositivos
const DEFAULT_USERS = [
  { id: 'u_fiscal', username: 'fiscal', password: 'fiscal123', role: 'fiscal', name: 'Fiscal' },
  { id: 'u_adm',    username: 'adm',    password: 'adm123',    role: 'adm',    name: 'Administrador' },
];

async function fsGetUsers() {
  try {
    const snap = await fbDb.collection('users').get();
    if (snap.empty) {
      // Primeiro acesso: semente com usuários padrão
      for (const u of DEFAULT_USERS) {
        const { id, ...data } = u;
        await fbDb.collection('users').doc(id).set(data);
      }
      return DEFAULT_USERS;
    }
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('fsGetUsers error:', e);
    return DEFAULT_USERS;
  }
}

async function fsAddUser(user) {
  const { id, ...data } = user;
  await fbDb.collection('users').doc(id).set(data);
}

async function fsDeleteUser(id) {
  await fbDb.collection('users').doc(id).delete();
}

// Real-time listener — atualiza todos os usuários automaticamente
function startRealtimeSync() {
  if (fbUnsubscribe) fbUnsubscribe();
  fbUnsubscribe = fbDb.collection('equipamentos')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      equipamentos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMapMarkers();
      renderList();
      updateCounts();
    }, err => console.error('Snapshot error:', err));
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Tema salvo
  const savedTheme = localStorage.getItem('fc_theme') || 'dark';
  if (savedTheme === 'light') applyTheme('light', false);

  // Conectar Firebase
  const ok = initFirebase();
  if (!ok) {
    showToast('❌ Erro ao conectar ao banco de dados.', 'error');
    return;
  }
  updateModeBadge(true);

  // Sessão salva
  const session = JSON.parse(localStorage.getItem('fc_session') || 'null');
  if (session) {
    currentUser = session;
    initApp();
  }
});

function updateModeBadge(online) {
  const badge = document.getElementById('modeBadge');
  if (!badge) return;
  if (online) {
    badge.textContent  = '🔥 Firebase Sync';
    badge.className    = 'mode-badge firebase';
  } else {
    badge.textContent = '❌ Sem conexão';
    badge.className   = 'mode-badge local';
  }
}

// ============================================================
//  LOGIN
// ============================================================
async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!username || !password) { showLoginError('Preencha usuário e senha.'); return; }

  showSyncIndicator('Verificando credenciais...');
  const users = await fsGetUsers();
  hideSyncIndicator();

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) { showLoginError('Usuário ou senha inválidos.'); return; }

  currentUser = user;
  localStorage.setItem('fc_session', JSON.stringify(user));
  initApp();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('loginScreen').classList.contains('active')) doLogin();
});

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function doLogout() {
  if (fbUnsubscribe) { fbUnsubscribe(); fbUnsubscribe = null; }
  localStorage.removeItem('fc_session');
  currentUser  = null;
  equipamentos = [];
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').classList.add('hidden');
}

// ============================================================
//  INIT APP
// ============================================================
async function initApp() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');

  updateUserUI();
  applyRoleVisibility();
  updateModeBadge(true);
  initMap();

  showSyncIndicator('Carregando dados...');
  equipamentos = await fsGetEquipamentos();
  hideSyncIndicator();

  renderMapMarkers();
  renderList();
  updateCounts();

  // Escuta mudanças em tempo real
  startRealtimeSync();
}

function updateUserUI() {
  document.getElementById('userNameDisplay').textContent = currentUser.name || currentUser.username;
  document.getElementById('userRoleDisplay').textContent = currentUser.role.toUpperCase();
  document.getElementById('userAvatar').textContent = (currentUser.name || currentUser.username)[0].toUpperCase();
}

function applyRoleVisibility() {
  const isAdm = currentUser.role === 'adm';
  document.querySelectorAll('.adm-only').forEach(el => el.classList.toggle('hidden', !isAdm));
}

// ============================================================
//  SIDEBAR / TEMA / NAVEGAÇÃO
// ============================================================
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (window.innerWidth <= 768) sb.classList.toggle('open');
  else sb.classList.toggle('collapsed');
  setTimeout(() => { if (map) map.invalidateSize(); }, 350);
}
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) document.getElementById('sidebar').classList.remove('open');
});

function toggleTheme() {
  const isLight = document.body.classList.contains('light-mode');
  applyTheme(isLight ? 'dark' : 'light', true);
}
function applyTheme(theme, save = true) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-mode', isLight);
  const icon  = document.querySelector('#themeBtn .theme-toggle-icon');
  const label = document.getElementById('themeLabel');
  if (icon)  icon.textContent  = isLight ? '☀️' : '🌙';
  if (label) label.textContent = isLight ? 'Modo Escuro' : 'Modo Claro';
  if (save)  localStorage.setItem('fc_theme', theme);
  updateMapTiles(theme);
}
function updateMapTiles(theme) {
  if (!map) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(TILES[theme] || TILES.dark, {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
  }).addTo(map);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const viewEl = document.getElementById('view' + name.charAt(0).toUpperCase() + name.slice(1));
  if (viewEl) viewEl.classList.add('active');
  const navEl = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (navEl) navEl.classList.add('active');
  const titles = {
    map: 'Mapa de Equipamentos', list: 'Lista de Equipamentos',
    cadastro: 'Cadastrar Equipamento', usuarios: 'Gerenciar Usuários'
  };
  document.getElementById('pageTitle').textContent = titles[name] || name;
  if (name === 'map')      setTimeout(() => { if (map) map.invalidateSize(); }, 100);
  if (name === 'list')     renderList();
  if (name === 'usuarios') renderUsers();
  if (name === 'cadastro') resetForm();
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

// ============================================================
//  MAPA
// ============================================================
function initMap() {
  if (map) return;
  map = L.map('map', { center: [-15.8, -47.9], zoom: 5, zoomControl: true });
  const theme = localStorage.getItem('fc_theme') || 'dark';
  currentTileLayer = L.tileLayer(TILES[theme], {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
  }).addTo(map);
  renderMapMarkers();
}

function getMarkerIcon(status) {
  const colors = { instalado: '#2ecc71', retirado: '#f39c12', finalizado: '#3498db' };
  const color = colors[status] || '#ff4d4d';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z" fill="${color}" stroke="#000" stroke-width="1"/>
    <circle cx="12" cy="12" r="5" fill="#000" opacity="0.5"/>
  </svg>`;
  return L.icon({ iconUrl: 'data:image/svg+xml;base64,' + btoa(svg), iconSize:[24,36], iconAnchor:[12,36], popupAnchor:[0,-36] });
}

function renderMapMarkers() {
  if (!map) return;
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  const activeFilters = getActiveFilters();
  const searchVal = (document.getElementById('mapSearchInput')?.value || '').toLowerCase();
  equipamentos.forEach(eq => {
    if (!eq.lat || !eq.lng) return;
    if (eq.status === 'finalizado') return;        // ← Finalizados sem pin
    if (!activeFilters.includes(eq.status)) return;
    if (searchVal && !eq.chave?.toLowerCase().includes(searchVal) && !eq.ocorrencia?.toLowerCase().includes(searchVal)) return;
    const marker = L.marker([eq.lat, eq.lng], { icon: getMarkerIcon(eq.status) })
      .addTo(map).bindPopup(buildMapPopup(eq));
    markers[eq.id] = marker;
  });
}

function buildMapPopup(eq) {
  const lbl = { instalado:'🟢 Instalado', retirado:'🟡 Retirado', finalizado:'🔵 Finalizado' };
  return `<div class="map-popup">
    <div class="map-popup-title">${eq.chave}</div>
    <div class="map-popup-row"><strong>Ocorrência:</strong><span>${eq.ocorrencia}</span></div>
    <div class="map-popup-row"><strong>Status:</strong><span>${lbl[eq.status]||eq.status}</span></div>
    <div class="map-popup-row"><strong>Tipo:</strong><span>${eq.tipo||'—'}</span></div>
    <div class="map-popup-row"><strong>Local:</strong><span>${eq.endereco||'—'}</span></div>
    <div class="map-popup-row"><strong>Cadastro:</strong><span>${eq.dataCadastro}</span></div>
    <div class="map-popup-row"><strong>Usuário:</strong><span>${eq.usuarioCadastro}</span></div>
    ${eq.equipeRetirada ? `<div class="map-popup-row"><strong>Equipe:</strong><span>${eq.equipeRetirada}</span></div>` : ''}
    <button class="map-popup-btn" onclick="openEquipamento('${eq.id}')">Ver detalhes completos</button>
  </div>`;
}

function getActiveFilters() {
  return Array.from(document.querySelectorAll('[data-status]'))
    .filter(cb => cb.checked).map(cb => cb.dataset.status);
}
function updateMapFilter() { renderMapMarkers(); }
function filterMapSearch() { renderMapMarkers(); }

// ============================================================
//  LISTA
// ============================================================
function renderList() {
  const search = (document.getElementById('listSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('listFilter')?.value || '';
  let items = equipamentos.filter(eq => {
    const ms = !search
      || eq.chave?.toLowerCase().includes(search)
      || eq.ocorrencia?.toLowerCase().includes(search)
      || eq.usuarioCadastro?.toLowerCase().includes(search)
      || eq.tipo?.toLowerCase().includes(search)
      || eq.endereco?.toLowerCase().includes(search);
    return ms && (!filter || eq.status === filter);
  });
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const container = document.getElementById('equipList');
  if (!items.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div>📭</div><p>Nenhum equipamento encontrado</p></div>`;
    return;
  }
  container.innerHTML = items.map(eq => `
    <div class="equip-card ${eq.status}" onclick="openEquipamento('${eq.id}')">
      <div class="card-head">
        <div class="card-chave">${eq.chave}</div>
        <span class="status-pill ${eq.status}">${eq.status}</span>
      </div>
      <div class="card-body">
        <span><strong>Ocorrência:</strong>${eq.ocorrencia}</span>
        <span><strong>Tipo:</strong>${eq.tipo||'—'}</span>
        <span><strong>Local:</strong>${eq.endereco||'—'}</span>
        <span><strong>Cadastro:</strong>${eq.dataCadastro} por ${eq.usuarioCadastro}</span>
        ${eq.equipeRetirada ? `<span><strong>Equipe Ret.:</strong>${eq.equipeRetirada} (${eq.dataRetirada})</span>` : ''}
      </div>
    </div>`).join('');
}

// ============================================================
//  CADASTRO
// ============================================================
function resetForm() {
  ['fChave','fOcorrencia','fTipo','fEndereco','fObs'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  capturedGPS = null; capturedPhotoB64 = null;
  document.getElementById('gpsStatus').textContent = 'Clique em "Capturar GPS" para obter sua localização';
  const gc = document.getElementById('gpsCoords'); gc.textContent = ''; gc.classList.add('hidden');
  document.getElementById('photoPreview').innerHTML = `<span class="photo-icon">📷</span><span>Clique para tirar foto ou selecionar</span>`;
  document.getElementById('photoInput').value = '';
  const mm = document.getElementById('miniMap'); if (mm) mm.style.display = 'none';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  document.getElementById('formError').classList.add('hidden');
}

function getGPS() {
  const statusEl = document.getElementById('gpsStatus');
  statusEl.textContent = '⏳ Obtendo localização...';
  if (!navigator.geolocation) { statusEl.textContent = '❌ Geolocalização não suportada.'; return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      capturedGPS = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      statusEl.textContent = `✅ GPS capturado com precisão de ~${capturedGPS.acc}m`;
      const ce = document.getElementById('gpsCoords');
      ce.textContent = `Lat: ${capturedGPS.lat.toFixed(6)}  Lng: ${capturedGPS.lng.toFixed(6)}`;
      ce.classList.remove('hidden');
      initMiniMap(capturedGPS.lat, capturedGPS.lng);
    },
    err => { statusEl.textContent = `❌ Erro: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function initMiniMap(lat, lng) {
  const el = document.getElementById('miniMap'); el.style.display = 'block';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  setTimeout(() => {
    miniMap = L.map('miniMap', { zoomControl:false, dragging:false, scrollWheelZoom:false }).setView([lat,lng], 15);
    const theme = localStorage.getItem('fc_theme') || 'dark';
    L.tileLayer(TILES[theme], { maxZoom:19 }).addTo(miniMap);
    L.marker([lat,lng], { icon: getMarkerIcon('instalado') }).addTo(miniMap);
  }, 100);
}

function handlePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    capturedPhotoB64 = e.target.result;
    document.getElementById('photoPreview').innerHTML = `<img class="photo-preview-img" src="${capturedPhotoB64}">`;
  };
  reader.readAsDataURL(file);
}

async function submitCadastro() {
  const chave      = document.getElementById('fChave').value.trim();
  const ocorrencia = document.getElementById('fOcorrencia').value.trim();
  const tipo       = document.getElementById('fTipo').value.trim();
  const endereco   = document.getElementById('fEndereco').value.trim();
  const obs        = document.getElementById('fObs').value.trim();

  if (!chave)          { showFormError('Nº Chave/Poste é obrigatório.'); return; }
  if (!ocorrencia)     { showFormError('Nº Ocorrência é obrigatório.'); return; }
  if (!capturedGPS)    { showFormError('Localização GPS é obrigatória. Clique em "Capturar GPS".'); return; }
  if (!capturedPhotoB64) { showFormError('Foto do equipamento é obrigatória.'); return; }

  document.getElementById('formError').classList.add('hidden');
  const now = new Date();
  const newEq = {
    id:              'eq_' + Date.now(),
    chave, ocorrencia, tipo, endereco, obs,
    lat:             capturedGPS.lat,
    lng:             capturedGPS.lng,
    photo:           capturedPhotoB64,
    status:          'instalado',
    dataCadastro:    formatDate(now),
    usuarioCadastro: currentUser.name || currentUser.username,
    createdAt:       now.toISOString(),
    equipeRetirada:  null,
    dataRetirada:    null,
    dataFinalizacao: null,
    usuarioFinalizacao: null,
  };

  showSyncIndicator('Salvando no Firebase...');
  await fsAddEquipamento(newEq);
  hideSyncIndicator();
  // Listener em tempo real cuida da atualização em todos os dispositivos

  showToast('✅ Equipamento cadastrado com sucesso!', 'success');
  resetForm();
  showView('map');
  setTimeout(() => {
    if (map && newEq.lat) {
      map.flyTo([newEq.lat, newEq.lng], 16, { duration: 1.5 });
      setTimeout(() => { const m = markers[newEq.id]; if (m) m.openPopup(); }, 1600);
    }
  }, 400);
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg; el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
//  DETALHES DO EQUIPAMENTO
// ============================================================
function openEquipamento(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq) return;
  const isAdm      = currentUser.role === 'adm';
  const isFiscal   = currentUser.role === 'fiscal';
  const isInstalado = eq.status === 'instalado';
  const isRetirado  = eq.status === 'retirado';

  let actionsHTML = `<button class="btn-sm btn-view" onclick="flyToMarker('${eq.id}'); closeModalDirect()">🗺️ Ver no Mapa</button>`;

  if (isFiscal && isInstalado)
    actionsHTML += `<button class="btn-sm btn-done" onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;

  if (isAdm && isInstalado) {
    actionsHTML += `<button class="btn-sm btn-remove" onclick="showRetiradaForm('${eq.id}')">🔧 Registrar Retirada</button>`;
    actionsHTML += `<button class="btn-sm btn-done"   onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;
    actionsHTML += `<button class="btn-sm btn-edit"   onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }
  if (isAdm && isRetirado) {
    actionsHTML += `<button class="btn-sm btn-done"   onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;
    actionsHTML += `<button class="btn-sm btn-edit"   onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }
  if (isAdm && eq.status === 'finalizado') {
    actionsHTML += `<button class="btn-sm btn-edit"   onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }

  const photoHTML = eq.photo
    ? `<img class="popup-photo" src="${eq.photo}" alt="Foto do equipamento">`
    : '<p style="color:var(--text3);font-size:0.85rem;">Sem foto disponível</p>';
  const statusColors = { instalado:'var(--green)', retirado:'var(--orange)', finalizado:'var(--blue)' };

  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Detalhes do Equipamento</div>
    <div class="popup-chave">${eq.chave}</div>
    <div class="popup-grid">
      <div class="popup-field"><label>Status</label>
        <span style="color:${statusColors[eq.status]};font-weight:700;text-transform:uppercase">${eq.status}</span></div>
      <div class="popup-field"><label>Ocorrência</label><span>${eq.ocorrencia}</span></div>
      <div class="popup-field"><label>Tipo</label><span>${eq.tipo||'—'}</span></div>
      <div class="popup-field"><label>Endereço</label><span>${eq.endereco||'—'}</span></div>
      <div class="popup-field"><label>Cadastrado em</label><span>${eq.dataCadastro}</span></div>
      <div class="popup-field"><label>Cadastrado por</label><span>${eq.usuarioCadastro}</span></div>
      <div class="popup-field"><label>Latitude</label>
        <span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lat?.toFixed(6)}</span></div>
      <div class="popup-field"><label>Longitude</label>
        <span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lng?.toFixed(6)}</span></div>
      ${eq.equipeRetirada ? `<div class="popup-field"><label>Equipe Retirada</label><span>${eq.equipeRetirada}</span></div>` : ''}
      ${eq.dataRetirada   ? `<div class="popup-field"><label>Data Retirada</label><span>${eq.dataRetirada}</span></div>` : ''}
      ${eq.dataFinalizacao? `<div class="popup-field"><label>Finalizado em</label><span>${eq.dataFinalizacao}</span></div>` : ''}
    </div>
    ${eq.obs ? `<div class="popup-field" style="margin-bottom:12px"><label>Observações</label><span>${eq.obs}</span></div>` : ''}
    ${photoHTML}
    <div class="popup-actions">${actionsHTML}</div>`;
  openModal();
}

// ============================================================
//  RETIRADA
// ============================================================
function showRetiradaForm(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq) return;
  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Registrar Retirada</div>
    <div class="popup-chave">${eq.chave}</div>
    <div class="remove-form">
      <div class="form-group">
        <label>Equipe responsável pela retirada <span class="required">*</span></label>
        <input type="text" id="removeEquipe" placeholder="Ex: Equipe Norte — João Silva">
      </div>
      <div class="form-group">
        <label>Data da Retirada <span class="required">*</span></label>
        <input type="date" id="removeData" value="${new Date().toISOString().split('T')[0]}">
      </div>
      <div id="removeError" class="error-msg hidden"></div>
      <button class="btn-primary btn-full" onclick="confirmRetirada('${id}')">Confirmar Retirada</button>
    </div>`;
}

async function confirmRetirada(id) {
  const equipe  = document.getElementById('removeEquipe').value.trim();
  const data    = document.getElementById('removeData').value;
  const errEl   = document.getElementById('removeError');
  if (!equipe) { errEl.textContent = 'Informe a equipe.'; errEl.classList.remove('hidden'); return; }
  if (!data)   { errEl.textContent = 'Informe a data.';  errEl.classList.remove('hidden'); return; }

  const updates = { status:'retirado', equipeRetirada:equipe, dataRetirada:formatDateFromInput(data) };
  showSyncIndicator('Registrando retirada...');
  await fsUpdateEquipamento(id, updates);
  hideSyncIndicator();
  closeModalDirect();
  showToast('🔧 Retirada registrada com sucesso!', 'success');
}

// ============================================================
//  FINALIZAR
// ============================================================
async function finalizarEquipamento(id) {
  if (!confirm('Confirmar finalização deste equipamento?')) return;
  const updates = {
    status:             'finalizado',
    dataFinalizacao:    formatDate(new Date()),
    usuarioFinalizacao: currentUser.name || currentUser.username,
  };
  showSyncIndicator('Finalizando equipamento...');
  await fsUpdateEquipamento(id, updates);
  hideSyncIndicator();
  closeModalDirect();
  showToast('✅ Equipamento finalizado! Pin removido do mapa.', 'success');
}

// ============================================================
//  EDITAR
// ============================================================
function editEquipamento(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq) return;
  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Editar Equipamento</div>
    <div class="popup-chave">${eq.chave}</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
      <div class="form-group"><label>Nº Chave / Poste</label>
        <input type="text" id="editChave" value="${eq.chave}"></div>
      <div class="form-group"><label>Nº Ocorrência</label>
        <input type="text" id="editOcorrencia" value="${eq.ocorrencia}"></div>
      <div class="form-group"><label>Tipo</label>
        <input type="text" id="editTipo" value="${eq.tipo||''}"></div>
      <div class="form-group"><label>Endereço</label>
        <input type="text" id="editEndereco" value="${eq.endereco||''}"></div>
      <div class="form-group"><label>Status</label>
        <select id="editStatus">
          <option value="instalado"  ${eq.status==='instalado'  ?'selected':''}>Instalado</option>
          <option value="retirado"   ${eq.status==='retirado'   ?'selected':''}>Retirado</option>
          <option value="finalizado" ${eq.status==='finalizado' ?'selected':''}>Finalizado</option>
        </select></div>
      <div class="form-group"><label>Observações</label>
        <textarea id="editObs" rows="2">${eq.obs||''}</textarea></div>
      <button class="btn-primary btn-full" onclick="saveEdit('${id}')">💾 Salvar Alterações</button>
    </div>`;
}

async function saveEdit(id) {
  const updates = {
    chave:      document.getElementById('editChave').value.trim(),
    ocorrencia: document.getElementById('editOcorrencia').value.trim(),
    tipo:       document.getElementById('editTipo').value.trim(),
    endereco:   document.getElementById('editEndereco').value.trim(),
    status:     document.getElementById('editStatus').value,
    obs:        document.getElementById('editObs').value.trim(),
  };
  showSyncIndicator('Salvando alterações...');
  await fsUpdateEquipamento(id, updates);
  hideSyncIndicator();
  closeModalDirect();
  showToast('✏️ Equipamento atualizado!', 'success');
}

// ============================================================
//  EXCLUIR
// ============================================================
async function deleteEquipamento(id) {
  if (!confirm('Tem certeza que deseja EXCLUIR este equipamento? Esta ação não pode ser desfeita.')) return;
  showSyncIndicator('Excluindo...');
  await fsDeleteEquipamento(id);
  hideSyncIndicator();
  closeModalDirect();
  showToast('🗑️ Equipamento excluído.', 'info');
}

// ============================================================
//  FLY TO
// ============================================================
function flyToMarker(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq || !map) return;
  showView('map');
  setTimeout(() => {
    map.flyTo([eq.lat, eq.lng], 17, { duration: 1.5 });
    setTimeout(() => { const m = markers[id]; if (m) m.openPopup(); }, 1600);
  }, 200);
}

// ============================================================
//  USUÁRIOS — CRUD COMPLETO (ADM)
// ============================================================

// Estado do formulário de usuário
let userFormMode = 'create'; // 'create' | 'edit'

async function renderUsers() {
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const users  = await fsGetUsers();
  const filtered = users.filter(u =>
    !search ||
    (u.name||'').toLowerCase().includes(search) ||
    u.username.toLowerCase().includes(search) ||
    u.role.toLowerCase().includes(search)
  );

  const container = document.getElementById('userList');
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div>👤</div><p>Nenhum usuário encontrado</p></div>`;
    return;
  }

  const editingId = document.getElementById('editingUserId')?.value || '';

  container.innerHTML = filtered.map(u => {
    const isDefault  = u.id === 'u_fiscal' || u.id === 'u_adm';
    const isEditing  = u.id === editingId;
    const avatarClass = u.role === 'adm' ? 'adm-av' : 'fiscal-av';
    const roleLabel   = u.role === 'adm' ? '🔑 Administrador' : '👷 Fiscal';
    const roleColor   = u.role === 'adm' ? 'var(--accent)' : 'var(--blue)';

    return `
    <div class="user-card ${isEditing ? 'editing' : ''}" id="ucard_${u.id}">
      <div class="user-card-avatar ${avatarClass}">
        ${(u.name || u.username)[0].toUpperCase()}
      </div>
      <div class="user-card-info">
        <div class="user-card-name">${u.name || u.username}</div>
        <div class="user-card-login">@${u.username}</div>
        <div class="user-card-meta">
          <span class="role-tag" style="color:${roleColor}">${roleLabel}</span>
          ${isDefault ? '<span class="user-default-tag">padrão</span>' : ''}
        </div>
      </div>
      <div class="user-card-actions">
        <button class="btn-sm btn-edit"   onclick="startEditUser('${u.id}')" title="Editar">✏️</button>
        ${!isDefault
          ? `<button class="btn-sm btn-delete" onclick="removeUser('${u.id}')" title="Excluir">🗑️</button>`
          : `<button class="btn-sm" style="opacity:0.3;cursor:not-allowed;border:1px solid var(--border);color:var(--text3);padding:6px 10px" title="Usuário padrão não pode ser excluído" disabled>🔒</button>`
        }
      </div>
    </div>`;
  }).join('');
}

async function startEditUser(id) {
  const users = await fsGetUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;

  userFormMode = 'edit';

  // Preenche formulário
  document.getElementById('editingUserId').value = id;
  document.getElementById('nuName').value  = u.name || u.username;
  document.getElementById('nuUser').value  = u.username;
  document.getElementById('nuPass').value  = '';

  // Marca perfil correto
  document.querySelectorAll('input[name="nuRole"]').forEach(r => {
    r.checked = r.value === u.role;
  });

  // Atualiza UI do formulário
  document.getElementById('userFormTitle').textContent    = '✏️ Editar Usuário';
  document.getElementById('userFormSubtitle').textContent = `Editando: ${u.name || u.username}`;
  document.getElementById('userFormBtn').textContent      = '💾 Salvar Alterações';
  document.getElementById('userCancelBtn').style.display  = 'inline-flex';
  document.getElementById('editPassHint').classList.remove('hidden');
  document.getElementById('userFormError').classList.add('hidden');

  // Destaca o card e sobe até o form
  renderUsers();
  document.querySelector('.users-form-panel').scrollIntoView({ behavior: 'smooth' });
}

function cancelUserEdit() {
  userFormMode = 'create';
  document.getElementById('editingUserId').value = '';
  document.getElementById('nuName').value  = '';
  document.getElementById('nuUser').value  = '';
  document.getElementById('nuPass').value  = '';
  document.querySelectorAll('input[name="nuRole"]')[0].checked = true;
  document.getElementById('userFormTitle').textContent    = '➕ Novo Usuário';
  document.getElementById('userFormSubtitle').textContent = 'Preencha os dados para cadastrar';
  document.getElementById('userFormBtn').textContent      = '➕ Cadastrar Usuário';
  document.getElementById('userCancelBtn').style.display  = 'none';
  document.getElementById('editPassHint').classList.add('hidden');
  document.getElementById('userFormError').classList.add('hidden');
  renderUsers();
}

async function submitUserForm() {
  if (userFormMode === 'edit') {
    await saveUserEdit();
  } else {
    await addUser();
  }
}

async function addUser() {
  const name     = document.getElementById('nuName').value.trim();
  const username = document.getElementById('nuUser').value.trim();
  const password = document.getElementById('nuPass').value;
  const role     = document.querySelector('input[name="nuRole"]:checked')?.value || 'fiscal';
  const errEl    = document.getElementById('userFormError');

  if (!name)     { errEl.textContent = 'Informe o nome completo.'; errEl.classList.remove('hidden'); return; }
  if (!username) { errEl.textContent = 'Informe o login do usuário.'; errEl.classList.remove('hidden'); return; }
  if (!password) { errEl.textContent = 'Informe a senha.'; errEl.classList.remove('hidden'); return; }
  if (password.length < 4) { errEl.textContent = 'A senha deve ter no mínimo 4 caracteres.'; errEl.classList.remove('hidden'); return; }

  errEl.classList.add('hidden');
  const users = await fsGetUsers();
  if (users.find(u => u.username === username)) {
    errEl.textContent = 'Este login já está em uso. Escolha outro.';
    errEl.classList.remove('hidden');
    return;
  }

  const newUser = { id: 'u_' + Date.now(), name, username, password, role };
  showSyncIndicator('Cadastrando usuário...');
  await fsAddUser(newUser);
  hideSyncIndicator();

  cancelUserEdit();
  showToast(`✅ Usuário "${name}" cadastrado com sucesso!`, 'success');
}

async function saveUserEdit() {
  const id       = document.getElementById('editingUserId').value;
  const name     = document.getElementById('nuName').value.trim();
  const username = document.getElementById('nuUser').value.trim();
  const password = document.getElementById('nuPass').value;
  const role     = document.querySelector('input[name="nuRole"]:checked')?.value || 'fiscal';
  const errEl    = document.getElementById('userFormError');

  if (!name)     { errEl.textContent = 'Informe o nome completo.'; errEl.classList.remove('hidden'); return; }
  if (!username) { errEl.textContent = 'Informe o login do usuário.'; errEl.classList.remove('hidden'); return; }
  if (password && password.length < 4) { errEl.textContent = 'A senha deve ter no mínimo 4 caracteres.'; errEl.classList.remove('hidden'); return; }

  errEl.classList.add('hidden');

  // Verifica duplicata de login (exceto o próprio usuário)
  const users = await fsGetUsers();
  if (users.find(u => u.username === username && u.id !== id)) {
    errEl.textContent = 'Este login já está em uso por outro usuário.';
    errEl.classList.remove('hidden');
    return;
  }

  const updates = { name, username, role };
  if (password) updates.password = password; // só atualiza senha se preenchida

  showSyncIndicator('Salvando alterações...');
  await fbDb.collection('users').doc(id).update(updates);
  hideSyncIndicator();

  // Se editou o próprio usuário logado, atualiza sessão
  if (currentUser.id === id) {
    currentUser = { ...currentUser, ...updates };
    localStorage.setItem('fc_session', JSON.stringify(currentUser));
    updateUserUI();
  }

  cancelUserEdit();
  showToast(`✏️ Usuário "${name}" atualizado com sucesso!`, 'success');
}

async function removeUser(id) {
  const users = await fsGetUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;

  // Não permite excluir o próprio usuário logado
  if (currentUser.id === id) {
    showToast('❌ Você não pode excluir seu próprio usuário.', 'error');
    return;
  }

  if (!confirm(`Excluir o usuário "${u.name || u.username}"?\n\nEsta ação não pode ser desfeita.`)) return;

  showSyncIndicator('Excluindo usuário...');
  await fsDeleteUser(id);
  hideSyncIndicator();

  // Se estava editando esse usuário, cancela edição
  if (document.getElementById('editingUserId').value === id) cancelUserEdit();

  renderUsers();
  showToast(`🗑️ Usuário "${u.name || u.username}" excluído.`, 'info');
}

function togglePassVis(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
  }
}

// ============================================================
//  CONTADORES
// ============================================================
function updateCounts() {
  const c = { instalado:0, retirado:0, finalizado:0 };
  equipamentos.forEach(e => { if (c[e.status] !== undefined) c[e.status]++; });
  document.getElementById('countInstalled').textContent = `${c.instalado} Instalado${c.instalado!==1?'s':''}`;
  document.getElementById('countRemoved').textContent   = `${c.retirado} Retirado${c.retirado!==1?'s':''}`;
  document.getElementById('countDone').textContent      = `${c.finalizado} Finalizado${c.finalizado!==1?'s':''}`;
}

// ============================================================
//  MODAL
// ============================================================
function openModal() { document.getElementById('modal').classList.remove('hidden'); }
function closeModal(e) { if (e.target === document.getElementById('modal')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modal').classList.add('hidden'); }

// ============================================================
//  SYNC INDICATOR
// ============================================================
let syncTimer;
function showSyncIndicator(msg = 'Sincronizando...') {
  const el = document.getElementById('syncIndicator');
  document.getElementById('syncLabel').textContent = msg;
  el.classList.remove('hidden');
  el.querySelector('.sync-dot').className = 'sync-dot';
}
function hideSyncIndicator() {
  const el = document.getElementById('syncIndicator');
  document.getElementById('syncLabel').textContent = '✓ Sincronizado';
  el.querySelector('.sync-dot').className = 'sync-dot online';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

// ============================================================
//  TOAST
// ============================================================
let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ============================================================
//  EXPORTAR EXCEL
// ============================================================
function exportExcel() {
  if (typeof XLSX === 'undefined') { showToast('❌ Biblioteca Excel não carregada.', 'error'); return; }
  const search = (document.getElementById('listSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('listFilter')?.value || '';
  let items = equipamentos.filter(eq => {
    const ms = !search
      || eq.chave?.toLowerCase().includes(search)
      || eq.ocorrencia?.toLowerCase().includes(search)
      || eq.usuarioCadastro?.toLowerCase().includes(search)
      || eq.tipo?.toLowerCase().includes(search)
      || eq.endereco?.toLowerCase().includes(search);
    return ms && (!filter || eq.status === filter);
  });
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!items.length) { showToast('Nenhum registro para exportar.', 'info'); return; }

  const statusLabel = { instalado:'Instalado', retirado:'Retirado', finalizado:'Finalizado' };
  const rows = items.map((eq, i) => ({
    '#': i + 1,
    'Nº Chave / Poste':   eq.chave||'',
    'Nº Ocorrência':      eq.ocorrencia||'',
    'Tipo de Equipamento':eq.tipo||'',
    'Endereço / Referência': eq.endereco||'',
    'Status':             statusLabel[eq.status]||eq.status,
    'Data Cadastro':      eq.dataCadastro||'',
    'Cadastrado por':     eq.usuarioCadastro||'',
    'Latitude':           eq.lat != null ? eq.lat.toFixed(6) : '',
    'Longitude':          eq.lng != null ? eq.lng.toFixed(6) : '',
    'Equipe Retirada':    eq.equipeRetirada||'',
    'Data Retirada':      eq.dataRetirada||'',
    'Data Finalização':   eq.dataFinalizacao||'',
    'Usuário Finalização':eq.usuarioFinalizacao||'',
    'Observações':        eq.obs||'',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    {wch:4},{wch:18},{wch:18},{wch:22},{wch:30},{wch:12},
    {wch:20},{wch:18},{wch:14},{wch:14},{wch:22},{wch:16},{wch:20},{wch:20},{wch:30}
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipamentos');

  const c = { Instalado:0, Retirado:0, Finalizado:0 };
  equipamentos.forEach(e => { const k = statusLabel[e.status]; if (k) c[k]++; });
  const ws2 = XLSX.utils.json_to_sheet([
    {'Resumo':'Total de Equipamentos', 'Quantidade': equipamentos.length},
    {'Resumo':'Instalados',            'Quantidade': c.Instalado},
    {'Resumo':'Retirados',             'Quantidade': c.Retirado},
    {'Resumo':'Finalizados',           'Quantidade': c.Finalizado},
    {'Resumo':'Banco de Dados',        'Quantidade': 'Firebase — controle-bypass'},
    {'Resumo':'Exportado em',          'Quantidade': formatDate(new Date())},
  ]);
  ws2['!cols'] = [{wch:30},{wch:30}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumo');

  const now = new Date();
  const fname = `FieldControl_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.xlsx`;
  XLSX.writeFile(wb, fname);
  showToast(`📊 Planilha exportada: ${fname}`, 'success');
}

// ============================================================
//  UTILS
// ============================================================
function formatDate(d) {
  return d.toLocaleDateString('pt-BR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}
function formatDateFromInput(str) {
  const [y, m, d] = str.split('-'); return `${d}/${m}/${y}`;
}
