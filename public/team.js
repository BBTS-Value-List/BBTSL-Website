const API_BASE = "/api";
const LOGIN_SHORTCUT_CODE = "KeyL";
const TEAM_FETCH_CREDENTIALS = "same-origin";
const SYSTEM_ACCOUNT_ELIGIBLE_DISCORD_ID = "386438401563557888";
const ROLE_ORDER = ["Owner", "Developer", "Administrator", "Maintainer", "Editor", "Contributor"];
const LOGOUT_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14 4H7.75A1.75 1.75 0 0 0 6 5.75v12.5C6 19.216 6.784 20 7.75 20H14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 12h8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
    <path d="m15.5 8.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

const dom = {
  teamGrid: document.getElementById("teamGrid"),
  teamManageHost: document.getElementById("teamManageHost"),
  identityDock: document.getElementById("teamIdentityDock"),
  mobileIdentityDock: document.getElementById("teamMobileIdentityDock"),
  mobileUtilityTrigger: document.getElementById("teamMobileUtilityTrigger"),
  mobileUtilityOverlay: document.getElementById("teamMobileUtilityOverlay"),
  mobileUtilityCloseBtn: document.getElementById("teamMobileUtilityCloseBtn"),
  shortcutLoginOverlay: document.getElementById("teamShortcutLoginOverlay"),
  shortcutLoginCloseBtn: document.getElementById("teamShortcutLoginCloseBtn"),
  shortcutLoginCancelBtn: document.getElementById("teamShortcutLoginCancelBtn"),
  shortcutLoginBtn: document.getElementById("teamShortcutLoginBtn"),
  accountChoiceOverlay: document.getElementById("teamAccountChoiceOverlay"),
  accountChoiceCloseBtn: document.getElementById("teamAccountChoiceCloseBtn"),
  accountChoiceActualBtn: document.getElementById("teamAccountChoiceActualBtn"),
  accountChoiceSystemBtn: document.getElementById("teamAccountChoiceSystemBtn"),
  accountChoiceActualAvatar: document.getElementById("teamAccountChoiceActualAvatar"),
  accountChoiceActualName: document.getElementById("teamAccountChoiceActualName"),
  accountChoiceActualRole: document.getElementById("teamAccountChoiceActualRole")
};

const state = {
  auth: { authenticated: false, user: null, permissions: [], canUseSystemAccount: false, systemMode: false },
  team: [],
  lastLoginFlag: ""
};

function hasPermission(permission) {
  return state.auth.permissions.includes(permission) || state.auth.permissions.includes("owner:all");
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  headers["x-bbts-request"] = "1";
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${API_BASE}${path}`, { credentials: TEAM_FETCH_CREDENTIALS, ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }
  return body;
}

async function init() {
  state.auth = await api("/auth/status");
  await refreshTeam();
  attachEvents();
}

async function refreshTeamFromBfcache() {
  try {
    state.auth = await api("/auth/status");
    await refreshTeam();
  } catch (error) {
    console.error("Could not refresh team page after bfcache restore.", error);
  }
}

async function refreshTeam() {
  const body = await api("/team");
  state.team = (body.team || []).filter((member) => member.discordUserId !== SYSTEM_ACCOUNT_ELIGIBLE_DISCORD_ID);
  if (body.auth) {
    state.auth = body.auth;
  }
  renderTeam();
  renderManage();
  renderIdentityDock();
}

function renderTeam() {
  if (!state.team.length) {
    dom.teamGrid.innerHTML = `<div class="audit-empty">No public team members are listed yet.</div>`;
    return;
  }
  const grouped = ROLE_ORDER
    .map((role) => ({
      role,
      members: state.team.filter((member) => member.role === role)
    }))
    .filter((group) => group.members.length);

  dom.teamGrid.innerHTML = grouped
    .map((group) => `
      <section class="team-role-group">
        <div class="team-role-divider">${escapeHtml(group.role)}</div>
        <div class="team-role-list">
          ${group.members.map((member) => `
            <article class="team-member-card">
              ${buildTeamMemberAvatarMarkup(member)}
              <div class="team-member-copy">
                <h2>${escapeHtml(member.displayName)}</h2>
                <div class="team-member-handle">${escapeHtml(member.handle || member.displayName)}</div>
              </div>
            </article>
          `).join("")}
        </div>
      </section>
    `)
    .join("");
  bindTeamMemberAvatarAnimations();
}

function buildTeamMemberAvatarMarkup(member) {
  if (!member.avatarUrl) {
    return '<div class="team-member-avatar team-member-avatar-fallback">?</div>';
  }
  const animatedAvatarUrl = getAnimatedAvatarUrl(member.avatarUrl);
  const staticAvatarUrl = animatedAvatarUrl ? member.avatarUrl.replace(/\.gif(?=\?|$)/i, ".webp") : member.avatarUrl;
  const animatedAvatarAttribute = animatedAvatarUrl ? ` data-animated-avatar="${escapeHtmlAttr(animatedAvatarUrl)}"` : "";
  return `<img class="team-member-avatar" src="${escapeHtmlAttr(staticAvatarUrl)}"${animatedAvatarAttribute} alt="${escapeHtmlAttr(member.displayName)}">`;
}

function getAnimatedAvatarUrl(avatarUrl) {
  return /\.gif(?:\?|$)/i.test(avatarUrl) ? avatarUrl : "";
}

function bindTeamMemberAvatarAnimations() {
  dom.teamGrid.querySelectorAll("[data-animated-avatar]").forEach((avatar) => {
    const staticAvatarUrl = avatar.src;
    const animatedAvatarUrl = avatar.dataset.animatedAvatar;
    avatar.addEventListener("pointerenter", () => {
      avatar.src = animatedAvatarUrl;
    });
    avatar.addEventListener("pointerleave", () => {
      avatar.src = staticAvatarUrl;
    });
  });
}

function renderManage() {
  if (!hasPermission("team:manage")) {
    dom.teamManageHost.innerHTML = "";
    return;
  }
  dom.teamManageHost.innerHTML = `
    <section class="team-manage" id="teamManage">
      <div class="team-manage-card control-surface">
        <h2>Manage Team Members</h2>
        <form id="teamCreateForm" class="team-manage-form">
          <div class="field-grid">
            <div class="field">
              <label for="teamDiscordId">Discord User ID</label>
              <input id="teamDiscordId" type="text" required>
            </div>
            <div class="field">
              <label for="teamRole">Role</label>
              <select id="teamRole">
                <option value="Contributor">Contributor</option>
                <option value="Editor">Editor</option>
                <option value="Maintainer">Maintainer</option>
                <option value="Administrator">Administrator</option>
                <option value="Developer">Developer</option>
                <option value="Owner">Owner</option>
                <option value="Viewer">Viewer</option>
              </select>
            </div>
          </div>
          <div class="field-grid">
            <div class="field">
              <label for="teamUsername">Username</label>
              <input id="teamUsername" type="text">
            </div>
            <div class="field">
              <label for="teamGlobalName">Display Name</label>
              <input id="teamGlobalName" type="text">
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn-save" type="submit">Add Account</button>
          </div>
          <p class="team-manage-status" id="teamCreateStatus" hidden></p>
        </form>
      </div>
      <div class="team-manage-card control-surface">
        <h2>Assigned Accounts</h2>
        <div class="team-manage-list" id="teamManageList"></div>
      </div>
    </section>
  `;
  const teamCreateForm = document.getElementById("teamCreateForm");
  const teamDiscordId = document.getElementById("teamDiscordId");
  const teamRole = document.getElementById("teamRole");
  const teamUsername = document.getElementById("teamUsername");
  const teamGlobalName = document.getElementById("teamGlobalName");
  const teamCreateStatus = document.getElementById("teamCreateStatus");
  const teamManageList = document.getElementById("teamManageList");

  teamManageList.innerHTML = state.team
    .filter((member) => member.role !== "Viewer")
    .map(buildManagedTeamMemberMarkup)
    .join("");
  bindManagedTeamMemberForms(teamManageList);
  bindTeamCreateForm({
    teamCreateForm,
    teamCreateStatus,
    teamDiscordId,
    teamRole,
    teamUsername,
    teamGlobalName
  });
}

function buildManagedTeamMemberMarkup(member) {
  return `
    <form class="team-manage-row" data-user-id="${member.id}">
      <div class="team-manage-meta">
        <strong>${escapeHtml(member.displayName)}</strong>
        <span>${escapeHtml(member.discordUserId)}</span>
      </div>
      <div class="team-manage-input">
        <label>Username</label>
        <input name="username" type="text" value="${escapeHtmlAttr(member.username || "")}" placeholder="Username">
      </div>
      <div class="team-manage-input">
        <label>Display Name</label>
        <input name="globalName" type="text" value="${escapeHtmlAttr(member.globalName || "")}" placeholder="Display Name">
      </div>
      <div class="team-manage-input">
        <label>Role</label>
        <select name="role">
          ${["Viewer", "Contributor", "Editor", "Maintainer", "Administrator", "Developer", "Owner"].map((role) => `<option value="${role}" ${role === member.role ? "selected" : ""}>${role}</option>`).join("")}
        </select>
      </div>
      <div class="team-manage-input">
        <label>Status</label>
        <select name="status">
          <option value="active" ${member.status === "active" ? "selected" : ""}>Active</option>
          <option value="disabled" ${member.status === "disabled" ? "selected" : ""}>Disabled</option>
        </select>
      </div>
      <div class="team-manage-actions">
        <button class="tbtn" type="submit">Save</button>
        <p class="team-manage-status" hidden></p>
      </div>
    </form>
  `;
}

function bindManagedTeamMemberForms(teamManageList) {
  teamManageList.querySelectorAll("[data-user-id]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      const statusNode = form.querySelector(".team-manage-status");
      const userId = Number(form.dataset.userId);
      const role = form.querySelector('select[name="role"]').value;
      const status = form.querySelector('select[name="status"]').value;
      const username = form.querySelector('input[name="username"]').value.trim();
      const globalName = form.querySelector('input[name="globalName"]').value.trim();
      submitButton.disabled = true;
      if (statusNode) {
        statusNode.hidden = true;
      }
      try {
        await api(`/team/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({ role, status, username, globalName })
        });
        if (statusNode) {
          statusNode.textContent = "Saved.";
          statusNode.className = "team-manage-status is-success";
          statusNode.hidden = false;
        }
        await refreshTeam();
      } catch (error) {
        if (statusNode) {
          statusNode.textContent = error.message || "Could not save this account.";
          statusNode.className = "team-manage-status is-error";
          statusNode.hidden = false;
        }
      } finally {
        submitButton.disabled = false;
      }
    });
  });
}

function bindTeamCreateForm({
  teamCreateForm,
  teamCreateStatus,
  teamDiscordId,
  teamRole,
  teamUsername,
  teamGlobalName
}) {
  teamCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = teamCreateForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    teamCreateStatus.hidden = true;
    try {
      await api("/team/users", {
        method: "POST",
        body: JSON.stringify({
          discordUserId: teamDiscordId.value.trim(),
          role: teamRole.value,
          username: teamUsername.value.trim(),
          globalName: teamGlobalName.value.trim()
        })
      });
      teamCreateForm.reset();
      teamCreateStatus.textContent = "Account added.";
      teamCreateStatus.className = "team-manage-status is-success";
      teamCreateStatus.hidden = false;
      await refreshTeam();
    } catch (error) {
      teamCreateStatus.textContent = error.message || "Could not add this account.";
      teamCreateStatus.className = "team-manage-status is-error";
      teamCreateStatus.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}

function renderIdentityDock() {
  const markup = !state.auth.authenticated ? "" : `
    <div class="identity-card">
      <div class="identity-info">
        ${state.auth.user.avatarUrl ? `<img class="identity-avatar" src="${escapeHtmlAttr(state.auth.user.avatarUrl)}" alt="${escapeHtmlAttr(state.auth.user.displayName)}">` : '<div class="identity-avatar identity-avatar-fallback">?</div>'}
        <div>
          <div class="identity-name">${escapeHtml(state.auth.user.displayName)}</div>
          <div class="identity-role">${escapeHtml(state.auth.user.displayRole || state.auth.user.role)}</div>
        </div>
      </div>
      <button class="identity-logout" type="button" data-team-logout aria-label="Log out">${LOGOUT_ICON}</button>
    </div>
  `;
  [dom.identityDock, dom.mobileIdentityDock].forEach((target) => {
    if (target) {
      target.innerHTML = markup;
    }
  });
  document.querySelectorAll("[data-team-logout]").forEach((button) => {
    button.addEventListener("click", logout);
  });
  syncMobileUtilityVisibility();
  maybeOpenAccountChoice();
}

function attachEvents() {
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      void refreshTeamFromBfcache();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.code !== LOGIN_SHORTCUT_CODE) {
      return;
    }
    event.preventDefault();
    if (state.auth.authenticated) {
      void logout();
      return;
    }
    openShortcutLoginModal();
  });
  dom.mobileUtilityTrigger?.addEventListener("click", openMobileUtilityModal);
  dom.mobileUtilityCloseBtn?.addEventListener("click", closeMobileUtilityModal);
  dom.mobileUtilityOverlay?.addEventListener("click", (event) => {
    if (event.target === dom.mobileUtilityOverlay) {
      closeMobileUtilityModal();
    }
  });
  dom.shortcutLoginOverlay?.addEventListener("click", (event) => {
    if (event.target === dom.shortcutLoginOverlay) {
      closeShortcutLoginModal();
    }
  });
  dom.shortcutLoginCloseBtn?.addEventListener("click", closeShortcutLoginModal);
  dom.shortcutLoginCancelBtn?.addEventListener("click", closeShortcutLoginModal);
  dom.shortcutLoginBtn?.addEventListener("click", () => startDiscordAuth("login"));
  dom.accountChoiceOverlay?.addEventListener("click", (event) => {
    if (event.target === dom.accountChoiceOverlay) {
      closeAccountChoiceModal();
    }
  });
  dom.accountChoiceCloseBtn?.addEventListener("click", closeAccountChoiceModal);
  dom.accountChoiceActualBtn?.addEventListener("click", closeAccountChoiceModal);
  dom.accountChoiceSystemBtn?.addEventListener("click", () => {
    void activateSystemAccount().catch((error) => {
      window.alert(error?.message || "Could not switch to the BBTSL System account.");
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (dom.mobileUtilityOverlay && !dom.mobileUtilityOverlay.hidden) {
        closeMobileUtilityModal();
      }
      if (dom.shortcutLoginOverlay && !dom.shortcutLoginOverlay.hidden) {
        closeShortcutLoginModal();
      }
      if (dom.accountChoiceOverlay && !dom.accountChoiceOverlay.hidden) {
        closeAccountChoiceModal();
      }
    }
  });
}

function startDiscordAuth(purpose = "login") {
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/api/auth/start?purpose=${encodeURIComponent(purpose)}&returnTo=${returnTo}`;
}

function handleLoginFlags() {
  const url = new URL(window.location.href);
  const login = url.searchParams.get("login");
  state.lastLoginFlag = login || "";
  if (!login) {
    return;
  }
  url.searchParams.delete("login");
  window.history.replaceState({}, "", url.toString());
}

async function logout() {
  await api("/auth/logout", { method: "POST" });
  window.location.reload();
}

function openMobileUtilityModal() {
  if (!dom.mobileUtilityOverlay) {
    return;
  }
  dom.mobileUtilityOverlay.hidden = false;
  dom.mobileUtilityOverlay.classList.add("show");
  document.body.classList.add("modal-open");
}

function closeMobileUtilityModal() {
  if (!dom.mobileUtilityOverlay) {
    return;
  }
  dom.mobileUtilityOverlay.classList.remove("show");
  dom.mobileUtilityOverlay.hidden = true;
  document.body.classList.remove("modal-open");
}

function openShortcutLoginModal() {
  if (!dom.shortcutLoginOverlay) {
    return;
  }
  dom.shortcutLoginOverlay.hidden = false;
  dom.shortcutLoginOverlay.classList.add("show");
  document.body.classList.add("modal-open");
  dom.shortcutLoginBtn?.focus();
}

function closeShortcutLoginModal() {
  if (!dom.shortcutLoginOverlay) {
    return;
  }
  dom.shortcutLoginOverlay.classList.remove("show");
  dom.shortcutLoginOverlay.hidden = true;
  document.body.classList.remove("modal-open");
}

function openAccountChoiceModal() {
  if (!dom.accountChoiceOverlay || !state.auth?.user) {
    return;
  }
  const authUser = state.auth.user;
  const displayName = authUser.displayName || authUser.globalName || authUser.username || "Your account";
  const roleText = authUser.displayRole || authUser.role || "Discord account";
  if (authUser.avatarUrl) {
    const avatar = document.createElement("img");
    avatar.className = "account-choice-avatar";
    avatar.id = "teamAccountChoiceActualAvatar";
    avatar.src = authUser.avatarUrl;
    avatar.alt = displayName;
    dom.accountChoiceActualAvatar.replaceWith(avatar);
    dom.accountChoiceActualAvatar = avatar;
  } else {
    const avatar = document.createElement("div");
    avatar.className = "account-choice-avatar identity-avatar identity-avatar-fallback";
    avatar.id = "teamAccountChoiceActualAvatar";
    avatar.textContent = "?";
    dom.accountChoiceActualAvatar.replaceWith(avatar);
    dom.accountChoiceActualAvatar = avatar;
  }
  dom.accountChoiceActualName.textContent = displayName;
  dom.accountChoiceActualRole.textContent = roleText;
  dom.accountChoiceOverlay.hidden = false;
  dom.accountChoiceOverlay.classList.add("show");
  document.body.classList.add("modal-open");
  dom.accountChoiceActualBtn?.focus();
}

function closeAccountChoiceModal() {
  if (!dom.accountChoiceOverlay) {
    return;
  }
  dom.accountChoiceOverlay.classList.remove("show");
  dom.accountChoiceOverlay.hidden = true;
  document.body.classList.remove("modal-open");
}

function maybeOpenAccountChoice() {
  if (state.lastLoginFlag !== "success") {
    return;
  }
  if (!state.auth?.authenticated || state.auth.systemMode || !state.auth.canUseSystemAccount) {
    return;
  }
  if (String(state.auth.user?.discordUserId || "") !== SYSTEM_ACCOUNT_ELIGIBLE_DISCORD_ID) {
    return;
  }
  state.lastLoginFlag = "";
  openAccountChoiceModal();
}

async function activateSystemAccount() {
  await api("/auth/system-session", { method: "POST" });
  closeAccountChoiceModal();
  await refreshTeam();
}

function syncMobileUtilityVisibility() {
  const hasUtilityContent = Boolean(state.auth.authenticated);
  if (dom.mobileUtilityTrigger) {
    dom.mobileUtilityTrigger.hidden = !hasUtilityContent;
  }
  if (!hasUtilityContent && dom.mobileUtilityOverlay && !dom.mobileUtilityOverlay.hidden) {
    closeMobileUtilityModal();
  }
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

handleLoginFlags();

init().catch((error) => {
  console.error(error);
  dom.teamGrid.innerHTML = `<div class="audit-empty">${escapeHtml(error.message || "Could not load the team page.")}</div>`;
});
