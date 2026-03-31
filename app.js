// ============================================================
//  FIELDCONTROL — Sistema de Gestão de Equipamentos em Campo
//  Armazenamento: localStorage (gratuito, sem backend)
//  Para escala maior: substituir por Firebase Firestore
// ============================================================

// ---- DATA LAYER (localStorage) ----
const DB = {
  get: (key) => JSON.parse(localStorage.getItem(key) || 'null'),
  set: (key, val) => localStorage.setItem(key, JSON.stringify(val)),

  getEquipamentos: () => DB.get('fc_equipamentos') || [],
  setEquipamentos: (arr) => DB.set('fc_equipamentos', arr),

  getUsers: () => DB.get('fc_users') || [
    { id: '1', username: 'fiscal', password: 'fiscal123', role: 'fiscal', name: 'Fiscal' },
    { id: '2', username: 'adm', password: 'adm123', role: 'adm', name: 'Administrador' }
  ],
  setUsers: (arr) => DB.set('fc_users', arr),

  getSession: () => DB.get('fc_session'),
  setSession: (u) => DB.set('fc_session', u),
  clearSession: () => localStorage.removeItem('fc_session'),
};

// ---- STATE ----
let currentUser = null;
let equipamentos = [];
let map = null;
let miniMap = null;
let markers = {};
let capturedGPS = null;
let capturedPhotoB64 = null;
let currentTileLayer = null;

// Map tile URLs per theme
const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme before anything renders
  const savedTheme = localStorage.getItem('fc_theme') || 'dark';
  if (savedTheme === 'light') applyTheme('light', false);

  const session = DB.getSession();
  if (session) {
    currentUser = session;
    initApp();
  }
});

// ---- LOGIN ----
function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const users = DB.getUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    showLoginError('Usuário ou senha inválidos.');
    return;
  }
  currentUser = user;
  DB.setSession(user);
  initApp();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('loginScreen').classList.contains('active')) {
    doLogin();
  }
});

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function doLogout() {
  DB.clearSession();
  currentUser = null;
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').classList.add('hidden');
}

// ---- INIT APP ----
function initApp() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');

  equipamentos = DB.getEquipamentos();
  updateUserUI();
  applyRoleVisibility();
  initMap();
  renderList();
  updateCounts();
}

function updateUserUI() {
  document.getElementById('userNameDisplay').textContent = currentUser.name || currentUser.username;
  document.getElementById('userRoleDisplay').textContent = currentUser.role.toUpperCase();
  document.getElementById('userAvatar').textContent = (currentUser.name || currentUser.username)[0].toUpperCase();
}

function applyRoleVisibility() {
  const isAdm = currentUser.role === 'adm';
  document.querySelectorAll('.adm-only').forEach(el => {
    el.classList.toggle('hidden', !isAdm);
  });
}

// ---- SIDEBAR ----
let sidebarOpen = window.innerWidth > 768;
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (window.innerWidth <= 768) {
    sb.classList.toggle('open');
  } else {
    sb.classList.toggle('collapsed');
  }
  setTimeout(() => { if (map) map.invalidateSize(); }, 350);
}

window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    document.getElementById('sidebar').classList.remove('open');
  }
});

// ---- THEME ----
function toggleTheme() {
  const isLight = document.body.classList.contains('light-mode');
  applyTheme(isLight ? 'dark' : 'light', true);
}

function applyTheme(theme, save = true) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-mode', isLight);
  const btn = document.getElementById('themeBtn');
  const label = document.getElementById('themeLabel');
  if (btn) btn.querySelector('.theme-toggle-icon').textContent = isLight ? '☀️' : '🌙';
  if (label) label.textContent = isLight ? 'Modo Escuro' : 'Modo Claro';
  if (save) localStorage.setItem('fc_theme', theme);
  updateMapTiles(theme);
}

function updateMapTiles(theme) {
  if (!map) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(TILES[theme] || TILES.dark, {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  }).addTo(map);
}

// ---- NAVIGATION ----
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById('view' + name.charAt(0).toUpperCase() + name.slice(1));
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = { map: 'Mapa de Equipamentos', list: 'Lista de Equipamentos', cadastro: 'Cadastrar Equipamento', usuarios: 'Gerenciar Usuários' };
  document.getElementById('pageTitle').textContent = titles[name] || name;

  if (name === 'map') setTimeout(() => { if (map) map.invalidateSize(); }, 100);
  if (name === 'list') renderList();
  if (name === 'usuarios') renderUsers();
  if (name === 'cadastro') resetForm();

  // close sidebar on mobile
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

// ---- MAP ----
function initMap() {
  if (map) return;

  map = L.map('map', {
    center: [-15.8, -47.9],
    zoom: 5,
    zoomControl: true,
  });

  const theme = localStorage.getItem('fc_theme') || 'dark';
  currentTileLayer = L.tileLayer(TILES[theme], {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  renderMapMarkers();
}

function getMarkerIcon(status) {
  const colors = {
    instalado: '#2ecc71',
    retirado: '#f39c12',
    finalizado: '#3498db',
  };
  const color = colors[status] || '#ff4d4d';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z" fill="${color}" stroke="#000" stroke-width="1"/>
    <circle cx="12" cy="12" r="5" fill="#000" opacity="0.5"/>
  </svg>`;
  return L.icon({
    iconUrl: 'data:image/svg+xml;base64,' + btoa(svg),
    iconSize: [24, 36],
    iconAnchor: [12, 36],
    popupAnchor: [0, -36],
  });
}

function renderMapMarkers() {
  if (!map) return;

  // Remove existing markers
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const activeFilters = getActiveFilters();
  const searchVal = (document.getElementById('mapSearchInput')?.value || '').toLowerCase();

  equipamentos.forEach(eq => {
    if (!eq.lat || !eq.lng) return;
    // Finalizados NÃO aparecem no mapa
    if (eq.status === 'finalizado') return;
    if (!activeFilters.includes(eq.status)) return;
    if (searchVal && !eq.chave?.toLowerCase().includes(searchVal) && !eq.ocorrencia?.toLowerCase().includes(searchVal)) return;

    const marker = L.marker([eq.lat, eq.lng], { icon: getMarkerIcon(eq.status) })
      .addTo(map)
      .bindPopup(buildMapPopup(eq));

    markers[eq.id] = marker;
  });
}

function buildMapPopup(eq) {
  const statusLabel = { instalado: '🟢 Instalado', retirado: '🟡 Retirado', finalizado: '🔵 Finalizado' };
  return `
    <div class="map-popup">
      <div class="map-popup-title">${eq.chave}</div>
      <div class="map-popup-row"><strong>Ocorrência:</strong><span>${eq.ocorrencia}</span></div>
      <div class="map-popup-row"><strong>Status:</strong><span>${statusLabel[eq.status] || eq.status}</span></div>
      <div class="map-popup-row"><strong>Tipo:</strong><span>${eq.tipo || '—'}</span></div>
      <div class="map-popup-row"><strong>Local:</strong><span>${eq.endereco || '—'}</span></div>
      <div class="map-popup-row"><strong>Cadastro:</strong><span>${eq.dataCadastro}</span></div>
      <div class="map-popup-row"><strong>Usuário:</strong><span>${eq.usuarioCadastro}</span></div>
      ${eq.equipeRetirada ? `<div class="map-popup-row"><strong>Equipe:</strong><span>${eq.equipeRetirada}</span></div>` : ''}
      <button class="map-popup-btn" onclick="openEquipamento('${eq.id}')">Ver detalhes completos</button>
    </div>
  `;
}

function getActiveFilters() {
  return Array.from(document.querySelectorAll('[data-status]'))
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.status);
}

function updateMapFilter() { renderMapMarkers(); }
function filterMapSearch() { renderMapMarkers(); }

// ---- LIST ----
function renderList() {
  const search = (document.getElementById('listSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('listFilter')?.value || '';

  let items = equipamentos.filter(eq => {
    const matchSearch = !search ||
      eq.chave?.toLowerCase().includes(search) ||
      eq.ocorrencia?.toLowerCase().includes(search) ||
      eq.usuarioCadastro?.toLowerCase().includes(search) ||
      eq.tipo?.toLowerCase().includes(search) ||
      eq.endereco?.toLowerCase().includes(search);
    const matchFilter = !filter || eq.status === filter;
    return matchSearch && matchFilter;
  });

  // Sort by date descending
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
        <span><strong>Tipo:</strong>${eq.tipo || '—'}</span>
        <span><strong>Local:</strong>${eq.endereco || '—'}</span>
        <span><strong>Cadastro:</strong>${eq.dataCadastro} por ${eq.usuarioCadastro}</span>
        ${eq.equipeRetirada ? `<span><strong>Equipe Ret.:</strong>${eq.equipeRetirada} (${eq.dataRetirada})</span>` : ''}
      </div>
    </div>
  `).join('');
}

// ---- CADASTRO ----
function resetForm() {
  ['fChave','fOcorrencia','fTipo','fEndereco','fObs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  capturedGPS = null;
  capturedPhotoB64 = null;
  document.getElementById('gpsStatus').textContent = 'Clique em "Capturar GPS" para obter sua localização';
  document.getElementById('gpsCoords').textContent = '';
  document.getElementById('gpsCoords').classList.add('hidden');
  document.getElementById('photoPreview').innerHTML = `<span class="photo-icon">📷</span><span>Clique para tirar foto ou selecionar</span>`;
  document.getElementById('photoInput').value = '';
  const miniMapEl = document.getElementById('miniMap');
  if (miniMapEl) miniMapEl.style.display = 'none';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  document.getElementById('formError').classList.add('hidden');
}

function getGPS() {
  const statusEl = document.getElementById('gpsStatus');
  statusEl.textContent = '⏳ Obtendo localização...';
  if (!navigator.geolocation) {
    statusEl.textContent = '❌ Geolocalização não suportada neste dispositivo.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      capturedGPS = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      statusEl.textContent = `✅ GPS capturado com precisão de ~${capturedGPS.acc}m`;
      const coordsEl = document.getElementById('gpsCoords');
      coordsEl.textContent = `Lat: ${capturedGPS.lat.toFixed(6)}  Lng: ${capturedGPS.lng.toFixed(6)}`;
      coordsEl.classList.remove('hidden');
      initMiniMap(capturedGPS.lat, capturedGPS.lng);
    },
    (err) => {
      statusEl.textContent = `❌ Erro ao obter GPS: ${err.message}. Tente manualmente ou permita o acesso à localização.`;
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function initMiniMap(lat, lng) {
  const el = document.getElementById('miniMap');
  el.style.display = 'block';
  if (miniMap) { miniMap.remove(); miniMap = null; }
  setTimeout(() => {
    miniMap = L.map('miniMap', { zoomControl: false, dragging: false, scrollWheelZoom: false }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(miniMap);
    L.marker([lat, lng], { icon: getMarkerIcon('instalado') }).addTo(miniMap);
  }, 100);
}

function handlePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    capturedPhotoB64 = e.target.result;
    document.getElementById('photoPreview').innerHTML = `<img class="photo-preview-img" src="${capturedPhotoB64}">`;
  };
  reader.readAsDataURL(file);
}

function submitCadastro() {
  const chave = document.getElementById('fChave').value.trim();
  const ocorrencia = document.getElementById('fOcorrencia').value.trim();
  const tipo = document.getElementById('fTipo').value.trim();
  const endereco = document.getElementById('fEndereco').value.trim();
  const obs = document.getElementById('fObs').value.trim();
  const errEl = document.getElementById('formError');

  if (!chave) { showFormError('Nº Chave/Poste é obrigatório.'); return; }
  if (!ocorrencia) { showFormError('Nº Ocorrência é obrigatório.'); return; }
  if (!capturedGPS) { showFormError('Localização GPS é obrigatória. Clique em "Capturar GPS".'); return; }
  if (!capturedPhotoB64) { showFormError('Foto do equipamento é obrigatória.'); return; }

  errEl.classList.add('hidden');

  const now = new Date();
  const newEq = {
    id: 'eq_' + Date.now(),
    chave,
    ocorrencia,
    tipo,
    endereco,
    obs,
    lat: capturedGPS.lat,
    lng: capturedGPS.lng,
    photo: capturedPhotoB64,
    status: 'instalado',
    dataCadastro: formatDate(now),
    usuarioCadastro: currentUser.name || currentUser.username,
    createdAt: now.toISOString(),
    equipeRetirada: null,
    dataRetirada: null,
    dataFinalizacao: null,
    usuarioFinalizacao: null,
  };

  equipamentos.push(newEq);
  DB.setEquipamentos(equipamentos);
  updateCounts();
  renderMapMarkers();

  showToast('✅ Equipamento cadastrado com sucesso!', 'success');
  resetForm();
  showView('map');

  // Fly to new marker
  setTimeout(() => {
    if (map && newEq.lat) {
      map.flyTo([newEq.lat, newEq.lng], 16, { duration: 1.5 });
      const m = markers[newEq.id];
      if (m) m.openPopup();
    }
  }, 400);
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth' });
}

// ---- OPEN EQUIPAMENTO DETAIL ----
function openEquipamento(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq) return;

  const isAdm = currentUser.role === 'adm';
  const isFiscal = currentUser.role === 'fiscal';
  const isInstalado = eq.status === 'instalado';
  const isRetirado = eq.status === 'retirado';

  let actionsHTML = `<button class="btn-sm btn-view" onclick="flyToMarker('${eq.id}'); closeModalDirect()">🗺️ Ver no Mapa</button>`;

  if (isFiscal && isInstalado) {
    actionsHTML += `<button class="btn-sm btn-done" onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;
  }
  if (isAdm && isInstalado) {
    actionsHTML += `<button class="btn-sm btn-remove" onclick="showRetiradaForm('${eq.id}')">🔧 Registrar Retirada</button>`;
    actionsHTML += `<button class="btn-sm btn-done" onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;
    actionsHTML += `<button class="btn-sm btn-edit" onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }
  if (isAdm && isRetirado) {
    actionsHTML += `<button class="btn-sm btn-done" onclick="finalizarEquipamento('${eq.id}')">✅ Finalizar</button>`;
    actionsHTML += `<button class="btn-sm btn-edit" onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }
  if (isAdm && eq.status === 'finalizado') {
    actionsHTML += `<button class="btn-sm btn-edit" onclick="editEquipamento('${eq.id}')">✏️ Editar</button>`;
    actionsHTML += `<button class="btn-sm btn-delete" onclick="deleteEquipamento('${eq.id}')">🗑️ Excluir</button>`;
  }

  const photoHTML = eq.photo ? `<img class="popup-photo" src="${eq.photo}" alt="Foto do equipamento">` : '<p style="color:var(--text3);font-size:0.85rem;">Sem foto disponível</p>';

  const statusColors = { instalado: 'var(--green)', retirado: 'var(--orange)', finalizado: 'var(--blue)' };

  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Detalhes do Equipamento</div>
    <div class="popup-chave">${eq.chave}</div>
    <div class="popup-grid">
      <div class="popup-field"><label>Status</label><span style="color:${statusColors[eq.status]};font-weight:700;text-transform:uppercase">${eq.status}</span></div>
      <div class="popup-field"><label>Ocorrência</label><span>${eq.ocorrencia}</span></div>
      <div class="popup-field"><label>Tipo</label><span>${eq.tipo || '—'}</span></div>
      <div class="popup-field"><label>Endereço</label><span>${eq.endereco || '—'}</span></div>
      <div class="popup-field"><label>Cadastrado em</label><span>${eq.dataCadastro}</span></div>
      <div class="popup-field"><label>Cadastrado por</label><span>${eq.usuarioCadastro}</span></div>
      <div class="popup-field"><label>Latitude</label><span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lat?.toFixed(6)}</span></div>
      <div class="popup-field"><label>Longitude</label><span style="font-family:var(--font-mono);font-size:0.8rem">${eq.lng?.toFixed(6)}</span></div>
      ${eq.equipeRetirada ? `<div class="popup-field"><label>Equipe Retirada</label><span>${eq.equipeRetirada}</span></div>` : ''}
      ${eq.dataRetirada ? `<div class="popup-field"><label>Data Retirada</label><span>${eq.dataRetirada}</span></div>` : ''}
      ${eq.dataFinalizacao ? `<div class="popup-field"><label>Finalizado em</label><span>${eq.dataFinalizacao}</span></div>` : ''}
    </div>
    ${eq.obs ? `<div class="popup-field" style="margin-bottom:12px"><label>Observações</label><span>${eq.obs}</span></div>` : ''}
    ${photoHTML}
    <div class="popup-actions">${actionsHTML}</div>
  `;

  openModal();
}

// ---- RETIRADA ----
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
    </div>
  `;
}

function confirmRetirada(id) {
  const equipe = document.getElementById('removeEquipe').value.trim();
  const data = document.getElementById('removeData').value;
  if (!equipe) { document.getElementById('removeError').textContent = 'Informe a equipe.'; document.getElementById('removeError').classList.remove('hidden'); return; }
  if (!data) { document.getElementById('removeError').textContent = 'Informe a data.'; document.getElementById('removeError').classList.remove('hidden'); return; }

  const eq = equipamentos.find(e => e.id === id);
  eq.status = 'retirado';
  eq.equipeRetirada = equipe;
  eq.dataRetirada = formatDateFromInput(data);
  DB.setEquipamentos(equipamentos);
  renderMapMarkers();
  renderList();
  updateCounts();
  closeModalDirect();
  showToast('🔧 Retirada registrada com sucesso!', 'success');
}

// ---- FINALIZAR ----
function finalizarEquipamento(id) {
  if (!confirm('Confirmar finalização deste equipamento?')) return;
  const eq = equipamentos.find(e => e.id === id);
  eq.status = 'finalizado';
  eq.dataFinalizacao = formatDate(new Date());
  eq.usuarioFinalizacao = currentUser.name || currentUser.username;
  DB.setEquipamentos(equipamentos);
  renderMapMarkers();
  renderList();
  updateCounts();
  closeModalDirect();
  showToast('✅ Equipamento finalizado!', 'success');
}

// ---- EDIT ----
function editEquipamento(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq) return;

  document.getElementById('modalContent').innerHTML = `
    <div class="popup-title">Editar Equipamento</div>
    <div class="popup-chave">${eq.chave}</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
      <div class="form-group"><label>Nº Chave / Poste</label><input type="text" id="editChave" value="${eq.chave}"></div>
      <div class="form-group"><label>Nº Ocorrência</label><input type="text" id="editOcorrencia" value="${eq.ocorrencia}"></div>
      <div class="form-group"><label>Tipo</label><input type="text" id="editTipo" value="${eq.tipo || ''}"></div>
      <div class="form-group"><label>Endereço</label><input type="text" id="editEndereco" value="${eq.endereco || ''}"></div>
      <div class="form-group"><label>Status</label>
        <select id="editStatus">
          <option value="instalado" ${eq.status==='instalado'?'selected':''}>Instalado</option>
          <option value="retirado" ${eq.status==='retirado'?'selected':''}>Retirado</option>
          <option value="finalizado" ${eq.status==='finalizado'?'selected':''}>Finalizado</option>
        </select>
      </div>
      <div class="form-group"><label>Observações</label><textarea id="editObs" rows="2">${eq.obs || ''}</textarea></div>
      <button class="btn-primary btn-full" onclick="saveEdit('${id}')">💾 Salvar Alterações</button>
    </div>
  `;
}

function saveEdit(id) {
  const eq = equipamentos.find(e => e.id === id);
  eq.chave = document.getElementById('editChave').value.trim() || eq.chave;
  eq.ocorrencia = document.getElementById('editOcorrencia').value.trim() || eq.ocorrencia;
  eq.tipo = document.getElementById('editTipo').value.trim();
  eq.endereco = document.getElementById('editEndereco').value.trim();
  eq.status = document.getElementById('editStatus').value;
  eq.obs = document.getElementById('editObs').value.trim();
  DB.setEquipamentos(equipamentos);
  renderMapMarkers();
  renderList();
  updateCounts();
  closeModalDirect();
  showToast('✏️ Equipamento atualizado!', 'success');
}

// ---- DELETE ----
function deleteEquipamento(id) {
  if (!confirm('Tem certeza que deseja EXCLUIR este equipamento? Esta ação não pode ser desfeita.')) return;
  equipamentos = equipamentos.filter(e => e.id !== id);
  DB.setEquipamentos(equipamentos);
  renderMapMarkers();
  renderList();
  updateCounts();
  closeModalDirect();
  showToast('🗑️ Equipamento excluído.', 'info');
}

// ---- FLY TO ----
function flyToMarker(id) {
  const eq = equipamentos.find(e => e.id === id);
  if (!eq || !map) return;
  showView('map');
  setTimeout(() => {
    map.flyTo([eq.lat, eq.lng], 17, { duration: 1.5 });
    setTimeout(() => { const m = markers[id]; if (m) m.openPopup(); }, 1600);
  }, 200);
}

// ---- USERS (ADM) ----
function renderUsers() {
  const users = DB.getUsers();
  const container = document.getElementById('userList');
  container.innerHTML = users.map(u => `
    <div class="user-row">
      <div class="user-avatar" style="width:32px;height:32px;font-size:0.85rem">${u.name ? u.name[0].toUpperCase() : u.username[0].toUpperCase()}</div>
      <div class="user-row-name">${u.name || u.username} <small style="color:var(--text3)">(${u.username})</small></div>
      <div class="user-row-role"><span class="role-tag">${u.role}</span></div>
      ${u.id !== '1' && u.id !== '2' ? `<button class="btn-sm btn-delete" onclick="removeUser('${u.id}')">Remover</button>` : '<span style="font-size:0.75rem;color:var(--text3)">padrão</span>'}
    </div>
  `).join('');
}

function addUser() {
  const username = document.getElementById('nuUser').value.trim();
  const password = document.getElementById('nuPass').value;
  const role = document.getElementById('nuRole').value;
  if (!username || !password) { showToast('Preencha usuário e senha.', 'error'); return; }
  const users = DB.getUsers();
  if (users.find(u => u.username === username)) { showToast('Este usuário já existe.', 'error'); return; }
  users.push({ id: 'u_' + Date.now(), username, password, role, name: username });
  DB.setUsers(users);
  document.getElementById('nuUser').value = '';
  document.getElementById('nuPass').value = '';
  renderUsers();
  showToast('✅ Usuário adicionado!', 'success');
}

function removeUser(id) {
  if (!confirm('Remover este usuário?')) return;
  const users = DB.getUsers().filter(u => u.id !== id);
  DB.setUsers(users);
  renderUsers();
  showToast('Usuário removido.', 'info');
}

// ---- COUNTS ----
function updateCounts() {
  const counts = { instalado: 0, retirado: 0, finalizado: 0 };
  equipamentos.forEach(e => { if (counts[e.status] !== undefined) counts[e.status]++; });
  document.getElementById('countInstalled').textContent = `${counts.instalado} Instalado${counts.instalado !== 1 ? 's' : ''}`;
  document.getElementById('countRemoved').textContent = `${counts.retirado} Retirado${counts.retirado !== 1 ? 's' : ''}`;
  document.getElementById('countDone').textContent = `${counts.finalizado} Finalizado${counts.finalizado !== 1 ? 's' : ''}`;
}

// ---- MODAL ----
function openModal() { document.getElementById('modal').classList.remove('hidden'); }
function closeModal(e) { if (e.target === document.getElementById('modal')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modal').classList.add('hidden'); }

// ---- TOAST ----
let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---- EXCEL EXPORT ----
function exportExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('❌ Biblioteca Excel não carregada. Verifique sua conexão.', 'error');
    return;
  }

  const search = (document.getElementById('listSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('listFilter')?.value || '';

  let items = equipamentos.filter(eq => {
    const matchSearch = !search ||
      eq.chave?.toLowerCase().includes(search) ||
      eq.ocorrencia?.toLowerCase().includes(search) ||
      eq.usuarioCadastro?.toLowerCase().includes(search) ||
      eq.tipo?.toLowerCase().includes(search) ||
      eq.endereco?.toLowerCase().includes(search);
    const matchFilter = !filter || eq.status === filter;
    return matchSearch && matchFilter;
  });

  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!items.length) {
    showToast('Nenhum registro para exportar.', 'info');
    return;
  }

  const statusLabel = { instalado: 'Instalado', retirado: 'Retirado', finalizado: 'Finalizado' };

  const rows = items.map((eq, i) => ({
    '#': i + 1,
    'Nº Chave / Poste': eq.chave || '',
    'Nº Ocorrência': eq.ocorrencia || '',
    'Tipo de Equipamento': eq.tipo || '',
    'Endereço / Referência': eq.endereco || '',
    'Status': statusLabel[eq.status] || eq.status,
    'Data Cadastro': eq.dataCadastro || '',
    'Cadastrado por': eq.usuarioCadastro || '',
    'Latitude': eq.lat != null ? eq.lat.toFixed(6) : '',
    'Longitude': eq.lng != null ? eq.lng.toFixed(6) : '',
    'Equipe Retirada': eq.equipeRetirada || '',
    'Data Retirada': eq.dataRetirada || '',
    'Data Finalização': eq.dataFinalizacao || '',
    'Usuário Finalização': eq.usuarioFinalizacao || '',
    'Observações': eq.obs || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    {wch:4},{wch:18},{wch:18},{wch:22},{wch:30},{wch:12},
    {wch:20},{wch:18},{wch:14},{wch:14},{wch:22},{wch:16},{wch:20},{wch:20},{wch:30}
  ];

  // Header style (SheetJS community doesn't support styles natively, but set freeze)
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipamentos');

  // Summary sheet
  const counts = { Instalado: 0, Retirado: 0, Finalizado: 0 };
  equipamentos.forEach(e => {
    const k = statusLabel[e.status];
    if (k) counts[k]++;
  });
  const summary = [
    { 'Resumo': 'Total de Equipamentos', 'Quantidade': equipamentos.length },
    { 'Resumo': 'Instalados', 'Quantidade': counts.Instalado },
    { 'Resumo': 'Retirados', 'Quantidade': counts.Retirado },
    { 'Resumo': 'Finalizados', 'Quantidade': counts.Finalizado },
    { 'Resumo': 'Exportado em', 'Quantidade': formatDate(new Date()) },
  ];
  const ws2 = XLSX.utils.json_to_sheet(summary);
  ws2['!cols'] = [{wch:28},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumo');

  const now = new Date();
  const fname = `FieldControl_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.xlsx`;

  XLSX.writeFile(wb, fname);
  showToast(`📊 Planilha exportada: ${fname}`, 'success');
}

// ---- UTILS ----
function formatDate(d) {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatDateFromInput(str) {
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

// ---- SEED DEMO DATA ----
(function seedDemo() {
  if (DB.getEquipamentos().length > 0) return;
  const demo = [
    { id: 'eq_demo1', chave: 'CH-00100', ocorrencia: 'OC-2024-001', tipo: 'Transformador', endereco: 'Av. Paulista, 1000 - SP', lat: -23.5654, lng: -46.6520, photo: '', status: 'instalado', dataCadastro: '10/01/2025 08:30', usuarioCadastro: 'Fiscal', createdAt: '2025-01-10T08:30:00Z', equipeRetirada: null, dataRetirada: null, dataFinalizacao: null },
    { id: 'eq_demo2', chave: 'CH-00200', ocorrencia: 'OC-2024-002', tipo: 'Chave Seccionadora', endereco: 'Rua da Consolação, 250 - SP', lat: -23.5530, lng: -46.6560, photo: '', status: 'retirado', dataCadastro: '12/01/2025 09:15', usuarioCadastro: 'Fiscal', createdAt: '2025-01-12T09:15:00Z', equipeRetirada: 'Equipe A', dataRetirada: '20/01/2025', dataFinalizacao: null },
    { id: 'eq_demo3', chave: 'CH-00300', ocorrencia: 'OC-2024-003', tipo: 'Poste Duplo', endereco: 'Praça da Sé, SP', lat: -23.5505, lng: -46.6333, photo: '', status: 'finalizado', dataCadastro: '15/01/2025 14:00', usuarioCadastro: 'Adm', createdAt: '2025-01-15T14:00:00Z', equipeRetirada: 'Equipe B', dataRetirada: '25/01/2025', dataFinalizacao: '28/01/2025 10:00' },
  ];
  DB.setEquipamentos(demo);
})();
