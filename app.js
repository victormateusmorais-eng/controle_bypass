// ============================================================
//  FIELDCONTROL — Sistema de Gestão de Equipamentos em Campo
//  Banco: Firebase Firestore
//  Foto: base64 comprimida (~200KB) em sub-coleção "fotos"
//        → evita limite 1MB do doc principal e erro de CORS
//        → sem dependência de Firebase Storage
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
let fbDb          = null;
let fbUnsubscribe = null;

// ---- APP STATE ----
let currentUser       = null;
let equipamentos      = [];
let map               = null;
let miniMap           = null;
let markers           = {};
let capturedGPS       = null;
let capturedPhotoBlob = null;   // Blob comprimido pronto para salvar
let capturedPhotoB64  = null;   // Preview local (base64 comprimido)
let currentTileLayer  = null;

const TILES = {
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

// ============================================================
//  FIREBASE INIT
// ============================================================
function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    fbDb = firebase.firestore();
    // Configurações para melhor tolerância a falhas de rede
    fbDb.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED });
    fbDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    console.log('✅ Firebase Firestore conectado — controle-bypass');
    return true;
  } catch (e) {
    console.error('❌ Firebase init error:', e);
    return false;
  }
}

// ============================================================
//  IMAGEM — Compressão agressiva → base64 → Firestore
//  Estratégia: max 800px, qualidade 0.65 → ~80–200KB
//  Salvo em coleção separada "fotos/{equipId}"
//  → doc principal fica < 50KB, sem problema de limite 1MB
// ============================================================

// Comprime imagem: maxPx largura/altura, quality 0–1
function compressImage(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      // Redimensiona mantendo proporção
      if (width > maxPx || height > maxPx) {
        if (width >= height) {
          height = Math.round(height * maxPx / width);
          width  = maxPx;
        } else {
          width  = Math.round(width * maxPx / height);
          height = maxPx;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob falhou')),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Falha ao carregar imagem'));
    img.src = url;
  });
}

// Converte Blob para base64 string (sem prefixo data:...)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result); // inclui "data:image/jpeg;base64,..."
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Salva foto em coleção separada "fotos/{equipId}"
async function fsSaveFoto(equipId, base64) {
  await fbDb.collection('fotos').doc(equipId).set({ data: base64, updatedAt: new Date().toISOString() });
}

// Busca foto da coleção "fotos/{equipId}"
async function fsGetFoto(equipId) {
  try {
    const doc = await fbDb.collection('fotos').doc(equipId).get();
    return doc.exists ? doc.data().data : null;
  } catch (e) {
    console.error('fsGetFoto error:', e);
    return null;
  }
}

// Exclui foto ao excluir equipamento
async function fsDeleteFoto(equipId) {
  try {
    await fbDb.collection('fotos').doc(equipId).delete();
  } catch (e) { /* silencioso */ }
}

// ============================================================
//  GEOCODING REVERSO (Nominatim — OpenStreetMap, gratuito)
// ============================================================
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=pt-BR`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.address) return null;
    const a = data.address;
    // Monta endereço legível em português
    const parts = [];
    if (a.road || a.pedestrian || a.footway)  parts.push(a.road || a.pedestrian || a.footway);
    if (a.house_number)                        parts.push(a.house_number);
    if (a.suburb || a.neighbourhood)           parts.push(a.suburb || a.neighbourhood);
    if (a.city || a.town || a.village || a.municipality) {
      parts.push(a.city || a.town || a.village || a.municipality);
    }
    if (a.state)  parts.push(a.state);
    return parts.length ? parts.join(', ') : data.display_name;
  } catch (e) {
    console.warn('Geocoding reverso falhou:', e);
    return null;
  }
}

// ============================================================
//  FIRESTORE CRUD — EQUIPAMENTOS
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
  await fsDeleteFoto(id);
}

// ============================================================
//  FIRESTORE CRUD — USUÁRIOS
// ============================================================
const DEFAULT_USERS = [
  { id: 'u_fiscal', username: 'fiscal', password: 'fiscal123', role: 'fiscal', name: 'Fiscal' },
  { id: 'u_adm',    username: 'adm',    password: 'adm123',    role: 'adm',    name: 'Administrador' },
];

async function fsGetUsers() {
  try {
    const snap = await fbDb.collection('users').get();
    if (snap.empty) {
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

// Real-time listener
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
  const savedTheme = localStorage.getItem('fc_theme') || 'dark';
  if (savedTheme === 'light') applyTheme('light', false);

  const ok = initFirebase();
  if (!ok) { showToast('❌ Erro ao conectar ao Firebase.', 'error'); return; }
  updateModeBadge(true);

  const session = JSON.parse(localStorage.getItem('fc_session') || 'null');
  if (session) { currentUser = session; initApp(); }
});

function updateModeBadge(online) {
  const badge = document.getElementById('modeBadge');
  if (!badge) return;
  badge.textContent = online ? '🔥 Firebase Sync' : '❌ Sem conexão';
  badge.className   = 'mode-badge ' + (online ? 'firebase' : 'local');
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
  el.textContent = msg; el.classList.remove('hidden');
}

function doLogout() {
  if (fbUnsubscribe) { fbUnsubscribe(); fbUnsubscribe = null; }
  localStorage.removeItem('fc_session');
  currentUser = null; equipamentos = [];
  document.body.classList.remove('sidebar-is-open');
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
  if (window.innerWidth <= 768) {
    const opening = !sb.classList.contains('open');
    sb.classList.toggle('open', opening);
    document.body.classList.toggle('sidebar-is-open', opening);
  } else {
    sb.classList.toggle('collapsed');
    setTimeout(() => { if (map) map.invalidateSize(); }, 350);
  }
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-is-open');
}
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    closeSidebar();
    if (map) setTimeout(() => map.invalidateSize(), 50);
  }
});

function toggleTheme() {
  applyTheme(document.body.classList.contains('light-mode') ? 'dark' : 'light', true);
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
  document.querySelectorAll('.bottom-nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById('view' + name.charAt(0).toUpperCase() + name.slice(1));
  if (viewEl) viewEl.classList.add('active');

  // Sidebar nav
  const navEl = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (navEl) navEl.classList.add('active');

  // Bottom nav (mobile)
  const bnEl = document.querySelector(`.bottom-nav-item[data-view="${name}"]`);
  if (bnEl) bnEl.classList.add('active');

  const titles = { map:'Mapa de Equipamentos', list:'Lista de Equipamentos',
                   cadastro:'Cadastrar Equipamento', usuarios:'Gerenciar Usuários' };
  document.getElementById('pageTitle').textContent = titles[name] || name;

  if (name === 'map')      setTimeout(() => { if (map) map.invalidateSize(); }, 100);
  if (name === 'list')     renderList();
  if (name === 'usuarios') renderUsers();
  if (name === 'cadastro') resetForm();

  // Fecha sidebar no mobile ao navegar
  if (window.innerWidth <= 768) closeSidebar();
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
  const colors = { instalado:'#2ecc71', retirado:'#f39c12', finalizado:'#3498db' };
  const color = colors[status] || '#ff4d4d';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z" fill="${color}" stroke="#000" stroke-width="1"/>
    <circle cx="12" cy="12" r="5" fill="#000" opacity="0.5"/>
  </svg>`;
  return L.icon({ iconUrl:'data:image/svg+xml;base64,'+btoa(svg), iconSize:[24,36], iconAnchor:[12,36], popupAnchor:[0,-36] });
}

function renderMapMarkers() {
  if (!map) return;
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  const activeFilters = getActiveFilters();
  const searchVal = (document.getElementById('mapSearchInput')?.value || '').toLowerCase();
  equipamentos.forEach(eq => {
    if (!eq.lat || !eq.lng) return;
    if (eq.status === 'finalizado') return;
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
    <div class="map-popup-row"><strong>NDS:</strong><span>${eq.nds||eq.tipo||'—'}</span></div>
    <div class="map-popup-row"><strong>Local:</strong><span>${eq.endereco||'—'}</span></div>
    <div class="map-popup-row"><strong>Cadastro:</strong><span>${eq.dataCadastro}</span></div>
    <div class="map-popup-row"><strong>Usuário:</strong><span>${eq.usuarioCadastro}</span></div>
    ${eq.equipeRetirada?`<div class="map-popup-row"><strong>Equipe:</strong><span>${eq.equipeRetirada}</span></div>`:''}
    <button class="map-popup-btn" onclick="openEquipamento('${eq.id}')">Ver detalhes completos</button>
  </div>`;
}

function getActiveFilters() {
  return Array.from(document.querySelectorAll('[data-status]'))
    .filter(cb => cb.checked).map(cb => cb.dataset.status);
}
function updateMapFilter() { renderMapMarkers(); }
function filterMapSearch()  { renderMapMarkers(); }

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
      || (eq.nds||eq.tipo||'').toLowerCase().includes(search)
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
        <span><strong>NDS:</strong>${eq.nds||eq.tipo||'—'}</span>
        <span><strong>Local:</strong>${eq.endereco||'—'}</span>
        <span><strong>Cadastro:</strong>${eq.dataCadastro} por ${eq.usuarioCadastro}</span>
        ${eq.equipeRetirada?`<span><strong>Equipe Ret.:</strong>${eq.equipeRetirada} (${eq.dataRetirada})</span>`:''}
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
  capturedGPS = null; capturedPhotoBlob = null; capturedPhotoB64 = null;
  document.getElementById('gpsStatus').textContent = 'Clique em "Capturar GPS" para obter sua localização';
  const gc = document.getElementById('gpsCoords'); if (gc) { gc.textContent=''; gc.classList.add('hidden'); }
  document.getElementById('photoPreview').innerHTML = `<span class="photo-icon">📷</span><span>Clique para tirar foto ou selecionar</span>`;
  document.getElementById('photoInput').value = '';
  setUploadProgress(false);
  const mm = document.getElementById('miniMap'); if (mm) mm.style.display = 'none';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  document.getElementById('formError').classList.add('hidden');
}

// GPS + geocoding reverso automático
async function getGPS() {
  const statusEl = document.getElementById('gpsStatus');
  statusEl.textContent = '⏳ Obtendo localização...';
  if (!navigator.geolocation) { statusEl.textContent = '❌ Geolocalização não suportada.'; return; }

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = Math.round(pos.coords.accuracy);
      capturedGPS = { lat, lng, acc };

      statusEl.textContent = `✅ GPS capturado — precisão ~${acc}m`;
      const ce = document.getElementById('gpsCoords');
      ce.textContent = `Lat: ${lat.toFixed(6)}  Lng: ${lng.toFixed(6)}`;
      ce.classList.remove('hidden');
      initMiniMap(lat, lng);

      // Preenche endereço automaticamente
      const endEl = document.getElementById('fEndereco');
      if (endEl && !endEl.value.trim()) {
        statusEl.textContent = `✅ GPS capturado — buscando endereço...`;
        const addr = await reverseGeocode(lat, lng);
        if (addr) {
          endEl.value = addr;
          statusEl.textContent = `✅ GPS capturado — endereço encontrado ✓`;
        } else {
          statusEl.textContent = `✅ GPS capturado — precisão ~${acc}m`;
        }
      }
    },
    err => { statusEl.textContent = `❌ Erro: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

function initMiniMap(lat, lng) {
  const el = document.getElementById('miniMap'); el.style.display = 'block';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  setTimeout(() => {
    miniMap = L.map('miniMap', { zoomControl:false, dragging:false, scrollWheelZoom:false }).setView([lat,lng],15);
    const theme = localStorage.getItem('fc_theme') || 'dark';
    L.tileLayer(TILES[theme], { maxZoom:19 }).addTo(miniMap);
    L.marker([lat,lng], { icon: getMarkerIcon('instalado') }).addTo(miniMap);
  }, 100);
}

// Seleção e compressão da foto
function handlePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;

  capturedPhotoBlob = null;
  capturedPhotoB64  = null;
  setUploadProgress(true, 'Comprimindo imagem...', 20);

  // Tenta comprimir; se falhar usa o arquivo original
  compressImage(file, 800, 0.65)
    .catch(() => compressImage(file, 600, 0.55))   // segunda tentativa menor
    .catch(() => file)                              // último recurso: arquivo original
    .then(blob => {
      capturedPhotoBlob = blob;
      return blobToBase64(blob);
    })
    .then(b64 => {
      capturedPhotoB64 = b64;
      const kbSize = Math.round(b64.length * 0.75 / 1024);
      document.getElementById('photoPreview').innerHTML =
        `<img class="photo-preview-img" src="${b64}">`;
      setUploadProgress(true, `✅ Imagem pronta — ${kbSize}KB`, 100);
      setTimeout(() => setUploadProgress(false), 1500);
    })
    .catch(err => {
      console.error('Erro ao processar foto:', err);
      setUploadProgress(false);
      showToast('❌ Erro ao processar a imagem. Tente outra.', 'error');
    });
}

function setUploadProgress(visible, label = '', pct = 0) {
  const wrap = document.getElementById('photoUploadProgress');
  const fill = document.getElementById('uploadProgressFill');
  const lbl  = document.getElementById('uploadProgressLabel');
  if (!wrap) return;
  if (!visible) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent  = label;
}

// Salva equipamento — foto em coleção separada "fotos/"
async function submitCadastro() {
  const chave      = document.getElementById('fChave').value.trim();
  const ocorrencia = document.getElementById('fOcorrencia').value.trim();
  const nds        = document.getElementById('fTipo').value.trim();
  const endereco   = document.getElementById('fEndereco').value.trim();
  const obs        = document.getElementById('fObs').value.trim();

  if (!chave)            { showFormError('Nº Chave/Poste é obrigatório.'); return; }
  if (!ocorrencia)       { showFormError('Nº Ocorrência é obrigatório.'); return; }
  if (!capturedGPS)      { showFormError('Localização GPS é obrigatória. Clique em "Capturar GPS".'); return; }
  if (!capturedPhotoB64) { showFormError('Foto do equipamento é obrigatória.'); return; }

  document.getElementById('formError').classList.add('hidden');
  const saveBtn = document.getElementById('saveCadastroBtn');
  if (saveBtn) saveBtn.disabled = true;

  const equipId = 'eq_' + Date.now();
  const now     = new Date();

  try {
    // PASSO 1 — Salva foto em coleção "fotos/" (separado do doc principal)
    showSyncIndicator('Salvando foto...');
    setUploadProgress(true, 'Enviando foto para o Firebase...', 40);
    await fsSaveFoto(equipId, capturedPhotoB64);
    setUploadProgress(true, 'Foto salva ✓', 100);
    setTimeout(() => setUploadProgress(false), 800);

    // PASSO 2 — Salva documento principal (sem base64, apenas metadados)
    showSyncIndicator('Salvando equipamento...');
    const newEq = {
      id:               equipId,
      chave, ocorrencia,
      nds,  tipo: nds,    // mantém compatibilidade com registros antigos
      endereco, obs,
      lat:              capturedGPS.lat,
      lng:              capturedGPS.lng,
      hasPhoto:         true,       // flag indicando que tem foto em "fotos/"
      status:           'instalado',
      dataCadastro:     formatDate(now),
      usuarioCadastro:  currentUser.name || currentUser.username,
      createdAt:        now.toISOString(),
      equipeRetirada:   null,
      dataRetirada:     null,
      dataFinalizacao:  null,
      usuarioFinalizacao: null,
    };

    await fsAddEquipamento(newEq);
    hideSyncIndicator();

    showToast('✅ Equipamento cadastrado com sucesso!', 'success');
    resetForm();
    showView('map');
    setTimeout(() => {
      if (map && newEq.lat) {
        map.flyTo([newEq.lat, newEq.lng], 16, { duration: 1.5 });
        setTimeout(() => { const m = markers[newEq.id]; if (m) m.openPopup(); }, 1600);
      }
    }, 400);

  } catch (err) {
    console.error('submitCadastro error:', err);
    setUploadProgress(false);
    hideSyncIndicator();
    let msg = err.message || 'Verifique sua conexão.';
    // Mensagens amigáveis para erros comuns do Firestore
    if (msg.includes('quota'))         msg = 'Cota do Firebase atingida. Tente mais tarde.';
    if (msg.includes('permission'))    msg = 'Sem permissão. Verifique as regras do Firestore.';
    if (msg.includes('unavailable'))   msg = 'Firebase indisponível. Verifique sua internet.';
    if (msg.includes('deadline'))      msg = 'Tempo limite excedido. Verifique a internet e tente novamente.';
    showFormError('❌ Erro ao salvar: ' + msg);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg; el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============================================================
//  DETALHES DO EQUIPAMENTO — carrega foto lazy
// ============================================================
async function openEquipamento(id) {
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

  const sc = { instalado:'var(--green)', retirado:'var(--orange)', finalizado:'var(--blue)' };

  // Renderiza modal imediatamente com placeholder de foto
  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Detalhes do Equipamento</div>
    <div class="popup-chave">${eq.chave}</div>
    <div class="popup-grid">
      <div class="popup-field"><label>Status</label>
        <span style="color:${sc[eq.status]};font-weight:700;text-transform:uppercase">${eq.status}</span></div>
      <div class="popup-field"><label>Ocorrência</label><span>${eq.ocorrencia}</span></div>
      <div class="popup-field"><label>Nº NDS</label><span>${eq.nds||eq.tipo||'—'}</span></div>
      <div class="popup-field"><label>Endereço</label><span>${eq.endereco||'—'}</span></div>
      <div class="popup-field"><label>Cadastrado em</label><span>${eq.dataCadastro}</span></div>
      <div class="popup-field"><label>Cadastrado por</label><span>${eq.usuarioCadastro}</span></div>
      <div class="popup-field"><label>Latitude</label>
        <span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lat?.toFixed(6)}</span></div>
      <div class="popup-field"><label>Longitude</label>
        <span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lng?.toFixed(6)}</span></div>
      ${eq.equipeRetirada?`<div class="popup-field"><label>Equipe Retirada</label><span>${eq.equipeRetirada}</span></div>`:''}
      ${eq.dataRetirada?`<div class="popup-field"><label>Data Retirada</label><span>${eq.dataRetirada}</span></div>`:''}
      ${eq.dataFinalizacao?`<div class="popup-field"><label>Finalizado em</label><span>${eq.dataFinalizacao}</span></div>`:''}
    </div>
    ${eq.obs?`<div class="popup-field" style="margin-bottom:12px"><label>Observações</label><span>${eq.obs}</span></div>`:''}
    <div id="photoContainer" style="margin:12px 0">
      <div class="photo-loading">⏳ Carregando foto...</div>
    </div>
    <div class="popup-actions">${actionsHTML}</div>`;
  openModal();

  // Carrega foto de forma assíncrona
  if (eq.hasPhoto || eq.photo) {
    const photoData = eq.photo && eq.photo.startsWith('data:')
      ? eq.photo                           // já é base64 (registros antigos)
      : await fsGetFoto(eq.id);            // busca da coleção "fotos/"
    const photoContainer = document.getElementById('photoContainer');
    if (photoContainer) {
      photoContainer.innerHTML = photoData
        ? `<img class="popup-photo" src="${photoData}" alt="Foto do equipamento">`
        : `<p style="color:var(--text3);font-size:0.85rem;">Foto não encontrada.</p>`;
    }
  } else {
    const pc = document.getElementById('photoContainer');
    if (pc) pc.innerHTML = `<p style="color:var(--text3);font-size:0.85rem;">Sem foto cadastrada.</p>`;
  }
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
  const equipe = document.getElementById('removeEquipe').value.trim();
  const data   = document.getElementById('removeData').value;
  const errEl  = document.getElementById('removeError');
  if (!equipe) { errEl.textContent='Informe a equipe.'; errEl.classList.remove('hidden'); return; }
  if (!data)   { errEl.textContent='Informe a data.';  errEl.classList.remove('hidden'); return; }
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
  const updates = { status:'finalizado', dataFinalizacao:formatDate(new Date()),
                    usuarioFinalizacao:currentUser.name||currentUser.username };
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
      <div class="form-group"><label>Número NDS</label>
        <input type="text" id="editTipo" value="${eq.nds||eq.tipo||''}"></div>
      <div class="form-group"><label>Endereço</label>
        <input type="text" id="editEndereco" value="${eq.endereco||''}"></div>
      <div class="form-group"><label>Status</label>
        <select id="editStatus">
          <option value="instalado"  ${eq.status==='instalado'?'selected':''}>Instalado</option>
          <option value="retirado"   ${eq.status==='retirado'?'selected':''}>Retirado</option>
          <option value="finalizado" ${eq.status==='finalizado'?'selected':''}>Finalizado</option>
        </select></div>
      <div class="form-group"><label>Observações</label>
        <textarea id="editObs" rows="2">${eq.obs||''}</textarea></div>
      <button class="btn-primary btn-full" onclick="saveEdit('${id}')">💾 Salvar Alterações</button>
    </div>`;
}

async function saveEdit(id) {
  const nds = document.getElementById('editTipo').value.trim();
  const updates = {
    chave:      document.getElementById('editChave').value.trim(),
    ocorrencia: document.getElementById('editOcorrencia').value.trim(),
    nds, tipo:  nds,
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
  await fsDeleteEquipamento(id); // também exclui foto da coleção "fotos/"
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
    map.flyTo([eq.lat, eq.lng], 17, { duration:1.5 });
    setTimeout(() => { const m = markers[id]; if (m) m.openPopup(); }, 1600);
  }, 200);
}

// ============================================================
//  USUÁRIOS — CRUD COMPLETO (ADM)
// ============================================================
let userFormMode = 'create';

async function renderUsers() {
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const users  = await fsGetUsers();
  const filtered = users.filter(u =>
    !search ||
    (u.name||'').toLowerCase().includes(search) ||
    u.username.toLowerCase().includes(search) ||
    u.role.toLowerCase().includes(search)
  );
  const container  = document.getElementById('userList');
  const editingId  = document.getElementById('editingUserId')?.value || '';
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div>👤</div><p>Nenhum usuário encontrado</p></div>`;
    return;
  }
  container.innerHTML = filtered.map(u => {
    const isDefault   = u.id==='u_fiscal'||u.id==='u_adm';
    const isEditing   = u.id===editingId;
    const avatarClass = u.role==='adm' ? 'adm-av' : 'fiscal-av';
    const roleLabel   = u.role==='adm' ? '🔑 Administrador' : '👷 Fiscal';
    const roleColor   = u.role==='adm' ? 'var(--accent)' : 'var(--blue)';
    return `
    <div class="user-card ${isEditing?'editing':''}" id="ucard_${u.id}">
      <div class="user-card-avatar ${avatarClass}">${(u.name||u.username)[0].toUpperCase()}</div>
      <div class="user-card-info">
        <div class="user-card-name">${u.name||u.username}</div>
        <div class="user-card-login">@${u.username}</div>
        <div class="user-card-meta">
          <span class="role-tag" style="color:${roleColor}">${roleLabel}</span>
          ${isDefault?'<span class="user-default-tag">padrão</span>':''}
        </div>
      </div>
      <div class="user-card-actions">
        <button class="btn-sm btn-edit"   onclick="startEditUser('${u.id}')" title="Editar">✏️</button>
        ${!isDefault
          ? `<button class="btn-sm btn-delete" onclick="removeUser('${u.id}')" title="Excluir">🗑️</button>`
          : `<button class="btn-sm" style="opacity:0.3;cursor:not-allowed;border:1px solid var(--border);color:var(--text3);padding:6px 10px" disabled title="Usuário padrão">🔒</button>`}
      </div>
    </div>`;
  }).join('');
}

async function startEditUser(id) {
  const users = await fsGetUsers();
  const u = users.find(x => x.id===id);
  if (!u) return;
  userFormMode = 'edit';
  document.getElementById('editingUserId').value = id;
  document.getElementById('nuName').value  = u.name||u.username;
  document.getElementById('nuUser').value  = u.username;
  document.getElementById('nuPass').value  = '';
  document.querySelectorAll('input[name="nuRole"]').forEach(r => r.checked = r.value===u.role);
  document.getElementById('userFormTitle').textContent    = '✏️ Editar Usuário';
  document.getElementById('userFormSubtitle').textContent = `Editando: ${u.name||u.username}`;
  document.getElementById('userFormBtn').textContent      = '💾 Salvar Alterações';
  document.getElementById('userCancelBtn').style.display  = 'inline-flex';
  document.getElementById('editPassHint').classList.remove('hidden');
  document.getElementById('userFormError').classList.add('hidden');
  renderUsers();
  document.querySelector('.users-form-panel').scrollIntoView({ behavior:'smooth' });
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
  userFormMode==='edit' ? await saveUserEdit() : await addUser();
}

async function addUser() {
  const name     = document.getElementById('nuName').value.trim();
  const username = document.getElementById('nuUser').value.trim();
  const password = document.getElementById('nuPass').value;
  const role     = document.querySelector('input[name="nuRole"]:checked')?.value||'fiscal';
  const errEl    = document.getElementById('userFormError');
  if (!name)     { errEl.textContent='Informe o nome completo.'; errEl.classList.remove('hidden'); return; }
  if (!username) { errEl.textContent='Informe o login.'; errEl.classList.remove('hidden'); return; }
  if (!password) { errEl.textContent='Informe a senha.'; errEl.classList.remove('hidden'); return; }
  if (password.length<4) { errEl.textContent='Senha mínimo 4 caracteres.'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  const users = await fsGetUsers();
  if (users.find(u=>u.username===username)) { errEl.textContent='Login já em uso.'; errEl.classList.remove('hidden'); return; }
  await fsAddUser({ id:'u_'+Date.now(), name, username, password, role });
  cancelUserEdit();
  showToast(`✅ Usuário "${name}" cadastrado!`, 'success');
}

async function saveUserEdit() {
  const id       = document.getElementById('editingUserId').value;
  const name     = document.getElementById('nuName').value.trim();
  const username = document.getElementById('nuUser').value.trim();
  const password = document.getElementById('nuPass').value;
  const role     = document.querySelector('input[name="nuRole"]:checked')?.value||'fiscal';
  const errEl    = document.getElementById('userFormError');
  if (!name)     { errEl.textContent='Informe o nome.'; errEl.classList.remove('hidden'); return; }
  if (!username) { errEl.textContent='Informe o login.'; errEl.classList.remove('hidden'); return; }
  if (password && password.length<4) { errEl.textContent='Senha mínimo 4 caracteres.'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  const users = await fsGetUsers();
  if (users.find(u=>u.username===username&&u.id!==id)) { errEl.textContent='Login já em uso por outro usuário.'; errEl.classList.remove('hidden'); return; }
  const updates = { name, username, role };
  if (password) updates.password = password;
  showSyncIndicator('Salvando usuário...');
  await fbDb.collection('users').doc(id).update(updates);
  hideSyncIndicator();
  if (currentUser.id===id) { currentUser={...currentUser,...updates}; localStorage.setItem('fc_session',JSON.stringify(currentUser)); updateUserUI(); }
  cancelUserEdit();
  showToast(`✏️ Usuário "${name}" atualizado!`, 'success');
}

async function removeUser(id) {
  const users = await fsGetUsers();
  const u = users.find(x=>x.id===id);
  if (!u) return;
  if (currentUser.id===id) { showToast('❌ Você não pode excluir seu próprio usuário.','error'); return; }
  if (!confirm(`Excluir o usuário "${u.name||u.username}"?\n\nEsta ação não pode ser desfeita.`)) return;
  showSyncIndicator('Excluindo usuário...');
  await fsDeleteUser(id);
  hideSyncIndicator();
  if (document.getElementById('editingUserId').value===id) cancelUserEdit();
  renderUsers();
  showToast(`🗑️ Usuário "${u.name||u.username}" excluído.`,'info');
}

function togglePassVis(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type==='password') { input.type='text'; btn.textContent='🙈'; }
  else { input.type='password'; btn.textContent='👁'; }
}

// ============================================================
//  CONTADORES
// ============================================================
function updateCounts() {
  const c = { instalado:0, retirado:0, finalizado:0 };
  equipamentos.forEach(e => { if (c[e.status]!==undefined) c[e.status]++; });
  document.getElementById('countInstalled').textContent = `${c.instalado} Instalado${c.instalado!==1?'s':''}`;
  document.getElementById('countRemoved').textContent   = `${c.retirado} Retirado${c.retirado!==1?'s':''}`;
  document.getElementById('countDone').textContent      = `${c.finalizado} Finalizado${c.finalizado!==1?'s':''}`;
}

// ============================================================
//  MODAL
// ============================================================
function openModal()       { document.getElementById('modal').classList.remove('hidden'); }
function closeModal(e)     { if (e.target===document.getElementById('modal')) closeModalDirect(); }
function closeModalDirect(){ document.getElementById('modal').classList.add('hidden'); }

// ============================================================
//  SYNC INDICATOR
// ============================================================
let syncTimer;
function showSyncIndicator(msg='Sincronizando...') {
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
function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ============================================================
//  EXPORTAR EXCEL
// ============================================================
function exportExcel() {
  if (typeof XLSX==='undefined') { showToast('❌ Biblioteca Excel não carregada.','error'); return; }
  const search = (document.getElementById('listSearch')?.value||'').toLowerCase();
  const filter = document.getElementById('listFilter')?.value||'';
  let items = equipamentos.filter(eq => {
    const ms = !search||eq.chave?.toLowerCase().includes(search)||eq.ocorrencia?.toLowerCase().includes(search)
      ||eq.usuarioCadastro?.toLowerCase().includes(search)||(eq.nds||eq.tipo||'').toLowerCase().includes(search)
      ||eq.endereco?.toLowerCase().includes(search);
    return ms&&(!filter||eq.status===filter);
  });
  items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if (!items.length) { showToast('Nenhum registro para exportar.','info'); return; }
  const sl = { instalado:'Instalado', retirado:'Retirado', finalizado:'Finalizado' };
  const rows = items.map((eq,i) => ({
    '#': i+1,
    'Nº Chave / Poste':   eq.chave||'',
    'Nº Ocorrência':      eq.ocorrencia||'',
    'Número NDS':         eq.nds||eq.tipo||'',
    'Endereço / Referência': eq.endereco||'',
    'Status':             sl[eq.status]||eq.status,
    'Data Cadastro':      eq.dataCadastro||'',
    'Cadastrado por':     eq.usuarioCadastro||'',
    'Latitude':           eq.lat!=null?eq.lat.toFixed(6):'',
    'Longitude':          eq.lng!=null?eq.lng.toFixed(6):'',
    'Equipe Retirada':    eq.equipeRetirada||'',
    'Data Retirada':      eq.dataRetirada||'',
    'Data Finalização':   eq.dataFinalizacao||'',
    'Usuário Finalização':eq.usuarioFinalizacao||'',
    'Observações':        eq.obs||'',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:4},{wch:18},{wch:18},{wch:16},{wch:30},{wch:12},{wch:20},{wch:18},{wch:14},{wch:14},{wch:22},{wch:16},{wch:20},{wch:20},{wch:30}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipamentos');
  const c = {Instalado:0,Retirado:0,Finalizado:0};
  equipamentos.forEach(e=>{const k=sl[e.status];if(k)c[k]++;});
  const ws2 = XLSX.utils.json_to_sheet([
    {'Resumo':'Total','Quantidade':equipamentos.length},
    {'Resumo':'Instalados','Quantidade':c.Instalado},
    {'Resumo':'Retirados','Quantidade':c.Retirado},
    {'Resumo':'Finalizados','Quantidade':c.Finalizado},
    {'Resumo':'Banco','Quantidade':'Firebase — controle-bypass'},
    {'Resumo':'Exportado em','Quantidade':formatDate(new Date())},
  ]);
  ws2['!cols']=[{wch:28},{wch:28}];
  XLSX.utils.book_append_sheet(wb,ws2,'Resumo');
  const now=new Date();
  const fname=`FieldControl_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.xlsx`;
  XLSX.writeFile(wb,fname);
  showToast(`📊 Planilha exportada: ${fname}`,'success');
}

// ============================================================
//  UTILS
// ============================================================
function formatDate(d) {
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function formatDateFromInput(str) {
  const [y,m,d]=str.split('-'); return `${d}/${m}/${y}`;
}
