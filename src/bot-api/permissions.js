const ROLE_PERMISSIONS = Object.freeze({
  Viewer: [],
  Contributor: ["team:view:self"],
  Editor: ["team:view:self", "sword:update", "media:update"],
  Maintainer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete"],
  Administrator: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export"],
  Developer: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "audit:revert", "team:manage", "session:revoke", "backup:manage"],
  Owner: ["team:view:self", "sword:update", "media:update", "sword:create", "sword:delete", "audit:view", "data:export", "audit:revert", "team:manage", "session:revoke", "backup:manage", "owner:all"]
});

const DENIED_CAPABILITIES = new Set(["data:reset"]);
export const STAFF_LOGIN_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function getBotPermissions(role) {
  return [...(ROLE_PERMISSIONS[String(role || "")] || [])].filter((capability) => !DENIED_CAPABILITIES.has(capability));
}

export function hasBotCapability(role, capability) {
  const normalized = String(capability || "");
  if (DENIED_CAPABILITIES.has(normalized)) return false;
  const permissions = getBotPermissions(role);
  return permissions.includes(normalized) || permissions.includes("owner:all");
}

export function isRecentWebsiteLogin(value, now = Date.now()) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return false;
  return timestamp <= Number(now) + 60_000 && Number(now) - timestamp <= STAFF_LOGIN_FRESH_MS;
}

export function serializeBotActor(row, options = {}) {
  if (!row || row.status !== "active" || !getBotPermissions(row.role).includes("team:view:self")) return null;
  const discordUserId = String(row.discord_user_id || "");
  if (!/^\d{8,32}$/.test(discordUserId)) return null;
  const lastLoginAt = row.last_login_at || null;
  const staffLoginFresh = isRecentWebsiteLogin(lastLoginAt, options.now ?? Date.now());
  return {
    id: Number(row.id),
    discordUserId,
    username: String(row.username || ""),
    displayName: String(row.global_name || row.username || discordUserId),
    avatarHash: String(row.avatar_hash || ""),
    role: String(row.role || ""),
    permissions: getBotPermissions(row.role),
    active: true,
    lastLoginAt,
    staffLoginFresh,
    updatedAt: row.updated_at || null
  };
}
