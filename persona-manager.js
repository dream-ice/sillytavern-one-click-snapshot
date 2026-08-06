/**
 * 用户角色管理增强 / Persona management
 *
 * Adds tags, folders, favorites, bulk editing and extra sort orders to the
 * native Persona Management panel without patching SillyTavern itself.
 *
 * Everything hooks into stock extension points:
 * - `personasFilter.filterFunctions` for filtering and custom ordering
 * - `printTagList({ tags })` + `removeAction` for tag chips that are NOT
 *   backed by `tag_map`, so persona tags never leak into the character list
 * - a MutationObserver on `#user_avatar_block` for card decoration
 *
 * Persona tags reference SillyTavern's global `tags` array by id, so colors,
 * folder types and the shared Tag Management dialog all keep working. Only
 * the persona -> tag assignment lives in this extension's settings.
 */
import { chat, characters, chat_metadata, eventSource, event_types, getRequestHeaders, getThumbnailUrl, printCharactersDebounced, saveMetadata, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { groups, selected_group } from '../../../group-chats.js';
import { power_user } from '../../../power-user.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { renderTemplateAsync } from '../../../templates.js';
import { buildPersonaAvatarList, getConnectedPersonas, getUserAvatars, personasFilter, setUserAvatar, user_avatar } from '../../../personas.js';
import { TAG_FOLDER_DEFAULT_TYPE, TAG_FOLDER_TYPES, appendTagToList, applyCharacterTagsToMessageDivs, compareTagsForSort, printTagList, sortTags, tag_map, tags } from '../../../tags.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../popup.js';
import { uuidv4 } from '../../../utils.js';

/** Key of the persona state inside this extension's settings object. */
const STATE_KEY = 'personaManager';

/**
 * Sort orders this module adds to the native `#persona_sort_order` select.
 * The `ocs-` prefix keeps them from colliding with anything SillyTavern may
 * add later, since the choice is persisted into `power_user.persona_sort_order`.
 */
const SORT_ORDERS = {
    'ocs-newest': '最新',
    'ocs-oldest': '最旧',
    'ocs-favorites': '收藏夹',
    'ocs-recent': '最近使用',
    'ocs-most-used': '最多聊天',
    'ocs-least-used': '最少聊天',
    'ocs-most-tokens': '最多Token',
    'ocs-least-tokens': '最少Token',
    'ocs-random': '随机',
};

/** Orders that need the chat-layer counts to have been scanned at least once. */
const USAGE_ORDERS = new Set(['ocs-most-used', 'ocs-least-used']);

/** Orders that need persona description token counts. */
const TOKEN_ORDERS = new Set(['ocs-most-tokens', 'ocs-least-tokens']);

/** Concurrent chat reads during a scan. Matches what other chat-scanning extensions use. */
const SCAN_CONCURRENCY = 3;

const FILTER_STATE = {
    UNDEFINED: 'UNDEFINED',
    SELECTED: 'SELECTED',
    EXCLUDED: 'EXCLUDED',
};

/** @type {(() => object)|null} Accessor for the extension settings root, injected by index.js. */
let settingsAccessor = null;

/** @type {MutationObserver|null} */
let listObserver = null;
let decorating = false;
let decorateQueued = false;

/** Master switch, mirrored from the settings panel so hooks can go inert. */
let managerEnabled = true;

/** Transient view state. Not persisted: filters should not survive a reload. */
let folderTagId = null;
let favoriteFilter = FILTER_STATE.UNDEFINED;
let folderFilter = FILTER_STATE.UNDEFINED;
const selectedTagIds = new Set();
const excludedTagIds = new Set();

let bulkMode = false;
const bulkSelection = new Set();

/** Avatar files whose timestamps have already been fetched this session. */
const timestampsProbed = new Set();

/** @type {Promise<boolean>|null} In-flight archive scan, so it never runs twice at once. */
let usageScanPromise = null;

function state() {
    const root = settingsAccessor();
    root[STATE_KEY] ??= {};
    const value = root[STATE_KEY];
    value.meta ??= {};
    value.showTagFilters ??= false;
    value.pinCurrent ??= true;
    value.usage ??= { completedAt: 0, counts: {} };
    value.usage.counts ??= {};
    return value;
}

/**
 * Returns the stored metadata for a persona, creating it on first sight.
 * @param {string} avatarId Persona avatar file name
 * @returns {{createdAt: number, updatedAt: number, lastUsedAt: number, favorite: boolean, tags: string[]}}
 */
function meta(avatarId) {
    const store = state().meta;
    store[avatarId] ??= {
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        favorite: false,
        tags: [],
    };
    const value = store[avatarId];
    if (!Array.isArray(value.tags)) value.tags = [];
    value.useCount ??= 0;
    value.messageCount ??= Number(state().usage.counts[avatarId]) || 0;
    return value;
}

function knownPersonaIds() {
    return Object.keys(power_user.personas ?? {});
}

/**
 * Drops metadata for personas that no longer exist. A persona deleted outside
 * this extension would otherwise keep its tags alive in the filter row.
 */
function pruneOrphanedMeta() {
    const store = state().meta;
    const alive = new Set(knownPersonaIds());
    const orphans = Object.keys(store).filter(avatarId => !alive.has(avatarId));
    if (!orphans.length) return;

    for (const avatarId of orphans) delete store[avatarId];
    saveSettingsDebounced();
}

/**
 * Reads a persona avatar's file timestamp from the static file route.
 * `res.sendFile` sets Last-Modified, so existing personas get a meaningful
 * date without any server-side support.
 *
 * @param {string} avatarId Persona avatar file name
 * @returns {Promise<number>} Epoch milliseconds, or 0 when unavailable
 */
async function probeAvatarTimestamp(avatarId) {
    try {
        const response = await fetch(`/User%20Avatars/${encodeURIComponent(avatarId)}`, { method: 'HEAD' });
        if (!response.ok) return 0;
        const lastModified = response.headers.get('Last-Modified');
        const parsed = lastModified ? Date.parse(lastModified) : NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}

/**
 * Seeds timestamps for personas we have not seen before. Runs once per avatar
 * per session and falls back to "now" when the file cannot be probed, so sort
 * order stays stable instead of flapping.
 *
 * @param {string[]} avatarIds Persona avatar file names
 * @returns {Promise<boolean>} Whether anything was stored
 */
async function seedTimestamps(avatarIds) {
    const pending = avatarIds.filter(avatarId => !timestampsProbed.has(avatarId) && !meta(avatarId).createdAt);
    if (!pending.length) return false;

    for (const avatarId of pending) timestampsProbed.add(avatarId);
    const probed = await Promise.all(pending.map(probeAvatarTimestamp));

    pending.forEach((avatarId, index) => {
        const timestamp = probed[index] || Date.now();
        const record = meta(avatarId);
        record.createdAt = timestamp;
        record.updatedAt ||= timestamp;
        record.lastUsedAt ||= timestamp;
    });
    return true;
}

function touchPersona(avatarId, { used = false } = {}) {
    if (!avatarId || !power_user.personas?.[avatarId]) return;
    const record = meta(avatarId);
    if (used) {
        record.lastUsedAt = Date.now();
        record.useCount = Number(record.useCount || 0) + 1;
    } else {
        record.updatedAt = Date.now();
    }
    saveSettingsDebounced();
}

/* ----------------------------------------------------------- usage counts -- */

/**
 * Resolves which persona a saved user message was sent as.
 * @param {object} message A chat message object
 * @returns {string|null} Persona avatar file name
 */
function personaFromMessage(message) {
    if (!message?.is_user || typeof message.force_avatar !== 'string' || !message.force_avatar) return null;

    try {
        const url = new URL(message.force_avatar, window.location.origin);
        if (url.pathname.endsWith('/thumbnail') && url.searchParams.get('type') === 'persona') {
            const avatarId = url.searchParams.get('file');
            return avatarId && power_user.personas?.[avatarId] ? avatarId : null;
        }
        // Only the dedicated User Avatars path counts, so a same-named
        // character avatar can never be mistaken for a persona.
        const decoded = decodeURIComponent(message.force_avatar).split(/[?#]/, 1)[0];
        return knownPersonaIds().find(avatarId => decoded.endsWith(`/User Avatars/${avatarId}`)) ?? null;
    } catch {
        return null;
    }
}

/**
 * Reads one chat file as raw JSONL.
 *
 * Uses `/api/chats/export`, which is a plain `readFileSync` guarded by an
 * existence check. `/api/chats/get` would be the more obvious endpoint but it
 * creates the character's chat directory when missing, and a scan has no
 * business writing anything into the chat archive.
 *
 * @param {{file: string, isGroup: boolean, avatarUrl?: string}} target Chat to read
 * @returns {Promise<string|null>} Raw JSONL, or null when unreadable
 */
async function readChatFile({ file, isGroup, avatarUrl }) {
    try {
        const response = await fetch('/api/chats/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                file,
                avatar_url: avatarUrl ?? '',
                is_group: isGroup,
                format: 'jsonl',
                exportfilename: file,
            }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data?.result === 'string' ? data.result : null;
    } catch {
        return null;
    }
}

/**
 * Lists every saved chat without reading any of it.
 * @returns {Promise<Array<{file: string, isGroup: boolean, avatarUrl?: string}>>}
 */
async function listAllChats() {
    const targets = [];

    for (const character of characters ?? []) {
        if (!character?.avatar) continue;
        try {
            const response = await fetch('/api/characters/chats', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
            });
            if (!response.ok) continue;
            const data = await response.json();
            // A character with no chat directory answers `{ error: true }`.
            if (!Array.isArray(data)) continue;
            for (const entry of data) {
                if (entry?.file_name) targets.push({ file: entry.file_name, isGroup: false, avatarUrl: character.avatar });
            }
        } catch {
            // A single unreadable character must not abort the whole scan.
        }
    }

    for (const group of groups ?? []) {
        for (const chatId of group?.chats ?? []) {
            targets.push({ file: `${chatId}.jsonl`, isGroup: true });
        }
    }

    return targets;
}

/**
 * Counts user-message layers per persona across the whole archive.
 * Read-only: it lists chat files and reads them, and writes nothing.
 *
 * @returns {Promise<boolean>} Whether the counts were refreshed
 */
async function scanUsageCounts() {
    if (usageScanPromise) return usageScanPromise;

    usageScanPromise = (async () => {
        const toast = toastr.info('正在扫描聊天记录统计用户角色的消息层数……', '用户角色管理', { timeOut: 0, extendedTimeOut: 0 });
        try {
            const targets = await listAllChats();
            const counts = Object.create(null);

            for (let index = 0; index < targets.length; index += SCAN_CONCURRENCY) {
                const batch = targets.slice(index, index + SCAN_CONCURRENCY);
                const contents = await Promise.all(batch.map(readChatFile));

                for (const raw of contents) {
                    if (!raw) continue;
                    for (const line of raw.split('\n')) {
                        if (!line.trim()) continue;
                        let message = null;
                        try {
                            message = JSON.parse(line);
                        } catch {
                            continue; // Keep scanning past a malformed line.
                        }
                        const avatarId = personaFromMessage(message);
                        if (avatarId) counts[avatarId] = (counts[avatarId] || 0) + 1;
                    }
                }
            }

            const usage = state().usage;
            usage.counts = { ...counts };
            usage.completedAt = Date.now();
            for (const avatarId of knownPersonaIds()) meta(avatarId).messageCount = Number(counts[avatarId]) || 0;
            saveSettingsDebounced();

            toastr.success(`已扫描 ${targets.length} 个聊天文件。`, '用户角色管理');
            return true;
        } catch (error) {
            console.error('[One-click Snapshot] persona usage scan failed', error);
            toastr.error('扫描聊天记录失败。', '用户角色管理');
            return false;
        } finally {
            toastr.clear(toast);
            usageScanPromise = null;
        }
    })();

    return usageScanPromise;
}

/**
 * Keeps the counts current after the one-off scan, so switching sort order
 * never triggers another pass over the archive.
 * @param {object} message A freshly rendered user message
 */
function countNewMessage(message) {
    const usage = state().usage;
    if (!Number(usage.completedAt)) return;

    const avatarId = personaFromMessage(message);
    if (!avatarId) return;

    usage.counts[avatarId] = (Number(usage.counts[avatarId]) || 0) + 1;
    const record = meta(avatarId);
    record.messageCount = usage.counts[avatarId];
    record.lastUsedAt = Date.now();
    saveSettingsDebounced();
}

/* ---------------------------------------------------------- token counts -- */

/**
 * Cheap 32-bit string fingerprint. Used to notice that a persona description
 * changed without keeping a copy of the text in settings.json, which is
 * already large enough without duplicating every persona's prose.
 *
 * @param {string} text Text to fingerprint
 * @returns {number}
 */
function fingerprint(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
    }
    // Fold the length in so same-hash texts of different lengths still differ.
    return (hash ^ text.length) >>> 0;
}

function personaDescription(avatarId) {
    return String(power_user.persona_descriptions?.[avatarId]?.description ?? '');
}

/**
 * Refreshes the cached description token count for one persona.
 * @param {string} avatarId Persona avatar file name
 * @returns {Promise<boolean>} Whether the stored count changed
 */
async function refreshTokenCount(avatarId) {
    const description = personaDescription(avatarId);
    const stamp = fingerprint(description);
    const record = meta(avatarId);
    if (record.tokenStamp === stamp) return false;

    // Same tokenizer the persona panel's own counter uses, so the sort agrees
    // with the number shown under the description box.
    const count = description ? await getTokenCountAsync(description) : 0;
    record.tokenCount = Number(count) || 0;
    record.tokenStamp = stamp;
    return true;
}

/**
 * Makes sure every persona has a current token count before a token sort runs.
 * @returns {Promise<boolean>} Whether anything changed
 */
async function ensureTokenCounts() {
    let changed = false;
    for (const avatarId of knownPersonaIds()) {
        if (await refreshTokenCount(avatarId)) changed = true;
    }
    if (changed) saveSettingsDebounced();
    return changed;
}

/* ------------------------------------------------------------------ tags -- */

/**
 * Returns the global tag objects assigned to a persona, dropping references to
 * tags that were deleted in Tag Management since the last render.
 * @param {string} avatarId Persona avatar file name
 * @returns {object[]}
 */
function personaTags(avatarId) {
    const assigned = meta(avatarId).tags;
    const resolved = assigned.map(tagId => tags.find(tag => tag.id === tagId)).filter(Boolean);
    if (resolved.length !== assigned.length) {
        meta(avatarId).tags = resolved.map(tag => tag.id);
        saveSettingsDebounced();
    }
    return resolved;
}

function personaTagIds(avatarId) {
    return personaTags(avatarId).map(tag => tag.id);
}

/**
 * Applies a tag deletion to persona assignments. Personas keep their tags
 * outside `tag_map`, so nothing else cleans up after them.
 *
 * @param {string} tagId Deleted tag id
 * @param {string|null} mergeTagId Tag the deleted one was merged into, if any
 */
function onGlobalTagDeleted(tagId, mergeTagId) {
    let changed = false;

    for (const avatarId of knownPersonaIds()) {
        const record = meta(avatarId);
        if (!record.tags.includes(tagId)) continue;

        record.tags = record.tags.filter(id => id !== tagId);
        if (mergeTagId && !record.tags.includes(mergeTagId)) record.tags.push(mergeTagId);
        changed = true;
    }

    selectedTagIds.delete(tagId);
    excludedTagIds.delete(tagId);
    if (folderTagId === tagId) folderTagId = mergeTagId ?? null;

    if (changed) saveSettingsDebounced();
    refreshDetailPane();
    refreshFilterUi();
}

function addPersonaTag(avatarId, tagId) {
    const assigned = meta(avatarId).tags;
    if (assigned.includes(tagId)) return false;
    assigned.push(tagId);
    touchPersona(avatarId);
    return true;
}

function removePersonaTag(avatarId, tagId) {
    const record = meta(avatarId);
    const next = record.tags.filter(id => id !== tagId);
    if (next.length === record.tags.length) return false;
    record.tags = next;
    touchPersona(avatarId);
    return true;
}

/**
 * Creates a global tag, mirroring SillyTavern's own `newTag` defaults so the
 * result is indistinguishable from a tag created in Tag Management.
 * @param {string} tagName Tag name
 * @returns {object} The new or pre-existing tag
 */
function createGlobalTag(tagName) {
    const existing = tags.find(tag => tag.name.toLowerCase() === tagName.toLowerCase());
    if (existing) return existing;

    const tag = {
        id: uuidv4(),
        name: tagName,
        folder_type: TAG_FOLDER_DEFAULT_TYPE,
        filter_state: FILTER_STATE.UNDEFINED,
        sort_order: Math.max(0, ...tags.map(item => Number(item.sort_order) || 0)) + 1,
        is_hidden_on_character_card: false,
        color: '',
        color2: '',
        create_date: Date.now(),
    };
    tags.push(tag);
    saveSettingsDebounced();
    return tag;
}

/** Tags configured as folders. Personas honour the same bogus-folder setting as characters. */
function folderTags() {
    if (!power_user.bogus_folders) return [];
    return tags.filter(tag => tag.folder_type && tag.folder_type !== TAG_FOLDER_DEFAULT_TYPE);
}

/* --------------------------------------------------------------- ordering -- */

function currentSortOrder() {
    return String(power_user.persona_sort_order ?? '');
}

function isCustomOrder() {
    return Object.hasOwn(SORT_ORDERS, currentSortOrder());
}

function compareByOrder(a, b) {
    const aMeta = meta(a);
    const bMeta = meta(b);
    const aName = String(power_user.personas[a] || a);
    const bName = String(power_user.personas[b] || b);

    switch (currentSortOrder()) {
        // Creation time, not last edit: rewording a persona must not move it.
        case 'ocs-newest':
            return (bMeta.createdAt || 0) - (aMeta.createdAt || 0) || aName.localeCompare(bName);
        case 'ocs-oldest':
            return (aMeta.createdAt || 0) - (bMeta.createdAt || 0) || aName.localeCompare(bName);
        case 'ocs-favorites':
            return Number(Boolean(bMeta.favorite)) - Number(Boolean(aMeta.favorite)) || aName.localeCompare(bName);
        case 'ocs-recent':
            return (bMeta.lastUsedAt || 0) - (aMeta.lastUsedAt || 0) || aName.localeCompare(bName);
        case 'ocs-most-used':
            return (bMeta.messageCount || 0) - (aMeta.messageCount || 0)
                || (bMeta.lastUsedAt || bMeta.updatedAt || 0) - (aMeta.lastUsedAt || aMeta.updatedAt || 0)
                || aName.localeCompare(bName);
        case 'ocs-least-used':
            return (aMeta.messageCount || 0) - (bMeta.messageCount || 0)
                || (aMeta.lastUsedAt || aMeta.updatedAt || 0) - (bMeta.lastUsedAt || bMeta.updatedAt || 0)
                || aName.localeCompare(bName);
        case 'ocs-most-tokens':
            return (bMeta.tokenCount || 0) - (aMeta.tokenCount || 0) || aName.localeCompare(bName);
        case 'ocs-least-tokens':
            return (aMeta.tokenCount || 0) - (bMeta.tokenCount || 0) || aName.localeCompare(bName);
        default:
            return aName.localeCompare(bName);
    }
}

/**
 * Shuffles in place. A `Math.random() - 0.5` comparator is the obvious way to
 * write this and is badly biased, so use a real Fisher-Yates pass instead.
 * @param {string[]} items Persona avatar file names
 * @returns {string[]} The same array, shuffled
 */
function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

/* ----------------------------------------------------------------- filter -- */

/**
 * Filters and orders the persona list. Installed into `personasFilter` so it
 * runs inside SillyTavern's own `applyFilters` call.
 *
 * When one of our sort orders is active the result carries an own `sort`
 * method that keeps the order we just applied. SillyTavern's `sortPersonas`
 * would otherwise re-sort by name right after this returns. Plain arrays are
 * returned for the built-in A-Z / Z-A / search orders so those keep working.
 *
 * @param {string[]} avatarIds Persona avatar file names
 * @returns {string[]}
 */
function filterPersonas(avatarIds) {
    if (!managerEnabled) return avatarIds;
    let result = [...avatarIds];

    // The pinned cards render these above the list, so drop them here to avoid
    // duplicates. Filters run before SillyTavern sorts, so this holds for every
    // sort order, including the built-in A-Z / Z-A / search.
    const pinned = new Set(pinnedPersonaIds().ids);
    if (pinned.size) result = result.filter(avatarId => !pinned.has(avatarId));

    if (selectedTagIds.size) {
        result = result.filter(avatarId => {
            const assigned = personaTagIds(avatarId);
            return [...selectedTagIds].every(tagId => assigned.includes(tagId));
        });
    }
    if (excludedTagIds.size) {
        result = result.filter(avatarId => {
            const assigned = personaTagIds(avatarId);
            return ![...excludedTagIds].some(tagId => assigned.includes(tagId));
        });
    }
    if (favoriteFilter === FILTER_STATE.SELECTED) result = result.filter(avatarId => meta(avatarId).favorite === true);
    if (favoriteFilter === FILTER_STATE.EXCLUDED) result = result.filter(avatarId => meta(avatarId).favorite !== true);

    if (folderTagId) {
        // Inside a folder only its members are listed.
        result = result.filter(avatarId => personaTagIds(avatarId).includes(folderTagId));
    } else {
        // At the top level, members of closed folders are represented by the
        // folder tile instead of their own card.
        const closed = new Set(folderTags()
            .filter(tag => TAG_FOLDER_TYPES[tag.folder_type] === TAG_FOLDER_TYPES.CLOSED)
            .map(tag => tag.id));
        if (closed.size) result = result.filter(avatarId => !personaTagIds(avatarId).some(tagId => closed.has(tagId)));
        if (folderFilter === FILTER_STATE.SELECTED) {
            // "Only folders": the cards are hidden, the folder row stays.
            result = [];
        }
    }

    if (!isCustomOrder()) return result;

    if (currentSortOrder() === 'ocs-random') shuffle(result);
    else result.sort(compareByOrder);
    return Object.assign(result, { sort() { return this; } });
}

function refreshList() {
    void getUserAvatars(true, user_avatar);
}

function refreshFilterUi() {
    renderFilterRow();
    refreshList();
}

function clearFilters() {
    selectedTagIds.clear();
    excludedTagIds.clear();
    favoriteFilter = FILTER_STATE.UNDEFINED;
    folderFilter = FILTER_STATE.UNDEFINED;
    folderTagId = null;
}

function nextFilterState(current) {
    if (current === FILTER_STATE.UNDEFINED) return FILTER_STATE.SELECTED;
    if (current === FILTER_STATE.SELECTED) return FILTER_STATE.EXCLUDED;
    return FILTER_STATE.UNDEFINED;
}

function applyChipState(chip, chipState) {
    chip.attr('data-toggle-state', chipState)
        .toggleClass('selected', chipState === FILTER_STATE.SELECTED)
        .toggleClass('excluded', chipState === FILTER_STATE.EXCLUDED);
}

/* --------------------------------------------------------------- rendering -- */

/**
 * Brings our entries in the native sort select in line with the feature switch.
 *
 * They are removed rather than hidden or disabled: `display: none` on an
 * `<option>` does nothing in Safari, and a disabled entry still occupies the
 * list looking like something the user failed to click.
 *
 * @param {JQuery<HTMLElement>} [sortSelect] Defaults to the native select
 */
function syncSortOrders(sortSelect = $('#persona_sort_order')) {
    if (!sortSelect.length) return;

    sortSelect.find('option[value^="ocs-"]').remove();
    if (managerEnabled) {
        for (const [value, label] of Object.entries(SORT_ORDERS)) {
            sortSelect.append($('<option></option>').attr('value', value).text(label));
        }
    }
    // One of our orders is only selectable while our entries are present. Fall
    // back to A-Z whenever the stored one is no longer in the list, which also
    // covers an order left behind by an older or different install.
    if (!sortSelect.find(`option[value="${CSS.escape(currentSortOrder())}"]`).length) {
        power_user.persona_sort_order = 'asc';
    }
    sortSelect.val(currentSortOrder());
}

/** Injects the toolbar buttons, filter row and folder row once. */
function installPanelChrome() {
    const sortSelect = $('#persona_sort_order');
    // Keyed on the filter row this function creates below, not on our sort
    // entries: those come and go with the feature switch.
    if (!sortSelect.length || $('#ocs_persona_tag_controls').length) return;

    syncSortOrders(sortSelect);

    // Re-sorting must not silently reuse a stale archive scan, so the select
    // triggers the first scan itself and the button forces a fresh one.
    sortSelect.on('input.ocsPersonaManager', () => {
        const order = currentSortOrder();
        if (TOKEN_ORDERS.has(order)) {
            void ensureTokenCounts().then(changed => changed && refreshList());
            return;
        }
        if (!USAGE_ORDERS.has(order) || Number(state().usage.completedAt)) return;
        void scanUsageCounts().then(refreshList);
    });

    $('#persona_grid_toggle').after(
        '<i id="ocs_persona_usage_refresh" class="fa-solid fa-arrows-rotate menu_button" title="重新扫描聊天记录，更新用户角色的消息层数"></i>' +
        '<i id="ocs_persona_bulk_edit" class="fa-solid fa-pen-to-square menu_button" title="批量编辑用户角色"></i>' +
        '<div id="ocs_persona_bulk_count" class="paginationjs-nav"></div>' +
        // Same order as the character context menu: 收藏 / 标签 / 复制, then the trash.
        '<i id="ocs_persona_bulk_all" class="fa-solid fa-check-double menu_button" title="全选当前页" style="display:none;"></i>' +
        '<i id="ocs_persona_bulk_favorite" class="fa-solid fa-star menu_button" title="收藏 / 取消收藏选中的用户角色" style="display:none;"></i>' +
        '<i id="ocs_persona_bulk_tag" class="fa-solid fa-tags menu_button" title="给选中的用户角色批量打标签" style="display:none;"></i>' +
        '<i id="ocs_persona_bulk_duplicate" class="fa-solid fa-clone menu_button" title="复制选中的用户角色" style="display:none;"></i>' +
        '<i id="ocs_persona_bulk_delete" class="fa-solid fa-trash menu_button red_button" title="删除选中的用户角色" style="display:none;"></i>',
    );

    $('#user_avatar_block').before(
        '<div id="ocs_persona_tag_controls" class="rm_tag_controls"><div id="ocs_persona_tag_filter" class="tags"></div></div>' +
        '<div id="ocs_persona_folders" class="ocs-persona-folders"></div>',
    );

    $('#ocs_persona_usage_refresh').on('click', () => void scanUsageCounts().then(refreshList));
    $('#ocs_persona_bulk_edit').on('click', toggleBulkMode);
    $('#ocs_persona_bulk_all').on('click', selectAllVisible);
    $('#ocs_persona_bulk_favorite').on('click', toggleSelectedPersonaFavorites);
    $('#ocs_persona_bulk_tag').on('click', () => void editSelectedPersonaTags());
    $('#ocs_persona_bulk_duplicate').on('click', () => void duplicateSelectedPersonas());
    $('#ocs_persona_bulk_delete').on('click', () => void deleteSelectedPersonas());

    renderFilterRow();
}

/** Renders the action buttons and tag chips above the persona list. */
function renderFilterRow() {
    const container = $('#ocs_persona_tag_filter');
    if (!container.length) return;
    container.empty();

    const showChips = state().showTagFilters === true;

    const appendAction = (tag, chipState, action) => {
        const chip = $('<span class="tag actionable interactable" tabindex="0"><span class="tag_name"></span></span>');
        chip.attr('id', tag.id).css({ 'background-color': tag.color, color: tag.color2 });
        chip.find('.tag_name').addClass(tag.icon).attr('title', tag.name);
        applyChipState(chip, chipState);
        chip.on('click', action);
        container.append(chip);
    };

    appendAction({ id: 'ocs-filter-fav', name: '只看收藏', color: 'rgba(255, 255, 0, 0.5)', icon: 'fa-solid fa-star' },
        favoriteFilter, () => {
            favoriteFilter = nextFilterState(favoriteFilter);
            refreshFilterUi();
        });

    appendAction({ id: 'ocs-filter-folder', name: power_user.bogus_folders ? '只看文件夹' : '启用标签文件夹', color: 'rgba(120, 120, 120, 0.5)', icon: 'fa-solid fa-folder-plus' },
        folderFilter, () => {
            if (!power_user.bogus_folders) {
                $('#bogus_folders').prop('checked', true).trigger('input');
                refreshFilterUi();
                return;
            }
            folderFilter = nextFilterState(folderFilter);
            folderTagId = null;
            refreshFilterUi();
        });

    // `.tags_view` is SillyTavern's delegated opener for Tag Management.
    const manage = $('<span class="tag actionable interactable tags_view" tabindex="0"><span class="tag_name fa-solid fa-gear" title="管理标签"></span></span>');
    manage.css({ 'background-color': 'rgba(150, 100, 100, 0.5)' });
    container.append(manage);

    appendAction({ id: 'ocs-filter-list', name: '展开标签筛选', color: 'rgba(150, 100, 100, 0.5)', icon: 'fa-solid fa-tags' },
        showChips ? FILTER_STATE.SELECTED : FILTER_STATE.UNDEFINED, () => {
            state().showTagFilters = !showChips;
            saveSettingsDebounced();
            renderFilterRow();
        });

    const pinned = state().pinCurrent !== false;
    appendAction({ id: 'ocs-filter-pin', name: pinned ? '绑定 / 默认的用户已置顶，点击取消' : '把绑定 / 默认的用户置顶', color: 'rgba(150, 100, 100, 0.5)', icon: 'fa-solid fa-thumbtack' },
        pinned ? FILTER_STATE.SELECTED : FILTER_STATE.UNDEFINED, () => {
            state().pinCurrent = !pinned;
            saveSettingsDebounced();
            refreshFilterUi();
        });

    appendAction({ id: 'ocs-filter-clear', name: '清除所有筛选', color: 'transparent', icon: 'fa-solid fa-filter-circle-xmark' },
        FILTER_STATE.UNDEFINED, () => {
            clearFilters();
            refreshFilterUi();
        });

    if (!showChips) return;

    // Only tags actually assigned to a persona. Folder tags used to be listed
    // unconditionally, which surfaced tags that exist purely on the character
    // side and kept showing a tag after it had been cleared off every persona.
    const usedTagIds = new Set(knownPersonaIds().flatMap(personaTagIds));
    const chipTags = tags.filter(tag => usedTagIds.has(tag.id)).sort(compareTagsForSort);

    for (const tag of chipTags) {
        const chipState = selectedTagIds.has(tag.id) ? FILTER_STATE.SELECTED
            : excludedTagIds.has(tag.id) ? FILTER_STATE.EXCLUDED
                : FILTER_STATE.UNDEFINED;
        const chip = $('<span class="tag interactable" tabindex="0"><span class="tag_name"></span></span>');
        chip.attr('id', tag.id).css({ 'background-color': tag.color, color: tag.color2 });
        chip.find('.tag_name').text(tag.name);
        chip.attr('title', `${tag.name}\n\n点一下包含 · 再点排除 · 第三下清除`);
        applyChipState(chip, chipState);
        chip.on('click', () => {
            const next = nextFilterState(chipState);
            selectedTagIds.delete(tag.id);
            excludedTagIds.delete(tag.id);
            if (next === FILTER_STATE.SELECTED) selectedTagIds.add(tag.id);
            if (next === FILTER_STATE.EXCLUDED) excludedTagIds.add(tag.id);
            folderTagId = null;
            refreshFilterUi();
        });
        container.append(chip);
    }
}

/**
 * Replicates SillyTavern's `getPersonaStates`, which is module-private. The
 * pinned card lives outside `#user_avatar_block`, so `updatePersonaUIStates`
 * never reaches it and these badges have to be applied here.
 *
 * @param {string} avatarId Persona avatar file name
 */
function applyPersonaStateClasses(card, avatarId) {
    const connections = power_user.persona_descriptions?.[avatarId]?.connections;
    const hasCharLock = Boolean(connections?.some(connection =>
        (!selected_group && connection.type === 'character' && connection.id === characters[Number(this_chid)]?.avatar)
        || (selected_group && connection.type === 'group' && connection.id === selected_group)));

    card.toggleClass('default_persona', power_user.default_persona === avatarId)
        .toggleClass('locked_to_chat', chat_metadata.persona == avatarId)
        .toggleClass('locked_to_character', hasCharLock)
        .toggleClass('selected', avatarId === user_avatar);
}

/**
 * The personas to keep at the top of the list, most specific binding first.
 *
 * Deliberately the ones *bound to what you are doing now*, not the one merely
 * selected: the point is to still reach the persona a character is linked to
 * after switching away to crib from an older one. Each step down keeps the row
 * useful for people who use fewer of SillyTavern's binding features.
 *
 * @returns {{ids: string[], label: string}}
 */
function pinnedPersonaIds() {
    if (state().pinCurrent === false) return { ids: [], label: '' };

    const exists = avatarId => Boolean(avatarId) && Boolean(power_user.personas?.[avatarId]);

    // 1. Bound to this chat or this character — the most specific binding.
    const bound = new Set();
    if (exists(chat_metadata.persona)) bound.add(chat_metadata.persona);
    for (const avatarId of getConnectedPersonas() ?? []) {
        if (exists(avatarId)) bound.add(avatarId);
    }
    if (bound.size) return { ids: [...bound], label: '当前角色绑定' };

    // 2. The default persona, which is what a new chat would pick anyway.
    if (exists(power_user.default_persona)) return { ids: [power_user.default_persona], label: '默认用户' };

    // 3. Nothing configured at all: whatever is in use.
    if (exists(user_avatar)) return { ids: [user_avatar], label: '当前使用' };
    return { ids: [], label: '' };
}

/**
 * Pins the bound personas to the top of the list.
 *
 * Cards are prepended *inside* `#user_avatar_block` rather than into a
 * container of their own: that block is a `flex-wrap` row with its own padding,
 * and a card outside it loses that layout context — it overflows to the right
 * and its name gets ellipsed. Living inside also means every stock rule, the
 * grid view and any user theme scoped to `#user_avatar_block` still apply.
 *
 * They are not part of the paginated data, so no sort order can move them. The
 * filter drops the same personas from the list to avoid showing them twice.
 */
function renderCurrentPersonaRow() {
    const list = $('#user_avatar_block');
    list.find('.ocs-persona-current-label, .ocs-persona-current-card, .ocs-persona-current-sep').remove();
    if (!managerEnabled) return;

    const { ids, label: labelText } = pinnedPersonaIds();
    if (!ids.length) return;

    const cards = ids.map(avatarId => {
        const card = $('#user_avatar_template .avatar-container').clone().addClass('ocs-persona-current-card');
        card.attr('data-avatar-id', avatarId);
        card.find('.avatar').attr({ 'data-avatar-id': avatarId, title: avatarId });
        card.find('img').attr('src', getThumbnailUrl('persona', avatarId));
        card.find('.ch_name').text(power_user.personas[avatarId] || avatarId);
        card.find('.ch_additional_info').text(power_user.persona_descriptions?.[avatarId]?.title || '');
        card.find('.ch_description').text(power_user.persona_descriptions?.[avatarId]?.description || list.attr('no_desc_text') || '');
        applyPersonaStateClasses(card, avatarId);
        return card;
    });

    const label = $('<div class="ocs-persona-current-label"></div>').text(labelText);
    list.prepend(label, ...cards, $('<div class="ocs-persona-current-sep"></div>'));
}

/**
 * Renders the folder row above the persona list. Folders are deliberately not
 * part of the paginated card list: mixing them in is what made page counts and
 * "back" navigation inconsistent.
 */
function renderFolderRow() {
    const row = $('#ocs_persona_folders');
    if (!row.length) return;
    row.empty();

    if (folderTagId) {
        const tag = tags.find(item => item.id === folderTagId);
        const back = $('#bogus_folder_back_template .bogus_folder_select_back').clone();
        back.attr('id', 'ocs_persona_folder_back').find('.ch_name').text('返回');
        back.attr('title', tag ? `返回：${tag.name}` : '返回');
        back.on('click', () => {
            folderTagId = null;
            refreshFilterUi();
        });
        row.append(back);
        return;
    }

    if (folderFilter === FILTER_STATE.EXCLUDED) return;

    const personaIds = knownPersonaIds();
    for (const tag of folderTags()) {
        const members = personaIds.filter(avatarId => personaTagIds(avatarId).includes(tag.id));
        if (!members.length) continue;

        const folder = TAG_FOLDER_TYPES[tag.folder_type] ?? TAG_FOLDER_TYPES[TAG_FOLDER_DEFAULT_TYPE];
        const block = $('#bogus_folder_template .bogus_folder_select').clone();
        block.addClass(`ocs_persona_folder ${folder.class}`).attr({ tagid: tag.id, id: `OcsPersonaFolder${tag.id}` });
        block.find('.avatar').css({ 'background-color': tag.color, color: tag.color2 }).attr('title', `[文件夹] ${tag.name}`);
        block.find('.bogus_folder_icon').addClass(folder.fa_icon);
        block.find('.ch_name').text(tag.name).attr('title', `[文件夹] ${tag.name}`);
        block.find('.bogus_folder_counter').text(`${members.length} 个用户角色`);
        block.find('.bogus_folder_hidden_counter').empty();
        buildPersonaAvatarList(block.find('.bogus_folder_avatars_block'), members);
        block.on('click', () => {
            folderTagId = tag.id;
            folderFilter = FILTER_STATE.UNDEFINED;
            refreshFilterUi();
        });
        row.append(block);
    }
}

/**
 * Adds the favorite marker, bulk selection state and tag chips to one card.
 * @param {JQuery<HTMLElement>} card A `.avatar-container`
 * @param {string} avatarId Persona avatar file name
 */
function decorateCard(card, avatarId) {
    card.toggleClass('ocs-persona-fav', meta(avatarId).favorite === true);
    card.toggleClass('ocs-persona-selected', bulkSelection.has(avatarId));

    let chips = card.find('.ocs-persona-card-tags');
    if (!chips.length) {
        chips = $('<div class="ocs-persona-card-tags tags tags_inline"></div>');
        // Tags belong between the name and the title. The name block is a
        // nowrap flex row, so the stylesheet keeps the strip shrink-only
        // instead of letting it crush the name into an ellipsis.
        const title = card.find('.character_name_block .ch_additional_info').first();
        if (title.length) title.before(chips);
        else card.find('.character_name_block').append(chips);
    }
    printTagList(chips, { tags: personaTags(avatarId), empty: 'always', tagOptions: { isCharacterList: true } });
}

/**
 * Adds tag chips, the favorite marker and the bulk checkbox to persona cards
 * after SillyTavern has rendered them.
 */
function decorateCards() {
    const list = $('#user_avatar_block');
    if (!list.length) return;
    if (!managerEnabled) {
        // Everything this module injects into a card is removable, so turning
        // the feature off leaves the stock list behind without a reload.
        list.removeClass('ocs-persona-bulk-mode').find('.ocs-persona-card-tags').remove();
        list.find('.avatar-container').removeClass('ocs-persona-fav ocs-persona-selected');
        renderCurrentPersonaRow();
        return;
    }

    list.toggleClass('ocs-persona-bulk-mode', bulkMode);
    $('#ocs_persona_folders').toggleClass('ocs-persona-bulk-mode', bulkMode);
    pruneOrphanedMeta();

    // Add the pinned card first so the pass below decorates it like any other.
    renderCurrentPersonaRow();

    list.find('.avatar-container[data-avatar-id]').each((_, node) => {
        const card = $(node);
        const avatarId = String(card.attr('data-avatar-id'));
        if (avatarId && power_user.personas?.[avatarId]) decorateCard(card, avatarId);
    });

    renderFolderRow();
    updateBulkControls();
}

function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
        decorateQueued = false;
        if (decorating) return;
        decorating = true;
        listObserver?.disconnect();
        try {
            decorateCards();
        } finally {
            observeList();
            decorating = false;
        }
    });
}

function observeList() {
    const list = document.getElementById('user_avatar_block');
    if (!list || !listObserver) return;
    listObserver.observe(list, { childList: true });
}

/* ------------------------------------------------------- tag manager sync -- */

/**
 * Adds persona assignments to the entry counts in Tag Management.
 *
 * SillyTavern counts entries straight out of `tag_map`, which persona tags
 * deliberately stay out of, so a tag used only by personas would report zero.
 * The stock count is kept in a data attribute so repeated passes stay correct.
 *
 * @param {JQuery<HTMLElement>} root The `#tag_view_list` container
 */
function syncTagManagerCounts(root) {
    root.find('.tag_view_item[id]').each((_, node) => {
        const item = $(node);
        const counter = item.find('.tag_view_counter_value').first();
        if (!counter.length) return;

        if (item.attr('data-ocs-base-count') === undefined) {
            item.attr('data-ocs-base-count', counter.text().trim() || '0');
        }
        const tagId = String(item.attr('id'));
        const base = Number(item.attr('data-ocs-base-count')) || 0;
        const personaCount = knownPersonaIds().filter(avatarId => meta(avatarId).tags.includes(tagId)).length;

        // Only write on an actual change: this container is watched by the
        // observer that calls us, and an unconditional write would loop.
        const total = String(base + personaCount);
        if (counter.text() !== total) counter.text(total);
    });
}

/**
 * Watches Tag Management so persona counts stay right and so folder, rename,
 * visibility and delete actions taken there show up in the persona list
 * immediately instead of on the next reload.
 */
function installTagManagerSync() {
    let queued = false;
    const sync = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            const root = $('#tag_view_list');
            if (root.length) syncTagManagerCounts(root);
        });
    };

    new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });

    // These run after SillyTavern's own handlers, which are bound earlier.
    $(document).on('click.ocsPersonaTagManager', '#tag_view_list .eye-toggle, #tag_view_list .tag_as_folder, #tag_view_list .tag_view_create', () => {
        setTimeout(() => {
            sync();
            refreshFilterUi();
        }, 0);
    });
    $(document).on('input.ocsPersonaTagManager', '#tag_view_list .tag_view_name', () => {
        setTimeout(refreshFilterUi, 0);
    });
    // The bogus-folder master switch decides whether folders exist at all.
    $(document).on('input.ocsPersonaTagManager', '#bogus_folders', () => setTimeout(refreshFilterUi, 0));
}

/* ------------------------------------------------------------ tag delete -- */

/**
 * Runs the delete-tag flow in place of SillyTavern's own handler.
 *
 * Two reasons to own it rather than patch the app:
 * - the stock handler reads `$('#merge_tag_select').val()` *after* the popup
 *   has closed, by which point Select2 has torn its control down and a stale
 *   control from an earlier popup can match first, so the merge target is
 *   silently dropped and the tag is deleted without being merged;
 * - persona tags live outside `tag_map`, so they need the same delete/merge
 *   decision applied to them.
 *
 * @param {string} tagId Tag being deleted
 */
async function deleteTagWithMerge(tagId) {
    const tag = tags.find(candidate => candidate.id === tagId);
    if (!tag) return;

    const otherTags = sortTags(tags.filter(candidate => candidate.id !== tagId).map(candidate => ({ id: candidate.id, name: candidate.name })));
    // The template's root nodes include `<select id="merge_tag_select">` itself,
    // and `.find()` only walks descendants — so the obvious
    // `$(html).find('#merge_tag_select')` matches nothing at all. Wrapping the
    // template makes every lookup below actually resolve.
    const popupContent = $('<div></div>').append(await renderTemplateAsync('deleteTag', { otherTags }));
    const mergeSelect = popupContent.find('#merge_tag_select');
    appendTagToList(popupContent.find('#tag_to_delete'), tag);

    let mergeTagId = null;
    const resolveTag = value => (value ? tags.find(candidate => String(candidate.id) === String(value))?.id ?? null : null);
    mergeSelect.on('change', () => { mergeTagId = resolveTag(mergeSelect.val()); });

    // Deliberately a plain <select>. Select2 renders its dropdown into
    // document.body, and this popup is a native <dialog> opened with
    // showModal() — anything outside the top layer is inert, so the panel
    // opens where it cannot be clicked. Stock SillyTavern never actually
    // reached its own select2 call here, so the native control is also what
    // this dialog has always shown in practice.
    mergeSelect.val('');

    const result = await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, '', {
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            // Authoritative read, at the moment of confirmation: `onClosing`
            // runs before `#hide()`, so the dialog is still open and the
            // control still exists. Query the dialog rather than the document,
            // so a leftover `#merge_tag_select` elsewhere can never match.
            const live = /** @type {HTMLSelectElement?} */ (popup.dlg.querySelector('#merge_tag_select'));
            if (live) mergeTagId = resolveTag(live.value);
            return true;
        },
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    let mergedReferences = 0;
    for (const key of Object.keys(tag_map)) {
        if (!tag_map[key].some(x => String(x) === String(tagId))) continue;
        tag_map[key] = tag_map[key].filter(x => String(x) !== String(tagId));
        if (mergeTagId && !tag_map[key].some(x => String(x) === String(mergeTagId))) {
            tag_map[key].push(mergeTagId);
            mergedReferences++;
        }
    }

    const index = tags.findIndex(candidate => candidate.id === tagId);
    if (index !== -1) tags.splice(index, 1);
    $(`.tag[id="${tagId}"]`).remove();
    $(`.tag_view_item[id="${tagId}"]`).remove();

    const mergeName = mergeTagId ? tags.find(candidate => candidate.id === mergeTagId)?.name : null;
    toastr.success(`已删除「${tag.name}」${mergeName ? `，并合并到「${mergeName}」` : ''}`, '删除标签');
    console.info(`Tag '${tag.name}' merge completed`, { mergeTagId, mergedReferences });

    onGlobalTagDeleted(tagId, mergeTagId);
    printCharactersDebounced();
    saveSettingsDebounced();
    applyCharacterTagsToMessageDivs();
}

/** Takes over `.tag_delete` before SillyTavern's delegated handler can see it. */
function installTagDeleteOverride() {
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.tag_view_item .tag_delete');
        if (!button) return;

        const tagId = button.closest('.tag_view_item')?.getAttribute('id');
        if (!tagId) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        void deleteTagWithMerge(tagId);
    }, true);
}

/* -------------------------------------------------------------- bulk mode -- */

function updateBulkControls() {
    const count = bulkSelection.size;
    // Always show the number in bulk mode, zero included — this is what the
    // character list's `#bulkSelectedCount` does.
    $('#ocs_persona_bulk_count').text(String(count)).attr('title', `已选中 ${count} 个用户角色`).toggle(bulkMode);
    $('#ocs_persona_bulk_all, #ocs_persona_bulk_favorite, #ocs_persona_bulk_tag, #ocs_persona_bulk_duplicate, #ocs_persona_bulk_delete').toggle(bulkMode);
    $('#ocs_persona_bulk_edit').toggleClass('bulk_edit_overlay_active', bulkMode);
}

function toggleBulkMode() {
    bulkMode = !bulkMode;
    if (!bulkMode) bulkSelection.clear();
    scheduleDecorate();
}

function selectAllVisible() {
    const visible = $('#user_avatar_block .avatar-container[data-avatar-id]')
        .toArray()
        .map(node => String(node.getAttribute('data-avatar-id')))
        .filter(avatarId => power_user.personas?.[avatarId]);

    const allSelected = visible.length > 0 && visible.every(avatarId => bulkSelection.has(avatarId));
    for (const avatarId of visible) {
        if (allSelected) bulkSelection.delete(avatarId);
        else bulkSelection.add(avatarId);
    }
    scheduleDecorate();
}

/**
 * Toggles the favorite flag of every selected persona.
 * Matches `CharacterContextMenu.favorite`, which flips each entry on its own
 * rather than forcing the whole selection to one state.
 */
function toggleSelectedPersonaFavorites() {
    const avatarIds = [...bulkSelection].filter(avatarId => power_user.personas?.[avatarId]);
    if (!avatarIds.length) return toastr.info('请先选择至少一个用户角色。', '用户角色管理');

    for (const avatarId of avatarIds) {
        const record = meta(avatarId);
        record.favorite = !record.favorite;
        record.updatedAt = Date.now();
    }
    saveSettingsDebounced();
    refreshDetailPane();
    refreshFilterUi();
}

/**
 * Copies every selected persona, avatar file included.
 *
 * A persona is keyed by its avatar file name, so a real copy needs a new file:
 * the source image is re-uploaded through the stock avatar endpoint, which
 * mints a fresh name and leaves the original untouched.
 */
async function duplicateSelectedPersonas() {
    const avatarIds = [...bulkSelection].filter(avatarId => power_user.personas?.[avatarId]);
    if (!avatarIds.length) return toastr.info('请先选择至少一个用户角色。', '用户角色管理');

    const failed = [];
    let created = 0;

    for (const avatarId of avatarIds) {
        try {
            const image = await fetch(`/User%20Avatars/${encodeURIComponent(avatarId)}`);
            if (!image.ok) throw new Error(`HTTP ${image.status}`);

            const form = new FormData();
            form.append('avatar', await image.blob(), avatarId);
            const upload = await fetch('/api/avatars/upload', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: form,
            });
            if (!upload.ok) throw new Error(`HTTP ${upload.status}`);

            const newAvatarId = (await upload.json())?.path;
            if (!newAvatarId) throw new Error('missing path');

            const name = `${power_user.personas[avatarId]} - 副本`;
            const descriptor = structuredClone(power_user.persona_descriptions?.[avatarId] ?? {});
            // A copy has not been used anywhere yet. Carrying these over would
            // make it claim chat/character locks it never earned, and point at
            // version ids that belong to the original's avatar key.
            delete descriptor.connections;
            delete descriptor.extensions?.one_click_snapshot;

            power_user.personas[newAvatarId] = name;
            power_user.persona_descriptions[newAvatarId] = descriptor;

            const source = meta(avatarId);
            const copy = meta(newAvatarId);
            copy.tags = [...source.tags];
            copy.favorite = source.favorite;
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            copy.lastUsedAt = Date.now();
            copy.messageCount = 0;
            copy.useCount = 0;

            created++;
            await eventSource.emit(event_types.PERSONA_CREATED, {
                avatarId: newAvatarId,
                name,
                description: descriptor.description ?? '',
                title: descriptor.title ?? '',
            });
        } catch (error) {
            console.error('[One-click Snapshot] failed to duplicate persona', avatarId, error);
            failed.push(power_user.personas[avatarId] ?? avatarId);
        }
    }

    if (created) {
        saveSettingsDebounced();
        toastr.success(`已复制 ${created} 个用户角色。`, '用户角色管理');
    }
    if (failed.length) toastr.error(`这些用户角色复制失败：${failed.join('、')}`, '用户角色管理');

    bulkSelection.clear();
    bulkMode = false;
    refreshFilterUi();
}

/**
 * Bulk tag editor for the selected personas. Mirrors the semantics of
 * SillyTavern's own character bulk tag popup: adding applies to everyone in
 * the selection, and the chips shown are the tags they all share.
 */
async function editSelectedPersonaTags() {
    const avatarIds = [...bulkSelection].filter(avatarId => power_user.personas?.[avatarId]);
    if (!avatarIds.length) return toastr.info('请先选择至少一个用户角色。', '用户角色管理');

    // Mirrors SillyTavern's own character bulk tag popup (`#bulk_tag_popup`):
    // same heading, description, avatar strip, tag control and action row.
    const root = $('<div class="ocs-persona-bulk-tags"></div>');
    root.append($('<h3 class="marginBot5"></h3>').text(`修改 ${avatarIds.length} 个用户角色的标签`));
    root.append('<small class="bulk_tags_desc m-b-1">为所有选中的用户角色添加或移除共有标签。</small>');
    root.append('<div class="ocs-persona-bulk-tags-avatars avatars_inline avatars_inline_small tags tags_inline"></div><br>');
    root.append(
        '<div class="marginBot5">' +
        '<div class="tag_controls">' +
        '<input class="ocs-persona-bulk-tag-input text_pole tag_input wide100p margin0" placeholder="搜索 / 新建标签" />' +
        '<div class="tags_view menu_button fa-solid fa-tags" title="管理标签"></div>' +
        '</div>' +
        '<div class="ocs-persona-bulk-tag-list m-t-1 tags"></div>' +
        '</div>' +
        '<div class="ocs-persona-bulk-tags-actions m-t-1">' +
        '<div class="menu_button ocs-persona-bulk-tags-destructive ocs-persona-bulk-tags-clear" title="移除选中用户角色的全部标签"><i class="fa-solid fa-trash-can margin-right-10px"></i>全部</div>' +
        '<div class="menu_button ocs-persona-bulk-tags-destructive ocs-persona-bulk-tags-mutual" title="只移除它们共有的标签"><i class="fa-solid fa-trash-can margin-right-10px"></i>共有</div>' +
        '</div>',
    );

    buildPersonaAvatarList(root.find('.ocs-persona-bulk-tags-avatars'), avatarIds);

    /** Tags every selected persona has. */
    const mutualTags = () => {
        const [first, ...rest] = avatarIds;
        return personaTags(first).filter(tag => rest.every(avatarId => personaTagIds(avatarId).includes(tag.id)));
    };

    const repaint = () => {
        printTagList(root.find('.ocs-persona-bulk-tag-list'), {
            tags: mutualTags(),
            empty: 'always',
            tagOptions: {
                removable: true,
                removeAction: tag => {
                    for (const avatarId of avatarIds) removePersonaTag(avatarId, tag.id);
                    saveSettingsDebounced();
                    refreshFilterUi();
                    return true;
                },
            },
        });
    };

    const input = root.find('.ocs-persona-bulk-tag-input');
    const commit = (tagName) => {
        const name = String(tagName ?? '').trim();
        if (!name) return;
        const tag = createGlobalTag(name);
        for (const avatarId of avatarIds) addPersonaTag(avatarId, tag.id);
        saveSettingsDebounced();
        input.val('');
        repaint();
        refreshFilterUi();
    };

    // @ts-ignore jQuery UI is bundled by SillyTavern
    input.autocomplete({
        minLength: 0,
        source: (request, response) => {
            const assigned = new Set(mutualTags().map(tag => tag.id));
            const term = String(request.term ?? '').toLowerCase();
            response(tags
                .filter(tag => !assigned.has(tag.id) && tag.name.toLowerCase().includes(term))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(tag => ({ label: tag.name, value: tag.name })));
        },
        select: (event, ui) => {
            commit(ui.item.value);
            return false;
        },
    }).on('focus', function () {
        // @ts-ignore
        $(this).autocomplete('search', String($(this).val() ?? ''));
    }).on('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit($(this).val());
    });

    root.find('.ocs-persona-bulk-tags-clear').on('click', async () => {
        const confirmed = await Popup.show.confirm('移除全部标签', `确定移除这 ${avatarIds.length} 个用户角色的<b>全部</b>标签吗？`);
        if (!confirmed) return;
        for (const avatarId of avatarIds) {
            meta(avatarId).tags = [];
            touchPersona(avatarId);
        }
        saveSettingsDebounced();
        repaint();
        refreshFilterUi();
    });

    root.find('.ocs-persona-bulk-tags-mutual').on('click', async () => {
        const mutual = mutualTags();
        if (!mutual.length) return toastr.info('这些用户角色没有共有的标签。', '用户角色管理');
        const confirmed = await Popup.show.confirm('移除共有标签', `确定移除它们共有的 ${mutual.length} 个标签吗？各自独有的标签会保留。`);
        if (!confirmed) return;
        for (const avatarId of avatarIds) {
            for (const tag of mutual) removePersonaTag(avatarId, tag.id);
        }
        saveSettingsDebounced();
        repaint();
        refreshFilterUi();
    });

    repaint();
    await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    refreshDetailPane();
}

/**
 * Deletes every selected persona. Mirrors SillyTavern's own delete flow: the
 * avatar file goes first and the settings entries only follow a successful
 * response, so a failed request never orphans the persona list.
 */
async function deleteSelectedPersonas() {
    const avatarIds = [...bulkSelection].filter(avatarId => power_user.personas?.[avatarId]);
    if (!avatarIds.length) return;

    const names = avatarIds.map(avatarId => power_user.personas[avatarId]).join('、');
    const confirmed = await Popup.show.confirm(
        '删除用户角色',
        `确定删除这 ${avatarIds.length} 个用户角色吗？<br><br>${names}<br><br>与它们关联的用户设定信息会一并丢失。`,
    );
    if (!confirmed) return;

    const deleted = [];
    const failed = [];
    let defaultCleared = false;
    let lockCleared = false;

    for (const avatarId of avatarIds) {
        const name = power_user.personas[avatarId] ?? '';
        const response = await fetch('/api/avatars/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar: avatarId }),
        });
        if (!response.ok) {
            failed.push(name || avatarId);
            continue;
        }

        delete power_user.personas[avatarId];
        delete power_user.persona_descriptions[avatarId];
        delete state().meta[avatarId];

        if (avatarId === power_user.default_persona) {
            power_user.default_persona = null;
            defaultCleared = true;
        }
        if (avatarId === chat_metadata.persona) {
            delete chat_metadata.persona;
            lockCleared = true;
        }
        deleted.push(avatarId);
        await eventSource.emit(event_types.PERSONA_DELETED, { avatarId, name });
    }

    if (lockCleared) await saveMetadata();
    if (deleted.length) saveSettingsDebounced();
    if (defaultCleared) toastr.warning('默认用户角色已被删除，需要重新指定一个。', '用户角色管理');
    if (failed.length) toastr.error(`这些用户角色删除失败：${failed.join('、')}`, '用户角色管理');

    bulkSelection.clear();
    bulkMode = false;

    // The active persona may be gone. Switch to any remaining one so the
    // detail panel does not keep showing a deleted avatar.
    if (deleted.includes(user_avatar)) {
        const next = knownPersonaIds()[0];
        if (next) await setUserAvatar(next, { toastPersonaNameChange: false });
    }
    refreshFilterUi();
}

function onCardClickCapture(event) {
    if (!bulkMode) return;
    const card = event.target instanceof Element ? event.target.closest('#user_avatar_block .avatar-container[data-avatar-id]') : null;
    if (!card) return;

    const avatarId = String(card.getAttribute('data-avatar-id'));
    if (!power_user.personas?.[avatarId]) return;

    // In bulk mode a click selects instead of switching the active persona.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (bulkSelection.has(avatarId)) bulkSelection.delete(avatarId);
    else bulkSelection.add(avatarId);
    scheduleDecorate();
}

/* ----------------------------------------------------- persona detail pane -- */

/** Injects the favorite button and the tag editor into the persona detail pane. */
function installDetailPane() {
    if ($('#ocs_persona_favorite').length) return;

    $('#persona_rename_button').before('<div id="ocs_persona_favorite" class="menu_button fa-solid fa-star" title="收藏此用户角色"></div>');
    $('#ocs_persona_favorite').on('click', () => {
        if (!user_avatar || !power_user.personas?.[user_avatar]) return;
        const record = meta(user_avatar);
        record.favorite = !record.favorite;
        touchPersona(user_avatar);
        refreshDetailPane();
        refreshFilterUi();
    });

    const anchor = $('#persona_description').prevAll('h4').first();
    if (!anchor.length) return;

    anchor.before(
        '<div id="ocs_persona_tags" class="wide100p">' +
        '<div class="tag_controls">' +
        '<input id="ocs_persona_tag_input" class="text_pole textarea_compact wide100p margin0" placeholder="搜索 / 新建标签" />' +
        '<div class="menu_button fa-solid fa-tags tags_view" title="管理标签"></div>' +
        '</div>' +
        '<div id="ocs_persona_tag_list" class="tags"></div>' +
        '</div>',
    );

    installTagInput();
}

/**
 * Wires the tag autocomplete. Deliberately not SillyTavern's `createTagInput`,
 * which would write the selection straight into `tag_map`.
 */
function installTagInput() {
    const input = $('#ocs_persona_tag_input');

    const commit = (tagName) => {
        const name = String(tagName ?? '').trim();
        if (!name || !user_avatar || !power_user.personas?.[user_avatar]) return;
        const tag = createGlobalTag(name);
        if (addPersonaTag(user_avatar, tag.id)) {
            refreshDetailPane();
            refreshFilterUi();
        }
        input.val('');
    };

    // @ts-ignore jQuery UI is bundled by SillyTavern
    input.autocomplete({
        minLength: 0,
        source: (request, response) => {
            const assigned = new Set(user_avatar ? personaTagIds(user_avatar) : []);
            const term = String(request.term ?? '').toLowerCase();
            response(tags
                .filter(tag => !assigned.has(tag.id) && tag.name.toLowerCase().includes(term))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(tag => ({ label: tag.name, value: tag.name })));
        },
        select: (event, ui) => {
            commit(ui.item.value);
            return false;
        },
    }).on('focus', function () {
        // @ts-ignore
        $(this).autocomplete('search', String($(this).val() ?? ''));
    }).on('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit($(this).val());
    });
}

/** Repaints the favorite state and tag chips for the currently open persona. */
function refreshDetailPane() {
    const available = managerEnabled && Boolean(user_avatar && power_user.personas?.[user_avatar]);
    $('#ocs_persona_tags').toggle(available);
    $('#ocs_persona_favorite').toggle(available).toggleClass('ocs-persona-fav-on', available && meta(user_avatar).favorite === true);
    if (!available) return;

    printTagList($('#ocs_persona_tag_list'), {
        tags: personaTags(user_avatar),
        empty: 'always',
        tagOptions: {
            removable: true,
            removeAction: tag => {
                removePersonaTag(user_avatar, tag.id);
                refreshFilterUi();
                return true;
            },
        },
    });
}

/* ------------------------------------------------------------------ setup -- */

/**
 * Turns the whole persona manager on or off in place.
 *
 * Nothing is uninstalled: the observers and the filter hook stay put and simply
 * go inert, and the injected chrome is hidden rather than destroyed. That keeps
 * the switch instant in both directions without a teardown path that could
 * leave half-removed listeners behind.
 *
 * @param {boolean} enabled Desired state
 */
export function setPersonaManagerEnabled(enabled) {
    managerEnabled = Boolean(enabled);
    $('#ocs_persona_tag_controls, #ocs_persona_folders, #ocs_persona_usage_refresh, #ocs_persona_bulk_edit, #ocs_persona_tags, #ocs_persona_favorite').toggle(managerEnabled);
    // Also resets a stored order of ours, which would otherwise leave the list
    // unsorted once our comparator stops running.
    syncSortOrders();
    if (!managerEnabled) {
        bulkMode = false;
        bulkSelection.clear();
        updateBulkControls();
    }
    refreshDetailPane();
    refreshFilterUi();
}

/**
 * Installs the persona management enhancements.
 * @param {() => object} getSettings Accessor for this extension's settings root
 */
export function installPersonaManager(getSettings) {
    settingsAccessor = getSettings;

    personasFilter.filterFunctions.ocsPersonaManager = filterPersonas;

    listObserver = new MutationObserver(scheduleDecorate);

    const boot = () => {
        installPanelChrome();
        installDetailPane();
        observeList();
        refreshDetailPane();
        // On first load the list may already have been rendered before
        // `user_avatar` was known, so it can still contain the persona that is
        // about to be pinned. Re-filter rather than only redecorating.
        if (state().pinCurrent !== false) refreshList();
        else scheduleDecorate();
    };

    // The persona panel exists in the initial document, but the drawer content
    // is only laid out once settings have been applied.
    boot();
    eventSource.on(event_types.APP_READY, boot);

    document.addEventListener('click', onCardClickCapture, true);
    installTagManagerSync();
    installTagDeleteOverride();

    eventSource.on(event_types.PERSONA_CREATED, () => {
        void (async () => {
            if (await seedTimestamps(knownPersonaIds())) saveSettingsDebounced();
            refreshFilterUi();
        })();
    });
    eventSource.on(event_types.PERSONA_UPDATED, () => {
        touchPersona(user_avatar);
        refreshDetailPane();
        void refreshTokenCount(user_avatar).then(changed => {
            if (!changed) return;
            saveSettingsDebounced();
            if (TOKEN_ORDERS.has(currentSortOrder())) refreshList();
        });
    });
    eventSource.on(event_types.PERSONA_RENAMED, () => touchPersona(user_avatar));
    eventSource.on(event_types.PERSONA_CHANGED, () => {
        touchPersona(user_avatar, { used: true });
        refreshDetailPane();
        // Which personas the list must leave out is decided while filtering, so
        // a decorate pass alone would leave a pinned persona sitting in the
        // list as well. Only the unbound fallback tracks the selection, but the
        // chat lock can move with it too.
        if (state().pinCurrent !== false) refreshList();
        else scheduleDecorate();
    });
    // The binding follows the character, so opening another chat changes what
    // belongs at the top.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (state().pinCurrent !== false) setTimeout(refreshList, 0);
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, messageId => countNewMessage(chat?.[messageId]));
    eventSource.on(event_types.PERSONA_DELETED, ({ avatarId }) => {
        delete state().meta[avatarId];
        bulkSelection.delete(avatarId);
        saveSettingsDebounced();
    });

    // Seed timestamps for personas that existed before this extension, and the
    // token counts if the saved sort order needs them right away.
    void (async () => {
        let changed = await seedTimestamps(knownPersonaIds());
        if (TOKEN_ORDERS.has(currentSortOrder())) changed = await ensureTokenCounts() || changed;
        if (changed) {
            saveSettingsDebounced();
            if (isCustomOrder()) refreshList();
        }
    })();
}
