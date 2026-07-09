const CAT_COLORS = {
  "LTM": "#a389f4",
  "Ranked": "#e8b94f",
  "Top Spenders": "#4fd1a5",
  "Other Swords": "#5fc2ff",
  "Explosions": "#ff6a6a"
};

const TREND_ICON = {
  Rising: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17L10 11L14 15L20 7"/><path d="M14 7H20V13"/></svg>',
  Falling: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7L10 13L14 9L20 17"/><path d="M14 17H20V11"/></svg>',
  Stable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12H20"/></svg>',
  Manipulated: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V13"/><circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none"/><path d="M10.3 3.8L2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.8a1.6 1.6 0 0 0-2.8 0Z"/></svg>',
  "N/A": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M8 12H16"/></svg>'
};

const TEMPER_STOPS = ["#4a5a78","#5573c9","#7d5fd9","#a34fd0","#d94f9e","#e8636b","#e88a4f","#efab4a","#f4cf5c"];
const MAX_EDIT_VALUE = 10000000;
const EDITOR_PASSWORD = "Bigkunfupandadihh";

// ---- persisted edits (this browser only) ----
const OVERRIDES_KEY = "bbts_overrides_v2";
const ADDED_KEY = "bbts_added_v2";
const DELETED_KEY = "bbts_deleted_v2";

function loadJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}
function saveJSON(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }
  catch(e){ console.error("Could not save:", e); }
}

let overrides = loadJSON(OVERRIDES_KEY, {});   // { id: {partial fields} }
let added = loadJSON(ADDED_KEY, []);           // [ full sword objects ]
let deleted = loadJSON(DELETED_KEY, []);       // [ id, id, ... ]

let nextId = Math.max(99, ...added.map(s => s.id)) + 1;

function getMergedSwords(){
  const base = SWORDS
    .filter(s => !deleted.includes(s.id))
    .map(s => overrides[s.id] ? { ...s, ...overrides[s.id] } : s);
  const extra = added
    .filter(s => !deleted.includes(s.id))
    .map(s => overrides[s.id] ? { ...s, ...overrides[s.id] } : s);
  return [...base, ...extra];
}

let minV = 0, maxV = 0;
function computeMinMax(){
  const values = getMergedSwords().map(s => s.v);
  minV = values.length ? Math.min(...values) : 0;
  maxV = values.length ? Math.max(...values) : 0;
}
computeMinMax();

// ---- editor access gate ----
const UNLOCK_KEY = "bbts_editor_unlocked";
let isUnlocked = sessionStorage.getItem(UNLOCK_KEY) === "true";

function setUnlocked(state){
  isUnlocked = state;
  sessionStorage.setItem(UNLOCK_KEY, state ? "true" : "false");
  document.getElementById('editToolbar').style.display = state ? "flex" : "none";
  const lockIcon = document.getElementById('lockIcon');
  lockIcon.innerHTML = state
    ? '<path d="M8 10V7a4 4 0 0 1 8 0v1"/><rect x="4" y="10" width="16" height="10" rx="2"/>'
    : '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>';
  document.getElementById('lockBtn').style.color = state ? "var(--teal)" : "var(--text-faint)";
  document.getElementById('lockBtn').style.borderColor = state ? "var(--teal)" : "var(--line)";
  renderGrid();
}

document.getElementById('lockBtn').addEventListener('click', () => {
  if(isUnlocked){
    setUnlocked(false);
    return;
  }
  const attempt = window.prompt("Enter editor password:");
  if(attempt === null) return;
  if(attempt === EDITOR_PASSWORD){
    setUnlocked(true);
  } else {
    alert("Incorrect password.");
  }
});

function temperColor(v){
  const pct = maxV === minV ? 0 : (v - minV) / (maxV - minV);
  const idx = Math.min(TEMPER_STOPS.length - 1, Math.floor(pct * (TEMPER_STOPS.length - 1)));
  return TEMPER_STOPS[idx];
}

function fmtValue(v){ return v.toLocaleString('en-US'); }
function fmtDate(iso){
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- state ----
let activeCategory = "All";
let searchTerm = "";
let sortMode = "value-desc";
const categories = ["All", "LTM", "Ranked", "Top Spenders", "Other Swords", "Explosions"];

function renderChips(){
  const chipsEl = document.getElementById('chips');
  chipsEl.innerHTML = categories.map(cat => {
    const active = cat === activeCategory ? 'active' : '';
    return `<div class="chip ${active}" data-cat="${cat}">${cat}</div>`;
  }).join('');
  chipsEl.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.cat;
      renderChips();
      renderGrid();
    });
  });
}

function getFiltered(){
  let list = getMergedSwords().filter(s => {
    const matchesCat = activeCategory === "All" || s.c === activeCategory;
    const matchesSearch = s.n.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCat && matchesSearch;
  });
  switch(sortMode){
    case "value-desc": list.sort((a,b) => b.v - a.v); break;
    case "value-asc": list.sort((a,b) => a.v - b.v); break;
    case "name-asc": list.sort((a,b) => a.n.localeCompare(b.n)); break;
    case "updated-desc": list.sort((a,b) => new Date(b.u) - new Date(a.u)); break;
  }
  return list;
}

const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 2.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/><path d="M14.5 5.5l4 4"/></svg>';

function cardHTML(s){
  const color = CAT_COLORS[s.c] || "#7d8aa3";
  const tColor = temperColor(s.v);
  const trendClass = s.t.replace(/[^A-Za-z]/g, '') || "NA";
  const icon = TREND_ICON[s.t] || TREND_ICON["N/A"];
  const desc = s.desc ? `<div class="card-desc">${s.desc}</div>` : "";
  const isEdited = !!overrides[s.id];

  return `
  <div class="card" style="--tcolor:${tColor}">
    ${s.img ? `<div class="card-thumb"><img src="${s.img}" alt="${s.n}"></div>` : ''}
    <div class="card-top">
      <div class="card-name">${s.n}</div>
      <div class="cat-badge" style="color:${color}">${s.c}</div>
    </div>
    <div class="card-value"><span class="diamond">♦</span>${fmtValue(s.v)}</div>
    <div class="card-meta">
      <div class="meta-item"><span class="k">Demand</span>${s.d}</div>
      <div class="meta-item"><span class="k">Trend</span><span class="trend ${trendClass}">${icon}${s.t}</span></div>
      <div class="meta-item"><span class="k">Count</span>${s.ct ?? '—'}</div>
    </div>
    ${desc}
    <div class="card-footer">
      <div class="card-updated">UPDATED ${fmtDate(s.u).toUpperCase()}</div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${isEdited ? '<span class="edited-tag">Edited</span>' : ''}
        ${isUnlocked ? `<div class="edit-btn" data-edit="${s.id}" title="Edit">${PENCIL_ICON}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function renderGrid(){
  const filtered = getFiltered();
  const gridEl = document.getElementById('grid');
  const emptyEl = document.getElementById('empty');
  if(filtered.length === 0){
    gridEl.innerHTML = "";
    emptyEl.textContent = "No blades match that search. Try another name.";
    emptyEl.classList.add('show');
  } else {
    emptyEl.classList.remove('show');
    gridEl.innerHTML = filtered.map(cardHTML).join('');
  }
  gridEl.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(Number(btn.dataset.edit)));
  });
}

function renderLastUpdated(){
  const data = getMergedSwords();
  if(!data.length){ document.getElementById('lastUpdated').textContent = '—'; return; }
  const latest = data.reduce((a,b) => new Date(a.u) > new Date(b.u) ? a : b);
  document.getElementById('lastUpdated').textContent = fmtDate(latest.u);
}

// ---- edit modal ----
const modalOverlay = document.getElementById('modalOverlay');
const editForm = document.getElementById('editForm');
let editingId = null;
let isAddingSword = false;
let pendingImage = undefined;

function updateImagePreview(src){
  const preview = document.getElementById('f-image-preview');
  const removeLink = document.getElementById('f-image-remove');
  if(src){
    preview.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:contain;">`;
    removeLink.style.display = 'block';
  } else {
    preview.innerHTML = 'No image';
    removeLink.style.display = 'none';
  }
}

document.getElementById('f-image').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = reader.result;
    updateImagePreview(pendingImage);
  };
  reader.readAsDataURL(file);
});

document.getElementById('f-image-remove').addEventListener('click', () => {
  pendingImage = null;
  document.getElementById('f-image').value = '';
  updateImagePreview(null);
});

function openEditModal(id){
  const sword = getMergedSwords().find(s => s.id === id);
  if(!sword) return;
  editingId = id;
  isAddingSword = false;
  pendingImage = undefined;
  document.getElementById('modalTitle').textContent = 'Edit Sword';
  document.getElementById('f-image').value = '';
  document.getElementById('f-name').value = sword.n;
  document.getElementById('f-cat').value = sword.c;
  document.getElementById('f-value').value = sword.v;
  document.getElementById('f-demand').value = sword.d;
  document.getElementById('f-trend').value = sword.t;
  document.getElementById('f-count').value = sword.ct ?? '';
  document.getElementById('f-desc').value = sword.desc || '';
  updateImagePreview(sword.img || null);
  modalOverlay.classList.add('show');
}

function openAddModal(){
  editingId = null;
  isAddingSword = true;
  pendingImage = undefined;
  document.getElementById('modalTitle').textContent = 'Add Sword';
  document.getElementById('f-image').value = '';
  document.getElementById('f-name').value = '';
  document.getElementById('f-cat').value = activeCategory !== 'All' ? activeCategory : 'Other Swords';
  document.getElementById('f-value').value = '';
  document.getElementById('f-demand').value = 'Medium';
  document.getElementById('f-trend').value = 'Stable';
  document.getElementById('f-count').value = '';
  document.getElementById('f-desc').value = '';
  updateImagePreview(null);
  modalOverlay.classList.add('show');
  document.getElementById('f-name').focus();
}

function closeEditModal(){
  modalOverlay.classList.remove('show');
  editingId = null;
  isAddingSword = false;
}

editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const editedValue = Math.min(Number(document.getElementById('f-value').value) || 0, MAX_EDIT_VALUE);
  const countVal = document.getElementById('f-count').value;
  const swordName = document.getElementById('f-name').value.trim();

  if(!swordName){ alert("Enter a sword name."); return; }
  const duplicate = getMergedSwords().some(s => s.n.toLowerCase() === swordName.toLowerCase() && s.id !== editingId);
  if(duplicate){ alert("A sword with that name already exists."); return; }

  const fields = {
    n: swordName,
    c: document.getElementById('f-cat').value,
    v: editedValue,
    d: document.getElementById('f-demand').value,
    t: document.getElementById('f-trend').value,
    ct: countVal === '' ? null : Number(countVal),
    desc: document.getElementById('f-desc').value,
    u: new Date().toISOString().slice(0,10)
  };
  if(pendingImage !== undefined) fields.img = pendingImage === null ? undefined : pendingImage;

  if(isAddingSword){
    const newSword = { id: nextId++, img: undefined, ...fields };
    added.push(newSword);
    saveJSON(ADDED_KEY, added);
  } else {
    overrides[editingId] = { ...(overrides[editingId] || {}), ...fields };
    saveJSON(OVERRIDES_KEY, overrides);
  }

  computeMinMax();
  closeEditModal();
  renderGrid();
  renderLastUpdated();
});

document.getElementById('addSwordBtn').addEventListener('click', openAddModal);
document.getElementById('cancelBtn').addEventListener('click', closeEditModal);
modalOverlay.addEventListener('click', (e) => { if(e.target === modalOverlay) closeEditModal(); });
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeEditModal(); });

// ---- export current snapshot ----
function buildDataFileText(){
  const lines = getMergedSwords().map(s => {
    const desc = (s.desc || '').replace(/"/g, '\\"');
    const ct = s.ct === null || s.ct === undefined ? 'null' : s.ct;
    const img = s.img ? `,img:${JSON.stringify(s.img)}` : '';
    return `{id:${s.id},n:${JSON.stringify(s.n)},c:${JSON.stringify(s.c)},v:${s.v},d:${JSON.stringify(s.d)},t:${JSON.stringify(s.t)},ct:${ct},u:${JSON.stringify(s.u)},desc:"${desc}"${img}}`;
  });
  return `const SWORDS = [\n${lines.join(',\n')}\n];\n`;
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const text = buildDataFileText();
  const blob = new Blob([text], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.js';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if(!confirm('This clears every edit saved in this browser and reloads the original values. Continue?')) return;
  overrides = {};
  added = [];
  deleted = [];
  saveJSON(OVERRIDES_KEY, overrides);
  saveJSON(ADDED_KEY, added);
  saveJSON(DELETED_KEY, deleted);
  nextId = 100;
  computeMinMax();
  renderGrid();
  renderLastUpdated();
});

// ---- search/sort events ----
document.getElementById('search').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderGrid();
});
document.getElementById('sortSelect').addEventListener('change', (e) => {
  sortMode = e.target.value;
  renderGrid();
});

// ---- init ----
renderChips();
renderGrid();
renderLastUpdated();
setUnlocked(isUnlocked);
