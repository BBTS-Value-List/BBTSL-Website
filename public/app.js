const CATEGORY_COLORS = {
  LTM: "#a389f4",
  Ranked: "#e8b94f",
  "Top Spenders": "#4fd1a5",
  "Other Swords": "#5fc2ff",
  Explosions: "#ff6a6a"
};

const TREND_ICONS = {
  Rising: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17L10 11L14 15L20 7"/><path d="M14 7H20V13"/></svg>',
  Falling: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7L10 13L14 9L20 17"/><path d="M14 17H20V11"/></svg>',
  Stable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12H20"/></svg>',
  Manipulated: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V13"/><circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none"/><path d="M10.3 3.8L2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.8a1.6 1.6 0 0 0-2.8 0Z"/></svg>',
  "N/A": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M8 12H16"/></svg>'
};

const VALUE_BAR_STOPS = ["#4a5a78", "#5573c9", "#7d5fd9", "#a34fd0", "#d94f9e", "#e8636b", "#e88a4f", "#efab4a", "#f4cf5c"];
const CATEGORY_ORDER = ["All", "LTM", "Ranked", "Top Spenders", "Other Swords", "Explosions"];
const API_BASE = "/api";
const ADMIN_SEQUENCE = "bbtsladmin";
const ADMIN_SEQUENCE_TIMEOUT_MS = 2500;
const DESCRIPTION_PREVIEW_LENGTH = 175;
const MAX_EDIT_VALUE = 10_000_000;
const UNAVAILABLE_IMAGE_MARKUP = '<div class="card-thumb"><img src="/images/unavailable.webp" alt="Unavailable"></div>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 2.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/><path d="M14.5 5.5l4 4"/></svg>';

const dom = {
  body: document.body,
  chips: document.getElementById("chips"),
  search: document.getElementById("search"),
  sortSelect: document.getElementById("sortSelect"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("empty"),
  lastUpdated: document.getElementById("lastUpdated"),
  controlsShell: document.querySelector(".controls-shell"),
  modalOverlay: document.getElementById("modalOverlay"),
  authModalOverlay: document.getElementById("authModalOverlay"),
  editForm: document.getElementById("editForm"),
  authForm: document.getElementById("authForm"),
  modalTitle: document.getElementById("modalTitle"),
  authCode: document.getElementById("authCode"),
  authError: document.getElementById("authError"),
  authSubmitBtn: document.getElementById("authSubmitBtn"),
  authCancelBtn: document.getElementById("authCancelBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  imageInput: document.getElementById("f-image"),
  imagePreview: document.getElementById("f-image-preview"),
  imageRemove: document.getElementById("f-image-remove"),
  fields: {
    name: document.getElementById("f-name"),
    category: document.getElementById("f-cat"),
    value: document.getElementById("f-value"),
    demand: document.getElementById("f-demand"),
    trend: document.getElementById("f-trend"),
    count: document.getElementById("f-count"),
    description: document.getElementById("f-desc")
  }
};

const state = {
  swords: [],
  minValue: 0,
  maxValue: 0,
  isAuthenticated: false,
  activeCategory: "All",
  searchTerm: "",
  sortMode: "value-desc",
  editingId: null,
  isAddingSword: false,
  pendingImage: undefined,
  activeModalId: null,
  activeModalTrigger: null,
  adminSequenceBuffer: "",
  adminSequenceTimestamp: 0,
  expandedDescriptions: new Set()
};

function setSwordState(swords) {
  state.swords = swords;
  if (swords.length === 0) {
    state.minValue = 0;
    state.maxValue = 0;
    return;
  }

  const values = swords.map((sword) => sword.v);
  state.minValue = Math.min(...values);
  state.maxValue = Math.max(...values);
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (method !== "GET") {
    headers["x-bbts-request"] = "1";
  }

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return body;
}

async function refreshSwords() {
  const { swords } = await api("/swords");
  setSwordState(swords);
  renderGrid();
  renderLastUpdated();
}

async function syncAuthStatus() {
  const status = await api("/auth/status");
  setAuthenticated(Boolean(status.authenticated));
}

function setAuthenticated(nextValue) {
  state.isAuthenticated = nextValue;
  dom.body.classList.toggle("is-admin", nextValue);
  renderEditToolbar();
  renderGrid();
}

function getModalElements(modalId) {
  const overlay = document.getElementById(modalId);
  return {
    overlay,
    modal: overlay?.querySelector(".modal") || null
  };
}

function getFocusableElements(container) {
  if (!container) {
    return [];
  }

  return [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hasAttribute("hidden"));
}

function openModal(modalId, focusTargetId = null) {
  const { overlay, modal } = getModalElements(modalId);
  if (!overlay || !modal) {
    return;
  }

  state.activeModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.activeModalId = modalId;
  overlay.hidden = false;
  overlay.classList.add("show");
  dom.body.classList.add("modal-open");

  const target = focusTargetId ? document.getElementById(focusTargetId) : null;
  (target || getFocusableElements(modal)[0] || modal).focus();
}

function closeModal(modalId, restoreFocus = true) {
  const { overlay } = getModalElements(modalId);
  if (!overlay) {
    return;
  }

  overlay.classList.remove("show");
  overlay.hidden = true;

  if (state.activeModalId !== modalId) {
    return;
  }

  state.activeModalId = null;
  dom.body.classList.remove("modal-open");

  if (restoreFocus) {
    state.activeModalTrigger?.focus?.();
  }

  state.activeModalTrigger = null;
}

function openAuthModal() {
  dom.authCode.value = "";
  dom.authError.hidden = true;
  openModal("authModalOverlay", "authCode");
}

function closeAuthModal() {
  closeModal("authModalOverlay");
}

async function submitAuthCode(event) {
  event.preventDefault();
  const code = dom.authCode.value.trim();

  if (!/^\d{6}$/.test(code)) {
    dom.authError.textContent = "Enter the current 6-digit authenticator code.";
    dom.authError.hidden = false;
    return;
  }

  dom.authSubmitBtn.disabled = true;
  dom.authError.hidden = true;

  try {
    await api("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ code })
    });
    await syncAuthStatus();
    closeAuthModal();
  } catch (error) {
    dom.authError.textContent = error.message || "Verification failed.";
    dom.authError.hidden = false;
  } finally {
    dom.authSubmitBtn.disabled = false;
  }
}

async function logoutAdmin() {
  await api("/auth/logout", { method: "POST" });
  setAuthenticated(false);
  closeEditModal();
}

function getValueAccent(value) {
  const range = state.maxValue - state.minValue;
  const position = range <= 0 ? 0 : (value - state.minValue) / range;
  const index = Math.min(VALUE_BAR_STOPS.length - 1, Math.floor(position * (VALUE_BAR_STOPS.length - 1)));
  return VALUE_BAR_STOPS[index];
}

function formatValue(value) {
  return value.toLocaleString("en-US");
}

function formatShortDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function renderChips() {
  dom.chips.innerHTML = CATEGORY_ORDER.map((category) => {
    const activeClass = category === state.activeCategory ? "active" : "";
    return `<button class="chip ${activeClass}" type="button" data-cat="${category}">${category}</button>`;
  }).join("");

  dom.chips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.activeCategory = chip.dataset.cat;
      renderChips();
      renderGrid();
    });
  });
}

function getFilteredSwords() {
  const searchTerm = state.searchTerm.trim().toLowerCase();
  const swords = state.swords.filter((sword) => {
    const categoryMatch = state.activeCategory === "All" || sword.c === state.activeCategory;
    const searchMatch = searchTerm === "" || sword.n.toLowerCase().includes(searchTerm);
    return categoryMatch && searchMatch;
  });

  switch (state.sortMode) {
    case "value-asc":
      return swords.sort((left, right) => left.v - right.v || left.id - right.id);
    case "name-asc":
      return swords.sort((left, right) => left.n.localeCompare(right.n, "en", { sensitivity: "base" }) || left.id - right.id);
    case "updated-desc":
      return swords.sort((left, right) => new Date(right.u) - new Date(left.u) || left.id - right.id);
    case "value-desc":
    default:
      return swords.sort((left, right) => right.v - left.v || left.id - right.id);
  }
}

function normalizeDescription(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildDescriptionMarkup(sword) {
  const description = normalizeDescription(sword.descr);
  if (!description) {
    return `
      <div class="card-desc is-empty-desc">
        <div class="card-desc-body">No description available.</div>
      </div>
    `;
  }

  const isExpanded = state.expandedDescriptions.has(sword.id);
  const needsToggle = description.length > DESCRIPTION_PREVIEW_LENGTH;
  const previewText = needsToggle && !isExpanded
    ? description.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd()
    : description;
  const suffix = needsToggle && !isExpanded ? "..." : "";
  const toggleMarkup = needsToggle
    ? `<button class="desc-toggle" type="button" data-desc-toggle="${sword.id}" aria-expanded="${isExpanded ? "true" : "false"}" aria-label="${isExpanded ? "Collapse description" : "Expand description"}">${isExpanded ? "&lt;" : "&gt;"}</button>`
    : "";

  return `
    <div class="card-desc${isExpanded ? " is-expanded" : ""}">
      <div class="card-desc-body">${escapeHtml(previewText)}${suffix}${toggleMarkup}</div>
    </div>
  `;
}

function buildCardImageMarkup(sword) {
  if (!sword.img) {
    return UNAVAILABLE_IMAGE_MARKUP;
  }

  return `<div class="card-thumb"><img src="${sword.img}" alt="${escapeHtmlAttr(sword.n)}"></div>`;
}

function buildCardMarkup(sword) {
  const categoryColor = CATEGORY_COLORS[sword.c] || "#7d8aa3";
  const trendClassName = sword.t.replace(/[^A-Za-z]/g, "") || "NA";
  const trendIcon = TREND_ICONS[sword.t] || TREND_ICONS["N/A"];

  return `
    <article class="card" style="--tcolor:${getValueAccent(sword.v)}; --ccolor:${categoryColor}" aria-label="${escapeHtmlAttr(sword.n)} value card">
      ${buildCardImageMarkup(sword)}
      <div class="card-body">
        <div class="card-top">
          <div class="card-name">${escapeHtml(sword.n)}</div>
          <div class="cat-badge" style="color:${categoryColor}">${escapeHtml(sword.c)}</div>
        </div>
        <div class="card-meta">
          <div class="meta-item"><span class="k">Demand</span>${escapeHtml(sword.d)}</div>
          <div class="meta-item"><span class="k">Trend</span><span class="trend ${trendClassName}">${trendIcon}${escapeHtml(sword.t)}</span></div>
          <div class="meta-item"><span class="k">Count</span>${sword.ct ?? "-"}</div>
        </div>
        <div class="card-value"><img class="value-token" src="/token.svg" alt="" aria-hidden="true">${formatValue(sword.v)}</div>
        ${buildDescriptionMarkup(sword)}
      </div>
      <div class="card-footer">
        <div class="card-updated">UPDATED ${formatShortDate(sword.u).toUpperCase()}</div>
        <div class="card-actions">
          ${sword.edited ? '<span class="edited-tag">Edited</span>' : ""}
          ${state.isAuthenticated ? `<button class="edit-btn" type="button" data-edit="${sword.id}" title="Edit" aria-label="Edit ${escapeHtmlAttr(sword.n)}">${PENCIL_ICON}</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function bindGridEvents() {
  dom.grid.querySelectorAll(".edit-btn").forEach((button) => {
    button.addEventListener("click", () => openEditModal(Number(button.dataset.edit)));
  });

  dom.grid.querySelectorAll("[data-desc-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleDescription(Number(button.dataset.descToggle)));
  });
}

function renderGrid() {
  const swords = getFilteredSwords();

  if (swords.length === 0) {
    dom.grid.innerHTML = "";
    dom.empty.textContent = state.swords.length === 0
      ? "No swords are available right now."
      : "No swords match the current filters.";
    dom.empty.classList.add("show");
    return;
  }

  dom.empty.classList.remove("show");
  dom.grid.innerHTML = swords.map(buildCardMarkup).join("");
  bindGridEvents();
}

function renderLastUpdated() {
  if (state.swords.length === 0) {
    dom.lastUpdated.textContent = "Unavailable";
    return;
  }

  const latestDate = state.swords.reduce((latest, sword) => sword.u > latest ? sword.u : latest, state.swords[0].u);
  dom.lastUpdated.textContent = new Date(`${latestDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function renderEditToolbar() {
  const existing = document.getElementById("editToolbar");
  if (!state.isAuthenticated) {
    existing?.remove();
    return;
  }

  if (!existing) {
    dom.controlsShell.insertAdjacentHTML("beforeend", `
      <div class="edit-toolbar" id="editToolbar">
        <button class="tbtn ghost" id="addSwordBtn" type="button">Add Sword</button>
        <button class="tbtn" id="exportBtn" type="button">Export Data</button>
        <button class="tbtn warn" id="resetBtn" type="button">Reset Data</button>
        <button class="tbtn" id="logoutBtn" type="button">Log Out</button>
      </div>
    `);
  }

  document.getElementById("addSwordBtn").onclick = openAddModal;
  document.getElementById("exportBtn").onclick = exportDataFile;
  document.getElementById("resetBtn").onclick = resetData;
  document.getElementById("logoutBtn").onclick = () => void logoutAdmin();
}

function updateImagePreview(source) {
  if (!source) {
    dom.imagePreview.textContent = "No image";
    dom.imageRemove.hidden = true;
    return;
  }

  dom.imagePreview.innerHTML = `<img src="${source}" alt="" class="preview-image">`;
  dom.imageRemove.hidden = false;
}

function fillEditForm(sword) {
  dom.fields.name.value = sword.n;
  dom.fields.category.value = sword.c;
  dom.fields.value.value = sword.v;
  dom.fields.demand.value = sword.d;
  dom.fields.trend.value = sword.t;
  dom.fields.count.value = sword.ct ?? "";
  dom.fields.description.value = sword.descr || "";
  dom.imageInput.value = "";
  updateImagePreview(sword.img || null);
}

function clearEditForm() {
  dom.fields.name.value = "";
  dom.fields.category.value = state.activeCategory !== "All" ? state.activeCategory : "Other Swords";
  dom.fields.value.value = "";
  dom.fields.demand.value = "Medium";
  dom.fields.trend.value = "Stable";
  dom.fields.count.value = "";
  dom.fields.description.value = "";
  dom.imageInput.value = "";
  updateImagePreview(null);
}

function openEditModal(id) {
  const sword = state.swords.find((entry) => entry.id === id);
  if (!sword) {
    return;
  }

  state.editingId = id;
  state.isAddingSword = false;
  state.pendingImage = undefined;
  dom.modalTitle.textContent = "Edit Sword";
  dom.deleteBtn.hidden = false;
  fillEditForm(sword);
  openModal("modalOverlay", "f-name");
}

function openAddModal() {
  state.editingId = null;
  state.isAddingSword = true;
  state.pendingImage = undefined;
  dom.modalTitle.textContent = "Add Sword";
  dom.deleteBtn.hidden = true;
  clearEditForm();
  openModal("modalOverlay", "f-name");
}

function closeEditModal() {
  closeModal("modalOverlay");
  state.editingId = null;
  state.isAddingSword = false;
}

function buildSwordPayload() {
  return {
    n: dom.fields.name.value.trim(),
    c: dom.fields.category.value,
    v: Math.min(Number(dom.fields.value.value) || 0, MAX_EDIT_VALUE),
    d: dom.fields.demand.value,
    t: dom.fields.trend.value,
    ct: dom.fields.count.value === "" ? null : Number(dom.fields.count.value),
    descr: dom.fields.description.value
  };
}

function validateSwordName(name) {
  if (!name) {
    alert("Enter a sword name.");
    return false;
  }

  const duplicate = state.swords.some((sword) => sword.n.toLowerCase() === name.toLowerCase() && sword.id !== state.editingId);
  if (duplicate) {
    alert("A sword with that name already exists.");
    return false;
  }

  return true;
}

async function saveSword(payload) {
  if (state.pendingImage !== undefined) {
    payload.img = state.pendingImage;
  }

  if (state.isAddingSword) {
    await api("/swords", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return;
  }

  await api(`/swords/${state.editingId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

async function handleProtectedAction(action, onUnauthorized) {
  try {
    await action();
    return true;
  } catch (error) {
    if (error.status === 401) {
      setAuthenticated(false);
      onUnauthorized?.();
      openAuthModal();
      return false;
    }

    throw error;
  }
}

async function handleEditSubmit(event) {
  event.preventDefault();
  if (!state.isAddingSword && state.editingId === null) {
    return;
  }

  const payload = buildSwordPayload();
  if (!validateSwordName(payload.n)) {
    return;
  }

  const saveButton = dom.editForm.querySelector(".btn-save");
  saveButton.disabled = true;

  try {
    const completed = await handleProtectedAction(() => saveSword(payload), closeEditModal);
    if (!completed) {
      return;
    }

    await refreshSwords();
    closeEditModal();
  } catch (error) {
    alert(error.message || "Could not save this sword.");
  } finally {
    saveButton.disabled = false;
  }
}

async function handleDeleteSword() {
  if (state.editingId === null) {
    return;
  }

  const sword = state.swords.find((entry) => entry.id === state.editingId);
  const name = sword ? sword.n : "this sword";
  if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) {
    return;
  }

  dom.deleteBtn.disabled = true;

  try {
    const completed = await handleProtectedAction(
      () => api(`/swords/${state.editingId}`, { method: "DELETE" }),
      closeEditModal
    );
    if (!completed) {
      return;
    }

    await refreshSwords();
    closeEditModal();
  } catch (error) {
    alert(error.message || "Could not delete this sword.");
  } finally {
    dom.deleteBtn.disabled = false;
  }
}

function buildExportText() {
  const rows = state.swords.map((sword) => {
    const description = (sword.descr || "").replace(/"/g, '\\"');
    const count = sword.ct === null || sword.ct === undefined ? "null" : sword.ct;
    const imagePart = sword.img ? `,img:${JSON.stringify(sword.img)}` : "";
    return `{n:${JSON.stringify(sword.n)},c:${JSON.stringify(sword.c)},v:${sword.v},d:${JSON.stringify(sword.d)},t:${JSON.stringify(sword.t)},ct:${count},u:${JSON.stringify(sword.u)},desc:"${description}"${imagePart}},`;
  });

  return `const SWORDS = [\n${rows.join("\n")}\n];\n`;
}

function exportDataFile() {
  const blob = new Blob([buildExportText()], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "data.js";
  anchor.click();
  URL.revokeObjectURL(url);
}

function confirmReset() {
  return window.prompt("Type RESET to restore the shared baseline and remove every saved edit.") === "RESET";
}

async function resetData() {
  if (!confirmReset()) {
    return;
  }

  try {
    const completed = await handleProtectedAction(() => api("/reset", { method: "POST" }));
    if (!completed) {
      return;
    }

    await refreshSwords();
  } catch (error) {
    alert(error.message || "Could not reset the data.");
  }
}

function toggleDescription(swordId) {
  if (state.expandedDescriptions.has(swordId)) {
    state.expandedDescriptions.delete(swordId);
  } else {
    state.expandedDescriptions.add(swordId);
  }

  renderGrid();
}

function handleAdminShortcut(event) {
  if (event.key === "Escape") {
    if (state.activeModalId === "modalOverlay") {
      closeEditModal();
    } else if (state.activeModalId === "authModalOverlay") {
      closeAuthModal();
    }
    return;
  }

  if (event.key === "Tab" && state.activeModalId) {
    const { modal } = getModalElements(state.activeModalId);
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }

  if (event.target instanceof HTMLElement) {
    const tagName = event.target.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || event.target.isContentEditable) {
      return;
    }
  }

  if (event.ctrlKey && event.shiftKey && event.code === "KeyL") {
    event.preventDefault();
    if (state.isAuthenticated) {
      void logoutAdmin();
      return;
    }
    openAuthModal();
    return;
  }

  if (event.key.length !== 1) {
    return;
  }

  const now = Date.now();
  const nextCharacter = event.key.toLowerCase();
  state.adminSequenceBuffer = now - state.adminSequenceTimestamp > ADMIN_SEQUENCE_TIMEOUT_MS
    ? nextCharacter
    : `${state.adminSequenceBuffer}${nextCharacter}`.slice(-ADMIN_SEQUENCE.length);
  state.adminSequenceTimestamp = now;

  if (state.adminSequenceBuffer !== ADMIN_SEQUENCE) {
    return;
  }

  state.adminSequenceBuffer = "";
  if (state.isAuthenticated) {
    void logoutAdmin();
    return;
  }
  openAuthModal();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value);
}

function attachEvents() {
  dom.search.addEventListener("input", (event) => {
    state.searchTerm = event.target.value;
    renderGrid();
  });

  dom.sortSelect.addEventListener("change", (event) => {
    state.sortMode = event.target.value;
    renderGrid();
  });

  dom.authForm.addEventListener("submit", submitAuthCode);
  dom.authCancelBtn.addEventListener("click", closeAuthModal);
  dom.authModalOverlay.addEventListener("click", (event) => {
    if (event.target === dom.authModalOverlay) {
      closeAuthModal();
    }
  });

  dom.editForm.addEventListener("submit", handleEditSubmit);
  dom.cancelBtn.addEventListener("click", closeEditModal);
  dom.deleteBtn.addEventListener("click", handleDeleteSword);
  dom.imageRemove.addEventListener("click", () => {
    state.pendingImage = null;
    dom.imageInput.value = "";
    updateImagePreview(null);
  });

  dom.imageInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      state.pendingImage = await readFileAsDataUrl(file);
      updateImagePreview(state.pendingImage);
    } catch (error) {
      alert(error.message || "Could not load the selected image.");
      dom.imageInput.value = "";
    }
  });

  dom.modalOverlay.addEventListener("click", (event) => {
    if (event.target === dom.modalOverlay) {
      closeEditModal();
    }
  });

  document.addEventListener("keydown", handleAdminShortcut);
}

async function init() {
  attachEvents();
  renderChips();
  renderEditToolbar();

  dom.empty.textContent = "Loading value list.";
  dom.empty.classList.add("show");

  try {
    await Promise.all([syncAuthStatus(), refreshSwords()]);
  } catch (error) {
    console.error(error);
    dom.empty.textContent = "Could not load the value list.";
    dom.empty.classList.add("show");
  }
}

init();
