/**
 * 一键快照 / One-click Snapshot
 * Native-page version selectors + a wand-menu snapshot popup.
 */
import {
    characters,
    chat_metadata,
    createOrEditCharacter,
    displayOnlineStatus,
    eventSource,
    event_types,
    getCurrentChatDetails,
    getCurrentChatId,
    getPastCharacterChats,
    main_api,
    reloadChatMutex,
    reloadCurrentChat,
    saveSettingsDebounced,
    select_selected_character,
    this_chid,
} from '../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { getWorldInfoSettings, loadWorldInfo, onWorldInfoChange, saveWorldInfo, world_names } from '../../../world-info.js';
import { PAGINATION_TEMPLATE, getCharaFilename, getSortableDelay, localizePagination, paginationDropdownChangeHandler, renderPaginationDropdown } from '../../../utils.js';
import { getPresetManager } from '../../../preset-manager.js';
import { power_user } from '../../../power-user.js';
import { getChatCompletionModel, selected_proxy, settingsToUpdate } from '../../../openai.js';
import { SECRET_KEYS, rotateSecret, secret_state } from '../../../secrets.js';
import { getConnectedPersonas, getUserAvatars, setPersonaDescription, setPersonaLockState, setUserAvatar, user_avatar } from '../../../personas.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../popup.js';
import { allowPresetScripts, allowScopedScripts, disallowPresetScripts, disallowScopedScripts, getCurrentPresetAPI, getCurrentPresetName, getScriptsByType, isPresetScriptsAllowed, isScopedScriptsAllowed, saveScriptsByType, SCRIPT_TYPES } from '../../regex/engine.js';
import { DiffMatchPatch } from '../../../../lib.js';
import { installPersonaManager, setPersonaManagerEnabled } from './persona-manager.js';
import { feature, initFeatures, installFeatureSettings, onFeatureChange } from './settings-panel.js';

const EXTENSION_KEY = 'one_click_snapshot';
const METADATA_KEY = 'one_click_snapshot';
const $ = window.jQuery;
let applying = false;
let versionAutoSyncTimer = null;
let qrShortcutObserver = null;
let qrShortcutRefreshQueued = false;
let greetingSnapshotPending = null;
let greetingGenerationStopped = false;
let greetingDeferredCharacterDefaultChatId = null;
let themeOptionObserver = null;
let observedThemeSelect = null;
const observedThemeOptionNames = new WeakMap();
let avatarGalleryStyleObserver = null;
let observedAvatarGalleryStyle = null;
let greetingCatalogObserver = null;
let greetingCatalogDecorateQueued = false;
let greetingCatalogDecorateDeferred = false;

const deepClone = value => value === undefined ? undefined : structuredClone(value);
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `ocs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DEFAULT_CAPTURE_SCOPES = { character: true, persona: true, theme: true, worldInfo: true, preset: true, api: true, regex: true, worldSources: { global: true, characterMain: true, characterExtra: true, user: true, chat: true }, regexSources: { global: true, scoped: true, preset: true } };
const THEME_MANAGER_EXTENSION_KEY = 'theme-manager';
const THEME_MANAGER_CHARACTER_BINDINGS_KEY = 'themeManager_characterThemeBindings';
const PRESET_PARAMETER_KEYS = new Set([
    'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
    'openai_max_context', 'openai_max_tokens', 'reasoning_effort', 'verbosity', 'seed', 'n',
]);
const PRESET_PARAMETER_LABELS = {
    temperature: '温度',
    frequency_penalty: '频率惩罚',
    presence_penalty: '存在惩罚',
    top_p: 'Top P',
    top_k: 'Top K',
    top_a: 'Top A',
    min_p: 'Min P',
    repetition_penalty: '重复惩罚',
    openai_max_context: '上下文长度',
    openai_max_tokens: '最大回复长度',
    reasoning_effort: '推理强度',
    verbosity: '输出详细度',
    seed: '随机种子',
    n: '候选回复数',
};
const API_TEMPLATE_TYPES = ['context', 'instruct', 'sysprompt', 'reasoning'];
const API_MAIN_LABELS = {
    openai: '聊天补全',
};
// Connection endpoints normally stay out of a snapshot. Custom
// (OpenAI-compatible) is the one exception: unlike the native sources it has
// no proxy-preset file to represent its endpoint, so its URL and the active
// native secret reference belong together. The secret value itself is never
// copied into extension settings.
const OPENAI_API_SETTING_KEYS = new Set([
    'chat_completion_source',
    'openai_model', 'claude_model', 'openrouter_model', 'ai21_model', 'mistralai_model', 'cohere_model', 'perplexity_model',
    'groq_model', 'chutes_model', 'siliconflow_model', 'minimax_model', 'electronhub_model', 'nanogpt_model', 'deepseek_model',
    'aimlapi_model', 'xai_model', 'pollinations_model', 'moonshot_model', 'fireworks_model', 'cometapi_model', 'custom_model',
    'google_model', 'vertexai_model', 'zai_model', 'workers_ai_model', 'azure_openai_model',
    'openrouter_use_fallback', 'openrouter_providers', 'openrouter_quantizations', 'openrouter_allow_fallbacks', 'openrouter_middleout',
    'nanogpt_provider', 'nanogpt_payg_override',
    'custom_prompt_post_processing', 'assistant_prefill', 'assistant_impersonation', 'use_sysprompt', 'squash_system_messages',
    'continue_prefill', 'continue_postfix', 'function_calling', 'tool_call_recurse_limit', 'show_thoughts', 'tool_reasoning_mode',
    'reasoning_effort', 'verbosity', 'enable_web_search', 'request_images', 'request_image_aspect_ratio', 'request_image_resolution',
]);
const OPENAI_API_MODEL_KEYS = new Set([...OPENAI_API_SETTING_KEYS].filter(key => key.endsWith('_model')));

function settings() {
    extension_settings[EXTENSION_KEY] ??= { schemaVersion: 7, snapshots: [], snapshotGroups: [], snapshotBindings: {}, characterBindings: {}, greetingBindings: {}, characterVersions: {}, personaVersions: {}, characterVersionGroups: {}, personaVersionGroups: {}, activeCharacterVersions: {}, activePersonaVersions: {}, autoSyncVersions: false, qrShortcutEnabled: true, lastCaptureScopes: deepClone(DEFAULT_CAPTURE_SCOPES) };
    const value = extension_settings[EXTENSION_KEY];
    value.snapshots ??= [];
    value.snapshotGroups ??= [];
    value.snapshotBindings ??= {};
    value.characterBindings ??= {};
    value.greetingBindings ??= {};
    value.schemaVersion = Math.max(Number(value.schemaVersion) || 0, 7);
    value.characterVersions ??= {};
    value.personaVersions ??= {};
    value.characterVersionGroups ??= {};
    value.personaVersionGroups ??= {};
    value.activeCharacterVersions ??= {};
    value.activePersonaVersions ??= {};
    value.autoSyncVersions ??= false;
    value.characterNameMirror ??= {};
    value.personaNameMirror ??= {};
    value.lastCaptureScopes ??= deepClone(DEFAULT_CAPTURE_SCOPES);
    for (const key of ['character', 'persona', 'theme', 'worldInfo', 'preset', 'api', 'regex']) value.lastCaptureScopes[key] ??= DEFAULT_CAPTURE_SCOPES[key];
    value.lastCaptureScopes.worldSources ??= deepClone(DEFAULT_CAPTURE_SCOPES.worldSources);
    for (const source of Object.keys(DEFAULT_CAPTURE_SCOPES.worldSources)) value.lastCaptureScopes.worldSources[source] ??= DEFAULT_CAPTURE_SCOPES.worldSources[source];
    value.lastCaptureScopes.regexSources ??= deepClone(DEFAULT_CAPTURE_SCOPES.regexSources);
    for (const source of Object.keys(DEFAULT_CAPTURE_SCOPES.regexSources)) value.lastCaptureScopes.regexSources[source] ??= DEFAULT_CAPTURE_SCOPES.regexSources[source];
    // QR is now the sole entry point. Always restore it for existing settings
    // that were created while the older optional switch still existed.
    value.qrShortcutEnabled = true;
    return value;
}

function binding() {
    chat_metadata[METADATA_KEY] ??= {};
    const value = chat_metadata[METADATA_KEY];
    // Compatibility with the first development build.
    if (value.boundSnapshotId && !value.snapshotId) value.snapshotId = value.boundSnapshotId;
    if (value.enabled === undefined) value.enabled = true;
    return value;
}

function currentCharacter() {
    return this_chid === undefined ? null : characters[this_chid] ?? null;
}

function characterVersions() {
    const avatar = currentCharacter()?.avatar;
    if (!avatar) return [];
    settings().characterVersions[avatar] ??= [];
    return settings().characterVersions[avatar];
}

function personaVersions() {
    if (!user_avatar) return [];
    settings().personaVersions[user_avatar] ??= [];
    return settings().personaVersions[user_avatar];
}

function currentCharacterVersion() {
    const active = settings().activeCharacterVersions[currentCharacter()?.avatar];
    return characterVersions().find(version => version.id === active) ?? null;
}

function currentPersonaVersion() {
    const active = settings().activePersonaVersions[user_avatar];
    return personaVersions().find(version => version.id === active) ?? null;
}

/**
 * Wraps a snapshot-scoped event handler so it does nothing while the feature
 * is off, instead of having to unbind it.
 * @param {Function} handler Event handler
 * @returns {Function}
 */
function whenSnapshot(handler) {
    return (...args) => (feature('snapshot') ? handler(...args) : undefined);
}

/**
 * Reconciles everything this extension injects with the current switches.
 * Called at start-up and again whenever a switch moves, which is what makes the
 * settings take effect without a reload.
 */
function applyFeatureState() {
    renderQrShortcut();

    const versionOn = feature('version');
    $('#one_click_snapshot_character_version_button, #one_click_snapshot_persona_version_button').toggle(versionOn);
    // The "More" entries are <option> elements. Safari has never honoured
    // display:none on those, so drop and re-add them instead of hiding —
    // installVersionMenu only appends what is missing.
    if (versionOn) installVersionMenu();
    else $('#one_click_snapshot_character_versions, #one_click_snapshot_persona_versions').remove();

    $('[id^="ocs_bulk_character_context_menu_"]').toggleClass('ocs-feature-off', !feature('native.characterBulkButtons'));
    setPersonaManagerEnabled(feature('persona'));
    refreshVersionIndicators();
}

/* ------------------------------------------------- version name mirroring -- */

/**
 * Per-avatar state for mirroring a version name into the native field that the
 * character / persona list already displays:
 * - character -> `data.character_version`, shown on the card as `.character_version`
 * - persona   -> `persona_descriptions[avatar].title`, shown as `.ch_additional_info`
 *
 * `previous` keeps whatever the user had written there before mirroring was
 * switched on, so turning it back off can offer to restore it.
 *
 * @param {'character'|'persona'} type Version type
 * @returns {Record<string, {previous: string}>}
 */
function nameMirrorStore(type) {
    const key = type === 'character' ? 'characterNameMirror' : 'personaNameMirror';
    settings()[key] ??= {};
    return settings()[key];
}

function nameMirrorOwner(type) {
    return type === 'character' ? currentCharacter()?.avatar ?? null : user_avatar || null;
}

function isNameMirrorEnabled(type, owner = nameMirrorOwner(type)) {
    return Boolean(owner) && Boolean(nameMirrorStore(type)[owner]);
}

/** Reads the native field that mirroring writes into. */
function nativeVersionLabel(type) {
    if (type === 'character') return String(currentCharacter()?.data?.character_version ?? '');
    return String(power_user.persona_descriptions?.[user_avatar]?.title ?? '');
}

/**
 * Writes a label into the native field and repaints whatever displays it.
 * The character card is written by the caller's own save, so this only
 * persists for personas.
 *
 * @param {'character'|'persona'} type Version type
 * @param {string} label Text to write
 * @param {object} [options]
 * @param {boolean} [options.persist=true] Whether to save and repaint here
 */
async function writeNativeVersionLabel(type, label, { persist = true } = {}) {
    if (type === 'character') {
        const character = currentCharacter();
        if (!character) return;
        character.data ??= {};
        character.data.character_version = label;
        $('#character_version_textarea').val(label);
        if (persist) await createOrEditCharacter(new CustomEvent('ocs-name-mirror'));
        return;
    }

    const avatar = user_avatar;
    if (!avatar || !power_user.persona_descriptions?.[avatar]) return;
    if (label) power_user.persona_descriptions[avatar].title = label;
    else delete power_user.persona_descriptions[avatar].title;
    if (!persist) return;
    saveSettingsDebounced();
    await getUserAvatars(true, avatar);
    await eventSource.emit(event_types.PERSONA_UPDATED, avatar);
}

/**
 * Pushes the active version's name into the native field. Called after a
 * version is applied or renamed.
 *
 * @param {'character'|'persona'} type Version type
 * @param {object} [options]
 * @param {boolean} [options.persist=true] Whether to save here, or let the caller's own save cover it
 */
async function applyNameMirror(type, { persist = true } = {}) {
    if (!isNameMirrorEnabled(type)) return;
    const version = type === 'character' ? currentCharacterVersion() : currentPersonaVersion();
    // No active version means nothing to mirror. Leave the field alone rather
    // than wiping text the user may still want.
    if (!version?.name) return;
    if (nativeVersionLabel(type) === version.name) return;
    await writeNativeVersionLabel(type, version.name, { persist });
}

/**
 * The native fields are read-only while mirroring owns them. The persona title
 * only exists inside the rename popup, so that one is locked when it appears.
 */
function refreshNameMirrorLocks() {
    const locked = isNameMirrorEnabled('character');
    const field = $('#character_version_textarea');
    field.prop('readonly', locked).toggleClass('ocs-name-mirror-locked', locked);
    if (locked) field.attr('title', '「角色版本」正由一键快照的版本名同步接管，如需手动修改请先在版本管理器里关闭同步。');
    else if (field.attr('title')?.startsWith('「角色版本」正由')) field.removeAttr('title');
}

/** Locks the persona title input inside SillyTavern's rename popup. */
function installPersonaTitleLock() {
    new MutationObserver(() => {
        if (!isNameMirrorEnabled('persona')) return;
        const input = document.querySelector('dialog.popup #persona_title');
        if (!(input instanceof HTMLInputElement) || input.readOnly) return;
        input.readOnly = true;
        input.title = '「备注」正由一键快照的版本名同步接管，如需手动修改请先在版本管理器里关闭同步。';
    }).observe(document.body, { childList: true, subtree: true });
}

function refreshVersionIndicators() {
    $('#one_click_snapshot_character_version_hint, #one_click_snapshot_persona_version_hint').remove();
    if (!feature('version')) return;
    const characterVersion = currentCharacterVersion();
    if (characterVersion?.name) {
        const hint = $('<span id="one_click_snapshot_character_version_hint" class="ocs-native-version-hint"></span>').text(characterVersion.name);
        const title = $('#description_div > .flex-container').first();
        title.append(hint);
    }
    const personaVersion = currentPersonaVersion();
    if (personaVersion?.name) {
        const hint = $('<span id="one_click_snapshot_persona_version_hint" class="ocs-native-version-hint"></span>').text(personaVersion.name);
        const title = $('#persona_description').prevAll('h4').first();
        title.append(hint);
    }
    refreshVersionAvatarOverrides();
}

function versionAvatarOwner(type) {
    return type === 'character' ? currentCharacter()?.avatar ?? null : user_avatar ?? null;
}

function versionAvatarGallery(type) {
    // AvatarCropper owns these lists, the files behind them, and its theme
    // bindings. We intentionally only read the gallery as a picker source.
    const owner = versionAvatarOwner(type);
    const images = type === 'character'
        ? extension_settings.charGalleryImages?.[owner]
        : extension_settings.userGalleryImages;
    return Array.isArray(images) ? [...new Set(images.filter(path => typeof path === 'string' && path))] : [];
}

function hasVersionAvatarGallery(type) {
    return type === 'character'
        ? Boolean(extension_settings.charGalleryImages)
        : Array.isArray(extension_settings.userGalleryImages);
}

function originalAvatarPath(type) {
    const owner = versionAvatarOwner(type);
    if (!owner) return '';
    return `${type === 'character' ? '/characters/' : '/User Avatars/'}${encodeURIComponent(owner)}`;
}

function avatarPathLabel(path) {
    if (!path) return '原始头像';
    const filename = String(path).split('/').pop() || String(path);
    try { return decodeURIComponent(filename); } catch { return filename; }
}

function currentAvatarGalleryTheme() {
    return String(document.getElementById('themes')?.value ?? 'default');
}

function syncVersionAvatarToGallery(type, version) {
    // AvatarCropper's gallery considers this per-theme binding its selected
    // item. Keep it in step with a version switch so the gallery never says
    // “A” while the version overlay is visibly showing “B”.
    if (!version || !hasVersionAvatarGallery(type)) return false;
    const owner = versionAvatarOwner(type);
    if (!owner) return false;
    const theme = currentAvatarGalleryTheme();
    extension_settings.avatarThemeBindings ??= {};
    extension_settings.avatarThemeBindings[theme] ??= {};
    const bindings = extension_settings.avatarThemeBindings[theme];
    const path = version.avatarPath ?? null;
    let changed = false;
    if (!path) {
        if (Object.hasOwn(bindings, owner)) {
            delete bindings[owner];
            changed = true;
        }
    } else if (bindings[owner] !== path) {
        bindings[owner] = path;
        changed = true;
    }
    if (changed) saveSettingsDebounced();
    return changed;
}

function versionAvatarDisplayPath(type, version) {
    const theme = currentAvatarGalleryTheme();
    const owner = versionAvatarOwner(type);
    // Once a version has been applied, AvatarCropper remains the live source
    // of truth. This lets a manual gallery click take over immediately while
    // the saved version value is kept for the next explicit version apply.
    const selectedPath = hasVersionAvatarGallery(type)
        ? extension_settings.avatarThemeBindings?.[theme]?.[owner] ?? null
        : version?.avatarPath;
    if (!selectedPath) return null;
    // Let a gallery image keep the crop that AvatarCropper has associated
    // with this selected image, exactly as its own CSS engine would.
    return extension_settings.avatarThemeCrops?.[theme]?.[owner]?.[selectedPath] ?? selectedPath;
}

function escapeCssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ');
}

function versionAvatarSelectorCss(avatarId) {
    const escapedId = escapeCssString(avatarId);
    const encodedId = escapeCssString(encodeURIComponent(avatarId));
    return [
        `.avatar img[src*="${escapedId}"]`,
        `.avatar img[src*="${encodedId}"]`,
        `#avatar_load_preview[src*="${escapedId}"]`,
        `#avatar_load_preview[src*="${encodedId}"]`,
        `.zoomed_avatar img[src*="${escapedId}"]`,
        `.zoomed_avatar img[src*="${encodedId}"]`,
    ].join(',\n');
}

function refreshVersionAvatarOverrides() {
    const overrides = [
        ['character', currentCharacterVersion()],
        ['persona', currentPersonaVersion()],
    ].flatMap(([type, version]) => {
        const owner = versionAvatarOwner(type);
        const path = versionAvatarDisplayPath(type, version);
        if (!owner || !version) return [];
        // AvatarCropper refreshes its generated CSS on its own cadence. Keep
        // a `normal` rule for the original-image case so a just-removed old
        // binding cannot linger on screen during that short interval.
        const content = path ? `url("${escapeCssString(path)}")` : 'normal';
        return `${versionAvatarSelectorCss(owner)} { content: ${content} !important; object-fit: cover !important; }`;
    });
    const styleId = 'one-click-snapshot-version-avatar-style';
    let style = document.getElementById(styleId);
    if (!overrides.length) {
        style?.remove();
        return;
    }
    if (!style) {
        style = document.createElement('style');
        style.id = styleId;
        document.head.appendChild(style);
    }
    style.textContent = overrides.join('\n');
}

function installAvatarGallerySelectionObserver(attempt = 0) {
    const style = document.getElementById('st-avatar-bindings-style');
    if (style === observedAvatarGalleryStyle) return;
    avatarGalleryStyleObserver?.disconnect();
    observedAvatarGalleryStyle = style;
    if (!style) {
        // AvatarCropper can load after third-party extensions. Retry briefly,
        // but never keep a background timer alive when it is not installed.
        if (attempt < 4) setTimeout(() => installAvatarGallerySelectionObserver(attempt + 1), 1000);
        return;
    }
    // AvatarCropper regenerates this style after a manual gallery choice.
    // Rebuild only our display bridge from its current binding; never write
    // the binding back here, or manual choices would get overwritten again.
    avatarGalleryStyleObserver = new MutationObserver(() => refreshVersionAvatarOverrides());
    avatarGalleryStyleObserver.observe(style, { childList: true, characterData: true, subtree: true });
}

function refreshConnectionStatusDisplay() {
    // Some UI layers rebuild parts of the API panel after SETTINGS_UPDATED and
    // leave its initial “no connection” text behind while the core status is
    // still connected. Replaying the core display is visual-only: it neither
    // changes a connection nor starts a status check.
    setTimeout(() => displayOnlineStatus(), 0);
}

function captureCharacter() {
    const character = currentCharacter();
    if (!character) return null;
    const data = deepClone(character.data ?? {});
    // Scoped regex scripts belong to the character card, but they are their
    // own native resource rather than role-version content. Capturing the
    // whole data object here used to make an old character version silently
    // resurrect deleted scripts (or discard newly imported ones).
    if (data.extensions) delete data.extensions.regex_scripts;
    // Opening greetings are a card-level catalog with its own binding system.
    // A role version is never allowed to archive or replace that catalog.
    delete data.alternate_greetings;
    // Names and groups are card-level metadata too. Do not let a saved role
    // version freeze an old copy that could overwrite a later reorganisation.
    delete data.extensions?.one_click_snapshot;
    return {
        avatar: character.avatar,
        name: character.name,
        description: character.description ?? '',
        personality: character.personality ?? '',
        scenario: character.scenario ?? '',
        mes_example: character.mes_example ?? '',
        talkativeness: character.talkativeness,
        data,
    };
}

function capturePersona() {
    if (!user_avatar) return null;
    return {
        avatar: user_avatar,
        name: power_user.personas?.[user_avatar] ?? '',
        descriptor: deepClone(power_user.persona_descriptions?.[user_avatar] ?? {}),
    };
}

function selectedWorldNames() {
    const raw = $('#world_info').val();
    const indices = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
    return indices.map(Number).map(index => world_names[index]).filter(Boolean);
}

function worldBookDescriptors(included = { global: true, characterMain: true, characterExtra: true, user: true, chat: true }) {
    const output = new Map();
    const add = (name, source) => {
        if (!name || !world_names.includes(name)) return;
        const descriptor = output.get(name) ?? { name, sources: [] };
        if (!descriptor.sources.includes(source)) descriptor.sources.push(source);
        output.set(name, descriptor);
    };
    if (included.global) selectedWorldNames().forEach(name => add(name, '全局世界书'));
    const character = currentCharacter();
    if (included.characterMain) add(character?.data?.extensions?.world, '角色主世界书');
    if (included.chat) add(chat_metadata.world_info, '聊天世界书');

    const charFile = currentCharacter() ? getCharaFilename(this_chid) : '';
    const charLore = getWorldInfoSettings().world_info?.charLore ?? [];
    const extra = charLore.find(item => item.name === charFile)?.extraBooks ?? [];
    if (included.characterExtra) extra.forEach(name => add(name, '角色附加世界书'));
    const userLorebook = power_user.persona_descriptions?.[user_avatar]?.lorebook ?? power_user.persona_description_lorebook;
    if (included.user) add(userLorebook, '用户绑定世界书');
    return [...output.values()];
}

function entryLabel(entry, uid) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    return String(entry.comment || keys || `条目 #${uid}`);
}

function getPresetTransferWorldbookGroups() {
    try {
        const context = SillyTavern.getContext();
        // preset-transfer has used both camelCase and kebab-case keys across
        // releases. Prefer the live extension settings, then fall back to the
        // persisted settings object.
        const container = context?.extensionSettings ?? extension_settings;
        const transfer = container?.presetTransfer ?? container?.['preset-transfer'] ?? container?.PresetTransfer;
        const raw = transfer?.worldbookGroupingState ?? transfer?.worldBookGroupingState ?? transfer?.worldbookGroups;
        const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const bucket = state?.flat ?? state?.global ?? state;
        const groups = bucket?.groups;
        if (!groups || typeof groups !== 'object') return new Map();
        const result = new Map();
        for (const [group, members] of Object.entries(groups)) {
            const names = Array.isArray(members) ? members : (members?.items ?? members?.members ?? []);
            for (const rawName of names) {
                // v4's ordering tokens are stored as w:worldbook-name. Older
                // versions store the name directly.
                const name = String(rawName ?? '').replace(/^w:/, '').trim();
                if (name) result.set(name, String(group));
            }
        }
        return result;
    } catch {
        return new Map();
    }
}

function getPresetTransferSettings() {
    const context = SillyTavern.getContext();
    const container = context?.extensionSettings ?? extension_settings;
    return container?.presetTransfer ?? container?.['preset-transfer'] ?? container?.PresetTransfer ?? {};
}

function getPresetTransferWorldbookEntryGroups(worldbookName, orderedUids, data = null) {
    try {
        const transfer = getPresetTransferSettings();
        const raw = transfer?.worldbookEntryGroupingsBackup?.[worldbookName]
            ?? data?.extensions?.presetTransfer?.worldbookEntryGrouping;
        if (!Array.isArray(raw) || !raw.length) return new Map();
        const uids = orderedUids.map(String);
        const assignments = new Map();
        for (const grouping of raw) {
            const name = String(grouping?.name ?? grouping?.groupName ?? '').trim();
            if (!name) continue;
            let start = grouping?.startUid == null ? -1 : uids.indexOf(String(grouping.startUid));
            let end = grouping?.endUid == null ? -1 : uids.indexOf(String(grouping.endUid));
            if ((start < 0 || end < 0) && Number.isInteger(grouping?.startIndex) && Number.isInteger(grouping?.endIndex)) {
                start = grouping.startIndex;
                end = grouping.endIndex;
            }
            if (start < 0 || end < 0) continue;
            for (const uid of uids.slice(Math.min(start, end), Math.max(start, end) + 1)) {
                if (!assignments.has(uid)) assignments.set(uid, name);
            }
        }
        return assignments;
    } catch {
        return new Map();
    }
}

function getPresetTransferWorldbookEntryGates(worldbookName, orderedUids, data = null) {
    try {
        const transfer = getPresetTransferSettings();
        const raw = transfer?.worldbookEntryGroupingsBackup?.[worldbookName]
            ?? data?.extensions?.presetTransfer?.worldbookEntryGrouping;
        if (!Array.isArray(raw) || !raw.length) return [];
        const uids = orderedUids.map(String);
        const gates = [];
        for (const [index, grouping] of raw.entries()) {
            let start = grouping?.startUid == null ? -1 : uids.indexOf(String(grouping.startUid));
            let end = grouping?.endUid == null ? -1 : uids.indexOf(String(grouping.endUid));
            if ((start < 0 || end < 0) && Number.isInteger(grouping?.startIndex) && Number.isInteger(grouping?.endIndex)) {
                start = grouping.startIndex;
                end = grouping.endIndex;
            }
            if (start < 0 || end < 0) continue;
            const members = uids.slice(Math.min(start, end), Math.max(start, end) + 1);
            if (!members.length) continue;
            gates.push({
                id: String(grouping?.id ?? `${worldbookName}:${index}:${members[0]}:${members.at(-1)}`),
                name: String(grouping?.name ?? grouping?.groupName ?? '未命名分组'),
                uids: members,
                enabled: grouping?.gate !== false,
            });
        }
        return gates;
    } catch {
        return [];
    }
}

function presetGroupingProvider() {
    if (globalThis.__baiBaiToolkitExtensionInstalled && typeof globalThis.__baiBaiToolkitExtensionInstalled === 'object') return 'baibai';
    const context = SillyTavern.getContext();
    const container = context?.extensionSettings ?? extension_settings;
    if (typeof window.PT_setWorldbookGroupGate === 'function') return 'preset-transfer';
    if (['presetTransfer', 'preset-transfer', 'PresetTransfer'].some(key => Object.hasOwn(container ?? {}, key))) return 'preset-transfer';
    return null;
}

function hasUsablePresetGroupState(state) {
    return Boolean(state && typeof state === 'object' && (
        (Array.isArray(state.groups) && state.groups.length)
        || (state.prompts && typeof state.prompts === 'object' && Object.keys(state.prompts).length)
    ));
}

function presetGroupMapFromState(state) {
    if (!state || typeof state !== 'object') return new Map();
    const result = new Map();
    const names = new Map((state.groups ?? []).map((group, index) => [String(group.id ?? index), group.name || group.title || '未命名分组']));
    for (const [id, meta] of Object.entries(state.prompts ?? state.entries ?? {})) {
        const groupId = meta?.groupId ?? meta?.group ?? meta;
        result.set(id, names.get(String(groupId)) ?? (typeof groupId === 'string' ? groupId : '未分组'));
    }
    // Compatibility with member-list grouping data: { groups: [{ name,
    // entries: ['id'] }] }.
    for (const group of state.groups ?? []) {
        for (const id of group?.entries ?? group?.members ?? group?.items ?? []) {
            result.set(String(id), group.name || group.title || '未命名分组');
        }
    }
    return result;
}

function presetGroupMapFromEntryGrouping(state, settings) {
    if (!state || typeof state !== 'object') return new Map();
    const direct = presetGroupMapFromState(state);
    if (direct.size) return direct;
    const entries = Array.isArray(state) ? state : (['groups', 'entries', 'entryGroups', 'items']
        .map(key => state[key])
        .find(Array.isArray) ?? []);
    const promptIds = (settings?.prompt_order ?? [])
        .flatMap(order => order?.order ?? [])
        .map(item => String(item?.identifier ?? ''))
        .filter(Boolean);
    const result = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.name ?? entry.title ?? entry.groupName ?? '未命名分组');
        const members = entry.memberIdentifiers ?? entry.entries ?? entry.members ?? entry.items;
        if (Array.isArray(members)) {
            for (const id of members) if (promptIds.includes(String(id))) result.set(String(id), name);
            continue;
        }
        const start = promptIds.indexOf(String(entry.startIdentifier ?? entry.startId ?? ''));
        const end = promptIds.indexOf(String(entry.endIdentifier ?? entry.endId ?? ''));
        if (start < 0 || end < 0) continue;
        const exclusive = String(entry.mode ?? 'inclusive').toLowerCase() === 'exclusive';
        const from = Math.min(start, end) + (exclusive ? 1 : 0);
        const to = Math.max(start, end) - (exclusive ? 1 : 0);
        for (const id of promptIds.slice(from, to + 1)) result.set(id, name);
    }
    return result;
}

/**
 * The raw grouping state, from wherever the active provider keeps it.
 *
 * Split out from `getPresetPromptGroups` because the group switches live on
 * this object and are lost once it has been flattened to a name lookup.
 *
 * @param {object} settings Chat completion settings
 * @param {object} [preset] Preset object, when reading one that is not loaded
 * @returns {object|null}
 */
function presetPromptGroupState(settings, preset = null) {
    const provider = presetGroupingProvider();
    if (!provider) return null;

    // BaiBai does not read the stored copy at runtime. It clones it once per
    // preset into `presetPromptGroupRuntimeState` and works from that, syncing
    // back only on its own save -- so a write to the stored copy is invisible
    // to it and is then overwritten. Its extension object is that same state
    // container, which is what makes the live copy reachable from here.
    if (provider === 'baibai' && !preset) {
        const runtime = globalThis.__baiBaiToolkitExtensionInstalled?.presetPromptGroupRuntimeState;
        if (hasUsablePresetGroupState(runtime)) return runtime;
    }

    const extensions = settings?.extensions ?? {};
    const presetExtensions = preset?.extensions ?? {};
    const states = provider === 'baibai'
        ? [presetExtensions?.baibaiToolkit?.presetPromptGroups, extensions?.baibaiToolkit?.presetPromptGroups]
        : [
            extensions?.presetTransfer?.presetPromptGroups,
            extensions?.['preset-transfer']?.presetPromptGroups,
            presetExtensions?.presetTransfer?.presetPromptGroups,
            presetExtensions?.['preset-transfer']?.presetPromptGroups,
        ];
    return states.find(hasUsablePresetGroupState) ?? states.find(Boolean) ?? null;
}

/**
 * The prompt groups and their global switches.
 *
 * That switch is an overlay, exactly like the worldbook one: toggling it writes
 * `group.enabled` and leaves each prompt's own flag untouched, with the
 * effective state worked out as `item.enabled && group.enabled` at send time.
 * A snapshot has to record both to be able to reproduce what was in effect.
 *
 * @param {object} settings Chat completion settings
 * @param {object} [preset] Preset object, when reading one that is not loaded
 * @returns {{id: string, name: string, enabled: boolean, identifiers: string[]}[]}
 */
function presetPromptGroupGates(settings, preset = null) {
    const state = presetPromptGroupState(settings, preset);
    if (!state) return [];

    const members = new Map();
    for (const [identifier, meta] of Object.entries(state.prompts ?? state.entries ?? {})) {
        const groupId = String(meta?.groupId ?? meta?.group ?? meta ?? '');
        if (!groupId) continue;
        if (!members.has(groupId)) members.set(groupId, []);
        members.get(groupId).push(String(identifier));
    }

    return (state.groups ?? []).map((group, index) => {
        const id = String(group?.id ?? index);
        const listed = (group?.entries ?? group?.members ?? group?.items ?? []).map(String);
        return {
            id,
            name: group?.name || group?.title || '未命名分组',
            enabled: group?.enabled !== false,
            identifiers: members.get(id) ?? listed,
        };
    }).filter(group => group.identifiers.length);
}

function getPresetPromptGroups(settings, preset = null) {
    const provider = presetGroupingProvider();
    if (!provider) return new Map();
    const extensions = settings?.extensions ?? {};
    const presetExtensions = preset?.extensions ?? {};
    if (provider === 'baibai') {
        // This mirrors BaiBai's own preference: the saved preset wins once it
        // has a real group model; otherwise its live settings are the source.
        const states = [presetExtensions?.baibaiToolkit?.presetPromptGroups, extensions?.baibaiToolkit?.presetPromptGroups];
        const state = states.find(hasUsablePresetGroupState) ?? states.find(Boolean);
        const direct = presetGroupMapFromState(state);
        if (direct.size) return direct;
        // BaiBai natively imports PT's legacy entryGrouping format. During
        // that short import window, display the same grouping without ever
        // falling back to PT's separate runtime state.
        const compat = presetExtensions?.entryGrouping ?? extensions?.entryGrouping;
        return presetGroupMapFromEntryGrouping(compat, settings);
    }
    const states = [
        extensions?.presetTransfer?.presetPromptGroups,
        extensions?.['preset-transfer']?.presetPromptGroups,
        presetExtensions?.presetTransfer?.presetPromptGroups,
        presetExtensions?.['preset-transfer']?.presetPromptGroups,
    ];
    const state = states.find(hasUsablePresetGroupState) ?? states.find(Boolean);
    const direct = presetGroupMapFromState(state);
    if (direct.size) return direct;
    return presetGroupMapFromEntryGrouping(presetExtensions?.entryGrouping ?? extensions?.entryGrouping, settings);
}

/**
 * Reads one lorebook into the shape a snapshot stores.
 *
 * The read is by name and goes straight to the file, so it neither depends on
 * nor disturbs what is currently mounted. That is what lets a snapshot record
 * a book the user is not playing with right now.
 *
 * @param {{name: string, sources: string[]}} descriptor Book name and the slots it occupies
 * @param {Map<string, string>} [groups] Preset-transfer book groups, read once per batch
 * @returns {Promise<object|null>} The stored book, or null when the book cannot be read
 */
async function captureWorldBook(descriptor, groups = null) {
    const data = await loadWorldInfo(descriptor.name);
    if (!data?.entries) return null;

    const bookGroups = groups ?? getPresetTransferWorldbookGroups();
    const entries = Object.entries(data.entries)
        .sort(([, a], [, b]) => Number(a?.displayIndex ?? 0) - Number(b?.displayIndex ?? 0));
    const ptGroups = getPresetTransferWorldbookEntryGroups(descriptor.name, entries.map(([uid]) => uid), data);
    const ptGates = getPresetTransferWorldbookEntryGates(descriptor.name, entries.map(([uid]) => uid), data);
    const gatedOffUids = new Set(ptGates.filter(gate => !gate.enabled).flatMap(gate => gate.uids));
    return {
        ...descriptor,
        group: bookGroups.get(descriptor.name) ?? '',
        ptGates,
        entries: entries.map(([uid, entry]) => ({
            uid: String(uid),
            label: entryLabel(entry, uid),
            // PT's group switch is an overlay, not entry.disable. Record
            // the effective state users see, while retaining raw state for
            // a lossless restore of a group that is currently gated off.
            enabled: !entry.disable && !gatedOffUids.has(String(uid)),
            rawEnabled: !entry.disable,
            group: String(entry.group ?? '').trim(),
            ptGroup: ptGroups.get(String(uid)) ?? '',
        })),
    };
}

async function captureWorldInfo(includedSources) {
    const books = [];
    const groups = getPresetTransferWorldbookGroups();
    for (const descriptor of worldBookDescriptors(includedSources)) {
        const book = await captureWorldBook(descriptor, groups);
        if (book) books.push(book);
    }
    return {
        // Only the global selector is a mount state. Character, user and chat
        // lorebooks already belong to their owner, so snapshots preserve their
        // entry switches only.
        globalSelected: includedSources?.global ? selectedWorldNames() : null,
        context: {
            characterAvatar: currentCharacter()?.avatar ?? null,
            personaAvatar: user_avatar ?? null,
            chatId: String(getCurrentChatId() ?? ''),
        },
        books,
    };
}

function capturePreset() {
    const context = SillyTavern.getContext();
    const manager = getPresetManager();
    const oai = context.chatCompletionSettings;
    const prompts = new Map((oai?.prompts ?? []).map(prompt => [prompt.identifier, prompt.name || prompt.identifier]));
    const selectedName = manager?.getSelectedPresetName?.();
    const selectedPreset = manager?.getCompletionPresetByName?.(selectedName);
    const groups = getPresetPromptGroups(oai, selectedPreset);
    // No preset argument on purpose: the gate to record is the one in effect
    // right now, which lives in the provider's live state rather than in the
    // copy saved inside the preset file.
    const promptGates = main_api === 'openai' ? presetPromptGroupGates(oai) : [];
    const gatedOff = new Set(promptGates.filter(gate => !gate.enabled).flatMap(gate => gate.identifiers));
    const promptEntries = main_api === 'openai'
        ? (oai?.prompt_order ?? []).flatMap(list => (list.order ?? []).map(item => ({
            identifier: item.identifier,
            label: prompts.get(item.identifier) ?? item.identifier,
            // The group switch is an overlay, so record the state actually in
            // effect while keeping the raw flag for a lossless restore.
            enabled: !!item.enabled && !gatedOff.has(String(item.identifier)),
            rawEnabled: !!item.enabled,
            group: groups.get(item.identifier) ?? '',
        })))
        : [];
    return {
        api: main_api,
        // Keep the native value only as a legacy fallback. For completion
        // presets it is commonly a mutable list index, so presetName is the
        // authoritative reference when applying a snapshot.
        presetValue: manager?.getSelectedPreset() ?? null,
        presetName: manager?.getSelectedPresetName() ?? '未选择预设',
        // A snapshot is a set of switches, not a copy of a preset. The
        // identifier remains stable when the entry is renamed or edited, so
        // applying it later uses the preset's current text and only restores
        // the enabled state recorded here.
        promptEntries,
        promptGates,
        // Chat-completion presets serve Gemini, Claude and other compatible
        // backends. Store their generation controls separately from prompt
        // content, so a snapshot can restore e.g. a Gemini temperature of
        // 0.85 without overwriting the preset itself.
        parameters: capturePresetParameters(),
    };
}

function capturePresetParameters() {
    if (main_api !== 'openai') return null;
    const settings = SillyTavern.getContext().chatCompletionSettings;
    if (!settings) return null;
    const parameters = {};
    for (const key of PRESET_PARAMETER_KEYS) {
        const setting = settingsToUpdate[key]?.[1];
        if (setting && Object.hasOwn(settings, setting)) parameters[key] = deepClone(settings[setting]);
    }
    return parameters;
}

/**
 * The generation parameters stored inside an arbitrary preset object.
 *
 * `capturePresetParameters` reads the live settings; this reads a preset that
 * was never loaded, which is what lets a snapshot be pointed at a different
 * preset without the user having to switch to it first.
 *
 * @param {object} preset Preset object from the preset manager
 * @returns {object|null} Parameters, or null when the preset carries none
 */
function presetParametersOf(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const parameters = {};
    for (const key of PRESET_PARAMETER_KEYS) {
        // A preset file stores the parameter under its own name; only the live
        // settings object renames it (`temperature` becomes `temp_openai`).
        // Reading by the settings name alone finds just the handful where the
        // two happen to coincide.
        const setting = settingsToUpdate[key]?.[1];
        if (Object.hasOwn(preset, key)) parameters[key] = deepClone(preset[key]);
        else if (setting && Object.hasOwn(preset, setting)) parameters[key] = deepClone(preset[setting]);
    }
    return Object.keys(parameters).length ? parameters : null;
}

function presetParametersEqual(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

function applyPresetParameters(parameters) {
    if (main_api !== 'openai' || !parameters || typeof parameters !== 'object') return false;
    const settings = SillyTavern.getContext().chatCompletionSettings;
    if (!settings) return false;
    let changed = false;
    for (const [key, value] of Object.entries(parameters)) {
        if (!PRESET_PARAMETER_KEYS.has(key)) continue;
        const [selector, setting, isCheckbox] = settingsToUpdate[key] ?? [];
        if (!setting || presetParametersEqual(settings[setting], value)) continue;
        settings[setting] = deepClone(value);
        const control = $(selector);
        if (control.length) {
            // Treat these as a native preset application. In particular,
            // max-context settings use this marker to avoid forcing a
            // chat-completion source reconnect for a parameter-only update.
            if (isCheckbox) control.prop('checked', !!value).trigger('input', { source: 'preset' });
            else control.val(value).trigger('input', { source: 'preset' });
        }
        changed = true;
    }
    if (changed) saveSettingsDebounced();
    return changed;
}

function presetParameterLines(parameters) {
    if (!parameters || typeof parameters !== 'object') return [];
    return [...PRESET_PARAMETER_KEYS]
        .filter(key => Object.hasOwn(parameters, key))
        .map(key => `${PRESET_PARAMETER_LABELS[key] ?? key}：${parameters[key] === null || parameters[key] === '' ? '未设置' : String(parameters[key])}`);
}

function capturePresetReference(apiId) {
    const manager = getPresetManager(apiId);
    if (!manager) return null;
    return {
        name: manager.getSelectedPresetName?.() ?? '',
        value: manager.getSelectedPreset?.() ?? null,
    };
}

function captureCustomConnection(settings) {
    const connection = { url: String(settings.custom_url ?? '') };
    const activeSecret = Array.isArray(secret_state[SECRET_KEYS.CUSTOM])
        ? secret_state[SECRET_KEYS.CUSTOM].find(secret => secret.active)
        : null;
    if (activeSecret?.id) {
        // The immutable ID is the actual reference; the label is display-only
        // so renaming a secret naturally updates what this snapshot shows.
        connection.secret = { id: activeSecret.id, label: String(activeSecret.label ?? '') };
    }
    return connection;
}

function customSecretLabel(reference) {
    if (!reference?.id) return '';
    const liveSecret = Array.isArray(secret_state[SECRET_KEYS.CUSTOM])
        ? secret_state[SECRET_KEYS.CUSTOM].find(secret => secret.id === reference.id)
        : null;
    return String(liveSecret?.label || reference.label || reference.id);
}

function captureApiState() {
    const state = {
        // This scope intentionally represents SillyTavern's Chat Completion
        // connection only. Generation presets remain the separate “预设”
        // snapshot scope, so their prompt entries and parameters never get
        // duplicated or unexpectedly reapplied here.
        mainApi: 'openai',
        templates: Object.fromEntries(API_TEMPLATE_TYPES.map(type => [type, capturePresetReference(type)])),
    };
    const settings = SillyTavern.getContext().chatCompletionSettings;
    const values = {};
    for (const key of OPENAI_API_SETTING_KEYS) {
        const setting = settingsToUpdate[key]?.[1];
        if (setting && Object.hasOwn(settings, setting)) values[key] = deepClone(settings[setting]);
    }
    state.chatCompletion = {
        values,
        model: getChatCompletionModel(settings) ?? '',
        promptPostProcessingLabel: String($('#custom_prompt_post_processing option:selected').text() ?? '').trim(),
        // This is only the user-facing proxy preset name. Its URL and
        // password continue to live exclusively in SillyTavern's own proxy
        // preset store and are never copied into a snapshot.
        proxyPreset: String($('#openai_proxy_preset').val() ?? selected_proxy?.name ?? 'None'),
    };
    if (values.chat_completion_source === 'custom') {
        state.chatCompletion.customConnection = captureCustomConnection(settings);
        // Custom does not use SillyTavern's OpenAI reverse-proxy presets.
        delete state.chatCompletion.proxyPreset;
    }
    return state;
}

async function selectPresetReference(apiId, reference) {
    if (!reference?.name) return false;
    const manager = getPresetManager(apiId);
    if (!manager) return false;
    const value = manager.findPreset(reference.name);
    if (value === undefined || value === null || String(manager.getSelectedPreset()) === String(value)) return false;
    const loaded = apiId === 'openai'
        ? new Promise(resolve => eventSource.once(event_types.OAI_PRESET_CHANGED_AFTER, resolve))
        : null;
    manager.selectPreset(value);
    if (loaded) await loaded;
    return true;
}

function applyOpenAIConnectionState(values) {
    if (!values || typeof values !== 'object') return false;
    const settings = SillyTavern.getContext().chatCompletionSettings;
    if (!settings) return false;
    let changed = false;
    const source = values.chat_completion_source;
    if (source && settings.chat_completion_source !== source) {
        const sourceSelect = $('#chat_completion_source');
        if (sourceSelect.find(`option[value="${CSS.escape(String(source))}"]`).length) {
            sourceSelect.val(source).trigger('change');
            changed = true;
        } else {
            settings.chat_completion_source = source;
            changed = true;
        }
    }
    for (const [key, value] of Object.entries(values)) {
        if (key === 'chat_completion_source' || !OPENAI_API_SETTING_KEYS.has(key)) continue;
        const [selector, setting, isCheckbox] = settingsToUpdate[key] ?? [];
        if (!setting || presetParametersEqual(settings[setting], value)) continue;
        settings[setting] = deepClone(value);
        const control = $(selector);
        if (control.length) {
            if (isCheckbox) control.prop('checked', !!value).trigger('input', { source: 'snapshot' });
            else {
                control.val(value);
                // Model lists can be replaced asynchronously by the source / proxy
                // status check. Keep the saved setting as the authority and let
                // that native refresh select it once the matching options exist,
                // instead of firing a model change against a stale empty list.
                if (!OPENAI_API_MODEL_KEYS.has(key)) {
                    control.trigger(control.is('select') ? 'change' : 'input', { source: 'snapshot' });
                }
            }
        }
        changed = true;
    }
    if (changed) saveSettingsDebounced();
    return changed;
}

async function applyCustomConnection(connection) {
    if (!connection || typeof connection !== 'object') return false;
    const settings = SillyTavern.getContext().chatCompletionSettings;
    if (!settings) return false;
    let changed = false;

    let secretRotated = false;
    if (Object.hasOwn(connection, 'url') && !presetParametersEqual(settings.custom_url, connection.url)) {
        settings.custom_url = String(connection.url ?? '');
        $('#custom_api_url_text').val(settings.custom_url).trigger('input', { source: 'snapshot' });
        changed = true;
    }
    // Switch the native active secret by its stable ID. Its value stays in
    // SillyTavern's secret store and is never read, copied, or displayed here.
    if (connection.secret?.id) {
        const secrets = Array.isArray(secret_state[SECRET_KEYS.CUSTOM]) ? secret_state[SECRET_KEYS.CUSTOM] : [];
        const target = secrets.find(secret => secret.id === connection.secret.id);
        if (!target) {
            toastr.warning(`找不到自定义 API 密钥“${connection.secret.label || connection.secret.id}”，已保留当前密钥。`, '一键快照');
        } else if (!target.active) {
            await rotateSecret(SECRET_KEYS.CUSTOM, target.id);
            changed = true;
            secretRotated = true;
        }
    }
    if (changed) {
        saveSettingsDebounced();
        // rotateSecret triggers a native main-API refresh itself. If the
        // secret was already active, refresh once after changing the URL so
        // the model list and connection indicator use the final endpoint.
        if (!secretRotated) $('#api_button_openai').trigger('click');
    }
    return changed;
}

function applyProxyPreset(name) {
    if (!name) return false;
    const select = $('#openai_proxy_preset');
    const option = select.find('option').filter((_, item) => String(item.value) === String(name));
    if (!option.length) {
        toastr.warning(`找不到代理预设“${name}”，已保留当前代理。`, '一键快照');
        return false;
    }
    if (String(select.val()) === String(name)) return false;
    select.val(name).trigger('change');
    return true;
}

async function applyApiState(state) {
    if (!state?.chatCompletion) return false;
    let changed = false;
    if (main_api !== 'openai') {
        const selector = $('#main_api');
        if (!selector.find('option[value="openai"]').length) {
            toastr.warning('未找到聊天补全 API，已跳过 API 快照。', '一键快照');
            return false;
        }
        selector.val('openai').trigger('change');
        changed = true;
    }
    // Changing a source and a named proxy both start SillyTavern's native
    // status check. Apply the proxy first, then change the source: the source
    // handler cancels that earlier check and reconnects once with the final
    // proxy/source pair instead of leaving two checks racing for the status.
    // Custom has no proxy-preset backing file, so never touch that control.
    const source = state.chatCompletion.values?.chat_completion_source;
    if (source !== 'custom') changed = applyProxyPreset(state.chatCompletion.proxyPreset) || changed;
    changed = applyOpenAIConnectionState(state.chatCompletion.values) || changed;
    if (source === 'custom') changed = (await applyCustomConnection(state.chatCompletion.customConnection)) || changed;
    for (const type of API_TEMPLATE_TYPES) {
        changed = (await selectPresetReference(type, state.templates?.[type])) || changed;
    }
    return changed;
}

function apiStateLines(state) {
    if (!state) return [];
    const lines = [`主 API：${API_MAIN_LABELS.openai}`];
    if (state.chatCompletion?.values?.chat_completion_source) lines.push(`聊天补全来源：${state.chatCompletion.values.chat_completion_source}`);
    if (state.chatCompletion?.model) lines.push(`模型：${state.chatCompletion.model}`);
    const source = state.chatCompletion?.values?.chat_completion_source;
    if (source === 'custom' && state.chatCompletion?.customConnection?.url) lines.push(`自定义地址：${state.chatCompletion.customConnection.url}`);
    if (source === 'custom' && state.chatCompletion?.customConnection?.secret?.id) {
        lines.push(`密钥：${customSecretLabel(state.chatCompletion.customConnection.secret)}`);
    }
    if (source !== 'custom' && state.chatCompletion?.proxyPreset && state.chatCompletion.proxyPreset !== 'None') lines.push(`代理预设：${state.chatCompletion.proxyPreset}`);
    const templateLabels = { context: '上下文模板', instruct: '指令模板', sysprompt: '系统提示词', reasoning: '推理格式' };
    for (const type of API_TEMPLATE_TYPES) {
        if (state.templates?.[type]?.name) lines.push(`${templateLabels[type]}：${state.templates[type].name}`);
    }
    if (Object.hasOwn(state.chatCompletion?.values ?? {}, 'custom_prompt_post_processing')) {
        const savedValue = state.chatCompletion.values.custom_prompt_post_processing;
        const liveLabel = $('#custom_prompt_post_processing option').filter((_, option) => String(option.value) === String(savedValue)).text().trim();
        lines.push(`提示词后处理：${state.chatCompletion.promptPostProcessingLabel || liveLabel || (savedValue ? String(savedValue) : '无')}`);
    }
    return lines;
}

function currentThemeName() {
    return String($('#themes').val() ?? power_user.theme ?? '').trim();
}

function captureTheme() {
    return { name: currentThemeName() };
}

function themeNameFromPayload(payload) {
    return String(typeof payload?.theme === 'string' ? payload.theme : payload?.theme?.name ?? '').trim();
}

function isThemeManagerAvailable() {
    // Do not treat settings left behind by an uninstalled extension as an
    // active binding. The manager creates this panel as part of its startup.
    return Boolean(document.getElementById('theme-manager-panel'));
}

function themeManagerCharacterBindings() {
    if (!isThemeManagerAvailable()) return null;
    const store = extension_settings[THEME_MANAGER_EXTENSION_KEY];
    if (!store || typeof store !== 'object') return null;
    const bindings = store[THEME_MANAGER_CHARACTER_BINDINGS_KEY];
    return bindings && typeof bindings === 'object' ? bindings : null;
}

function themeManagerThemeForCharacter(avatar = currentCharacter()?.avatar) {
    if (!avatar) return '';
    return String(themeManagerCharacterBindings()?.[avatar] ?? '').trim();
}

function hasThemeManagerConflict(snapshot, character = currentCharacter()) {
    const snapshotTheme = themeNameFromPayload(snapshot?.payload);
    const managerTheme = themeManagerThemeForCharacter(character?.avatar);
    return Boolean(snapshotTheme && managerTheme && snapshotTheme !== managerTheme);
}

function setThemeManagerThemeForCharacter(avatar, themeName) {
    const bindings = themeManagerCharacterBindings();
    if (!bindings || !avatar || !themeName) return false;
    if (bindings[avatar] === themeName) return false;
    bindings[avatar] = themeName;
    saveSettingsDebounced();
    return true;
}

function removeThemeManagerThemeIfOwned(snapshot, avatar = currentCharacter()?.avatar) {
    const bindings = themeManagerCharacterBindings();
    const snapshotTheme = themeNameFromPayload(snapshot?.payload);
    if (!bindings || !avatar || !snapshotTheme || bindings[avatar] !== snapshotTheme) return false;
    delete bindings[avatar];
    saveSettingsDebounced();
    return true;
}

async function hydrateNativeTheme(name) {
    if (typeof window.baibaokuHydrateTheme !== 'function') return;
    const headers = SillyTavern.getContext?.().getRequestHeaders?.();
    if (!headers) return;
    try {
        const response = await fetch('/api/plugins/baibaoku/v1/themes/get', {
            method: 'POST', headers, body: JSON.stringify({ name }),
        });
        const payload = response.ok ? await response.json() : null;
        if (payload?.ok && payload.data) window.baibaokuHydrateTheme(payload.data);
    } catch {
        // The optional lazy-theme bridge is not part of the snapshot feature.
    }
}

async function applyTheme(state) {
    const name = themeNameFromPayload({ theme: state });
    if (!name) return false;
    const select = $('#themes');
    if (!select.find('option').filter((_, option) => String(option.value) === name).length) {
        toastr.warning(`找不到美化主题“${name}”，已跳过该部分。`, '一键快照');
        return false;
    }
    if (String(select.val()) === name) return false;
    await hydrateNativeTheme(name);
    // Theme Manager listens with addEventListener rather than jQuery. Match
    // its own switching path so the manager's selected tile, background hook,
    // and SillyTavern's complete native theme application all stay in sync.
    const nativeSelect = select.get(0);
    nativeSelect.value = name;
    nativeSelect.dispatchEvent(new Event('change'));
    return true;
}

function updateRenamedThemeReferences(previousName, nextName) {
    if (!previousName || !nextName || previousName === nextName) return;
    let changed = false;
    for (const snapshot of settings().snapshots) {
        if (!snapshot.scopes?.theme || themeNameFromPayload(snapshot.payload) !== previousName) continue;
        if (typeof snapshot.payload?.theme === 'string') snapshot.payload.theme = { name: nextName };
        else {
            snapshot.payload ??= {};
            snapshot.payload.theme ??= {};
            snapshot.payload.theme.name = nextName;
        }
        changed = true;
    }
    // Theme Manager stores the binding by display name too. Keep its own
    // role bindings valid when that manager renames a theme in place.
    const managerBindings = themeManagerCharacterBindings();
    if (managerBindings) {
        for (const [avatar, themeName] of Object.entries(managerBindings)) {
            if (themeName !== previousName) continue;
            managerBindings[avatar] = nextName;
            changed = true;
        }
    }
    if (changed) saveSettingsDebounced();
}

function installThemeRenameObserver() {
    const select = document.querySelector('#themes');
    if (!select || select === observedThemeSelect) return;
    themeOptionObserver?.disconnect();
    observedThemeSelect = select;
    for (const option of select.options) observedThemeOptionNames.set(option, String(option.value ?? ''));
    themeOptionObserver = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes' && record.target instanceof HTMLOptionElement) {
                const previousName = observedThemeOptionNames.get(record.target) ?? '';
                const nextName = String(record.target.value ?? '');
                updateRenamedThemeReferences(previousName, nextName);
                observedThemeOptionNames.set(record.target, nextName);
            }
            if (record.type === 'childList') {
                for (const node of record.addedNodes) {
                    if (node instanceof HTMLOptionElement) observedThemeOptionNames.set(node, String(node.value ?? ''));
                    if (node instanceof HTMLElement) {
                        for (const option of node.querySelectorAll?.('option') ?? []) observedThemeOptionNames.set(option, String(option.value ?? ''));
                    }
                }
            }
        }
    });
    themeOptionObserver.observe(select, { subtree: true, childList: true, attributes: true, attributeFilter: ['value'] });
}

/**
 * The key BaiBai files a regex scope's grouping under.
 *
 * It keeps one grouping per scope rather than one for everything, so the
 * global list, each character's local rules and each preset's rules all have
 * their own -- reading the wrong key silently yields no groups at all.
 *
 * @param {string} sourceKey One of `global`, `scoped`, `preset`
 * @param {object} context The snapshot's recorded regex context
 * @returns {string}
 */
function regexGroupScopeKey(sourceKey, context = {}) {
    if (sourceKey === 'scoped') return `scoped:${context.characterAvatar || 'none'}`;
    if (sourceKey === 'preset') return `preset:${context.presetApi || getCurrentPresetAPI()}:${context.presetName || ''}`;
    return 'global';
}

/**
 * Regex script grouping, from whichever provider is installed.
 *
 * BaiBai stores `scopes[key] = {groups: [{id, name}], scripts: {id: {groupId}}}`
 * under `extension_settings.baiBaiToolkit.regexListGroups`; PT stores one flat
 * list whose groups carry a `scope` of `global` / `scoped` / `preset`. Neither
 * group has an `enabled` flag, unlike their worldbook and preset groups, so
 * this is a display grouping with no switch behind it to reproduce on apply.
 *
 * @param {string} sourceKey One of `global`, `scoped`, `preset`
 * @param {object} context The snapshot's recorded regex context
 * @returns {Map<string, string>} Script id to group name
 */
function regexGroupMap(sourceKey, context = {}) {
    const result = new Map();

    // Note the casing: this is `baiBaiToolkit` in the extension settings, while
    // the copy saved into a preset is `baibaiToolkit`.
    const state = extension_settings?.baiBaiToolkit?.regexListGroups?.scopes?.[regexGroupScopeKey(sourceKey, context)];
    if (state) {
        const names = new Map((state.groups ?? []).map(group => [String(group?.id ?? ''), group?.name || '未命名分组']));
        for (const [id, meta] of Object.entries(state.scripts ?? {})) {
            const name = names.get(String(meta?.groupId ?? ''));
            if (name) result.set(String(id), name);
        }
        if (result.size) return result;
    }

    const groupings = extension_settings?.presetTransfer?.regexScriptGroupings
        ?? extension_settings?.['preset-transfer']?.regexScriptGroupings;
    for (const group of groupings?.groups ?? []) {
        if (group?.scope && group.scope !== sourceKey) continue;
        for (const id of group?.memberIds ?? group?.members ?? group?.entries ?? []) {
            result.set(String(id), group?.name || '未命名分组');
        }
    }
    return result;
}

/**
 * The regex scripts belonging to a character or a preset that is not loaded.
 *
 * Both live in data the browser already has -- the character card and the
 * preset object -- so a snapshot can be built for a character or preset the
 * user is not currently using. Applying it stays gated on actually being there,
 * which `applyRegex` already checks.
 *
 * @param {string} type One of SCRIPT_TYPES
 * @param {string} owner Character avatar, or preset name
 * @returns {{id: string, scriptName?: string}[]}
 */
function regexScriptsOf(type, owner) {
    if (type === SCRIPT_TYPES.SCOPED) {
        const character = (characters ?? []).find(item => item.avatar === owner);
        const scripts = character?.data?.extensions?.regex_scripts;
        return Array.isArray(scripts) ? scripts : [];
    }
    if (type === SCRIPT_TYPES.PRESET) {
        const preset = getPresetManager()?.getCompletionPresetByName?.(owner);
        const scripts = preset?.extensions?.regex_scripts;
        return Array.isArray(scripts) ? scripts : [];
    }
    return getScriptsByType(type);
}

/** The three regex source keys, paired with the script type each reads. */
const REGEX_SCOPE_TYPES = [['global', SCRIPT_TYPES.GLOBAL], ['scoped', SCRIPT_TYPES.SCOPED], ['preset', SCRIPT_TYPES.PRESET]];

function captureRegexSource(type) {
    return {
        scripts: getScriptsByType(type).map(script => ({
            id: script.id,
            label: script.scriptName || script.id,
            enabled: !script.disabled,
        })),
    };
}

function captureRegex(includedSources) {
    const character = currentCharacter();
    const api = getCurrentPresetAPI();
    const presetName = getCurrentPresetName();
    const sources = {};
    if (includedSources?.global) sources.global = captureRegexSource(SCRIPT_TYPES.GLOBAL);
    if (includedSources?.scoped) {
        sources.scoped = {
            ...captureRegexSource(SCRIPT_TYPES.SCOPED),
            allowed: isScopedScriptsAllowed(character),
        };
    }
    if (includedSources?.preset) {
        sources.preset = {
            ...captureRegexSource(SCRIPT_TYPES.PRESET),
            allowed: isPresetScriptsAllowed(api, presetName),
        };
    }
    return {
        context: {
            characterAvatar: character?.avatar ?? null,
            presetApi: api,
            presetName,
        },
        sources,
    };
}

async function applyRegexSource(type, source) {
    if (!source || !Array.isArray(source.scripts)) return false;
    const desiredEnabled = new Map(source.scripts.map(script => [script.id, !!script.enabled]));
    const scripts = getScriptsByType(type);
    let changed = false;
    for (const script of scripts) {
        if (!desiredEnabled.has(script.id)) continue;
        const enabled = desiredEnabled.get(script.id);
        if (!!script.disabled !== !enabled) {
            script.disabled = !enabled;
            changed = true;
        }
    }
    // Do not write or reload anything when the source already matches. New
    // scripts which were not present when the snapshot was created are left
    // untouched rather than being unexpectedly disabled.
    if (changed) await saveScriptsByType(scripts, type);
    return changed;
}

function refreshRegexPanel() {
    const containers = new Map([
        [SCRIPT_TYPES.GLOBAL, '#saved_regex_scripts'],
        [SCRIPT_TYPES.SCOPED, '#saved_scoped_scripts'],
        [SCRIPT_TYPES.PRESET, '#saved_preset_scripts'],
    ]);
    for (const [type, container] of containers) {
        for (const script of getScriptsByType(type)) {
            const scriptElement = document.getElementById(script.id);
            if (scriptElement?.closest(container)) $(scriptElement).find('.disable_regex').prop('checked', !!script.disabled);
        }
    }
    $('#regex_scoped_toggle').prop('checked', isScopedScriptsAllowed(currentCharacter()));
    $('#regex_preset_toggle').prop('checked', isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()));
}

async function reloadChatForRegexChange() {
    const chatId = String(getCurrentChatId() ?? '');
    if (!chatId) return;
    // SillyTavern's reload mutex deliberately drops a request while another
    // reload is in flight. Regex changes must still get one render once that
    // earlier reload is finished; otherwise the panel changes but the visible
    // chat keeps the old scoped-rule result.
    for (let attempt = 0; attempt < 3; attempt++) {
        let waitCount = 0;
        while (reloadChatMutex.isBusy && waitCount++ < 100) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (String(getCurrentChatId() ?? '') !== chatId) return;
        await reloadCurrentChat();
        if (!reloadChatMutex.isBusy) return;
    }
}

async function applyRegex(state) {
    if (!state?.sources) return;
    const context = state.context ?? {};
    let changed = false;
    changed = await applyRegexSource(SCRIPT_TYPES.GLOBAL, state.sources.global) || changed;

    const character = currentCharacter();
    if (state.sources.scoped && context.characterAvatar && context.characterAvatar === character?.avatar) {
        const shouldAllow = state.sources.scoped.allowed === true;
        if (isScopedScriptsAllowed(character) !== shouldAllow) {
            if (shouldAllow) allowScopedScripts(character);
            else disallowScopedScripts(character);
            changed = true;
        }
        changed = await applyRegexSource(SCRIPT_TYPES.SCOPED, state.sources.scoped) || changed;
    }

    const api = getCurrentPresetAPI();
    const presetName = getCurrentPresetName();
    if (state.sources.preset && context.presetApi === api && context.presetName === presetName) {
        const shouldAllow = state.sources.preset.allowed === true;
        if (isPresetScriptsAllowed(api, presetName) !== shouldAllow) {
            if (shouldAllow) allowPresetScripts(api, presetName);
            else disallowPresetScripts(api, presetName);
            changed = true;
        }
        changed = await applyRegexSource(SCRIPT_TYPES.PRESET, state.sources.preset) || changed;
    }
    if (changed) {
        refreshRegexPanel();
        // Match the native regex panel: message DOM has already been
        // transformed by the previous rule set, so it must be rendered from
        // the stored chat once after any actual regex-state change. The
        // helper waits out a concurrent native reload instead of losing this
        // request to SillyTavern's non-queueing reload mutex.
        await reloadChatForRegexChange();
    }
}

function captureGreetingCatalog(character = currentCharacter()) {
    if (!character) return null;
    const data = character.data ?? {};
    return {
        hasFirstMes: Object.hasOwn(character, 'first_mes'),
        firstMes: character.first_mes,
        hasAlternateGreetings: Object.hasOwn(data, 'alternate_greetings'),
        alternateGreetings: deepClone(data.alternate_greetings ?? []),
    };
}

function restoreGreetingCatalog(catalog, character = currentCharacter()) {
    if (!catalog || !character) return false;
    let changed = false;
    if (catalog.hasFirstMes) {
        if (character.first_mes !== catalog.firstMes) {
            character.first_mes = catalog.firstMes;
            changed = true;
        }
    } else if (Object.hasOwn(character, 'first_mes')) {
        delete character.first_mes;
        changed = true;
    }
    character.data ??= {};
    if (catalog.hasAlternateGreetings) {
        if (!presetParametersEqual(character.data.alternate_greetings, catalog.alternateGreetings)) {
            character.data.alternate_greetings = deepClone(catalog.alternateGreetings);
            changed = true;
        }
    } else if (Object.hasOwn(character.data, 'alternate_greetings')) {
        delete character.data.alternate_greetings;
        changed = true;
    }
    if (changed) select_selected_character(this_chid, { switchMenu: false });
    return changed;
}

async function applyCharacter(state, versionId = null, { persist = true, preserveGreetingCatalog = true, greetingCatalog = null } = {}) {
    const character = currentCharacter();
    if (!state || !character) return;
    if (state.avatar !== character.avatar) {
        toastr.warning(`“${state.name}”不是当前角色，已跳过角色版本。`, '一键快照');
        return;
    }
    const liveGreetingCatalog = preserveGreetingCatalog ? (greetingCatalog ?? captureGreetingCatalog(character)) : null;
    const currentExtensions = character.data?.extensions ?? {};
    const hasCurrentScopedRegex = Object.hasOwn(currentExtensions, 'regex_scripts');
    const currentScopedRegex = deepClone(currentExtensions.regex_scripts);
    const currentSnapshotExtension = deepClone(currentExtensions.one_click_snapshot ?? {});
    const data = deepClone(state.data ?? {});
    data.extensions ??= {};
    // Older saved versions may still contain regex_scripts. Always keep the
    // live card value instead: the regex panel and regex snapshot scope own
    // that data and must not be overwritten by a character-version switch.
    delete data.extensions.regex_scripts;
    if (hasCurrentScopedRegex) data.extensions.regex_scripts = currentScopedRegex;
    data.extensions.one_click_snapshot = { ...currentSnapshotExtension, versionId };
    // Ride along with the save this function already performs instead of
    // writing the character card a second time.
    if (versionId && isNameMirrorEnabled('character', character.avatar)) {
        const mirrored = characterVersions().find(version => version.id === versionId)?.name;
        if (mirrored) data.character_version = mirrored;
    }
    if (preserveGreetingCatalog) {
        if (liveGreetingCatalog?.hasAlternateGreetings) data.alternate_greetings = deepClone(liveGreetingCatalog.alternateGreetings);
        else delete data.alternate_greetings;
    }
    if (versionId) settings().activeCharacterVersions[character.avatar] = versionId;
    else delete settings().activeCharacterVersions[character.avatar];
    const characterUpdate = {
        description: state.description,
        personality: state.personality,
        scenario: state.scenario,
        mes_example: state.mes_example,
        talkativeness: state.talkativeness,
        data,
    };
    // Do not even assign this field while preserving. Omitting it prevents an
    // incomplete or legacy version object from turning a live greeting into
    // undefined before the safety restore runs.
    if (!preserveGreetingCatalog) characterUpdate.first_mes = state.first_mes;
    Object.assign(character, characterUpdate);
    select_selected_character(this_chid, { switchMenu: false });
    if (persist) {
        // SillyTavern rebuilds chat[0] from first_mes and alternate_greetings
        // when a character is saved before the first reply. A snapshot must
        // never rewrite that already-opened greeting: it would shift the
        // swipe indexes and invalidate greeting-to-snapshot bindings. Its
        // native "newChat" marker skips only that regeneration branch while
        // still saving the card for an explicit, manual application.
        await createOrEditCharacter(new CustomEvent('newChat'));
    }
    if (versionId) syncVersionAvatarToGallery('character', currentCharacterVersion());
    refreshVersionIndicators();
}

async function applyPersona(state, versionId = null) {
    if (!state?.avatar) return;
    power_user.personas ??= {};
    power_user.persona_descriptions ??= {};
    const descriptor = deepClone(state.descriptor ?? {});
    descriptor.extensions ??= {};
    descriptor.extensions.one_click_snapshot = { versionId };
    if (versionId) settings().activePersonaVersions[state.avatar] = versionId;
    else delete settings().activePersonaVersions[state.avatar];
    if (state.name) power_user.personas[state.avatar] = state.name;
    power_user.persona_descriptions[state.avatar] = descriptor;
    power_user.persona_description = descriptor.description ?? '';
    power_user.persona_description_position = descriptor.position ?? power_user.persona_description_position;
    power_user.persona_description_depth = descriptor.depth ?? power_user.persona_description_depth;
    power_user.persona_description_role = descriptor.role ?? power_user.persona_description_role;
    power_user.persona_description_lorebook = descriptor.lorebook ?? power_user.persona_description_lorebook;
    await setUserAvatar(state.avatar, { toastPersonaNameChange: false });
    setPersonaDescription();
    saveSettingsDebounced();
    if (versionId) syncVersionAvatarToGallery('persona', currentPersonaVersion());
    refreshVersionIndicators();
}

async function applyWorldInfo(state, { excludedSources = new Set() } = {}) {
    if (!state) return;
    if (Array.isArray(state.globalSelected)) {
        const chosen = state.globalSelected.filter(name => world_names.includes(name));
        $('#world_info').val(chosen.map(name => String(world_names.indexOf(name))));
        // This function is also a slash-command handler. Passing its native
        // sentinel avoids it trying to read args.silent from undefined.
        onWorldInfoChange('__notSlashCommand__');
    }
    let warnedAboutPtGate = false;
    for (const book of state.books ?? []) {
        const sources = Array.isArray(book.sources) ? book.sources : [];
        // A book can be mounted from several places. Keep it when at least
        // one of those places is compatible with the current chat.
        if (sources.length && !sources.some(source => !excludedSources.has(source))) continue;
        if (!world_names.includes(book.name)) continue;
        let data = await loadWorldInfo(book.name);
        if (!data?.entries) continue;
        const orderedUids = Object.entries(data.entries)
            .sort(([, a], [, b]) => Number(a?.displayIndex ?? 0) - Number(b?.displayIndex ?? 0))
            .map(([uid]) => String(uid));
        const savedGates = Array.isArray(book.ptGates) ? book.ptGates : [];
        const currentGates = getPresetTransferWorldbookEntryGates(book.name, orderedUids, data);
        const protectedUids = new Set(currentGates.filter(gate => !gate.enabled).flatMap(gate => gate.uids));
        // What the snapshot says should actually be in effect. A group gate is
        // derived from this rather than restored from the recorded gate state:
        // the snapshot stores the effective switches, so a group holding
        // anything that must be on has to be gated on for that to be reachable.
        const wantedUids = new Set((book.entries ?? []).filter(entry => entry.enabled).map(entry => String(entry.uid)));

        // Stock preset-transfer groups worldbook entries but has no group
        // switch, so every gate reads as open and there is nothing to
        // reproduce. Engaging this path there would warn about a feature that
        // build does not have and skip every grouped entry, which is most of
        // them. Only a build that actually has the switch -- or a library that
        // already has one closed -- gets the gate treatment.
        const ptSetGate = window.PT_setWorldbookGroupGate;
        const hasGateControl = typeof ptSetGate === 'function';
        const hasClosedGate = savedGates.some(gate => !gate.enabled) || currentGates.some(gate => !gate.enabled);

        if (savedGates.length && (hasGateControl || hasClosedGate)) {
            if (hasGateControl) {
                for (const gate of savedGates) {
                    const members = gate.uids.filter(uid => orderedUids.includes(String(uid))).map(String);
                    if (!members.length) continue;
                    const wanted = members.some(uid => wantedUids.has(uid));
                    const ok = await ptSetGate(book.name, gate.id, !wanted, members, orderedUids);
                    // A group the snapshot leaves entirely off is gated off and
                    // then left alone: the snapshot only says it should not be
                    // in effect, which the closed gate already achieves, and
                    // rewriting the switches underneath would throw away a
                    // grouping the user set up for their own reasons.
                    if (ok && wanted) members.forEach(uid => protectedUids.delete(uid));
                    else members.forEach(uid => protectedUids.add(uid));
                }
                // PT's own setter persists grouping metadata. Reload the file
                // before touching individual entry switches so we never write
                // a stale, grouping-less object back over it.
                data = await loadWorldInfo(book.name);
            } else {
                // A closed gate exists but the setter is not there to move it.
                // Those groups are left exactly as they are: preserving a gate
                // the user set is safer than flattening it. Only the affected
                // groups are skipped, never every grouped entry.
                if (!warnedAboutPtGate) {
                    toastr.warning('预设转移的分组开关尚未就绪，已跳过被关闭的分组以保护它们的状态。', '一键快照');
                    warnedAboutPtGate = true;
                }
            }
        }
        if (!data?.entries) continue;
        let changed = false;
        for (const saved of book.entries ?? []) {
            const entry = data.entries[saved.uid];
            if (!entry || protectedUids.has(String(saved.uid))) continue;
            // A closed PT gate already controls effective enablement. Restore
            // the underlying per-entry state without turning that group into
            // a pile of permanently disabled entries.
            const desiredEnabled = saved.enabled;
            if (!!entry.disable === !!desiredEnabled) {
                entry.disable = !desiredEnabled;
                changed = true;
            }
        }
        if (changed) await saveWorldInfo(book.name, data, true);
    }
}

function snapshotPresetValue(manager, state) {
    if (!manager || !state) return { found: false, value: null };
    const select = $(manager.select);
    const name = String(state.presetName ?? '').trim();
    // Completion-preset option values are often array indexes. Preset
    // Transfer can reorder those indexes, while the visible preset name still
    // identifies the intended preset. Never use an old index when a saved
    // name exists but no longer resolves: selecting an unrelated preset is
    // worse than safely skipping this snapshot scope.
    if (name && name !== '未选择预设') {
        const option = select.find('option').filter((_, item) => String($(item).text()) === name).first();
        return option.length ? { found: true, value: option.val() } : { found: false, value: null };
    }
    // Very old snapshots did not store a name. Keep their legacy behavior,
    // but only if that exact option value still exists in the live selector.
    if (state.presetValue === null || state.presetValue === undefined) return { found: false, value: null };
    const option = select.find('option').filter((_, item) => String($(item).val()) === String(state.presetValue)).first();
    return option.length ? { found: true, value: option.val() } : { found: false, value: null };
}

async function applyPreset(state) {
    if (!state || state.api !== main_api) return;
    const manager = getPresetManager();
    const selectedValue = manager?.getSelectedPreset?.();
    const targetPreset = snapshotPresetValue(manager, state);
    if (manager && !targetPreset.found) {
        const label = String(state.presetName ?? '').trim();
        toastr.warning(label ? `找不到预设“${label}”，已跳过预设快照。` : '找不到快照中的预设，已跳过预设快照。', '一键快照');
        return false;
    }
    const samePreset = targetPreset.found
        && selectedValue !== null
        && selectedValue !== undefined
        && String(selectedValue) === String(targetPreset.value);
    if (manager && targetPreset.found && !samePreset) {
        // Selecting a preset starts an asynchronous native load. Waiting for
        // it is essential: otherwise that load writes the preset file's old
        // prompt_order over the snapshot state we just restored.
        const presetLoaded = main_api === 'openai'
            ? new Promise(resolve => eventSource.once(event_types.OAI_PRESET_CHANGED_AFTER, resolve))
            : null;
        manager.selectPreset(targetPreset.value);
        if (presetLoaded) await presetLoaded;
    }
    // Do this after selecting the preset: native selection loads its current
    // file values first, then the snapshot restores its saved switch state.
    // When everything already matches, applyPresetParameters performs no UI
    // writes and therefore cannot cause an unnecessary preset reload.
    applyPresetParameters(state.parameters);
    const savedPromptEntries = Array.isArray(state.promptEntries)
        ? state.promptEntries
        // Older snapshots recorded the complete order. Reinterpret that
        // record as switch state instead of restoring its old content/order.
        : Array.isArray(state.promptOrder)
            ? state.promptOrder.flatMap(list => (list?.order ?? []).map(item => ({ identifier: item.identifier, enabled: !!item.enabled })))
            : null;
    if (main_api === 'openai' && savedPromptEntries) {
        const context = SillyTavern.getContext();
        // This runs after a changed preset has completed its native load, so
        // renamed or edited entries retain their current content. Reloading
        // the same preset is still avoided above.
        const enabledByIdentifier = new Map(savedPromptEntries.map(entry => [entry.identifier, !!entry.enabled]));

        // Group switches are derived rather than restored, for the same reason
        // as the worldbook ones: the snapshot records what was in effect, so a
        // group holding anything that must be on has to be switched on for that
        // to be reachable. A group the snapshot leaves entirely off is switched
        // off and its own entries are left exactly as the user arranged them --
        // the closed switch already achieves what the snapshot asked for.
        const skipped = new Set();
        let gateChanged = false;
        const liveGroupState = presetPromptGroupState(context.chatCompletionSettings);
        // Only when the provider's groups already carry the switch. A build
        // that merely groups prompts has no such concept, and writing the flag
        // in would put a field it never asked for into its own settings.
        const hasGroupSwitch = (liveGroupState?.groups ?? []).some(group => typeof group?.enabled === 'boolean');
        if (liveGroupState && hasGroupSwitch && Array.isArray(state.promptGates)) {
            // The stored copy is written too, so the choice survives the next
            // time the provider reloads its runtime state from disk.
            const storedGroups = context.chatCompletionSettings?.extensions?.baibaiToolkit?.presetPromptGroups?.groups;
            for (const gate of presetPromptGroupGates(context.chatCompletionSettings)) {
                const wanted = gate.identifiers.some(identifier => enabledByIdentifier.get(identifier) === true);
                for (const groups of [liveGroupState.groups, storedGroups]) {
                    const group = (groups ?? []).find(item => String(item?.id ?? '') === gate.id);
                    if (!group || group.enabled === wanted) continue;
                    group.enabled = wanted;
                    gateChanged = true;
                }
                if (!wanted) gate.identifiers.forEach(identifier => skipped.add(identifier));
            }
        }

        let changed = false;
        for (const list of context.chatCompletionSettings.prompt_order ?? []) {
            for (const item of list.order ?? []) {
                if (!enabledByIdentifier.has(item.identifier) || skipped.has(String(item.identifier))) continue;
                const enabled = enabledByIdentifier.get(item.identifier);
                if (!!item.enabled !== enabled) {
                    item.enabled = enabled;
                    changed = true;
                }
            }
        }
        // The gate alone counts as a change: the prompt manager has to redraw
        // for a group that just closed to stop showing as active.
        if (changed || gateChanged) {
            saveSettingsDebounced();
            await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        }
    }
}

function validateSnapshotVersionScopes(scopes) {
    // "No version yet" and "nothing selected to have a version" need different
    // wording: telling someone to go create a version is useless advice when
    // they have not opened a character at all.
    const missing = [];
    const unselected = [];
    if (scopes.character && !currentCharacterVersion()) {
        if (!currentCharacter()) unselected.push('角色');
        else missing.push(characterVersions().length ? '角色尚未应用已保存版本' : '角色尚未创建版本');
    }
    if (scopes.persona && !currentPersonaVersion()) {
        if (!user_avatar) unselected.push('用户');
        else missing.push(personaVersions().length ? '用户尚未应用已保存版本' : '用户尚未创建版本');
    }
    if (unselected.length) {
        toastr.warning(`还没有选择${unselected.join('和')}，无法记录${unselected.join('和')}版本。`, '一键快照');
        return false;
    }
    if (!missing.length) return true;
    toastr.warning(`${missing.join('；')}，请先在“更多”中完成版本管理后再保存快照。`, '一键快照');
    return false;
}

/**
 * Creates a version from the current description when a snapshot is about to
 * record a version reference and there is none yet.
 *
 * Without this the character / persona scope quietly stores `versionId: null`,
 * and applying that snapshot does nothing at all for those scopes — the user
 * has to know to go build a version by hand first.
 *
 * @param {'character'|'persona'} type Version type
 * @returns {boolean} Whether a version was created
 */
/**
 * Builds an "初始版本" for a character or user that has none yet.
 *
 * Unlike `ensureVersionForSnapshot` this works on any avatar, not just the one
 * currently open: the content editor lets a snapshot be pointed at somebody
 * else, and that somebody may never have had a version made for them.
 *
 * @param {'character'|'persona'} type Which library to add to
 * @param {string} avatar Owner avatar
 * @returns {{id: string, name: string}|null} The new version, or null
 */
function createInitialVersionFor(type, avatar) {
    if (!avatar) return null;

    let state = null;
    if (type === 'character') {
        const character = (characters ?? []).find(item => item.avatar === avatar);
        if (!character) return null;
        const data = deepClone(character.data ?? {});
        // Same exclusions as a normal capture: scoped regex, the greeting
        // catalog and our own metadata are card-level resources, not version
        // content, and a version must never freeze a copy of them.
        if (data.extensions) delete data.extensions.regex_scripts;
        delete data.alternate_greetings;
        delete data.extensions?.one_click_snapshot;
        state = {
            avatar,
            name: character.name,
            description: character.description ?? '',
            personality: character.personality ?? '',
            scenario: character.scenario ?? '',
            mes_example: character.mes_example ?? '',
            talkativeness: character.talkativeness,
            data,
        };
    } else {
        if (!power_user.personas?.[avatar]) return null;
        state = {
            avatar,
            name: String(power_user.personas[avatar] ?? ''),
            descriptor: deepClone(power_user.persona_descriptions?.[avatar] ?? {}),
        };
    }

    const store = type === 'character' ? settings().characterVersions : settings().personaVersions;
    store[avatar] ??= [];
    const version = { id: makeId(), createdAt: Date.now(), updatedAt: Date.now(), name: '初始版本', data: state, group: '' };
    store[avatar].push(version);
    // Only made active when this is the owner currently open; pointing the live
    // selection at somebody else's version would be nonsense.
    const active = type === 'character' ? settings().activeCharacterVersions : settings().activePersonaVersions;
    const openAvatar = type === 'character' ? currentCharacter()?.avatar : user_avatar;
    if (openAvatar === avatar) active[avatar] = version.id;
    return version;
}

function ensureVersionForSnapshot(type) {
    if (!feature('version.autoInitial')) return false;
    const existing = type === 'character' ? currentCharacterVersion() : currentPersonaVersion();
    if (existing) return false;

    const state = captureVersionFormState(type);
    if (!state?.avatar) return false;

    const context = versionContext(type);
    const version = { id: makeId(), createdAt: Date.now(), updatedAt: Date.now(), name: '初始版本', data: state, group: '' };
    context.list.push(version);
    if (type === 'character') settings().activeCharacterVersions[state.avatar] = version.id;
    else settings().activePersonaVersions[state.avatar] = version.id;
    refreshVersionIndicators();
    toastr.info(`已为${type === 'character' ? '角色' : '用户'}新建「初始版本」。`, '一键快照');
    return true;
}

async function buildSnapshot(name, scopes) {
    // Before validating, not after: the check below refuses to build a snapshot
    // when a version scope has no version, so creating one has to happen first
    // or the setting could never take effect.
    if (scopes.character) ensureVersionForSnapshot('character');
    if (scopes.persona) ensureVersionForSnapshot('persona');
    if (!validateSnapshotVersionScopes(scopes)) return null;
    const character = scopes.character ? currentCharacter() : null;
    const persona = scopes.persona && user_avatar ? {
        avatar: user_avatar,
        name: power_user.personas?.[user_avatar] ?? '',
    } : null;
    const snapshot = {
        id: makeId(), name: name.trim() || `快照 ${new Date().toLocaleString()}`,
        createdAt: Date.now(), updatedAt: Date.now(), scopes,
        payload: {
            // Version snapshots keep a stable version ID plus the owning
            // character/persona reference. Their mutable content lives in
            // the version itself, so later edits are naturally reflected.
            character: character ? { versionId: currentCharacterVersion()?.id ?? null, versionName: currentCharacterVersion()?.name ?? '当前未命名状态', data: { avatar: character.avatar, name: character.name } } : null,
            persona: persona ? { versionId: currentPersonaVersion()?.id ?? null, versionName: currentPersonaVersion()?.name ?? '当前未命名状态', data: persona } : null,
            theme: scopes.theme ? captureTheme() : null,
            worldInfo: scopes.worldInfo ? await captureWorldInfo(scopes.worldSources) : null,
            preset: scopes.preset ? capturePreset() : null,
            api: scopes.api ? captureApiState() : null,
            regex: scopes.regex ? captureRegex(scopes.regexSources) : null,
        },
    };
    return snapshot;
}

async function createSnapshot(name, scopes, group = '') {
    const snapshot = await buildSnapshot(name, scopes);
    if (!snapshot) return null;
    snapshot.group = group;
    settings().snapshots.push(snapshot);
    saveSettingsDebounced();
    return snapshot;
}

/** The scopes a snapshot can hold, in the order they are shown. */
const SNAPSHOT_SCOPE_LABELS = {
    character: '角色版本',
    persona: '用户版本',
    theme: '界面美化',
    worldInfo: '世界书与条目',
    preset: '预设与条目',
    api: '聊天补全 API',
    regex: '正则规则',
};

/** Scopes that store a version reference rather than content. */
const VERSION_SCOPES = new Set(['character', 'persona']);

/**
 * Refreshes only the named scopes of a snapshot from the current state.
 *
 * The whole point is that everything else is left alone: rebuilding the entire
 * snapshot — which is what a plain update does — would drag the current preset,
 * API and theme into a snapshot the user only wanted to add a lorebook to.
 *
 * Each scope is recaptured with that snapshot's *own* source configuration, so
 * a snapshot that deliberately captures only the global lorebooks keeps doing
 * exactly that.
 *
 * @param {object} snapshot Snapshot to modify in place
 * @param {string[]} scopeKeys Scopes to refresh
 * @param {object} [options]
 * @param {boolean} [options.addMissing=false] Also refresh scopes the snapshot does not currently hold
 * @returns {Promise<boolean>} Whether anything changed
 */
async function refreshSnapshotScopes(snapshot, scopeKeys, { addMissing = false, worldSources = null, regexSources = null } = {}) {
    // Without "add missing", a picked scope only applies to snapshots that
    // already record it, so a batch never cross-contaminates.
    const applicable = scopeKeys.filter(key => addMissing || snapshot.scopes?.[key] === true);
    if (!applicable.length) return false;

    const captureScopes = deepClone(snapshot.scopes ?? {});
    for (const key of applicable) captureScopes[key] = true;
    // Explicit sub-sources win; otherwise the snapshot keeps capturing from
    // exactly the places it captured from before.
    if (worldSources && Object.keys(worldSources).length) captureScopes.worldSources = worldSources;
    if (regexSources && Object.keys(regexSources).length) captureScopes.regexSources = regexSources;
    // Capture only what we are about to write, so an unrelated scope cannot
    // fail validation and abort the whole refresh.
    for (const key of Object.keys(SNAPSHOT_SCOPE_LABELS)) {
        if (!applicable.includes(key)) captureScopes[key] = false;
    }

    const fresh = await buildSnapshot(snapshot.name, normalizedSnapshotScopes(captureScopes));
    if (!fresh) return false;

    snapshot.payload ??= {};
    snapshot.scopes ??= {};
    for (const key of applicable) {
        snapshot.payload[key] = fresh.payload[key];
        snapshot.scopes[key] = true;
    }
    if (applicable.includes('worldInfo') && worldSources && Object.keys(worldSources).length) snapshot.scopes.worldSources = worldSources;
    if (applicable.includes('regex') && regexSources && Object.keys(regexSources).length) snapshot.scopes.regexSources = regexSources;
    snapshot.updatedAt = Date.now();
    return true;
}

/** Sub-sources the world info and regex scopes can be narrowed to. */
const WORLD_SOURCE_LABELS = { global: '全局世界书', characterMain: '角色主世界书', characterExtra: '角色附加世界书', user: '用户绑定世界书', chat: '聊天世界书' };
const REGEX_SOURCE_LABELS = { global: '全局正则', scoped: '角色局部正则', preset: '当前预设正则' };

/**
 * Asks which scopes to refresh, and for the two scopes that have sub-sources,
 * which of those to include.
 *
 * @param {object} options
 * @param {string} options.title Popup title
 * @param {string} options.hint Explanation shown above the list
 * @param {string[]} options.candidates Scopes to offer, in display order
 * @param {object} options.sources Source maps to pre-tick from (`worldSources`, `regexSources`)
 * @param {string[]} [options.preselected] Scopes to pre-tick
 * @param {Map<string, number>} [options.counts] How many targets already hold each scope
 * @param {number} [options.total] Number of targets, for the counts
 * @param {boolean} [options.confirmVersions=false] Whether to confirm re-pointing version references
 * @param {string[]} [options.extras] Scopes hidden behind the "show everything" toggle
 * @returns {Promise<{scopes: string[], worldSources: object, regexSources: object}|null>} Choice, or null when cancelled
 */
async function chooseSnapshotScopes({ title, hint, candidates, sources, preselected = [], counts = null, total = 0, confirmVersions = false, extras = [] }) {
    const root = $('<div class="ocs-scope-picker"></div>');
    const head = $('<div class="ocs-scope-picker-head"></div>').append($('<h3></h3>').text(title));
    root.append(head, $('<small></small>').text(hint));

    // Expanding to every scope is a choice about this one operation, not a
    // lasting preference — whether a missing scope may be added is the setting.
    if (extras.length) {
        const toggle = $('<label class="checkbox_label ocs-scope-extra-toggle"></label>');
        const input = $('<input type="checkbox">');
        toggle.append(input, $('<span></span>').text('显示全部范围'));
        input.on('change', function () { root.find('.ocs-scope-picker-grid').toggleClass('ocs-show-extras', this.checked); });
        head.append(toggle);
    }

    const grid = $('<div class="ocs-scope-picker-grid"></div>');
    for (const key of [...candidates, ...extras]) {
        const cell = $('<div class="ocs-scope-picker-cell"></div>').toggleClass('ocs-scope-extra', extras.includes(key));
        const row = $('<label class="checkbox_label"></label>');
        const input = $('<input type="checkbox">').attr('value', key).prop('checked', preselected.includes(key));
        row.append(input, $('<span></span>').text(SNAPSHOT_SCOPE_LABELS[key]));

        // In a batch, say up front how many of the chosen snapshots already
        // hold this scope — that is what decides whether "补上未包含的范围"
        // matters for it.
        if (counts) {
            const held = counts.get(key) ?? 0;
            row.append($('<small class="ocs-scope-count"></small>').text(`${held}/${total}`).toggleClass('is-partial', held < total));
        }
        cell.append(row);

        const labels = key === 'worldInfo' ? WORLD_SOURCE_LABELS : key === 'regex' ? REGEX_SOURCE_LABELS : null;
        if (labels) {
            const saved = key === 'worldInfo' ? sources?.worldSources : sources?.regexSources;
            const box = $('<div class="ocs-world-scope"></div>').attr('data-ocs-sources', key);
            const list = $('<div class="ocs-world-sources"></div>');
            // Only the sources these snapshots actually record. Listing the
            // rest would invite ticking one that this update has no business
            // adding — changing what is recorded is the card's job.
            const recorded = Object.keys(labels).filter(source => saved?.[source] === true);
            const shown = recorded.length ? recorded : Object.keys(labels);
            for (const source of Object.keys(labels)) {
                const isRecorded = shown.includes(source);
                // Sources nobody records are only offered where a scope may be
                // added at all, and they ride the same toggle as the scopes.
                if (!isRecorded && !extras.length) continue;
                list.append($('<label class="checkbox_label ocs-scope"></label>')
                    .toggleClass('ocs-scope-extra', !isRecorded)
                    .append($('<input type="checkbox">').attr('value', source).prop('checked', isRecorded), $('<span></span>').text(labels[source])));
            }
            box.append(list).toggleClass('is-enabled', input.prop('checked'));
            input.on('change', function () { box.toggleClass('is-enabled', this.checked); });
            cell.append(box);
        }
        grid.append(cell);
    }
    root.append(grid);

    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '更新', cancelButton: '取消' });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const scopes = root.find('.ocs-scope-picker-cell:not(.ocs-scope-extra), .ocs-show-extras .ocs-scope-extra')
        .find('> label > input:checked').map((_, input) => String($(input).val())).get();
    if (!scopes.length) {
        toastr.info('没有选择任何范围。', '一键快照');
        return null;
    }
    // Only worth asking for a batch: a single snapshot pointed at the version
    // in use is the expected result. The reference is all that moves — the
    // versions themselves stay in the version manager either way.
    if (confirmVersions && scopes.some(key => VERSION_SCOPES.has(key))) {
        const confirmed = await Popup.show.confirm(
            '确认刷新版本引用',
            '选中的快照里，凡是包含角色 / 用户版本范围的，都会被重新指向<b>当前正在使用的版本</b>。',
        );
        if (!confirmed) return null;
    }

    const readSources = scopeKey => Object.fromEntries(root
        .find(`[data-ocs-sources="${scopeKey}"] .ocs-scope:not(.ocs-scope-extra), .ocs-show-extras [data-ocs-sources="${scopeKey}"] .ocs-scope.ocs-scope-extra`)
        .find('input:checked').map((_, input) => [[String($(input).val()), true]]).get());
    return { scopes, worldSources: readSources('worldInfo'), regexSources: readSources('regex') };
}

/** The scopes a scope map holds, in display order. */
function heldScopes(scopes) {
    return Object.keys(SNAPSHOT_SCOPE_LABELS).filter(key => scopes?.[key] === true);
}

async function updateSnapshot(snapshot) {
    if (feature('snapshot.askScopeOnUpdate')) {
        // Version scopes are pre-ticked here: for a single snapshot, pointing
        // at the version in use is the expected result. Only a batch leaves
        // them off, where one choice would be forced onto many snapshots.
        const wanted = heldScopes(snapshot.scopes);
        if (!wanted.length) return false;
        const chosen = await chooseSnapshotScopes({
            title: `更新快照：${snapshot.name}`,
            hint: '勾选的范围会用当前状态覆盖，没勾的保留快照里已有的内容、不会被删除。',
            candidates: wanted,
            preselected: wanted,
            sources: snapshot.scopes,
        });
        if (!chosen) return false;
        const applied = await refreshSnapshotScopes(snapshot, chosen.scopes, {
            worldSources: chosen.worldSources,
            regexSources: chosen.regexSources,
        });
        if (!applied) return false;
        saveSettingsDebounced();
        toastr.success(`已更新快照：${snapshot.name}`, '一键快照');
        return true;
    }

    const replacement = await buildSnapshot(snapshot.name, snapshot.scopes);
    if (!replacement) return false;
    Object.assign(snapshot, replacement, { id: snapshot.id, name: snapshot.name, group: snapshot.group ?? '', createdAt: snapshot.createdAt, updatedAt: Date.now() });
    saveSettingsDebounced();
    toastr.success(`已更新快照：${snapshot.name}`, '一键快照');
    return true;
}

/**
 * Refreshes chosen scopes across many snapshots at once.
 * Answers the case of "I added one more lorebook and now every older snapshot
 * is missing it", which previously meant applying and re-saving each snapshot.
 */
/**
 * Stops a batch of snapshots from recording the chosen scopes.
 *
 * The counterpart to adding one on a card: refreshing can only ever write, so
 * without this there is no way to drop a scope from many snapshots at once.
 */
async function batchRemoveScopes(ids = []) {
    const targets = ids.map(id => getSnapshot(id)).filter(Boolean);
    if (!targets.length) return toastr.info('请先选择快照。', '一键快照');

    const counts = new Map();
    for (const snapshot of targets) {
        for (const key of heldScopes(snapshot.scopes)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const candidates = [...counts.keys()];
    if (!candidates.length) return toastr.info('选中的快照没有可移除的范围。', '一键快照');

    const root = $('<div class="ocs-scope-picker"></div>');
    root.append($('<div class="ocs-scope-picker-head"></div>').append($('<h3></h3>').text(`移除 ${targets.length} 个快照的范围`)));
    root.append($('<small></small>').text('勾选的范围会从这些快照里移除，已经记下的内容会丢失。右侧数字是包含该范围的快照数。'));
    const grid = $('<div class="ocs-scope-picker-grid"></div>');
    for (const key of candidates) {
        const cell = $('<div class="ocs-scope-picker-cell"></div>');
        const row = $('<label class="checkbox_label"></label>');
        row.append($('<input type="checkbox">').attr('value', key), $('<span></span>').text(SNAPSHOT_SCOPE_LABELS[key]));
        const held = counts.get(key) ?? 0;
        row.append($('<small class="ocs-scope-count"></small>').text(`${held}/${targets.length}`).toggleClass('is-partial', held < targets.length));
        grid.append(cell.append(row));
    }
    root.append(grid);

    if (await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '移除', cancelButton: '取消' }) !== POPUP_RESULT.AFFIRMATIVE) return;
    const keys = root.find('input:checked').map((_, input) => String($(input).val())).get();
    if (!keys.length) return toastr.info('没有选择任何范围。', '一键快照');

    const labels = keys.map(key => SNAPSHOT_SCOPE_LABELS[key]).join('、');
    if (!await Popup.show.confirm('移除记录范围', `这 ${targets.length} 个快照将不再记录${labels}，已经记下的内容会丢失。`)) return;

    let changed = 0;
    for (const snapshot of targets) {
        let touched = false;
        for (const key of keys) {
            if (snapshot.scopes?.[key] !== true) continue;
            snapshot.payload[key] = null;
            snapshot.scopes[key] = false;
            touched = true;
        }
        if (!touched) continue;
        snapshot.updatedAt = Date.now();
        changed++;
    }
    if (changed) saveSettingsDebounced();
    toastr.success(`已从 ${changed} 个快照移除${labels}。`, '一键快照');
}

async function batchUpdateSnapshots(ids = []) {
    const targets = ids.map(id => getSnapshot(id)).filter(Boolean);
    if (!targets.length) return toastr.info('请先选择快照。', '一键快照');

    // Each snapshot refreshes only the scopes it records, so a batch never
    // pushes one snapshot's scopes onto another. Only "允许给快照补上新范围"
    // changes that.
    let chosen = null;
    if (feature('snapshot.askScopeOnBatch')) {
        // Candidates are the union of those targets, which is how a scope just
        // added on one card shows up without any extra switch.
        const counts = new Map();
        for (const snapshot of targets) {
            for (const key of heldScopes(snapshot.scopes)) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        // The list is always the union; everything else hides behind the
        // "show everything" toggle, and only when adding a scope is allowed —
        // otherwise picking one of them could not do anything.
        const allowed = key => !VERSION_SCOPES.has(key) || feature('version');
        const union = Object.keys(SNAPSHOT_SCOPE_LABELS).filter(key => counts.has(key)).filter(allowed);
        const extras = feature('snapshot.addMissingScope')
            ? Object.keys(SNAPSHOT_SCOPE_LABELS).filter(key => !counts.has(key)).filter(allowed)
            : [];
        const candidates = union;
        if (!candidates.length && !extras.length) return toastr.info('选中的快照没有可更新的范围。', '一键快照');

        // Sub-sources start from the union across the targets, so a source any
        // of them records stays ticked.
        const mergedSources = { worldSources: {}, regexSources: {} };
        for (const snapshot of targets) {
            for (const bucket of ['worldSources', 'regexSources']) {
                for (const [source, on] of Object.entries(snapshot.scopes?.[bucket] ?? {})) {
                    if (on === true) mergedSources[bucket][source] = true;
                }
            }
        }

        chosen = await chooseSnapshotScopes({
            title: `刷新 ${targets.length} 个快照的范围`,
            hint: feature('snapshot.addMissingScope')
                ? '勾选的范围会用当前状态覆盖，没勾的保持原样。缺少所选范围的快照会补上该范围，右侧数字是已包含该范围的快照数。'
                : '勾选的范围会用当前状态覆盖，没勾的保持原样。每个快照只更新它自己包含的范围，右侧数字就是包含该范围的快照数。',
            candidates,
            sources: mergedSources,
            counts,
            total: targets.length,
            confirmVersions: true,
            extras,
        });
        if (!chosen) return;
    }

    const addMissing = feature('snapshot.addMissingScope');
    let changed = 0;
    let skipped = 0;
    for (const snapshot of targets) {
        const keys = chosen?.scopes ?? heldScopes(snapshot.scopes);
        const applied = keys.length && await refreshSnapshotScopes(snapshot, keys, {
            addMissing: Boolean(chosen) && addMissing,
            worldSources: chosen?.worldSources,
            regexSources: chosen?.regexSources,
        });
        if (applied) changed++;
        else skipped++;
    }

    if (changed) saveSettingsDebounced();
    toastr.success(`已更新 ${changed} 个快照${skipped ? `，跳过 ${skipped} 个（未包含所选范围）` : ''}。`, '一键快照');
}

function normalizedSnapshotScopes(scopes = {}) {
    const sourceScopes = (selected, recordedSources, defaults) => {
        if (!selected) return {};
        // A saved source map is authoritative. In particular, { global: true }
        // must stay global-only rather than silently turning into “all sources”.
        if (recordedSources && Object.keys(recordedSources).length) return deepClone(recordedSources);
        // Only legacy snapshots that predate source-level selection fall back to
        // the old all-sources behavior.
        return deepClone(defaults);
    };
    return {
        // Missing values mean that an older snapshot never recorded that
        // category. Do not quietly add newly introduced categories on update.
        character: scopes.character === true,
        persona: scopes.persona === true,
        theme: scopes.theme === true,
        worldInfo: scopes.worldInfo === true,
        preset: scopes.preset === true,
        api: scopes.api === true,
        regex: scopes.regex === true,
        worldSources: sourceScopes(scopes.worldInfo === true, scopes.worldSources, DEFAULT_CAPTURE_SCOPES.worldSources),
        regexSources: sourceScopes(scopes.regex === true, scopes.regexSources, DEFAULT_CAPTURE_SCOPES.regexSources),
    };
}

function getSnapshot(snapshotId) {
    return settings().snapshots.find(snapshot => snapshot.id === snapshotId) ?? null;
}

function currentAppliedSnapshotId() {
    const chatState = binding();
    // A manually applied snapshot is a chat state too, even when it is not
    // configured as this chat's automatic binding. Keep that state in the
    // chat metadata so reopening the library still puts it first.
    if (chatState.lastAppliedSnapshotId && getSnapshot(chatState.lastAppliedSnapshotId)) return chatState.lastAppliedSnapshotId;
    if (chatState.enabled !== false && chatState.snapshotId && getSnapshot(chatState.snapshotId)) return chatState.snapshotId;
    return null;
}

function snapshotRequirements(snapshot) {
    const payload = snapshot?.payload ?? {};
    const sources = new Set((payload.worldInfo?.books ?? []).flatMap(book => book.sources ?? []));
    const context = payload.worldInfo?.context ?? {};
    const regexContext = payload.regex?.context ?? {};
    const hasScopedRegex = Boolean(payload.regex?.sources?.scoped);
    const needsCharacter = Boolean(snapshot?.scopes?.character || sources.has('角色主世界书') || sources.has('角色附加世界书') || hasScopedRegex);
    const needsPersona = Boolean(snapshot?.scopes?.persona || sources.has('用户绑定世界书'));

    // Whose books these are, worked out from the books themselves rather than
    // from the context recorded at capture time. A snapshot assembled by hand
    // can hold a character's lorebook without ever having been taken while
    // that character was open, and the recorded context would then name the
    // wrong one -- silently passing a check that should have stopped it.
    const ownerFromBooks = (slots, ownersOf) => {
        for (const book of payload.worldInfo?.books ?? []) {
            if (!(book.sources ?? []).some(source => slots.has(source))) continue;
            const owners = ownersOf(book.name);
            // Only an unambiguous owner counts: a file shared by two characters
            // says nothing about which one this snapshot is for.
            if (owners.size === 1) return [...owners][0];
        }
        return null;
    };
    const bookCharacter = needsCharacter ? ownerFromBooks(CHARACTER_WORLD_SLOTS, characterOwnersOfBook) : null;
    const bookPersona = needsPersona ? ownerFromBooks(PERSONA_WORLD_SLOTS, personaOwnersOfBook) : null;

    const characterAvatar = payload.character?.data?.avatar
        ?? bookCharacter
        ?? (needsCharacter ? context.characterAvatar ?? regexContext.characterAvatar ?? null : null);
    const personaAvatar = payload.persona?.data?.avatar
        ?? bookPersona
        ?? (needsPersona ? context.personaAvatar ?? null : null);

    return {
        needsCharacter,
        needsPersona,
        hasChatWorldbook: sources.has('聊天世界书'),
        characterAvatar,
        characterName: payload.character?.data?.name
            ?? payload.character?.versionName
            ?? (characterAvatar ? (characters ?? []).find(item => item.avatar === characterAvatar)?.name : null)
            ?? '该快照中的角色',
        personaAvatar,
        personaName: payload.persona?.data?.name
            ?? payload.persona?.versionName
            ?? (personaAvatar ? String(power_user.personas?.[personaAvatar] ?? '') : null)
            ?? '该快照中的用户',
        chatId: context.chatId ? String(context.chatId) : null,
    };
}

function applyCompatibility(snapshot, { allowThemeOverride = false } = {}) {
    const requirements = snapshotRequirements(snapshot);
    const activeCharacter = currentCharacter()?.avatar ?? null;
    const activeChatId = String(getCurrentChatId() ?? '');
    return {
        requirements,
        characterMismatch: requirements.needsCharacter && (!requirements.characterAvatar || requirements.characterAvatar !== activeCharacter),
        personaMismatch: requirements.needsPersona && (!requirements.personaAvatar || requirements.personaAvatar !== user_avatar),
        chatMismatch: requirements.hasChatWorldbook && (!requirements.chatId || requirements.chatId !== activeChatId),
        themeMismatch: !allowThemeOverride && hasThemeManagerConflict(snapshot),
    };
}

async function applySnapshotCharacterVersion(payload, options) {
    const versionId = payload?.versionId;
    if (!versionId) return;
    const version = characterVersions().find(item => item.id === versionId);
    if (!version) {
        toastr.warning(`找不到角色版本“${payload.versionName ?? versionId}”，已跳过该部分。`, '一键快照');
        return;
    }
    await applyCharacter(version.data, version.id, options);
}

async function applySnapshotPersonaVersion(payload) {
    const versionId = payload?.versionId;
    if (!versionId) return;
    const version = personaVersions().find(item => item.id === versionId);
    if (!version) {
        toastr.warning(`找不到用户版本“${payload.versionName ?? versionId}”，已跳过该部分。`, '一键快照');
        return;
    }
    await applyPersona(version.data, version.id);
}

function bindingProblems(snapshot, { allowUserChange = false } = {}) {
    const requirements = snapshotRequirements(snapshot);
    const problems = [];
    const activeCharacter = currentCharacter()?.avatar ?? null;
    if (requirements.needsCharacter && (!requirements.characterAvatar || requirements.characterAvatar !== activeCharacter)) {
        problems.push(`角色不匹配（快照：${requirements.characterName}）`);
    }
    // Automatic bindings (for example, after an opening greeting) must stay
    // strictly compatible. A manual chat binding can instead ask whether to
    // keep compatible-only behavior or use SillyTavern's native chat lock.
    if (!allowUserChange && requirements.needsPersona) {
        if (!requirements.personaAvatar) {
            problems.push('快照缺少用户归属信息');
        } else if (chat_metadata.persona && chat_metadata.persona !== requirements.personaAvatar) {
            problems.push(`聊天已绑定其他用户，无法改绑为“${requirements.personaName}”`);
        } else {
            const connected = getConnectedPersonas();
            if (connected.length && !connected.includes(requirements.personaAvatar)) {
                problems.push(`当前角色已绑定其他用户，无法绑定“${requirements.personaName}”`);
            }
        }
    }
    return problems;
}

function snapshotCanBindCurrentChat(snapshot, { notify = false, allowUserChange = false } = {}) {
    const problems = bindingProblems(snapshot, { allowUserChange });
    if (!problems.length) return true;
    if (notify) toastr.warning(`无法绑定“${snapshot.name}”：${problems.join('；')}。`, '一键快照');
    return false;
}

async function applySnapshot(snapshot, { silent = false, skipMismatchPrompt = false, excludeChatWorldbook = false, persistCharacter = true, allowThemeOverride = false } = {}) {
    if (!snapshot || applying) return false;
    const compatibility = applyCompatibility(snapshot, { allowThemeOverride });
    const incompatible = [];
    if (compatibility.characterMismatch) incompatible.push(`角色内容（${compatibility.requirements.characterName}）`);
    if (compatibility.personaMismatch) incompatible.push(`用户内容（${compatibility.requirements.personaName}）`);
    if (compatibility.chatMismatch) incompatible.push('聊天绑定世界书');
    if (compatibility.themeMismatch) incompatible.push(`角色美化（已绑定${themeManagerThemeForCharacter()}）`);
    if (incompatible.length && !silent && !skipMismatchPrompt) {
        const confirmed = await Popup.show.confirm(
            '部分快照内容不匹配',
            `“${snapshot.name}”中的${incompatible.join('、')}不属于当前聊天。是否仅应用兼容内容（例如预设、全局世界书）？`,
        );
        if (!confirmed) return false;
    }

    const excludedSources = new Set();
    if (compatibility.characterMismatch) {
        excludedSources.add('角色主世界书');
        excludedSources.add('角色附加世界书');
    }
    if (compatibility.personaMismatch) excludedSources.add('用户绑定世界书');
    if (compatibility.chatMismatch) excludedSources.add('聊天世界书');
    if (excludeChatWorldbook) excludedSources.add('聊天世界书');

    // Automatic chat, role-default, and opening-greeting bindings must never
    // treat a role version as the source of truth for the card's greeting
    // catalog. Keep a full copy for the whole application, not just the
    // character-version assignment: native preset/regex reloads can happen
    // afterwards and used to leave an old version's empty first_mes in memory.
    const liveGreetingCatalog = captureGreetingCatalog();
    applying = true;
    try {
        const payload = snapshot.payload ?? {};
        // Opening greetings belong to the character card's greeting catalog,
        // not to a snapshot's version/switch state. Preserve them for manual
        // applications as well as automatic bindings, otherwise an older
        // version could silently overwrite (or remove) the first greeting
        // just before regex forces a chat reload.
        if (snapshot.scopes?.character && !compatibility.characterMismatch) {
            await applySnapshotCharacterVersion(payload.character, {
                persist: persistCharacter,
                preserveGreetingCatalog: true,
                greetingCatalog: liveGreetingCatalog,
            });
        }
        if (snapshot.scopes?.persona && !compatibility.personaMismatch) await applySnapshotPersonaVersion(payload.persona);
        if (snapshot.scopes?.theme && !compatibility.themeMismatch) await applyTheme(payload.theme);
        if (snapshot.scopes?.worldInfo) await applyWorldInfo(payload.worldInfo, { excludedSources });
        // Loading a native preset may restore its own linked connection and
        // start a status check. Apply it first; the snapshot's Chat
        // Completion state must be the final authority when both scopes are
        // selected (for example, “preset A + API B”).
        if (snapshot.scopes?.preset) await applyPreset(payload.preset);
        if (snapshot.scopes?.api) await applyApiState(payload.api);
        if (snapshot.scopes?.regex) await applyRegex(payload.regex);
        binding().lastAppliedSnapshotId = snapshot.id;
        // Powers the "最近应用" ordering in the library.
        snapshot.appliedAt = Date.now();
        saveSettingsDebounced();
        saveMetadataDebounced();
        if (!silent) toastr.success(`${incompatible.length ? '已应用兼容内容' : '已应用'}：${snapshot.name}`, '一键快照');
        return true;
    } catch (error) {
        console.error('[One-click Snapshot]', error);
        toastr.error(`应用失败：${error.message}`, '一键快照');
        return false;
    } finally {
        // Reassert after every scope has finished (or after a partial failure).
        // This is deliberately in-memory only: automatic bindings must not
        // save a changed card.
        restoreGreetingCatalog(liveGreetingCatalog);
        applying = false;
    }
}

async function bindSnapshotPersonaToChat(snapshot) {
    const personaAvatar = snapshotRequirements(snapshot).personaAvatar;
    if (!personaAvatar || chat_metadata.persona === personaAvatar) return true;
    // Use SillyTavern's native chat-lock path. It updates the current persona,
    // replaces any previous chat lock, and refreshes the native lock UI.
    if (user_avatar !== personaAvatar) await setUserAvatar(personaAvatar, { toastPersonaNameChange: false, navigateToCurrent: true });
    await setPersonaLockState(true, 'chat');
    return chat_metadata.persona === personaAvatar;
}

async function bindSnapshot(snapshotId, { userMode: requestedUserMode = null } = {}) {
    const snapshot = snapshotId ? getSnapshot(snapshotId) : null;
    if (snapshotId && !snapshot) return false;
    if (snapshot && !snapshotCanBindCurrentChat(snapshot, { notify: true, allowUserChange: requestedUserMode === null })) return false;
    if (snapshot) {
        const userMode = requestedUserMode ?? await chooseChatBindingUserMode(snapshot, snapshotRequirements(snapshot));
        if (userMode === null) return false;
        if (userMode === 'lock' && !await bindSnapshotPersonaToChat(snapshot)) {
            toastr.error('无法将该用户绑定到当前聊天。', '一键快照');
            return false;
        }
    }
    const value = binding();
    value.snapshotId = snapshotId || null;
    value.enabled = true;
    delete value.compatibleOnly;
    rememberCurrentChatBinding(snapshotId);
    saveMetadataDebounced();
    saveSettingsDebounced();
    return true;
}

function bindCompatibleSnapshot(snapshotId) {
    const snapshot = getSnapshot(snapshotId);
    if (!snapshot) return false;
    const value = binding();
    value.snapshotId = snapshot.id;
    value.enabled = true;
    // A greeting can deliberately opt into only the pieces compatible with
    // the selected chat's user. Keep that decision after it becomes a normal
    // chat binding instead of trying to force the chat's persona to change.
    value.compatibleOnly = true;
    rememberCurrentChatBinding(snapshot.id);
    saveMetadataDebounced();
    saveSettingsDebounced();
    return true;
}

function toggleBinding() {
    const value = binding();
    if (!value.snapshotId) return;
    value.enabled = !value.enabled;
    saveMetadataDebounced();
}

function currentChatReference() {
    const id = getCurrentChatId();
    if (!id) return null;
    const details = getCurrentChatDetails();
    return { id: String(id), name: String(details?.sessionName || id), integrity: chat_metadata?.integrity ?? null };
}

function rememberCurrentChatBinding(snapshotId) {
    const chat = currentChatReference();
    if (!chat) return;
    const bindings = settings().snapshotBindings;
    for (const [id, chats] of Object.entries(bindings)) {
        bindings[id] = (chats ?? []).filter(item => item?.id !== chat.id && (!chat.integrity || item?.integrity !== chat.integrity));
        if (!bindings[id].length) delete bindings[id];
    }
    if (!snapshotId) return;
    bindings[snapshotId] ??= [];
    bindings[snapshotId].push(chat);
}

function snapshotChatBindings(snapshotId) {
    return settings().snapshotBindings[snapshotId] ?? [];
}

function normalizeChatFileName(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
}

function updateChatBindingAfterRename({ oldFileName, newFileName }) {
    const oldId = normalizeChatFileName(oldFileName);
    const newId = normalizeChatFileName(newFileName);
    if (!oldId || !newId || oldId === newId) return;
    const current = currentChatReference();
    let changed = false;
    for (const [snapshotId, chats] of Object.entries(settings().snapshotBindings)) {
        const updated = (chats ?? []).map(chat => {
            if (chat?.id !== oldId) return chat;
            changed = true;
            return {
                ...chat,
                id: newId,
                name: newId,
                integrity: current?.id === newId ? current.integrity : chat.integrity ?? null,
            };
        });
        // A rename may race with CHAT_CHANGED, which can already have added
        // the new filename. Keep one record per current filename.
        const unique = new Map();
        for (const chat of updated) {
            if (chat?.id) unique.set(chat.id, chat);
        }
        if (unique.size !== updated.length) changed = true;
        settings().snapshotBindings[snapshotId] = [...unique.values()];
    }
    if (changed) saveSettingsDebounced();
}

async function pruneMissingCharacterChatBindings() {
    const character = currentCharacter();
    if (!character?.avatar) return false;
    let knownChats;
    try {
        knownChats = await getPastCharacterChats(this_chid);
    } catch {
        return false;
    }
    const existingIds = new Set((knownChats ?? []).map(chat => normalizeChatFileName(chat?.file_name)));
    let changed = false;
    for (const snapshot of settings().snapshots) {
        const requirements = snapshotRequirements(snapshot);
        // Character-scoped snapshots can only bind chats of that character,
        // so removing missing filenames here cannot touch another character's
        // or a group chat's binding.
        if (!requirements.needsCharacter || requirements.characterAvatar !== character.avatar) continue;
        const chats = settings().snapshotBindings[snapshot.id] ?? [];
        const remaining = chats.filter(chat => existingIds.has(chat?.id));
        if (remaining.length === chats.length) continue;
        if (remaining.length) settings().snapshotBindings[snapshot.id] = remaining;
        else delete settings().snapshotBindings[snapshot.id];
        changed = true;
    }
    if (changed) saveSettingsDebounced();
    return changed;
}

function currentCharacterBinding() {
    const avatar = currentCharacter()?.avatar;
    if (!avatar) return null;
    return settings().characterBindings[avatar] ?? null;
}

function snapshotCharacterBindings(snapshotId) {
    return Object.entries(settings().characterBindings)
        .filter(([, record]) => record?.snapshotId === snapshotId)
        .map(([avatar, record]) => ({
            avatar,
            name: characters.find(character => character?.avatar === avatar)?.name ?? avatar,
            enabled: record.enabled !== false,
            userMode: record.userMode ?? 'compatible',
        }));
}

function snapshotCanBindToCurrentCharacter(snapshot, { notify = false } = {}) {
    const character = currentCharacter();
    if (!character?.avatar) {
        if (notify) toastr.warning('请先进入一个角色聊天后再绑定角色默认快照。', '一键快照');
        return false;
    }
    const requirements = snapshotRequirements(snapshot);
    const matches = !requirements.needsCharacter || (requirements.characterAvatar === character.avatar);
    if (!matches && notify) {
        toastr.warning(`无法绑定“${snapshot.name}”：角色不匹配（快照：${requirements.characterName}）。`, '一键快照');
    }
    if (!matches) return false;
    if (hasThemeManagerConflict(snapshot, character)) {
        if (notify) toastr.warning(`无法绑定“${snapshot.name}”：${character.name}已在美化管理助手中绑定“${themeManagerThemeForCharacter(character.avatar)}”。`, '一键快照');
        return false;
    }
    return true;
}

async function chooseCharacterBindingUserMode(snapshot, requirements, character, { purpose = '角色默认快照' } = {}) {
    return chooseBindingUserMode(snapshot, requirements, {
        purpose,
        connected: getConnectedPersonas(character.avatar),
        connectedMode: 'connect',
        connectedLabel: '将该用户连接到此角色',
        conflictMessage: `“${character.name}”已连接其他用户。继续后会以“仅应用兼容内容”绑定；该快照的用户版本与用户绑定世界书只会在用户匹配时应用。`,
    });
}

async function chooseChatBindingUserMode(snapshot, requirements) {
    // A persona connected to the current character is selected natively when
    // this chat opens. Keep that higher-level relationship intact instead of
    // asking again or turning it into a chat-specific lock.
    if (requirements.needsPersona && getConnectedPersonas().includes(requirements.personaAvatar)) return 'compatible';
    return chooseBindingUserMode(snapshot, requirements, {
        purpose: '聊天快照',
        connected: chat_metadata.persona ? [chat_metadata.persona] : [],
        connectedMode: 'lock',
        connectedLabel: '将该用户绑定到此聊天',
        conflictMessage: '当前聊天已绑定其他用户。继续后会以“仅应用兼容内容”绑定；该快照的用户版本与用户绑定世界书只会在用户匹配时应用。',
    });
}

async function chooseBindingUserMode(snapshot, requirements, { purpose, connected, connectedMode, connectedLabel, conflictMessage }) {
    if (!requirements.needsPersona) return 'compatible';
    if (!requirements.personaAvatar) {
        toastr.warning(`无法绑定“${snapshot.name}”：快照缺少用户归属信息。`, '一键快照');
        return null;
    }
    if (connected.includes(requirements.personaAvatar)) return connectedMode;
    if (connected.length) {
        const confirmed = await Popup.show.confirm(
            '用户连接冲突',
            conflictMessage,
        );
        return confirmed ? 'compatible' : null;
    }

    const root = $('<div class="ocs-character-bind-choice"><p>快照包含用户“<strong></strong>”。请选择此绑定的用户策略：</p><label class="checkbox_label"><input type="radio" name="ocs-character-user-policy" value="compatible" checked>仅应用兼容内容（推荐）</label><label class="checkbox_label"><input type="radio" name="ocs-character-user-policy" value="connect"></label></div>');
    root.find('strong').text(requirements.personaName);
    root.find('input[value="connect"]').parent().append(document.createTextNode(connectedLabel));
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, `绑定${purpose}`, {
        wide: false,
        leftAlign: true,
        okButton: '确认绑定',
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return root.find('input[name="ocs-character-user-policy"]:checked').val() === 'connect' ? connectedMode : 'compatible';
}

async function connectPersonaToCharacter(personaAvatar, characterAvatar) {
    if (!power_user.persona_descriptions?.[personaAvatar] || !characterAvatar) return false;
    // Use SillyTavern's native locking path rather than only mutating the
    // connection array. Besides handling exclusivity correctly, this updates
    // the lock icon in the persona page immediately.
    if (user_avatar !== personaAvatar) await setUserAvatar(personaAvatar, { toastPersonaNameChange: false, navigateToCurrent: true });
    await setPersonaLockState(true, 'character');
    return getConnectedPersonas(characterAvatar).includes(personaAvatar);
}

async function bindSnapshotToCurrentCharacter(snapshot) {
    if (!snapshotCanBindToCurrentCharacter(snapshot, { notify: true })) return false;
    const character = currentCharacter();
    if (!character?.avatar) return false;
    const requirements = snapshotRequirements(snapshot);
    const userMode = await chooseCharacterBindingUserMode(snapshot, requirements, character);
    if (userMode === null) return false;
    if (userMode === 'connect' && !await connectPersonaToCharacter(requirements.personaAvatar, character.avatar)) {
        toastr.error('无法连接该用户到当前角色。', '一键快照');
        return false;
    }
    settings().characterBindings[character.avatar] = { snapshotId: snapshot.id, enabled: true, userMode };
    const snapshotTheme = themeNameFromPayload(snapshot.payload);
    if (snapshot.scopes?.theme && snapshotTheme) setThemeManagerThemeForCharacter(character.avatar, snapshotTheme);
    saveSettingsDebounced();
    toastr.success(`已绑定为“${character.name}”的角色默认快照。`, '一键快照');
    return true;
}

function unbindSnapshotFromCurrentCharacter(snapshotId) {
    const character = currentCharacter();
    if (!character?.avatar || settings().characterBindings[character.avatar]?.snapshotId !== snapshotId) return false;
    removeThemeManagerThemeIfOwned(getSnapshot(snapshotId), character.avatar);
    delete settings().characterBindings[character.avatar];
    saveSettingsDebounced();
    return true;
}

async function toggleCurrentCharacterBinding(snapshotId) {
    const record = currentCharacterBinding();
    if (!record || record.snapshotId !== snapshotId) return false;
    const snapshot = getSnapshot(snapshotId);
    const character = currentCharacter();
    if (!snapshot || !character?.avatar) return false;
    if (record.enabled !== false) {
        record.enabled = false;
        removeThemeManagerThemeIfOwned(snapshot, character.avatar);
    } else {
        if (!snapshotCanBindToCurrentCharacter(snapshot, { notify: true })) return false;
        record.enabled = true;
        const snapshotTheme = themeNameFromPayload(snapshot.payload);
        if (snapshot.scopes?.theme && snapshotTheme) setThemeManagerThemeForCharacter(character.avatar, snapshotTheme);
    }
    saveSettingsDebounced();
    return true;
}

function greetingFingerprint(text) {
    const value = String(text ?? '').trim();
    let hash = 5381;
    for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function greetingCatalogState(character = currentCharacter()) {
    const state = deepClone(character?.data?.extensions?.one_click_snapshot?.greetingCatalog ?? {});
    state.entries = Array.isArray(state.entries) ? state.entries : [];
    return state;
}

function nativeGreetingEntries(character = currentCharacter()) {
    if (!character) return [];
    const entries = [{ key: 'first', kind: 'first', index: 0, fallbackLabel: '主开场白', text: String(character.first_mes ?? '') }];
    const alternates = Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings : [];
    alternates.forEach((text, index) => entries.push({
        key: `alternate:${index}`,
        kind: 'alternate',
        index,
        fallbackLabel: `备选开场白 ${index + 1}`,
        text: String(text ?? ''),
    }));
    return entries;
}

function reconcileGreetingCatalog(catalog, character = currentCharacter()) {
    const entries = nativeGreetingEntries(character);
    catalog.entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
    const used = new Set();
    for (const entry of entries) {
        // The primary greeting is its own stable, native concept. Names and
        // groups are intentionally only for alternate greetings.
        if (entry.kind === 'first') continue;
        const fingerprint = greetingFingerprint(entry.text);
        // Prefer the recorded native position when text is duplicated. The
        // move handler updates lastIndex before SillyTavern swaps the text,
        // so identical greetings still keep their own names and groups.
        let metadata = catalog.entries.find(item => item?.kind === 'alternate' && item.fingerprint === fingerprint && item.lastIndex === entry.index && !used.has(item.id));
        if (!metadata) metadata = catalog.entries.find(item => item?.kind === 'alternate' && item.fingerprint === fingerprint && !used.has(item.id));
        // A direct edit in SillyTavern changes the fingerprint but leaves the
        // native position intact. Keep the user's name/group in that case.
        if (!metadata && entry.kind === 'alternate') {
            metadata = catalog.entries.find(item => item?.kind === 'alternate' && item.lastIndex === entry.index && !used.has(item.id));
        }
        if (!metadata) {
            metadata = { id: makeId(), kind: entry.kind, name: '', group: '' };
            catalog.entries.push(metadata);
        }
        metadata.kind = entry.kind;
        metadata.fingerprint = fingerprint;
        metadata.lastIndex = entry.index;
        metadata.name = String(metadata.name ?? '').trim();
        metadata.group = String(metadata.group ?? '').trim();
        metadata.collapsed = metadata.collapsed === true;
        used.add(metadata.id);
        entry.metadata = metadata;
    }
    // Deleted alternate greetings should not leave orphaned names behind to
    // be accidentally reused by a future greeting in the same position.
    catalog.entries = catalog.entries.filter(item => item?.kind === 'alternate' && used.has(item.id));
    return entries;
}

function greetingDisplayLabel(entry) {
    return entry?.metadata?.name || entry?.fallbackLabel || '未命名开场白';
}

function greetingCandidates(character = currentCharacter()) {
    // This order exactly follows SillyTavern's getFirstMessage(): when the
    // primary greeting is empty, it is removed before the swipe list exists.
    const greetings = reconcileGreetingCatalog(greetingCatalogState(character), character);
    const effective = greetings[0]?.text ? greetings : greetings.slice(1);
    return effective.map((greeting, swipeIndex) => ({
        ...greeting,
        label: greetingDisplayLabel(greeting),
        group: greeting.metadata?.group || '',
        swipeIndex,
        fingerprint: greetingFingerprint(greeting.text),
    })).filter(greeting => greeting.text.trim());
}

function greetingLabelFromKey(key) {
    if (key === 'first') return '主开场白';
    const alternate = /^alternate:(\d+)$/.exec(String(key));
    return alternate ? `备选开场白 ${Number(alternate[1]) + 1}` : null;
}

function syncGreetingBindingLabel(character, entry) {
    const record = character?.avatar ? settings().greetingBindings[character.avatar]?.[entry?.key] : null;
    if (!record) return;
    const label = greetingDisplayLabel(entry);
    if (record.label === label && record.characterName === character.name) return;
    record.label = label;
    record.characterName = character.name;
    saveSettingsDebounced();
}

function saveGreetingCatalogState(character, catalog) {
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions.one_click_snapshot ??= {};
    character.data.extensions.one_click_snapshot.greetingCatalog = deepClone(catalog);

    // The native character form serializes its hidden JSON copy, rather than
    // the live `characters[chid]` object. Patch only our metadata into that
    // copy before following the native save path, so it reaches the card file
    // without touching the greeting text or the other card fields.
    const jsonInput = $('#character_json_data');
    if (!jsonInput.length) return;
    try {
        const cardData = JSON.parse(String(jsonInput.val() ?? character.json_data ?? '{}'));
        cardData.data ??= {};
        cardData.data.extensions ??= {};
        cardData.data.extensions.one_click_snapshot ??= {};
        cardData.data.extensions.one_click_snapshot.greetingCatalog = deepClone(catalog);
        jsonInput.val(JSON.stringify(cardData));
    } catch (error) {
        console.warn('[One-click Snapshot] Failed to prepare greeting catalog for native save.', error);
    }
}

async function editGreetingMetadata(character, catalog, entry, field) {
    const isName = field === 'name';
    const value = isName
        ? await Popup.show.input('重命名开场白', '名称只用于管理和快照绑定显示，不会改动开场白正文。', entry.metadata.name ?? '')
        : await chooseGroup(entry.metadata.group, catalog.entries.map(item => String(item?.group ?? '').trim()), {
            title: '设置开场白分组',
            okButton: '确认分组',
        });
    if (value === null) return;
    entry.metadata[field] = String(value).trim();
    saveGreetingCatalogState(character, catalog);
    if (isName) syncGreetingBindingLabel(character, entry);
    scheduleNativeGreetingDecoration();
}

function updateNativeGreetingFilter(root, entries) {
    const toolbar = root.find('.ocs-native-greeting-toolbar');
    if (!toolbar.length) return;
    const groupSelect = toolbar.find('.ocs-native-greeting-filter-group');
    const search = toolbar.find('.ocs-native-greeting-filter-search');
    const selectedGroup = String(groupSelect.val() ?? '__all__');
    const groups = [...new Set(entries.map(entry => entry.metadata?.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    groupSelect.empty().append('<option value="__all__">全部分组</option><option value="">未分组</option>');
    for (const group of groups) groupSelect.append($('<option></option>').val(group).text(group));
    groupSelect.val([...groupSelect.find('option').map((_, option) => option.value)].includes(selectedGroup) ? selectedGroup : '__all__');
    const query = String(search.val() ?? '').trim().toLocaleLowerCase();
    root.find('.alternate_greeting').each((_, node) => {
        const block = $(node);
        const index = Number(block.attr('data-index'));
        const entry = entries.find(item => item.index === index);
        const inGroup = selectedGroup === '__all__' || entry?.metadata?.group === selectedGroup;
        const haystack = `${entry?.metadata?.name ?? ''} ${entry?.metadata?.group ?? ''} ${entry?.text ?? ''}`.toLocaleLowerCase();
        block.toggle(inGroup && (!query || haystack.includes(query)));
    });
}

function setNativeGreetingDetailsOpen(root, open) {
    const character = currentCharacter();
    if (!character?.avatar) return;
    const catalog = greetingCatalogState(character);
    const entries = reconcileGreetingCatalog(catalog, character);
    root.find('.alternate_greeting').each((_, node) => {
        const block = $(node);
        const index = Number(block.attr('data-index'));
        const entry = entries.find(item => item.kind === 'alternate' && item.index === index);
        if (!entry?.metadata) return;
        entry.metadata.collapsed = !open;
        block.find('details').first().prop('open', open);
    });
    saveGreetingCatalogState(character, catalog);
}

function alternateGreetings(character = currentCharacter()) {
    character.data ??= {};
    character.data.alternate_greetings ??= [];
    return character.data.alternate_greetings;
}

function syncNativeGreetingRows(root, character = currentCharacter()) {
    const list = root.find('.alternate_greetings_list');
    const array = alternateGreetings(character);
    list.children('.alternate_greeting').each((index, node) => {
        const block = $(node);
        block.attr('data-index', index);
        block.find('.greeting_index').text(index + 1);
        const text = block.find('.alternate_greeting_text').first();
        text.attr('id', `alternate_greeting_${index}`);
        if (text.data('ocsGreetingInputBound')) return;
        const listener = event => {
            // Native handlers capture the index that existed when the popup
            // opened. Once rows are dragged or batch-deleted that index can
            // be stale, so own the input update using the live DOM index.
            event.stopImmediatePropagation();
            const liveIndex = Number(block.attr('data-index'));
            if (Number.isInteger(liveIndex)) alternateGreetings(character)[liveIndex] = String(text.val() ?? '');
        };
        text.get(0)?.addEventListener('input', listener, true);
        text.data('ocsGreetingInputBound', true);
    });
}

function stampNativeGreetingRowIds(root, entries) {
    root.find('.alternate_greeting').each((_, node) => {
        const block = $(node);
        const index = Number(block.attr('data-index'));
        const id = entries.find(entry => entry.kind === 'alternate' && entry.index === index)?.metadata?.id;
        if (id) block.attr('data-ocs-greeting-id', id);
    });
}

function snapshotNativeGreetingDrag(root, character = currentCharacter()) {
    const array = alternateGreetings(character);
    const catalog = greetingCatalogState(character);
    const before = JSON.stringify(catalog.entries);
    const entries = reconcileGreetingCatalog(catalog, character)
        .filter(entry => entry.kind === 'alternate' && entry.metadata?.id);
    if (JSON.stringify(catalog.entries) !== before) saveGreetingCatalogState(character, catalog);
    stampNativeGreetingRowIds(root, entries);
    const valuesById = new Map(entries.map(entry => [entry.metadata.id, array[entry.index]]));
    const indexById = new Map(entries.map(entry => [entry.metadata.id, entry.index]));
    root.data('ocsGreetingDragSnapshot', {
        valuesById,
        indexById,
        initialValues: [...array],
    });
}

function selectedNativeGreetingIndexes(root) {
    return root.find('.ocs-native-greeting-select.is-selected').map((_, button) => Number($(button).closest('.alternate_greeting').attr('data-index'))).get().filter(Number.isInteger);
}

function setNativeGreetingSelected(control, selected) {
    control
        .toggleClass('is-selected', selected)
        .toggleClass('fa-square', !selected)
        .toggleClass('fa-square-check', selected)
        .attr('aria-checked', selected ? 'true' : 'false');
}

function refreshNativeGreetingModes(root) {
    const batchMode = root.data('ocsBatchMode') === true;
    const dragMode = root.data('ocsDragMode') === true;
    root.toggleClass('ocs-greeting-batch-mode', batchMode);
    root.toggleClass('ocs-greeting-drag-mode', dragMode);
    root.find('.ocs-native-greeting-batch').toggleClass('active', batchMode);
    root.find('.ocs-native-greeting-drag-toggle').toggleClass('active', dragMode);
    root.find('.ocs-native-greeting-batch').attr('title', batchMode ? '退出批量操作' : '批量操作');
    root.find('.ocs-native-greeting-drag-toggle').attr('title', dragMode ? '切换为上下键排序' : '切换为拖拽排序');
    root.find('.move_up_alternate_greeting, .move_down_alternate_greeting').toggle(!dragMode);
}

function applyNativeGreetingDragOrder(root, character = currentCharacter()) {
    const list = root.find('.alternate_greetings_list');
    const array = alternateGreetings(character);
    const catalog = greetingCatalogState(character);
    const entries = reconcileGreetingCatalog(catalog, character);
    const metadataById = new Map(entries.filter(entry => entry.kind === 'alternate').map(entry => [entry.metadata?.id, entry.metadata]));
    const snapshot = root.data('ocsGreetingDragSnapshot');
    const valuesById = snapshot?.valuesById;
    // The native `data-index` is only the row's current visual position. It
    // can be rewritten while jQuery UI is sorting, so it is not safe as a
    // drag identity. Our catalog already has a permanent id per greeting;
    // use the ids stamped when drag mode starts instead.
    const orderedIds = list.children('.alternate_greeting').map((_, node) => String($(node).attr('data-ocs-greeting-id') ?? '')).get();
    const validPermutation = orderedIds.length === array.length
        && orderedIds.every(id => metadataById.has(id))
        && new Set(orderedIds).size === array.length
        && valuesById instanceof Map
        && orderedIds.every(id => valuesById.has(id) && typeof valuesById.get(id) === 'string');
    // Never allow malformed rows to turn a missing array element into the
    // string "undefined" when SillyTavern next saves the character card.
    if (!validPermutation) {
        console.warn('[One-click Snapshot] Drag order rejected: the native greeting rows lost their stable identities.', { orderedIds, length: array.length });
        toastr.error('拖拽排序未完成，已取消本次变更以保护开场白内容。', '一键快照');
        // Restore the complete card-side array captured before this drag. A
        // failed interaction must never leave unrelated greetings empty.
        if (Array.isArray(snapshot?.initialValues) && snapshot.initialValues.length === array.length) {
            array.splice(0, array.length, ...snapshot.initialValues);
        }
        // Put the DOM back into the actual card order so a rejected drag can
        // never make names appear to have swapped rows.
        const rows = list.children('.alternate_greeting').detach().get().sort((left, right) => {
            const leftIndex = snapshot?.indexById?.get(String($(left).attr('data-ocs-greeting-id') ?? '')) ?? Number.MAX_SAFE_INTEGER;
            const rightIndex = snapshot?.indexById?.get(String($(right).attr('data-ocs-greeting-id') ?? '')) ?? Number.MAX_SAFE_INTEGER;
            return leftIndex - rightIndex;
        });
        list.append(rows);
        syncNativeGreetingRows(root, character);
        return;
    }
    // Only write from the frozen source captured at drag start. In
    // particular, never read from transient native input rows while they are
    // being detached/reinserted by sortable.
    array.splice(0, array.length, ...orderedIds.map(id => valuesById.get(id)));
    orderedIds.forEach((id, newIndex) => {
        const metadata = metadataById.get(id);
        if (metadata) metadata.lastIndex = newIndex;
    });
    reconcileGreetingCatalog(catalog, character);
    saveGreetingCatalogState(character, catalog);
    syncNativeGreetingRows(root, character);
    scheduleNativeGreetingDecoration();
}

function setNativeGreetingDragMode(root, enabled) {
    const list = root.find('.alternate_greetings_list');
    if (!list.length) return;
    if (list.sortable('instance') !== undefined) list.sortable('destroy');
    root.removeData('ocsGreetingDragActive').removeData('ocsGreetingDragSnapshot');
    root.data('ocsDragMode', enabled);
    if (enabled) {
        // Sorting a filtered subset makes the resulting order ambiguous.
        // Show the full native list while drag mode is active.
        root.data('ocsBatchMode', false);
        root.find('.ocs-native-greeting-select').each((_, node) => setNativeGreetingSelected($(node), false));
        root.find('.ocs-native-greeting-filter-search').val('').trigger('input');
        root.find('.ocs-native-greeting-filter-group').val('__all__').trigger('change');
        list.sortable({
            items: '> .alternate_greeting',
            handle: '.ocs-native-greeting-drag-handle',
            delay: window.matchMedia?.('(pointer: coarse)').matches ? 0 : getSortableDelay(),
            axis: 'y',
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: () => {
                snapshotNativeGreetingDrag(root);
                root.data('ocsGreetingDragActive', true);
            },
            update: () => applyNativeGreetingDragOrder(root),
            stop: () => {
                root.removeData('ocsGreetingDragActive').removeData('ocsGreetingDragSnapshot');
                // The mutation observer deliberately holds refreshes while
                // sorting. Apply all title/index updates only after drop.
                scheduleNativeGreetingDecoration();
            },
        }).disableSelection();
    }
    refreshNativeGreetingModes(root);
}

async function applyNativeGreetingBatchGroup(root) {
    const character = currentCharacter();
    const indexes = selectedNativeGreetingIndexes(root);
    if (!character?.avatar || !indexes.length) return;
    const catalog = greetingCatalogState(character);
    const entries = reconcileGreetingCatalog(catalog, character);
    const group = await chooseGroup('', catalog.entries.map(item => String(item?.group ?? '').trim()), {
        title: `为 ${indexes.length} 条开场白设置分组`,
        okButton: '确认分组',
    });
    if (group === null) return;
    for (const entry of entries) if (entry.kind === 'alternate' && indexes.includes(entry.index)) entry.metadata.group = group;
    saveGreetingCatalogState(character, catalog);
    scheduleNativeGreetingDecoration();
}

async function deleteNativeGreetingRows(root) {
    const indexes = selectedNativeGreetingIndexes(root);
    await deleteNativeGreetingIndexes(root, indexes);
}

async function deleteNativeGreetingIndexes(root, indexes) {
    const character = currentCharacter();
    if (!character?.avatar || !indexes.length) return;
    const count = indexes.length;
    if (!await Popup.show.confirm(`删除 ${count} 条开场白？`, '此操作只删除选中的备选开场白，且无法撤销。')) return;
    const array = alternateGreetings(character);
    const indexSet = new Set(indexes);
    array.splice(0, array.length, ...array.filter((_, index) => !indexSet.has(index)));
    root.find('.alternate_greeting').filter((_, node) => indexSet.has(Number($(node).attr('data-index')))).remove();
    const catalog = greetingCatalogState(character);
    reconcileGreetingCatalog(catalog, character);
    saveGreetingCatalogState(character, catalog);
    syncNativeGreetingRows(root, character);
    scheduleNativeGreetingDecoration();
}

function decorateNativeAlternateGreetings() {
    if (!feature('greeting')) return;
    const character = currentCharacter();
    if (!character?.avatar) return;
    $('dialog.popup .alternate_grettings').each((_, node) => {
        const root = $(node);
        root.addClass('ocs-native-greeting-catalog');
        const catalog = greetingCatalogState(character);
        const catalogBefore = JSON.stringify(catalog.entries);
        const entries = reconcileGreetingCatalog(catalog, character).filter(entry => entry.kind === 'alternate');
        if (JSON.stringify(catalog.entries) !== catalogBefore) saveGreetingCatalogState(character, catalog);
        const list = root.find('.alternate_greetings_list');
        if (!list.length) return;
        syncNativeGreetingRows(root, character);
        // Outside drag mode the native row indexes match the card exactly.
        // Re-stamp them so a later drag always starts from a known identity.
        if (root.data('ocsDragMode') !== true) stampNativeGreetingRowIds(root, entries);

        root.children('.title_restorable').find('.ocs-native-greeting-expand, .ocs-native-greeting-collapse').remove();

        if (!root.find('.ocs-native-greeting-toolbar').length) {
            const toolbar = $('<div class="ocs-native-greeting-toolbar"><div class="ocs-native-greeting-toolbar-filters"><input class="text_pole ocs-native-greeting-filter-search" type="search" placeholder="搜索名称、分组或开场白内容"><select class="text_pole ocs-native-greeting-filter-group" title="按分组筛选"><option value="__all__">全部分组</option></select></div><div class="ocs-native-greeting-toolbar-actions"><div class="menu_button ocs-native-greeting-expand fa-solid fa-angles-down" title="展开全部开场白"></div><div class="menu_button ocs-native-greeting-collapse fa-solid fa-angles-up" title="收起全部开场白"></div><div class="menu_button ocs-native-greeting-drag-toggle fa-solid fa-up-down-left-right" title="切换拖拽排序"></div><div class="menu_button ocs-native-greeting-batch fa-solid fa-list-check" title="批量操作"></div></div><div class="ocs-native-greeting-toolbar-batch-actions ocs-native-greeting-batch-only"><div class="menu_button ocs-native-greeting-batch-all fa-solid fa-check-double" title="全选 / 取消全选"></div><div class="menu_button ocs-native-greeting-batch-group fa-solid fa-folder-tree" title="为选中开场白分组"></div><div class="menu_button ocs-native-greeting-batch-delete fa-solid fa-trash" title="删除选中开场白"></div></div></div>');
            list.before(toolbar);
        }
        const toolbar = root.find('.ocs-native-greeting-toolbar');
        toolbar
            .off('input.oneClickSnapshotGreetingFilter change.oneClickSnapshotGreetingFilter', 'select, input')
            .on('input.oneClickSnapshotGreetingFilter change.oneClickSnapshotGreetingFilter', 'select, input', () => updateNativeGreetingFilter(root, entries));
        toolbar.find('.ocs-native-greeting-expand')
            .off('click.oneClickSnapshotGreetingExpand')
            .on('click.oneClickSnapshotGreetingExpand', event => {
                event.preventDefault();
                event.stopPropagation();
                setNativeGreetingDetailsOpen(root, true);
            });
        toolbar.find('.ocs-native-greeting-collapse')
            .off('click.oneClickSnapshotGreetingCollapse')
            .on('click.oneClickSnapshotGreetingCollapse', event => {
                event.preventDefault();
                event.stopPropagation();
                setNativeGreetingDetailsOpen(root, false);
            });
        toolbar.find('.ocs-native-greeting-drag-toggle')
            .off('click.oneClickSnapshotGreetingDrag')
            .on('click.oneClickSnapshotGreetingDrag', event => {
                event.preventDefault();
                event.stopPropagation();
                setNativeGreetingDragMode(root, root.data('ocsDragMode') !== true);
            });
        toolbar.find('.ocs-native-greeting-batch')
            .off('click.oneClickSnapshotGreetingBatch')
            .on('click.oneClickSnapshotGreetingBatch', event => {
                event.preventDefault();
                event.stopPropagation();
                const enabled = root.data('ocsBatchMode') !== true;
                if (enabled && root.data('ocsDragMode') === true) setNativeGreetingDragMode(root, false);
                root.data('ocsBatchMode', enabled);
                root.find('.ocs-native-greeting-select').each((_, node) => setNativeGreetingSelected($(node), false));
                refreshNativeGreetingModes(root);
            });
        toolbar.find('.ocs-native-greeting-batch-all')
            .off('click.oneClickSnapshotGreetingBatchAll')
            .on('click.oneClickSnapshotGreetingBatchAll', event => {
                event.preventDefault();
                event.stopPropagation();
                const checks = root.find('.ocs-native-greeting-select');
                const selectAll = checks.length > 0 && checks.filter('.is-selected').length !== checks.length;
                checks.each((_, node) => setNativeGreetingSelected($(node), selectAll));
            });
        toolbar.find('.ocs-native-greeting-batch-group')
            .off('click.oneClickSnapshotGreetingBatchGroup')
            .on('click.oneClickSnapshotGreetingBatchGroup', async event => {
                event.preventDefault();
                event.stopPropagation();
                await applyNativeGreetingBatchGroup(root);
            });
        toolbar.find('.ocs-native-greeting-batch-delete')
            .off('click.oneClickSnapshotGreetingBatchDelete')
            .on('click.oneClickSnapshotGreetingBatchDelete', async event => {
                event.preventDefault();
                event.stopPropagation();
                await deleteNativeGreetingRows(root);
            });

        list.find('.alternate_greeting').each((_, greetingNode) => {
            const block = $(greetingNode);
            const index = Number(block.attr('data-index'));
            const entry = entries.find(item => item.index === index);
            if (!entry?.metadata) return;
            const details = block.find('details').first();
            details
                .off('toggle.oneClickSnapshotGreetingCollapsed')
                .on('toggle.oneClickSnapshotGreetingCollapsed', () => {
                    const collapsed = !details.prop('open');
                    if (entry.metadata.collapsed === collapsed) return;
                    entry.metadata.collapsed = collapsed;
                    saveGreetingCatalogState(character, catalog);
                });
            details.prop('open', entry.metadata.collapsed !== true);
            const summaryTitle = details.find('summary strong').first();
            const titleRow = summaryTitle.closest('.flex-container').first();
            const controls = details.find('summary .title_restorable').first();
            let check = titleRow.find('.ocs-native-greeting-select');
            // Native <summary> consumes checkbox pointer events on some
            // browsers.  Use a checkbox-looking menu button instead so batch
            // selection never toggles the greeting panel or loses the click.
            if (!check.length || !check.is('div')) {
                check.remove();
                check = $('<div class="menu_button ocs-native-greeting-select fa-regular fa-square" role="checkbox" aria-checked="false" title="选择开场白"></div>');
                summaryTitle.before(check);
            }
            check
                .off('click.oneClickSnapshotGreetingSelect')
                .on('click.oneClickSnapshotGreetingSelect', event => {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (root.data('ocsBatchMode') !== true) return;
                    setNativeGreetingSelected(check, !check.hasClass('is-selected'));
                });
            let dragHandle = controls.find('.ocs-native-greeting-drag-handle');
            if (!dragHandle.length) {
                dragHandle = $('<div class="menu_button ocs-native-greeting-drag-handle fa-solid fa-grip-vertical" title="拖拽排序"></div>');
                controls.find('.move_up_alternate_greeting').before(dragHandle);
            }
            titleRow.find('.ocs-native-greeting-number, .ocs-native-greeting-group-badge, .ocs-native-greeting-snapshot-badge').remove();
            summaryTitle.text(entry.metadata.name || `其他开场白 #${index + 1}`);
            if (entry.metadata.name) titleRow.append($('<small class="ocs-native-greeting-number"></small>').text(`#${index + 1}`));
            if (entry.metadata.group) titleRow.append($('<small class="ocs-native-greeting-group-badge"></small>').text(entry.metadata.group));

            // Which snapshot this greeting opens with. Without it the binding is
            // only visible from the snapshot's own card, so there is no way to
            // tell from here which greetings are wired up and which are not.
            const bound = greetingBindingRecords(character)[entry.key];
            const boundSnapshot = bound?.snapshotId ? getSnapshot(bound.snapshotId) : null;
            if (boundSnapshot) {
                titleRow.append($('<small class="ocs-native-greeting-snapshot-badge"></small>')
                    .toggleClass('is-disabled', bound.enabled === false)
                    .attr('title', `选到这条开场白时会应用快照「${boundSnapshot.name}」${bound.enabled === false ? '（已停用）' : ''}`)
                    .append('<i class="fa-solid fa-camera"></i>', $('<span></span>').text(boundSnapshot.name)));
            }

            let renameButton = controls.find('.ocs-native-greeting-rename');
            let groupButton = controls.find('.ocs-native-greeting-group-edit');
            if (!renameButton.length) {
                renameButton = $('<div class="menu_button ocs-native-greeting-rename fa-solid fa-pen" title="重命名开场白"></div>');
                groupButton = $('<div class="menu_button ocs-native-greeting-group-edit fa-solid fa-folder-tree" title="设置开场白分组"></div>');
                const before = controls.find('.move_up_alternate_greeting');
                if (before.length) before.before(renameButton, groupButton);
                else controls.find('.delete_alternate_greeting').before(renameButton, groupButton);
            }
            renameButton
                .off('click.oneClickSnapshotGreetingRename')
                .on('click.oneClickSnapshotGreetingRename', async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    await editGreetingMetadata(character, catalog, entry, 'name');
                });
            groupButton
                .off('click.oneClickSnapshotGreetingGroup')
                .on('click.oneClickSnapshotGreetingGroup', async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    await editGreetingMetadata(character, catalog, entry, 'group');
                });
        });
        refreshNativeGreetingModes(root);
        updateNativeGreetingFilter(root, entries);
    });
}

function scheduleNativeGreetingDecoration() {
    const dragging = $('dialog.popup .alternate_grettings').toArray().some(node => $(node).data('ocsGreetingDragActive') === true);
    if (dragging) {
        greetingCatalogDecorateDeferred = true;
        return;
    }
    if (greetingCatalogDecorateQueued) return;
    greetingCatalogDecorateQueued = true;
    queueMicrotask(() => {
        greetingCatalogDecorateQueued = false;
        const stillDragging = $('dialog.popup .alternate_grettings').toArray().some(node => $(node).data('ocsGreetingDragActive') === true);
        if (stillDragging) {
            greetingCatalogDecorateDeferred = true;
            return;
        }
        greetingCatalogDecorateDeferred = false;
        decorateNativeAlternateGreetings();
    });
}

function captureNativeGreetingControls(event) {
    if (!feature('greeting')) return;
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest('.move_up_alternate_greeting, .move_down_alternate_greeting, .delete_alternate_greeting');
    if (!control) return;
    const root = $(control).closest('dialog.popup').find('.alternate_grettings').first();
    const block = control.closest('.alternate_greeting');
    const index = Number(block?.getAttribute('data-index'));
    const character = currentCharacter();
    if (!root.length || !Number.isInteger(index) || !character?.avatar) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (control.classList.contains('delete_alternate_greeting')) {
        void deleteNativeGreetingIndexes(root, [index]);
        return;
    }
    const direction = control.classList.contains('move_up_alternate_greeting') ? -1 : 1;
    const nextIndex = index + direction;
    const array = alternateGreetings(character);
    if (nextIndex < 0 || nextIndex >= array.length) return;
    const catalog = greetingCatalogState(character);
    const entries = reconcileGreetingCatalog(catalog, character);
    const moved = entries.find(entry => entry.kind === 'alternate' && entry.index === index)?.metadata;
    const adjacent = entries.find(entry => entry.kind === 'alternate' && entry.index === nextIndex)?.metadata;
    if (!moved || !adjacent) return;

    [array[index], array[nextIndex]] = [array[nextIndex], array[index]];
    [moved.lastIndex, adjacent.lastIndex] = [adjacent.lastIndex, moved.lastIndex];
    root.find(`.alternate_greeting[data-index="${index}"] .alternate_greeting_text`).val(array[index]);
    root.find(`.alternate_greeting[data-index="${nextIndex}"] .alternate_greeting_text`).val(array[nextIndex]);
    reconcileGreetingCatalog(catalog, character);
    saveGreetingCatalogState(character, catalog);
    scheduleNativeGreetingDecoration();
}

function installGreetingCatalogIntegration() {
    if (greetingCatalogObserver) return;
    greetingCatalogObserver = new MutationObserver(mutations => {
        const addedGreetingNode = mutations.some(mutation => [...mutation.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE
            && (node.matches('.alternate_grettings, .alternate_greeting') || node.querySelector?.('.alternate_grettings, .alternate_greeting'))));
        if (addedGreetingNode) scheduleNativeGreetingDecoration();
    });
    greetingCatalogObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', captureNativeGreetingControls, true);
    $(document)
        .off('click.oneClickSnapshotGreetingCatalog', '.open_alternate_greetings, .add_alternate_greeting, .move_up_alternate_greeting, .move_down_alternate_greeting')
        .on('click.oneClickSnapshotGreetingCatalog', '.open_alternate_greetings, .add_alternate_greeting, .move_up_alternate_greeting, .move_down_alternate_greeting', scheduleNativeGreetingDecoration);
}

/* ------------------------------------------------ native editor maximizers -- */

/**
 * Fields in the regex editor that deserve a full-screen editor, keyed by the
 * id to assign. The template's labels already point `for=` at exactly these
 * ids but the controls themselves never got one, so setting them also repairs
 * the label-to-field association.
 */
const REGEX_MAXIMIZE_FIELDS = [
    // "Find Regex" is deliberately absent: it is a single-line <input>, and a
    // full-screen textarea invites a stray newline that would break the pattern.
    { selector: '.regex_replace_string', id: 'regex_replace_string' },
    { selector: '.regex_trim_strings', id: 'regex_trim_strings' },
];

/**
 * Adds SillyTavern's own "maximize" button to the regex editor's long fields.
 *
 * Reuses the native `.editor_maximize` control rather than reimplementing it:
 * its handler is delegated on document and resolves the target through
 * `data-for`, so an injected button behaves exactly like the built-in ones.
 */
function decorateRegexEditorFields() {
    if (!feature('native.regexMaximize')) return;
    const dialog = document.querySelector('dialog.popup[open]');
    if (!dialog) return;

    for (const { selector, id } of REGEX_MAXIMIZE_FIELDS) {
        const field = dialog.querySelector(selector);
        if (!field) continue;
        if (!field.id) field.id = id;

        const label = field.closest('.flex1')?.querySelector('label.title_restorable');
        if (!label || label.querySelector('.editor_maximize')) continue;
        label.classList.add('ocs-regex-label');

        const button = document.createElement('i');
        button.className = 'editor_maximize fa-solid fa-maximize right_menu_button';
        button.setAttribute('data-for', field.id);
        button.title = '展开编辑器';
        label.append(button);
    }
}

/** Watches for the regex editor popup so its fields get maximize buttons. */
function installNativeEditorMaximizers() {
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            decorateRegexEditorFields();
        });
    }).observe(document.body, { childList: true, subtree: true });
}

/* -------------------------------------------- preset macro autocomplete -- */

/**
 * Stops the macro autocomplete from popping up while typing in the preset
 * prompt editor.
 *
 * SillyTavern has a global "Show in all macro fields" switch, but the preset
 * editor's textarea is marked `data-macros-autocomplete="always"` in the
 * markup, and `always` bypasses that switch — so no setting can quiet this
 * particular field. Downgrading it to the default mode hands it back to the
 * user's own preference; Ctrl+Space still forces the list open.
 *
 * The attribute has to change before the field is initialised: the mode is read
 * once and captured, and the observer skips elements it has already set up.
 */
function installPresetMacroAutocompleteFix() {
    const relax = () => {
        if (!feature('native.quietMacroAutocomplete')) return;
        for (const node of document.querySelectorAll('[data-macros-autocomplete="always"]')) {
            node.setAttribute('data-macros-autocomplete', 'default');
            node.setAttribute('data-ocs-quiet-macros', '');
        }
    };
    relax();
    new MutationObserver(relax).observe(document.body, { childList: true, subtree: true });

    // The expand button builds a brand new textarea and hardcodes the mode to
    // `always` on it, so relaxing the attribute afterwards is too late: the
    // mode is read once, when the element is initialised, and SillyTavern's own
    // observer was created at import time and therefore runs before ours.
    //
    // Instead the source is marked as not carrying macros for the duration of
    // the click. The copy inherits that and is skipped entirely, while the
    // source keeps the completion it was given long ago -- its own instance
    // already exists and is never rebuilt from the attribute.
    document.addEventListener('click', event => {
        if (!feature('native.quietMacroAutocomplete')) return;

        const opener = /** @type {HTMLElement?} */ (event.target)?.closest?.('.editor_maximize');
        const source = opener?.getAttribute('data-for') && document.getElementById(opener.getAttribute('data-for'));
        if (!(source instanceof HTMLElement) || !source.hasAttribute('data-ocs-quiet-macros')) return;
        if (source.dataset.macros === undefined || source.dataset.macros === 'false') return;

        const original = source.dataset.macros;
        source.dataset.macros = 'false';
        setTimeout(() => { source.dataset.macros = original; }, 0);
    }, true);
}

/* -------------------------------------------- character bulk action buttons -- */

/**
 * The bulk actions SillyTavern only exposes through a right-click on a
 * selected character. Delete is omitted: `#bulkDeleteButton` already shows it.
 */
const CHARACTER_BULK_ACTIONS = [
    { id: 'character_context_menu_favorite', icon: 'fa-star', title: '收藏 / 取消收藏选中的角色' },
    { id: 'character_context_menu_tag', icon: 'fa-tags', title: '给选中的角色批量打标签' },
    { id: 'character_context_menu_duplicate', icon: 'fa-clone', title: '复制选中的角色' },
    { id: 'character_context_menu_persona', icon: 'fa-user', title: '把选中的角色转为用户角色' },
];

/**
 * Surfaces the character context menu as visible buttons, left of the trash.
 *
 * Every button just clicks the native menu entry, so there is no second
 * implementation to keep in sync. They carry `bulkEditOptionElement`, the
 * class SillyTavern already shows and hides with bulk edit mode, so their
 * visibility needs no watching of our own.
 */
function installCharacterBulkActionButtons() {
    const trash = $('#bulkDeleteButton');
    if (!trash.length || $('#ocs_bulk_character_context_menu_tag').length) return;

    for (const action of CHARACTER_BULK_ACTIONS) {
        const button = $('<i class="fa-solid menu_button bulkEditOptionElement" style="display: none;"></i>')
            .attr({ id: `ocs_bulk_${action.id}`, title: action.title })
            .addClass(action.icon)
            .on('click', () => {
                const entry = /** @type {HTMLElement?} */ (document.getElementById(action.id));
                if (!entry) return toastr.warning('找不到酒馆对应的批量操作入口。', '一键快照');
                entry.click();
            });
        trash.before(button);
    }
}

function greetingBindingRecords(character = currentCharacter()) {
    const avatar = character?.avatar;
    if (!avatar) return {};
    return settings().greetingBindings[avatar] ?? {};
}

function cacheOpeningGreetingMap() {
    const character = currentCharacter();
    const chat = SillyTavern.getContext()?.chat;
    if (!character?.avatar || !Array.isArray(chat) || !chat.length) return;
    const opening = chat[0];
    if (!opening || opening.is_user || opening.is_system) return;
    // Greeting bindings are only evaluated before the first real reply. Do
    // not create metadata for established chats that no longer need it.
    if (chat.slice(1).some(message => message && !message.is_user && !message.is_system)) return;
    const candidates = greetingCandidates(character);
    if (!candidates.length) return;
    const value = binding();
    if (Array.isArray(value.greetingMap) && value.greetingMap.length) return;
    // Applying a greeting snapshot can change the live character version.
    // Keep the opening chat's original swipe-to-greeting relationship so a
    // later swipe is not reinterpreted against the newly applied card.
    value.greetingMap = candidates.map(({ key, label, swipeIndex, fingerprint }) => ({ key, label, swipeIndex, fingerprint }));
    saveMetadataDebounced();
}

function openingGreetingCandidates(character) {
    const saved = chat_metadata?.[METADATA_KEY]?.greetingMap;
    if (Array.isArray(saved) && saved.length) return saved;
    return greetingCandidates(character);
}

function snapshotGreetingBindings(snapshotId) {
    let migrated = false;
    const bindings = Object.entries(settings().greetingBindings).flatMap(([avatar, records]) => {
        const character = characters.find(item => item?.avatar === avatar);
        // The landing-page character list can be a lightweight copy without
        // our saved greeting metadata. In that case its fallback “#N” labels
        // are not authoritative, so keep the label stored with the binding.
        const hasGreetingCatalog = Array.isArray(character?.data?.extensions?.one_click_snapshot?.greetingCatalog?.entries);
        const candidates = hasGreetingCatalog ? greetingCandidates(character) : [];
        const matchingBindings = Object.entries(records ?? {})
            .filter(([, record]) => record?.snapshotId === snapshotId)
            .map(([key, record]) => {
                const liveLabel = candidates.find(candidate => candidate.key === key)?.label;
                // When the full character card is available, its current
                // name is the source of truth and also refreshes old records.
                if (liveLabel && record.label !== liveLabel) {
                    record.label = liveLabel;
                    migrated = true;
                }
                return {
                    avatar,
                    characterName: character?.name || record.characterName || avatar,
                    key,
                    label: liveLabel || record.label || greetingLabelFromKey(key) || '已变更的开场白',
                    enabled: record.enabled !== false,
                };
        });
        return matchingBindings;
    });
    if (migrated) saveSettingsDebounced();
    return bindings;
}

async function chooseGreetingCandidate(character, { onlySnapshotId = null, title = '绑定开场白快照', confirmLabel = '确认绑定' } = {}) {
    const records = greetingBindingRecords(character);
    const candidates = greetingCandidates(character).filter(candidate => !onlySnapshotId || records[candidate.key]?.snapshotId === onlySnapshotId);
    if (!candidates.length) {
        toastr.warning(onlySnapshotId ? '当前角色没有可解绑的开场白。' : '当前角色还没有可绑定的开场白。', '一键快照');
        return null;
    }
    const root = $('<div class="ocs-greeting-choice"><div class="ocs-greeting-choice-groups"><span class="ocs-greeting-choice-group-title">分组</span><div class="ocs-greeting-choice-group-tags" role="group" aria-label="选择开场白分组"></div></div><label class="ocs-greeting-choice-label">开场白<select class="text_pole ocs-greeting-choice-select"></select></label><p class="ocs-greeting-choice-preview"></p></div>');
    const groupTags = root.find('.ocs-greeting-choice-group-tags');
    const select = root.find('.ocs-greeting-choice-select');
    const groups = [...new Set(candidates.map(candidate => candidate.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const groupOptions = [{ key: '__all__', label: '全部' }];
    if (candidates.some(candidate => !candidate.group)) groupOptions.push({ key: '', label: '未分组' });
    groupOptions.push(...groups.map(group => ({ key: group, label: group })));
    let selectedGroup = '__all__';
    const renderCandidates = () => {
        const filtered = candidates.filter(candidate => selectedGroup === '__all__' || candidate.group === selectedGroup);
        select.empty();
        for (const candidate of filtered) select.append($('<option></option>').val(candidate.key).text(candidate.label));
        root.find('.ocs-greeting-choice-preview').text(filtered.find(candidate => candidate.key === select.val())?.text ?? '');
    };
    for (const option of groupOptions) {
        const tag = $('<button type="button" class="ocs-greeting-choice-group-tag"></button>')
            .text(option.label)
            .attr({ 'data-group': option.key, 'aria-pressed': option.key === selectedGroup ? 'true' : 'false' })
            .toggleClass('is-active', option.key === selectedGroup)
            .on('click', event => {
                event.preventDefault();
                event.stopPropagation();
                selectedGroup = option.key;
                groupTags.find('.ocs-greeting-choice-group-tag')
                    .removeClass('is-active')
                    .attr('aria-pressed', 'false');
                tag.addClass('is-active').attr('aria-pressed', 'true');
                renderCandidates();
            });
        groupTags.append(tag);
    }
    select.on('change', () => root.find('.ocs-greeting-choice-preview').text(candidates.find(candidate => candidate.key === select.val())?.text ?? ''));
    renderCandidates();
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, title, {
        wide: false,
        leftAlign: true,
        okButton: confirmLabel,
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
    return candidates.find(candidate => candidate.key === select.val()) ?? null;
}

async function bindSnapshotToGreeting(snapshot) {
    if (!snapshotCanBindToCurrentCharacter(snapshot, { notify: true })) return false;
    const character = currentCharacter();
    if (!character?.avatar) return false;
    const candidate = await chooseGreetingCandidate(character);
    if (!candidate) return false;
    const requirements = snapshotRequirements(snapshot);
    const userMode = await chooseCharacterBindingUserMode(snapshot, requirements, character, { purpose: '开场白快照' });
    if (userMode === null) return false;
    if (userMode === 'connect' && !await connectPersonaToCharacter(requirements.personaAvatar, character.avatar)) {
        toastr.error('无法连接该用户到当前角色。', '一键快照');
        return false;
    }
    settings().greetingBindings[character.avatar] ??= {};
    settings().greetingBindings[character.avatar][candidate.key] = {
        snapshotId: snapshot.id,
        fingerprint: candidate.fingerprint,
        label: candidate.label,
        characterName: character.name,
        userMode,
    };
    saveSettingsDebounced();
    toastr.success(`已将“${candidate.label}”绑定到快照“${snapshot.name}”。`, '一键快照');
    return true;
}

async function unbindSnapshotFromGreeting(snapshotId) {
    const character = currentCharacter();
    if (!character?.avatar) return false;
    const candidate = await chooseGreetingCandidate(character, {
        onlySnapshotId: snapshotId,
        title: '解绑开场白快照',
        confirmLabel: '确认解绑',
    });
    if (!candidate) return false;
    delete settings().greetingBindings[character.avatar]?.[candidate.key];
    if (!Object.keys(settings().greetingBindings[character.avatar] ?? {}).length) delete settings().greetingBindings[character.avatar];
    saveSettingsDebounced();
    return true;
}

function pruneSnapshotGroups() {
    const inUse = new Set(settings().snapshots.map(snapshot => String(snapshot.group ?? '').trim()).filter(Boolean));
    const before = settings().snapshotGroups.length;
    settings().snapshotGroups = settings().snapshotGroups.filter(group => inUse.has(group));
    return settings().snapshotGroups.length !== before;
}

function versionContext(type) {
    const character = type === 'character';
    return {
        title: character ? '角色版本' : '用户版本',
        promptTitle: character ? '新建角色版本' : '新建用户版本',
        promptHint: character ? '例如：现代版、古代版、校园 AU' : '例如：现代的我、古代的我',
        list: character ? characterVersions() : personaVersions(),
        current: character ? currentCharacterVersion() : currentPersonaVersion(),
        capture: character ? captureCharacter : capturePersona,
        apply: character ? applyCharacter : applyPersona,
    };
}

function versionGroups(type) {
    const avatar = type === 'character' ? currentCharacter()?.avatar : user_avatar;
    const key = type === 'character' ? 'characterVersionGroups' : 'personaVersionGroups';
    if (!avatar) return [];
    settings()[key][avatar] ??= [];
    return settings()[key][avatar];
}

function pruneVersionGroups(type) {
    const names = new Set(versionContext(type).list.map(version => String(version.group ?? '').trim()).filter(Boolean));
    const groups = versionGroups(type);
    const next = groups.filter(group => names.has(group));
    const changed = next.length !== groups.length;
    if (changed) {
        const avatar = type === 'character' ? currentCharacter()?.avatar : user_avatar;
        settings()[type === 'character' ? 'characterVersionGroups' : 'personaVersionGroups'][avatar] = next;
    }
    return changed;
}

function emptyVersionData(type, state) {
    // Versions are deliberately description-first. Keep the rest of the
    // character card as a safe baseline instead of making a blank version
    // unexpectedly wipe fields the user is not editing here.
    if (type === 'character') return { ...state, description: '' };
    return { ...state, descriptor: { ...deepClone(state.descriptor ?? {}), description: '' } };
}

function versionDataEquals(type, left, right) {
    const description = value => type === 'character'
        ? String(value?.description ?? '')
        : String(value?.descriptor?.description ?? '');
    return description(left) === description(right);
}

// The native editor writes its textarea before the full character/persona
// object is necessarily persisted. Read the visible field directly so both
// manual and automatic updates always capture what the user just typed.
function captureVersionFormState(type) {
    const state = type === 'character' ? captureCharacter() : capturePersona();
    if (!state) return null;
    if (type === 'character') {
        const field = $('#description_textarea');
        if (field.length) state.description = String(field.val() ?? '');
    } else {
        const field = $('#persona_description');
        if (field.length) {
            state.descriptor ??= {};
            state.descriptor.description = String(field.val() ?? '');
        }
    }
    return state;
}

function saveCurrentAsVersion(type) {
    const context = versionContext(type);
    const state = captureVersionFormState(type);
    if (!state) return Promise.resolve();
    return Popup.show.input(`另存当前${context.title}`, context.promptHint, '').then(name => {
        if (name === null) return;
        const version = { id: makeId(), createdAt: Date.now(), updatedAt: Date.now(), name: name.trim() || `${context.title} ${context.list.length + 1}`, data: state, group: '' };
        context.list.push(version);
        if (type === 'character') settings().activeCharacterVersions[state.avatar] = version.id;
        else settings().activePersonaVersions[state.avatar] = version.id;
        saveSettingsDebounced();
        refreshVersionIndicators();
    });
}

async function createBlankVersion(type) {
    const context = versionContext(type);
    const state = captureVersionFormState(type);
    if (!state) return;
    const name = await Popup.show.input(`新建空白${context.title}`, '创建后可在下方展开版本并填写提示词。', '');
    if (name === null) return;
    const version = { id: makeId(), createdAt: Date.now(), updatedAt: Date.now(), name: name.trim() || `${context.title} ${context.list.length + 1}`, data: emptyVersionData(type, state), group: '' };
    context.list.push(version);
    saveSettingsDebounced();
    await openVersionDescriptionEditor(type, version);
}

async function updateCurrentVersion(type) {
    const context = versionContext(type);
    const state = captureVersionFormState(type);
    if (!context.current || !state) return saveCurrentAsVersion(type);
    context.current.data = state;
    context.current.updatedAt = Date.now();
    saveSettingsDebounced();
    refreshVersionIndicators();
    toastr.success(`已更新${context.current.name}`, '一键快照');
}

function autoSyncCurrentVersion(type) {
    if (!settings().autoSyncVersions) return;
    const context = versionContext(type);
    const state = captureVersionFormState(type);
    if (!context.current || !state) return;
    clearTimeout(versionAutoSyncTimer);
    versionAutoSyncTimer = setTimeout(() => {
        // Re-read after the debounce: the user may have changed persona or
        // character during the same short typing burst.
        const fresh = versionContext(type);
        const latest = captureVersionFormState(type);
        if (!fresh.current || !latest) return;
        fresh.current.data = latest;
        fresh.current.updatedAt = Date.now();
        saveSettingsDebounced();
        refreshVersionIndicators();
        $(document).trigger('oneClickSnapshotVersionAutoSynced', [type]);
    }, 450);
}

function installVersionAutoSync() {
    $(document)
        .off('input.oneClickSnapshotVersionAuto', '#description_textarea')
        .on('input.oneClickSnapshotVersionAuto', '#description_textarea', () => autoSyncCurrentVersion('character'))
        .off('input.oneClickSnapshotVersionAuto', '#persona_description')
        .on('input.oneClickSnapshotVersionAuto', '#persona_description', () => autoSyncCurrentVersion('persona'));
}

async function applyVersion(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    await context.apply(version.data, version.id);
    // The character path already mirrored the name into the card it just saved.
    if (type === 'persona') await applyNameMirror('persona');
    saveSettingsDebounced();
    refreshVersionIndicators();
    refreshNameMirrorLocks();
}

async function openVersionQuickSwitcher(type) {
    const context = versionContext(type);
    if (!context.capture()) return toastr.warning(`请先选择${type === 'character' ? '角色' : '用户人设'}。`, '一键快照');
    const root = $('<div class="ocs-version-switch-popup"></div>');
    root.append($('<header><span class="ocs-kicker">VERSION SWITCHER</span><h3></h3></header>').find('h3').text(`切换${context.title}`).end());
    const versions = [...context.list].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!versions.length) {
        root.append('<div class="ocs-empty">还没有可切换的版本。请先在“管理版本”中创建版本。</div>');
        return await showOcsPopup(root);
    }
    const form = $('<div class="ocs-version-switch-form"></div>');
    const select = $('<select class="text_pole ocs-version-switch-select"></select>');
    for (const version of versions) select.append($('<option></option>').val(version.id).text(version.name));
    select.val(context.current?.id ?? versions[0].id);
    form.append($('<label class="ocs-version-switch-field"></label>').append('<span>选择版本</span>', select));
    root.append(form);
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, '', {
        wide: false,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: '确认切换',
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const versionId = String(select.val() ?? '');
        if (!versionId) return;
        if (context.current?.id !== versionId) await applyVersion(type, versionId);
    }
}

function syncSnapshotVersionName(type, versionId, name) {
    const payloadKey = type === 'character' ? 'character' : 'persona';
    let changed = false;
    for (const snapshot of settings().snapshots) {
        const reference = snapshot.payload?.[payloadKey];
        if (reference?.versionId !== versionId || reference.versionName === name) continue;
        // Do not update the snapshot timestamp: only its display label has
        // changed, while the recorded switch state remains untouched.
        reference.versionName = name;
        changed = true;
    }
    return changed;
}

function syncStoredSnapshotVersionNames() {
    let changed = false;
    for (const snapshot of settings().snapshots) {
        for (const [type, payloadKey, storeKey] of [
            ['character', 'character', 'characterVersions'],
            ['persona', 'persona', 'personaVersions'],
        ]) {
            const reference = snapshot.payload?.[payloadKey];
            const avatar = reference?.data?.avatar;
            if (!reference?.versionId || !avatar) continue;
            const version = settings()[storeKey]?.[avatar]?.find(item => item.id === reference.versionId);
            if (version) changed = syncSnapshotVersionName(type, version.id, version.name) || changed;
        }
    }
    return changed;
}

async function renameVersion(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    const name = await Popup.show.input(`重命名${context.title}`, '名称会同步到关联快照的显示；快照应用的仍是这个版本的当前内容。', version.name);
    if (name === null) return;
    version.name = name.trim() || version.name;
    syncSnapshotVersionName(type, version.id, version.name);
    version.updatedAt = Date.now();
    saveSettingsDebounced();
    // Renaming the active version must move the mirrored label with it.
    if (version.id === (type === 'character' ? currentCharacterVersion() : currentPersonaVersion())?.id) {
        await applyNameMirror(type);
    }
    refreshVersionIndicators();
}

async function chooseGroup(currentGroup, availableGroups, { title = '移动到分组', okButton = '确认移动' } = {}) {
    const groups = [...new Set([
        ...availableGroups,
        String(currentGroup ?? '').trim(),
    ].filter(Boolean))];
    const root = $('<div class="ocs-group-picker"></div>');
    root.append('<p>选择一个已有分组，或在下方输入新名称。</p>');
    const select = $('<select class="text_pole ocs-group-picker-select"></select>');
    select.append('<option value="">未分组</option>');
    for (const group of groups) select.append($('<option></option>').val(group).text(group));
    select.val(String(currentGroup ?? ''));
    const newGroup = $('<input class="text_pole ocs-group-picker-new" type="text" placeholder="输入新分组名称">');
    select.on('change', () => newGroup.val(''));
    root.append(
        $('<label class="ocs-group-picker-select-label">已有分组</label>').append(select),
        $('<label class="ocs-group-picker-new-label">新建分组</label>').append(newGroup),
    );
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, title, {
        wide: false,
        leftAlign: true,
        okButton,
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
    return String(newGroup.val() ?? '').trim() || String(select.val() ?? '');
}

async function setVersionGroup(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    const group = await chooseGroup(version.group, [
        ...versionGroups(type),
        ...context.list.map(item => String(item.group ?? '').trim()),
    ]);
    if (group === null) return;
    version.group = group;
    if (version.group && !versionGroups(type).includes(version.group)) versionGroups(type).push(version.group);
    pruneVersionGroups(type);
    version.updatedAt = Date.now();
    saveSettingsDebounced();
}

/** Ways to order a version library, in dropdown order. */
const VERSION_SORTS = {
    'updated-desc': { label: '最近更新', compare: (a, b) => b.updatedAt - a.updatedAt },
    'updated-asc': { label: '最早更新', compare: (a, b) => a.updatedAt - b.updatedAt },
    'created-desc': { label: '最近创建', compare: (a, b) => b.createdAt - a.createdAt },
    'created-asc': { label: '最早创建', compare: (a, b) => a.createdAt - b.createdAt },
    'name-asc': { label: '名称 A-Z', compare: (a, b) => String(a.name).localeCompare(String(b.name)) },
    'name-desc': { label: '名称 Z-A', compare: (a, b) => String(b.name).localeCompare(String(a.name)) },
};

function versionSort() {
    const stored = settings().versionSort;
    return Object.hasOwn(VERSION_SORTS, stored) ? stored : 'updated-desc';
}

/** Removes a version and any reference to it, without asking. */
function removeVersion(type, versionId) {
    const context = versionContext(type);
    const index = context.list.findIndex(item => item.id === versionId);
    if (index === -1) return false;
    context.list.splice(index, 1);
    if (type === 'character' && settings().activeCharacterVersions[currentCharacter()?.avatar] === versionId) delete settings().activeCharacterVersions[currentCharacter()?.avatar];
    if (type === 'persona' && settings().activePersonaVersions[user_avatar] === versionId) delete settings().activePersonaVersions[user_avatar];
    return true;
}

async function deleteVersion(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    if (!await Popup.show.confirm(`删除${context.title}`, `删除“${version.name}”？已保存的快照不会受影响。`)) return;
    removeVersion(type, versionId);
    pruneVersionGroups(type);
    saveSettingsDebounced();
    refreshVersionIndicators();
}

function getVersionDescription(type, version) {
    return type === 'character' ? String(version.data?.description ?? '') : String(version.data?.descriptor?.description ?? '');
}

function appendDiffFragment(container, text, className = '') {
    if (!text) return;
    container.append($('<span></span>').toggleClass(className, Boolean(className)).text(text));
}

async function openVersionComparison(type) {
    const context = versionContext(type);
    const versions = [...context.list].sort((a, b) => b.updatedAt - a.updatedAt);
    if (versions.length < 2) {
        toastr.warning(`至少需要两个${context.title}才能对比。`, '一键快照');
        return;
    }

    const root = $('<div class="ocs-version-diff-popup"></div>');
    root.append($('<header><span class="ocs-kicker">VERSION DIFF</span><h3></h3><p></p></header>')
        .find('h3').text(`对比${context.title}`).end()
        .find('p').text('只读对比版本描述：红色为来源中删除的内容，青色为目标中新加的内容。').end());
    const selectors = $('<div class="ocs-version-diff-selectors"></div>');
    const sourceSelect = $('<select class="text_pole"></select>');
    const targetSelect = $('<select class="text_pole"></select>');
    for (const version of versions) {
        sourceSelect.append($('<option></option>').val(version.id).text(version.name));
        targetSelect.append($('<option></option>').val(version.id).text(version.name));
    }
    sourceSelect.val(versions[1].id);
    targetSelect.val(context.current?.id && context.list.some(version => version.id === context.current.id) ? context.current.id : versions[0].id);
    if (sourceSelect.val() === targetSelect.val()) sourceSelect.val(versions[0].id === targetSelect.val() ? versions[1].id : versions[0].id);
    selectors.append($('<label></label>').append('<span>来源</span>', sourceSelect), $('<label></label>').append('<span>目标</span>', targetSelect));
    root.append(selectors);

    const summary = $('<p class="ocs-version-diff-summary"></p>');
    const panes = $('<div class="ocs-version-diff-panes"></div>');
    const sourcePane = $('<section class="ocs-version-diff-pane ocs-version-diff-source"></section>');
    const targetPane = $('<section class="ocs-version-diff-pane ocs-version-diff-target"></section>');
    const sourceHeading = $('<header><span>来源</span><strong></strong></header>');
    const targetHeading = $('<header><span>目标</span><strong></strong></header>');
    const sourceText = $('<div class="ocs-version-diff-text"></div>');
    const targetText = $('<div class="ocs-version-diff-text"></div>');
    sourcePane.append(sourceHeading, sourceText);
    targetPane.append(targetHeading, targetText);
    panes.append(sourcePane, targetPane);
    root.append(summary, panes);

    const render = () => {
        const source = context.list.find(version => version.id === sourceSelect.val());
        const target = context.list.find(version => version.id === targetSelect.val());
        if (!source || !target) return;
        sourceHeading.find('strong').text(source.name);
        targetHeading.find('strong').text(target.name);
        sourceText.empty();
        targetText.empty();
        const sourceValue = getVersionDescription(type, source);
        const targetValue = getVersionDescription(type, target);
        const differ = new DiffMatchPatch();
        const diffs = differ.diff_main(sourceValue, targetValue);
        differ.diff_cleanupSemantic(diffs);
        let removed = 0;
        let added = 0;
        for (const [operation, text] of diffs) {
            if (operation === -1) {
                appendDiffFragment(sourceText, text, 'ocs-version-diff-removed');
                removed += text.length;
            } else if (operation === 1) {
                appendDiffFragment(targetText, text, 'ocs-version-diff-added');
                added += text.length;
            } else {
                appendDiffFragment(sourceText, text);
                appendDiffFragment(targetText, text);
            }
        }
        if (!sourceValue) sourceText.append('<span class="ocs-version-diff-empty">（空白描述）</span>');
        if (!targetValue) targetText.append('<span class="ocs-version-diff-empty">（空白描述）</span>');
        summary.text(added || removed ? `目标新增 ${added} 字，来源删减 ${removed} 字。` : '两个版本的描述完全一致。');
    };
    let syncing = false;
    sourceText.add(targetText).on('scroll', event => {
        if (syncing) return;
        syncing = true;
        const other = event.currentTarget === sourceText.get(0) ? targetText : sourceText;
        other.scrollTop($(event.currentTarget).scrollTop());
        syncing = false;
    });
    sourceSelect.add(targetSelect).on('change', render);
    render();
    await showOcsPopup(root);
}

async function openVersionDescriptionEditor(type, version) {
    const label = type === 'character' ? '角色描述' : '用户描述';
    const root = $('<div class="ocs-version-editor-popup"></div>');
    root.append($('<header><span class="ocs-kicker">VERSION EDITOR</span><h3></h3></header>').find('h3').text(version.name).end());
    root.append($('<label class="ocs-version-edit-label"></label>').text(label).append($('<textarea class="text_pole" rows="12"></textarea>').val(getVersionDescription(type, version))));
    const actions = $('<div class="ocs-version-editor-actions"></div>');
    actions.append($('<button class="ocs-button ocs-primary">保存</button>').on('click', async () => {
        const data = deepClone(version.data);
        const value = String(root.find('textarea').val() ?? '');
        if (type === 'character') data.description = value;
        else { data.descriptor ??= {}; data.descriptor.description = value; }
        version.data = data;
        version.updatedAt = Date.now();
        saveSettingsDebounced();
        const context = versionContext(type);
        if (context.current?.id === version.id) {
            // The user is editing the version already active in SillyTavern,
            // so keep its native editor in sync. This is not a version switch;
            // preserve the live greeting catalog while writing the update.
            await context.apply(version.data, version.id, { preserveGreetingCatalog: true });
            saveSettingsDebounced();
            toastr.success(`已保存并同步当前版本：${version.name}`, '一键快照');
        } else {
            toastr.success(`已保存版本：${version.name}`, '一键快照');
        }
    }));
    root.append(actions);
    await showOcsPopup(root);
}

function versionPreview(type, version) {
    const preview = $('<div class="ocs-version-preview"></div>');
    const content = getVersionDescription(type, version);
    const avatarPath = version.avatarPath || originalAvatarPath(type);
    const avatarTitle = version.avatarPath ? '版本头像' : '原生头像';
    preview.append($('<div class="ocs-version-avatar-state"></div>').append(
        $('<span></span>').text('头像'),
        $('<img class="ocs-version-avatar-thumbnail" alt="">').attr({ src: avatarPath, title: avatarTitle }),
    ));
    preview.append($('<div class="ocs-version-preview-label"></div>').text(type === 'character' ? '角色描述' : '用户描述'));
    preview.append($('<p></p>').text(content || '（空白描述）'));
    return preview;
}

async function openVersionAvatarPicker(type, version) {
    const owner = versionAvatarOwner(type);
    if (!owner) return toastr.warning(`请先选择${type === 'character' ? '角色' : '用户人设'}。`, '一键快照');
    if (!version) return;
    const title = `设置“${version.name}”的头像`;
    const root = $('<div class="ocs-avatar-picker"></div>');
    root.append($('<header><span class="ocs-kicker">VERSION AVATAR</span><h3></h3><p></p></header>')
        .find('h3').text(title).end()
        .find('p').text('版本头像只读取图库中的图片。选择“原生头像”会清除这个版本的临时替换，不修改原生头像或图库插件的主题绑定。').end());
    if (!hasVersionAvatarGallery(type)) {
        root.append($('<div class="ocs-avatar-picker-note"></div>').text('未检测到头像图库。可先安装并启用 AvatarCropper，再把图片加入对应角色或用户的图库。'));
    } else if (!versionAvatarGallery(type).length) {
        root.append($('<div class="ocs-avatar-picker-note"></div>').text('当前图库还没有图片；此处仍可选择原始头像。'));
    }

    const choices = $('<div class="ocs-avatar-choice-grid"></div>');
    let selected = version.avatarPath ?? null;
    const selectedKey = () => selected ?? '__original__';
    const renderSelected = () => choices.find('.ocs-avatar-choice').each((_, element) => {
        const choice = $(element);
        choice.toggleClass('ocs-avatar-choice-selected', choice.data('ocsAvatarChoice') === selectedKey());
    });
    const addChoice = (key, label, path, detail = '') => {
        const choice = $('<button type="button" class="ocs-avatar-choice"></button>').data('ocsAvatarChoice', key);
        const previewPath = path ?? originalAvatarPath(type);
        choice.append($('<img alt="">').attr('src', previewPath), $('<span class="ocs-avatar-choice-label"></span>').text(label));
        if (detail) choice.append($('<small></small>').text(detail));
        choice.on('click', () => {
            selected = key === '__original__' ? null : key;
            renderSelected();
        });
        choices.append(choice);
    };
    addChoice('__original__', '原始头像', null, '不替换');
    for (const path of versionAvatarGallery(type)) addChoice(path, avatarPathLabel(path), path);
    root.append(choices);

    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, '', {
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: '保存头像',
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    renderSelected();
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;

    // Keep an explicit null for “原始头像”: it makes the next version apply
    // clear AvatarCropper's corresponding theme binding as well.
    if (!selected) version.avatarPath = null;
    else version.avatarPath = selected;
    version.updatedAt = Date.now();
    if (versionContext(type).current?.id === version.id) {
        syncVersionAvatarToGallery(type, version);
        refreshVersionAvatarOverrides();
    }
    toastr.success(`已保存“${version.name}”的版本头像`, '一键快照');
    saveSettingsDebounced();
}

async function openVersionManager(type) {
    const context = versionContext(type);
    if (!context.capture()) return toastr.warning(`请先选择${type === 'character' ? '角色' : '用户人设'}。`, '一键快照');
    if (pruneVersionGroups(type)) saveSettingsDebounced();
    const root = $(`<div class="ocs-version-popup"><header><span class="ocs-kicker">VERSION LIBRARY</span><h3>${context.title}</h3><p>展开版本可查看和编辑描述；保存当前正在使用的版本会同步原生描述框，保存其他版本只更新版本本身。</p></header><div class="ocs-version-toolbar"><button class="ocs-button ocs-version-compare"><i class="fa-solid fa-code-compare"></i> 对比版本</button><button class="ocs-button ocs-version-blank"><i class="fa-solid fa-plus"></i> 新建空白版本</button><button class="ocs-button ocs-version-copy"><i class="fa-solid fa-copy"></i> 另存当前描述</button><button class="ocs-button ocs-version-auto-sync"></button><button class="ocs-button ocs-version-name-mirror"></button></div><div class="ocs-library-heading"><div class="ocs-library-tools"><select class="text_pole ocs-version-filter"></select><button type="button" class="ocs-button ocs-icon-button ocs-version-expand" title="全部展开"><i class="fa-solid fa-angles-down"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-version-collapse" title="全部折叠"><i class="fa-solid fa-angles-up"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-version-bulk" title="批量操作"><i class="fa-solid fa-list-check"></i></button><span class="ocs-library-bulk-only ocs-bulk-count">0</span><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-version-bulk-all" title="全选 / 取消全选"><i class="fa-solid fa-check-double"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-version-bulk-group" title="移动选中的版本到分组"><i class="fa-solid fa-folder-tree"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-danger ocs-library-bulk-only ocs-version-bulk-delete" title="删除选中的版本"><i class="fa-solid fa-trash"></i></button></div><div class="ocs-library-footer"><div class="ocs-version-pagination"></div><select class="text_pole ocs-library-sort ocs-version-sort" title="排序方式"></select></div></div><div class="ocs-version-list"></div></div>`);
    const expandedVersionIds = new Set();
    let expansionInitialized = false;
    const syncButton = root.find('.ocs-version-auto-sync');
    const renderAutoSyncButton = () => {
        // Same value the settings panel edits, so the two never disagree.
        const enabled = settings().autoSyncVersions === true;
        syncButton.toggleClass('ocs-auto-sync-enabled', enabled).html(`<i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> 同步描述到版本`).attr('title', '开启后，原生描述框的修改会自动保存到当前应用版本。');
    };
    syncButton.on('click', () => {
        settings().autoSyncVersions = !settings().autoSyncVersions;
        saveSettingsDebounced();
        renderAutoSyncButton();
    });

    const nativeFieldName = type === 'character' ? '角色版本' : '备注';
    const mirrorButton = root.find('.ocs-version-name-mirror');
    const renderMirrorButton = () => {
        const enabled = isNameMirrorEnabled(type);
        mirrorButton
            .toggleClass('ocs-auto-sync-enabled', enabled)
            .html(`<i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> 同步名称到${nativeFieldName}`)
            .attr('title', `开启后，当前版本的名称会实时写入原生「${nativeFieldName}」，列表里就能直接看到正在用哪个版本。开启期间该字段不可手动修改。`);
    };
    mirrorButton.on('click', async () => {
        const owner = nameMirrorOwner(type);
        if (!owner) return;
        const store = nameMirrorStore(type);

        if (isNameMirrorEnabled(type, owner)) {
            const previous = String(store[owner]?.previous ?? '');
            delete store[owner];
            saveSettingsDebounced();
            if (previous && previous !== nativeVersionLabel(type)) {
                const restore = await Popup.show.confirm('关闭同步', `是否把「${nativeFieldName}」恢复成开启同步前的内容？<br><br>原值：${previous || '（空）'}<br>当前：${nativeVersionLabel(type) || '（空）'}`);
                if (restore) await writeNativeVersionLabel(type, previous);
            }
            renderMirrorButton();
            refreshNameMirrorLocks();
            return;
        }

        const current = nativeVersionLabel(type);
        const version = type === 'character' ? currentCharacterVersion() : currentPersonaVersion();
        if (current && current !== version?.name) {
            const overwrite = await Popup.show.confirm('覆盖现有内容', `「${nativeFieldName}」当前是「${current}」，开启同步会用版本名覆盖它。<br><br>关闭同步时可以恢复回来。要继续吗？`);
            if (!overwrite) return;
        }

        store[owner] = { previous: current };
        saveSettingsDebounced();
        await applyNameMirror(type);
        renderMirrorButton();
        refreshNameMirrorLocks();
        render();
    });
    const selection = new Set();
    let bulkMode = false;
    let page = 1;

    const visibleVersions = () => {
        const fresh = versionContext(type);
        const wanted = String(root.find('.ocs-version-filter').val() ?? '__all__');
        const compare = VERSION_SORTS[versionSort()].compare;
        return fresh.list
            .filter(version => wanted === '__all__' || (version.group || '未分组') === wanted)
            .sort((a, b) => {
                // The version in use stays on top whatever the order, the same
                // way the library pins the snapshot in use.
                const currentOrder = Number(b.id === fresh.current?.id) - Number(a.id === fresh.current?.id);
                return currentOrder || compare(a, b);
            });
    };

    const updateBulkControls = () => {
        // A class, not .toggle(): `.ocs-button` is `display: inline-flex !important`.
        root.find('.ocs-library-tools').toggleClass('ocs-bulk-on', bulkMode);
        root.find('.ocs-bulk-count').text(String(selection.size));
        root.find('.ocs-version-bulk').toggleClass('ocs-primary', bulkMode);
    };

    const renderFilter = () => {
        const select = root.find('.ocs-version-filter');
        const previous = String(select.val() ?? '__all__');
        const groups = [...new Set(versionContext(type).list.map(version => version.group || '未分组'))];
        select.empty().append('<option value="__all__">全部分组</option>');
        for (const group of groups) select.append($('<option></option>').attr('value', group).text(group));
        select.val(groups.includes(previous) ? previous : '__all__');
    };

    const renderCard = (version, current) => {
        const card = $('<details class="ocs-version-card"></details>')
            .attr('data-ocs-version-id', version.id)
            .toggleClass('ocs-active-version', current?.id === version.id)
            .prop('open', expandedVersionIds.has(version.id));
        card.on('toggle', () => {
            if (card.prop('open')) expandedVersionIds.add(version.id);
            else expandedVersionIds.delete(version.id);
        });

        const summary = $('<summary></summary>');
        if (bulkMode) {
            const tick = $('<input type="checkbox" class="ocs-card-tick">').prop('checked', selection.has(version.id));
            tick.on('click', event => event.stopPropagation());
            tick.on('change', function () {
                if (this.checked) selection.add(version.id);
                else selection.delete(version.id);
                updateBulkControls();
            });
            summary.append(tick);
        }
        summary.append($('<strong></strong>').text(version.name));
        if (version.group) summary.append($('<span class="ocs-card-group"></span>').text(version.group));
        summary.append($('<small></small>').text(`更新于 ${new Date(version.updatedAt).toLocaleString()}`));
        card.append(summary, versionPreview(type, version));

        const actions = $('<div class="ocs-card-actions"></div>');
        if (current?.id === version.id && !versionDataEquals(type, version.data, captureVersionFormState(type))) {
            card.append($('<div class="ocs-version-change-state"></div>').text('原生描述已更改'));
            actions.append($('<button class="ocs-button ocs-primary">更新</button>').on('click', async () => { await updateCurrentVersion(type); render(); }));
        }
        actions.append($('<button class="ocs-button">展开编辑</button>').on('click', async () => { await openVersionDescriptionEditor(type, version); render(); }));
        actions.append($('<button class="ocs-button">头像</button>').on('click', async () => { await openVersionAvatarPicker(type, version); render(); }));
        actions.append($('<button class="ocs-button">应用</button>').on('click', async () => { await applyVersion(type, version.id); render(); }));
        actions.append($('<button class="ocs-button">重命名</button>').on('click', async () => { await renameVersion(type, version.id); render(); }));
        actions.append($('<button class="ocs-button">分组</button>').on('click', async () => { await setVersionGroup(type, version.id); render(); }));
        actions.append($('<button class="ocs-button ocs-danger">删除</button>').on('click', async () => { await deleteVersion(type, version.id); render(); }));
        card.append(actions);
        return card;
    };

    const render = () => {
        const list = root.find('.ocs-version-list').empty();
        const pager = root.find('.ocs-version-pagination');
        const fresh = versionContext(type);
        if (!expansionInitialized) {
            if (fresh.current?.id) expandedVersionIds.add(fresh.current.id);
            expansionInitialized = true;
        }
        renderFilter();

        const versions = visibleVersions();
        const visibleIds = new Set(versions.map(version => version.id));
        for (const id of [...selection]) {
            if (!visibleIds.has(id)) selection.delete(id);
        }
        updateBulkControls();

        if (!versions.length) {
            pager.empty();
            return list.append('<div class="ocs-empty">还没有版本。可新建空白版本，或把当前原生描述另存为版本。</div>');
        }

        const perPage = Number(accountStorage.getItem(VERSION_PAGE_KEY)) || 10;
        pager.pagination({
            dataSource: versions,
            pageSize: perPage,
            sizeChangerOptions: SNAPSHOT_PAGE_SIZES,
            pageRange: 1,
            pageNumber: page,
            position: 'top',
            showPageNumbers: false,
            showSizeChanger: true,
            formatSizeChanger: renderPaginationDropdown(perPage, SNAPSHOT_PAGE_SIZES),
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            callback: function (data) {
                list.empty();
                for (const version of data) list.append(renderCard(version, fresh.current));
                localizePagination(pager);
            },
            afterSizeSelectorChange: function (event, size) {
                accountStorage.setItem(VERSION_PAGE_KEY, event.target.value);
                paginationDropdownChangeHandler(event, size);
            },
            afterPaging: function (current) {
                page = current;
            },
        });
    };

    const sortSelect = root.find('.ocs-version-sort');
    for (const [value, { label }] of Object.entries(VERSION_SORTS)) {
        sortSelect.append($('<option></option>').attr('value', value).text(label));
    }
    sortSelect.val(versionSort()).on('change', function () {
        settings().versionSort = String($(this).val());
        saveSettingsDebounced();
        page = 1;
        render();
    });
    root.find('.ocs-version-filter').on('change', () => { page = 1; render(); });
    root.find('.ocs-version-expand').on('click', () => root.find('.ocs-version-card').prop('open', true).each((_, node) => expandedVersionIds.add(node.dataset.ocsVersionId)));
    root.find('.ocs-version-collapse').on('click', () => root.find('.ocs-version-card').prop('open', false).each((_, node) => expandedVersionIds.delete(node.dataset.ocsVersionId)));
    root.find('.ocs-version-bulk').on('click', () => {
        bulkMode = !bulkMode;
        if (!bulkMode) selection.clear();
        render();
    });
    root.find('.ocs-version-bulk-all').on('click', () => {
        const ids = visibleVersions().map(version => version.id);
        const allPicked = ids.length > 0 && ids.every(id => selection.has(id));
        selection.clear();
        if (!allPicked) for (const id of ids) selection.add(id);
        render();
    });
    root.find('.ocs-version-bulk-group').on('click', async () => {
        if (!selection.size) return toastr.info('请先选择版本。', '一键快照');
        const group = await chooseGroup('', versionGroups(type), { title: '移动到分组', okButton: '确认移动' });
        if (group === null) return;
        for (const version of versionContext(type).list) {
            if (selection.has(version.id)) version.group = group;
        }
        if (group && !versionGroups(type).includes(group)) versionGroups(type).push(group);
        pruneVersionGroups(type);
        saveSettingsDebounced();
        render();
    });
    root.find('.ocs-version-bulk-delete').on('click', async () => {
        const ids = [...selection];
        if (!ids.length) return toastr.info('请先选择版本。', '一键快照');
        const names = ids.map(id => versionContext(type).list.find(item => item.id === id)?.name).filter(Boolean).join('、');
        if (!await Popup.show.confirm(`删除${context.title}`, `删除这 ${ids.length} 个版本？<br><br>${names}<br><br>已保存的快照不会受影响。`)) return;
        for (const id of ids) removeVersion(type, id);
        selection.clear();
        bulkMode = false;
        pruneVersionGroups(type);
        saveSettingsDebounced();
        refreshVersionIndicators();
        render();
    });

    root.find('.ocs-version-blank').on('click', async () => { await createBlankVersion(type); render(); });
    root.find('.ocs-version-copy').on('click', async () => { await saveCurrentAsVersion(type); render(); });
    root.find('.ocs-version-compare').on('click', () => openVersionComparison(type));
    const nativeSelector = type === 'character' ? '#description_textarea, #personality_textarea, #scenario_pole, #firstmessage_textarea, #mes_example_textarea' : '#persona_description';
    $(nativeSelector).off('input.oneClickSnapshotVersion').on('input.oneClickSnapshotVersion', render);
    const autoSyncRenderHandler = (_, syncedType) => {
        if (syncedType === type) render();
    };
    $(document).on('oneClickSnapshotVersionAutoSynced.oneClickSnapshotVersionUi', autoSyncRenderHandler);
    renderAutoSyncButton();
    renderMirrorButton();
    render();
    await showOcsPopup(root);
    $(nativeSelector).off('input.oneClickSnapshotVersion');
    $(document).off('oneClickSnapshotVersionAutoSynced.oneClickSnapshotVersionUi', autoSyncRenderHandler);
}

function installVersionMenu() {
    // The compact switchers belong with the native edit / duplicate controls,
    // not inside “More”. Keep the full manager in More for less frequent work.
    $('#one_click_snapshot_character_version_switch, #one_click_snapshot_persona_version_switch').remove();
    if (!$('#one_click_snapshot_character_version_button').length) {
        $('#dupe_button').after('<div id="one_click_snapshot_character_version_button" class="menu_button fa-solid fa-right-left" title="切换角色版本"></div>');
    }
    if (!$('#one_click_snapshot_persona_version_button').length) {
        $('#persona_duplicate_button').after('<div id="one_click_snapshot_persona_version_button" class="menu_button fa-solid fa-right-left" title="切换用户版本"></div>');
    }
    $(document)
        .off('click.oneClickSnapshotVersionSwitch', '#one_click_snapshot_character_version_button')
        .on('click.oneClickSnapshotVersionSwitch', '#one_click_snapshot_character_version_button', event => {
            event.preventDefault();
            openVersionQuickSwitcher('character');
        })
        .off('click.oneClickSnapshotVersionSwitch', '#one_click_snapshot_persona_version_button')
        .on('click.oneClickSnapshotVersionSwitch', '#one_click_snapshot_persona_version_button', event => {
            event.preventDefault();
            openVersionQuickSwitcher('persona');
        });
    if (!$('#one_click_snapshot_character_versions').length) $('#char-management-dropdown').append($('<option>', { id: 'one_click_snapshot_character_versions', text: '管理版本…' }));
    if (!$('#one_click_snapshot_persona_versions').length) $('#persona-management-dropdown').append($('<option>', { id: 'one_click_snapshot_persona_versions', text: '管理版本…' }));
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, target => {
        if (target === 'one_click_snapshot_character_versions') openVersionManager('character');
    });
    document.getElementById('persona-management-dropdown')?.addEventListener('change', event => {
        const select = /** @type {HTMLSelectElement} */ (event.target);
        const target = select.selectedOptions[0]?.id;
        if (target !== 'one_click_snapshot_persona_versions') return;
        event.stopImmediatePropagation();
        select.selectedIndex = 0;
        openVersionManager('persona');
    }, true);
}

const SNAPSHOT_SCOPE_TAGS = [
    ['character', '角色'],
    ['persona', '用户'],
    ['theme', '美化'],
    ['worldInfo', '世界书'],
    ['preset', '预设'],
    ['api', 'API'],
    ['regex', '正则'],
];

const SNAPSHOT_SCOPE_SOURCE_OPTIONS = {
    worldInfo: {
        title: '世界书记录范围',
        sourcesKey: 'worldSources',
        options: [
            ['global', '全局世界书'],
            ['characterMain', '角色主世界书'],
            ['characterExtra', '角色附加世界书'],
            ['user', '用户绑定世界书'],
            ['chat', '聊天世界书'],
        ],
    },
    regex: {
        title: '正则记录范围',
        sourcesKey: 'regexSources',
        options: [
            ['global', '全局正则'],
            ['scoped', '角色局部正则'],
            ['preset', '当前预设正则'],
        ],
    },
};

async function configureSnapshotScopeSources(state, key) {
    const configuration = SNAPSHOT_SCOPE_SOURCE_OPTIONS[key];
    if (!configuration) return true;
    const root = $('<div class="ocs-scope-source-picker"></div>');
    root.append($('<p></p>').text('选择要记录的来源。确定后立即生效，并按当前状态重新录入这一项。'));
    const choices = $('<div class="ocs-scope-source-choices"></div>');
    for (const [source, label] of configuration.options) {
        const input = $('<input type="checkbox">').val(source).prop('checked', state[configuration.sourcesKey][source] === true);
        choices.append($('<label class="checkbox_label ocs-scope"></label>').append(input, document.createTextNode(label)));
    }
    root.append(choices);
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, configuration.title, {
        wide: false,
        leftAlign: true,
        okButton: '确定',
        cancelButton: '取消',
    });
    popup.dlg.classList.add('ocs-dialog');
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return false;
    const sources = Object.fromEntries(choices.find('input:checked').toArray().map(input => [input.value, true]));
    state[configuration.sourcesKey] = sources;
    state[key] = Object.keys(sources).length > 0;
    return true;
}

/** The slots a lorebook can occupy in a snapshot, in display order. */
const WORLD_SLOT_ORDER = Object.values(WORLD_SOURCE_LABELS);

/** Slot label back to the `worldSources` key that controls whether it is recorded. */
const WORLD_SLOT_KEYS = Object.fromEntries(Object.entries(WORLD_SOURCE_LABELS).map(([key, label]) => [label, key]));

/** Slots whose book belongs to a character, and to a persona. */
const CHARACTER_WORLD_SLOTS = new Set(['角色主世界书', '角色附加世界书']);
const PERSONA_WORLD_SLOTS = new Set(['用户绑定世界书']);

/**
 * The characters a book is bound to, as main or extra lorebook.
 *
 * A set rather than one owner: the same file can legitimately be several
 * characters' lorebook, and treating that as "unknown owner" would refuse
 * combinations that are perfectly consistent.
 *
 * @param {string} name Book name
 * @returns {Set<string>} Character avatars
 */
function characterOwnersOfBook(name) {
    const owners = new Set();
    if (!name) return owners;
    const charLore = getWorldInfoSettings().world_info?.charLore ?? [];
    for (const character of characters ?? []) {
        if (String(character?.data?.extensions?.world ?? '') === name) owners.add(character.avatar);
        const file = getCharaFilename(null, { manualAvatarKey: character.avatar });
        if ((charLore.find(item => item.name === file)?.extraBooks ?? []).includes(name)) owners.add(character.avatar);
    }
    return owners;
}

/**
 * The personas a book is bound to.
 * @param {string} name Book name
 * @returns {Set<string>} Persona avatars
 */
function personaOwnersOfBook(name) {
    const owners = new Set();
    if (!name) return owners;
    for (const [avatar, descriptor] of Object.entries(power_user.persona_descriptions ?? {})) {
        if (String(descriptor?.lorebook ?? '') === name) owners.add(avatar);
    }
    return owners;
}

/**
 * Why a book cannot join this snapshot, or null when it can.
 *
 * A snapshot describes one character playing as one user, so it cannot hold
 * two lorebooks that belong to different characters -- applying it would ask
 * for two conflicting bindings at once. Books are only compared when both
 * sides have a known owner, so an unowned or shared file never blocks.
 *
 * @param {object} state The snapshot's world payload
 * @param {string} name Book being added
 * @param {string} slot Slot it would occupy
 * @returns {string|null} Message to show, or null when there is no conflict
 */
function worldOwnerConflict(state, name, slot) {
    const compare = (slots, ownersOf, subject) => {
        if (!slots.has(slot)) return null;
        const mine = ownersOf(name);
        if (!mine.size) return null;
        for (const book of state.books ?? []) {
            if (!(book.sources ?? []).some(source => slots.has(source))) continue;
            const theirs = ownersOf(book.name);
            if (!theirs.size || [...mine].some(avatar => theirs.has(avatar))) continue;
            return `这个快照已经记录了「${book.name}」，它属于另一个${subject}。一个快照只能记录一个${subject}的世界书。`;
        }
        return null;
    };
    return compare(CHARACTER_WORLD_SLOTS, characterOwnersOfBook, '角色')
        ?? compare(PERSONA_WORLD_SLOTS, personaOwnersOfBook, '用户');
}

/** Chat lorebook bindings, keyed by character avatar. */

/** Every chat's lorebook binding, resolved once per session. */
let chatWorldPromise = null;

/**
 * The lorebook bound to each chat, across every character.
 *
 * One request to `/api/chats/recent` with `metadata: true`: the server streams
 * each chat file and keeps only its first line, which is where SillyTavern
 * stores chat metadata. Reading the files through `/export` instead would ship
 * the whole archive to the browser for the sake of one field per chat.
 *
 * @returns {Promise<{avatar: string, chatId: string, world: string}[]>}
 */
function allChatWorlds() {
    chatWorldPromise ??= (async () => {
        let found = [];
        try {
            const response = await fetch('/api/chats/recent', {
                method: 'POST',
                headers: SillyTavern.getContext().getRequestHeaders(),
                // No `max`, so the server answers for the whole archive rather
                // than the handful the welcome screen asks for.
                body: JSON.stringify({ metadata: true, pinned: [] }),
                cache: 'no-cache',
            });
            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) {
                    found = data
                        .map(item => ({
                            avatar: String(item?.avatar ?? ''),
                            chatId: String(item?.file_id ?? String(item?.file_name ?? '').replace(/\.jsonl$/, '')),
                            world: String(item?.chat_metadata?.world_info ?? ''),
                        }))
                        .filter(item => item.chatId && item.world);
                }
            }
        } catch {
            // An unreadable archive simply contributes no options.
        }

        // The open chat may have been bound since it was last written to disk.
        const openId = String(getCurrentChatId() ?? '');
        const openWorld = String(chat_metadata.world_info ?? '');
        if (openId) {
            const existing = found.find(item => item.chatId === openId);
            if (existing) existing.world = openWorld;
            else if (openWorld) found.push({ avatar: currentCharacter()?.avatar ?? '', chatId: openId, world: openWorld });
        }
        return found.filter(item => item.world);
    })();
    return chatWorldPromise;
}

/**
 * Who a recorded book belongs to, for display beside its name.
 *
 * Resolved from the live bindings rather than stored on the book: a character
 * renamed since the snapshot was taken should read under its current name, and
 * a binding that has since been undone should stop claiming an owner.
 *
 * @param {object} book Recorded book
 * @param {{avatar: string, chatId: string, world: string}[]} [chatWorlds] Chat bindings, when known
 * @returns {string} Owner names, or an empty string for an unowned book
 */
function worldBookOwnerLabel(book, chatWorlds = []) {
    const sources = book.sources ?? [];
    const names = new Set();

    if (sources.some(source => CHARACTER_WORLD_SLOTS.has(source))) {
        for (const avatar of characterOwnersOfBook(book.name)) {
            const name = (characters ?? []).find(item => item.avatar === avatar)?.name;
            if (name) names.add(name);
        }
    }
    if (sources.some(source => PERSONA_WORLD_SLOTS.has(source))) {
        for (const avatar of personaOwnersOfBook(book.name)) names.add(String(power_user.personas?.[avatar] ?? avatar));
    }
    if (sources.includes('聊天世界书')) {
        for (const chat of chatWorlds) if (chat.world === book.name) names.add(chat.chatId);
    }
    return [...names].join('、');
}

/**
 * The one character and one user this snapshot is about.
 *
 * A book the snapshot already holds pins this down better than the recorded
 * context does: it is what the snapshot actually contains, and it stays right
 * for a snapshot that never recorded a character version at all. The context
 * is only the fallback for a snapshot that holds no bound book yet.
 *
 * @param {object} snapshot Snapshot being edited
 * @returns {{characterAvatar: string|null, personaAvatar: string|null}}
 */
function worldEditScope(snapshot) {
    const state = snapshot.payload?.worldInfo ?? {};

    const fromBooks = (slots, ownersOf) => {
        for (const book of state.books ?? []) {
            if (!(book.sources ?? []).some(source => slots.has(source))) continue;
            const owners = ownersOf(book.name);
            // Only an unambiguous owner counts. A file shared by two characters
            // says nothing about which one this snapshot is for.
            if (owners.size === 1) return [...owners][0];
        }
        return null;
    };

    // Deliberately not falling back to the recorded context: that is merely
    // where the snapshot was taken, not something it records. Once its last
    // tie to a character is removed the snapshot is about nobody in
    // particular again, and every character's books become choices.
    return {
        characterAvatar: fromBooks(CHARACTER_WORLD_SLOTS, characterOwnersOfBook)
            ?? (snapshot.scopes?.character ? snapshot.payload?.character?.data?.avatar ?? null : null),
        personaAvatar: fromBooks(PERSONA_WORLD_SLOTS, personaOwnersOfBook)
            ?? (snapshot.scopes?.persona ? snapshot.payload?.persona?.data?.avatar ?? null : null),
    };
}

/**
 * Preset-transfer's own grouping of the worldbook list, in its display order.
 *
 * Its `flat` view is the plain list grouping, stored as `order: ['g:名称', ...]`
 * alongside `groups: {名称: [书名, ...]}`. Only the display is borrowed: which
 * slot a book is recorded under still follows its actual binding.
 *
 * @returns {{label: string, names: string[]}[]} Groups in order, or empty
 */
function ptWorldGroupOrder() {
    const state = getPresetTransferSettings()?.worldbookGroupingState?.flat;
    const groups = state?.groups;
    if (!groups || typeof groups !== 'object') return [];

    const seen = new Set();
    const result = [];
    for (const token of Array.isArray(state.order) ? state.order : []) {
        if (!String(token).startsWith('g:')) continue;
        const label = String(token).slice(2);
        if (seen.has(label) || !Array.isArray(groups[label])) continue;
        seen.add(label);
        result.push({ label, names: groups[label].map(String) });
    }
    // Groups the order never mentioned still belong in the list.
    for (const [label, names] of Object.entries(groups)) {
        if (seen.has(label) || !Array.isArray(names)) continue;
        result.push({ label, names: names.map(String) });
    }
    return result;
}

/**
 * The books that may still be added, grouped by the slot they would occupy.
 *
 * Each slot lists only books that genuinely belong to it, so picking from a
 * group records a binding that actually exists -- there is nothing to validate
 * afterwards. The global group is every book, because mounting one globally is
 * a thing a snapshot really can do.
 *
 * @param {object} state The snapshot's world payload
 * @param {{avatar: string, chatId: string, world: string}[]} [chatWorlds] Chat lorebook bindings
 * @param {{characterAvatar: string|null, personaAvatar: string|null}} [scope] Who this snapshot is about
 * @returns {Map<string, {name: string, label: string}[]>} Slot label to options
 */
function worldAddCandidates(state, chatWorlds = [], scope = {}) {
    const used = new Set((state.books ?? []).map(book => book.name));
    const groups = new Map(WORLD_SLOT_ORDER.map(slot => [slot, new Map()]));
    const offer = (slot, name, owner = '') => {
        if (!name || used.has(name) || !world_names.includes(name)) return;
        const owners = groups.get(slot).get(name) ?? new Set();
        if (owner) owners.add(owner);
        groups.get(slot).set(name, owners);
    };

    // Every book that belongs to somebody, scoped or not. Used below to keep
    // the global group to books with no owner at all.
    const bound = new Set();
    const charLore = getWorldInfoSettings().world_info?.charLore ?? [];
    for (const character of characters ?? []) {
        const main = String(character?.data?.extensions?.world ?? '');
        const file = getCharaFilename(null, { manualAvatarKey: character.avatar });
        const extras = charLore.find(item => item.name === file)?.extraBooks ?? [];
        if (main) bound.add(main);
        for (const extra of extras) bound.add(extra);

        // A snapshot describes one character. Once we know which, the other
        // characters' books are not choices -- they are a different snapshot.
        if (scope.characterAvatar && character.avatar !== scope.characterAvatar) continue;
        offer('角色主世界书', main, character.name);
        for (const extra of extras) offer('角色附加世界书', extra, character.name);
    }

    for (const [avatar, descriptor] of Object.entries(power_user.persona_descriptions ?? {})) {
        const book = String(descriptor?.lorebook ?? '');
        if (book) bound.add(book);
        if (scope.personaAvatar && avatar !== scope.personaAvatar) continue;
        offer('用户绑定世界书', book, String(power_user.personas?.[avatar] ?? avatar));
    }

    // Every chat in the archive, so a book bound to some other character's chat
    // is kept out of the global group too -- but only this character's chats
    // are offered as a choice.
    for (const chat of chatWorlds) {
        bound.add(chat.world);
        if (scope.characterAvatar && chat.avatar !== scope.characterAvatar) continue;
        offer('聊天世界书', chat.world, chat.chatId);
    }

    // Global is the unowned group, and comes last. A bound book can technically
    // be mounted globally too, but listing it here as well reads as a duplicate
    // far more often than as a choice -- and once the snapshot is pinned to one
    // character, another character's book is not something to offer at all.
    for (const name of world_names) if (!bound.has(name)) offer('全局世界书', name);

    return new Map([...groups].map(([slot, books]) => [
        slot,
        [...books].map(([name, owners]) => ({ name, label: owners.size ? `${name} · ${[...owners].join('、')}` : name })),
    ]));
}

/**
 * Keeps the derived parts of the world payload consistent after an edit.
 *
 * The mount list is rebuilt from the global slot rather than edited beside it,
 * because applying a snapshot reads that list and nothing else to decide what
 * to mount -- the two must not be able to disagree. Slots in use are also
 * switched on in the recorded sources, or the next refresh would quietly drop
 * the book that was just filed there.
 *
 * @param {object} snapshot Snapshot to reconcile in place
 */
function syncWorldPayload(snapshot) {
    const state = snapshot.payload?.worldInfo;
    if (!state) return;
    state.books = Array.isArray(state.books) ? state.books : [];

    const global = state.books.filter(book => (book.sources ?? []).includes('全局世界书')).map(book => book.name);
    if (global.length || Array.isArray(state.globalSelected)) state.globalSelected = global;

    snapshot.scopes ??= {};
    snapshot.scopes.worldSources ??= {};
    for (const book of state.books) {
        for (const source of book.sources ?? []) {
            const key = WORLD_SLOT_KEYS[source];
            if (key) snapshot.scopes.worldSources[key] = true;
        }
    }
    snapshot.updatedAt = Date.now();
}

/**
 * The lorebook section of the contents popup, in edit mode.
 *
 * A flat list rather than the read-only view's grouping by source: a book can
 * sit in several slots at once, so the slot is a property of the book here and
 * not the heading it lives under.
 *
 * Edits are written as they are made, matching the rest of the extension --
 * there is no draft to lose, and no second button whose meaning depends on
 * what was touched first.
 *
 * @param {object} snapshot Snapshot to edit in place
 * @param {() => void} rerender Rebuilds this section after a structural change
 * @param {{avatar: string, chatId: string, world: string}[]} [chatWorlds] Chat lorebook bindings
 * @returns {JQuery<HTMLElement>}
 */
function renderWorldEditor(snapshot, rerender, chatWorlds = []) {
    snapshot.payload ??= {};
    const state = snapshot.payload.worldInfo ??= { globalSelected: null, context: {}, books: [] };
    state.books = Array.isArray(state.books) ? state.books : [];

    const details = $('<details class="ocs-content-drawer ocs-content-section ocs-content-world ocs-world-editing" open></details>');
    details.append(
        $('<summary></summary>').append($('<b></b>').text('世界书')),
        $('<div class="ocs-content-drawer-body"></div>'),
    );
    const body = details.children('.ocs-content-drawer-body');

    /** @param {boolean} structural Whether rows appeared or disappeared */
    const commit = (structural = false) => {
        syncWorldPayload(snapshot);
        saveSettingsDebounced();
        if (structural) rerender();
    };

    /**
     * One entry, with the same toggle SillyTavern draws on preset prompts.
     * The checkbox stays for keyboard and screen readers; the icon is the
     * visible part, swapped by CSS on `:checked`.
     */
    const entrySwitch = (entry, afterChange) => {
        const input = $('<input type="checkbox">').prop('checked', entry.enabled !== false);
        input.on('change', function () {
            // A hand-picked state is the one to restore, so the raw value moves
            // with it. Leaving it behind would make a group that is gated off
            // today restore the old switch instead of this one.
            entry.enabled = this.checked;
            entry.rawEnabled = this.checked;
            afterChange();
        });
        return $('<label class="ocs-world-entry"></label>').append(input, '<i class="ocs-toggle-icon"></i>', $('<span></span>').text(entry.label || entry.uid));
    };

    /**
     * One toggle for a whole set, reading as on only when every entry is.
     * Clicking it turns the set fully on, or fully off when it already is.
     */
    const bulkToggle = (entries, afterChange) => {
        const icon = $('<i class="ocs-toggle-icon"></i>');
        const button = $('<button type="button" class="ocs-world-bulk"></button>').append(icon);
        // Re-read on demand rather than captured: single entries are toggled
        // without a rebuild, and a captured value would go stale under them.
        // On when anything inside is on, off only when everything is -- the
        // same reading as the grouping extensions' own group switches. Clicking
        // therefore means "turn the rest on" or, when already fully on, "turn
        // it all off".
        const sync = () => {
            const any = entries.some(entry => entry.enabled !== false);
            const all = entries.length > 0 && entries.every(entry => entry.enabled !== false);
            icon.toggleClass('is-on', any);
            button.attr('title', all ? '全部关闭' : '全部开启');
            return all;
        };
        sync();
        button.on('ocs:sync', sync);
        button.on('click', event => {
            // This can sit inside a <summary>, whose default action is to open
            // and close the drawer it is in.
            event.preventDefault();
            event.stopPropagation();
            const value = !sync();
            for (const entry of entries) {
                entry.enabled = value;
                entry.rawEnabled = value;
            }
            afterChange(true);
        });
        return button;
    };

    const renderEntries = (book, showCount) => {
        const panel = $('<div class="ocs-world-entries"></div>');
        const entries = book.entries ?? [];
        if (!entries.length) return panel.append($('<small></small>').text('这本世界书没有条目。'));

        // Same grouping the read-only view uses, so an entry does not move
        // between the two. The saved group wins; the live lookup covers books
        // grouped after this snapshot was taken.
        const livePtGroups = getPresetTransferWorldbookEntryGroups(book.name, entries.map(entry => entry.uid));
        const groupOf = entry => entry.ptGroup || livePtGroups.get(String(entry.uid)) || entry.group || '';

        // Rebuilt on a bulk change, because every switch in it may have moved.
        const draw = () => {
            panel.empty();

            const grouped = new Map();
            const ungrouped = [];
            for (const entry of entries) {
                const group = groupOf(entry);
                if (!group) { ungrouped.push(entry); continue; }
                if (!grouped.has(group)) grouped.set(group, []);
                grouped.get(group).push(entry);
            }

            // Counters are refreshed in place on a single toggle, because
            // rebuilding would collapse the group being worked through.
            const counters = [];
            const refreshCounts = () => {
                showCount();
                for (const [node, members] of counters) node.text(`${members.filter(entry => entry.enabled !== false).length} / ${members.length}`);
                panel.find('.ocs-world-bulk').trigger('ocs:sync');
            };
            const onToggle = () => { refreshCounts(); commit(); };

            for (const entry of ungrouped) panel.append(entrySwitch(entry, onToggle));
            for (const [group, members] of grouped) {
                const counter = $('<small></small>');
                counters.push([counter, members]);
                const drawer = $('<details class="ocs-world-entry-group"></details>');
                drawer.append($('<summary></summary>').append($('<b></b>').text(group), counter, bulkToggle(members, redraw)));
                const groupBody = $('<div class="ocs-world-entry-group-body"></div>');
                for (const entry of members) groupBody.append(entrySwitch(entry, onToggle));
                panel.append(drawer.append(groupBody));
            }
            refreshCounts();
        };
        const redraw = () => {
            const open = panel.find('details').toArray().map(node => node.open);
            draw();
            panel.find('details').each((index, node) => { node.open = open[index] ?? false; });
            showCount();
            commit();
        };
        draw();
        panel.on('ocs:redraw', redraw);
        return panel;
    };

    // Read-only: a book's slot is a binding that already exists, and one book
    // sitting in two slots is rare enough that letting it be edited here costs
    // more in rules than it returns. Adding is where the slot is chosen.
    const renderSlots = (book) => {
        const owner = worldBookOwnerLabel(book, chatWorlds);
        const slots = (book.sources ?? []).join(' · ') || '未记录来源';
        return $('<div class="ocs-world-slots"></div>').text(owner ? `${slots} · ${owner}` : slots);
    };

    const renderBook = (book) => {
        const card = $('<div class="ocs-world-book"></div>');
        const head = $('<div class="ocs-world-book-head"></div>');
        const missing = !world_names.includes(book.name);
        const title = $('<b></b>').text(missing ? `${book.name}（已删除）` : book.name);
        if (missing) title.addClass('ocs-world-missing');

        const total = book.entries?.length ?? 0;
        const count = $('<small></small>');
        /** @type {JQuery<HTMLElement>|undefined} */
        let bulk;
        const showCount = () => {
            count.text(`${(book.entries ?? []).filter(entry => entry.enabled !== false).length} / ${total} 条`);
            bulk?.trigger('ocs:sync');
        };
        showCount();

        const entries = renderEntries(book, showCount);
        bulk = bulkToggle(book.entries ?? [], () => entries.trigger('ocs:redraw'));
        const expand = $('<button type="button" class="ocs-button ocs-icon-button"><i class="fa-solid fa-angles-down"></i></button>')
            .attr('title', '展开条目')
            .on('click', () => {
                const open = entries.toggleClass('is-open').hasClass('is-open');
                // The book-wide toggle only means something once the entries it
                // acts on are visible, so it rides along with them.
                card.toggleClass('is-expanded', open);
                expand.attr('title', open ? '收起条目' : '展开条目')
                    .children('i').toggleClass('fa-angles-down', !open).toggleClass('fa-angles-up', open);
            });
        const remove = $('<button type="button" class="ocs-button ocs-icon-button ocs-danger"><i class="fa-solid fa-trash"></i></button>')
            .attr('title', '不再记录这本世界书')
            .on('click', async () => {
                if (!await Popup.show.confirm('移除世界书', `这个快照将不再记录「${book.name}」。`)) return;
                state.books.splice(state.books.indexOf(book), 1);
                commit(true);
            });

        head.append(title, count, bulk, expand, remove);
        card.append(head, renderSlots(book), entries);
        return card;
    };

    for (const book of state.books) body.append(renderBook(book));
    if (!state.books.length) body.append($('<small class="ocs-world-empty"></small>').text('这个快照目前不记录任何世界书。'));

    const candidates = worldAddCandidates(state, chatWorlds, worldEditScope(snapshot));
    if ([...candidates.values()].some(options => options.length)) {
        // A collapsed list per slot rather than a <select> with <optgroup>:
        // the global group is every lorebook on the server, and a flat list of
        // those buries the four small groups that carry the real meaning.
        const panel = $('<div class="ocs-world-add-panel"></div>');
        const opener = $('<button type="button" class="ocs-button ocs-world-add-open"><i class="fa-solid fa-plus"></i> 添加世界书</button>')
            .on('click', () => panel.toggleClass('is-open'));

        // A filter over the whole panel: the global group alone can run to
        // hundreds of books, and scrolling a collapsed list to find one is the
        // slow way round.
        const search = $('<input class="text_pole ocs-world-add-search" type="search" placeholder="搜索世界书名称">');
        search.on('input', function () {
            const needle = String(this.value).trim().toLowerCase();
            for (const node of panel.children('.ocs-world-add-group')) {
                const group = $(node);
                let shown = 0;
                for (const item of group.find('.ocs-world-add-item')) {
                    const hit = !needle || String($(item).text()).toLowerCase().includes(needle);
                    $(item).toggleClass('is-hidden', !hit);
                    if (hit) shown += 1;
                }
                group.toggleClass('is-hidden', shown === 0);
                // Opened while filtering so hits are visible without a second
                // click, and left as the user had it once the box is cleared.
                if (needle) group.prop('open', true);
            }
        });
        panel.append(search);

        const pick = async (slot, name) => {
            const conflict = worldOwnerConflict(state, name, slot);
            if (conflict) return toastr.warning(conflict, '一键快照');
            const fresh = await captureWorldBook({ name, sources: [slot] });
            if (!fresh) return toastr.warning('读不到这本世界书的内容。', '一键快照');
            state.books.push(fresh);
            commit(true);
        };

        const addItem = (slot, option) => $('<button type="button" class="ocs-world-add-item"></button>')
            .text(option.label)
            .on('click', () => void pick(slot, option.name));

        const groupDrawer = (label, count, hint = '') => {
            const heading = $('<b></b>').text(label);
            // Inside the <b> so it stays beside the name: the heading carries
            // `margin-right: auto` and pushes anything after it to the far end.
            if (hint) heading.append($('<small class="ocs-world-owner"></small>').text(`（${hint}）`));
            return $('<details class="ocs-world-add-group"></details>')
                .append($('<summary></summary>').append(heading, $('<small></small>').text(`${count} 本`)));
        };

        // Preset-transfer's grouping is borrowed for the global slot only. The
        // other four name a binding and hold a book or two each; the global
        // list is the long one, and the one that grouping was set up for.
        // Nothing about what gets recorded changes -- the slot still comes from
        // the book's own binding.
        const ptGroups = feature('snapshot.contentEditorPtWorldGroups') ? ptWorldGroupOrder() : [];

        for (const [slot, options] of candidates) {
            if (!options.length) continue;
            const isGlobal = slot === WORLD_SLOT_ORDER[0];
            const drawer = groupDrawer(slot, options.length, isGlobal ? '未归属' : '');
            const groupBody = $('<div class="ocs-world-add-group-body"></div>');

            if (isGlobal && ptGroups.length) {
                const placed = new Set();
                for (const group of ptGroups) {
                    const members = options.filter(option => group.names.includes(option.name));
                    if (!members.length) continue;
                    members.forEach(option => placed.add(option));
                    const sub = groupDrawer(group.label, members.length);
                    const subBody = $('<div class="ocs-world-add-group-body"></div>');
                    for (const option of members) subBody.append(addItem(slot, option));
                    groupBody.append(sub.append(subBody));
                }
                const rest = options.filter(option => !placed.has(option));
                if (rest.length) {
                    const sub = groupDrawer('未分组', rest.length);
                    const subBody = $('<div class="ocs-world-add-group-body"></div>');
                    for (const option of rest) subBody.append(addItem(slot, option));
                    groupBody.append(sub.append(subBody));
                }
            } else {
                for (const option of options) groupBody.append(addItem(slot, option));
            }
            panel.append(drawer.append(groupBody));
        }
        body.append(opener, panel);
    }
    return details;
}

/**
 * The scope badges on a snapshot card. Editing them changes what the snapshot
 * records, and takes effect at once.
 *
 * Editing the scope set and refreshing the recorded state are two different
 * intents, and they used to share one button: the badges were a draft that only
 * landed when "更新" ran, which both entangled them and meant a batch could not
 * see pending edits. They are separate now — "更新" only refreshes, and every
 * change here is incremental, touching nothing but the scope being changed.
 *
 * @param {object} snapshot Snapshot to edit
 * @param {() => void} onChange Called after a change is saved
 */
function scopeBadges(snapshot, onChange = () => {}) {
    const badges = $('<div class="ocs-scope-badges ocs-editable-scope-badges"></div>');

    /** Records one scope from the current state, leaving the others alone. */
    const capture = async (key) => {
        const applied = await refreshSnapshotScopes(snapshot, [key], { addMissing: true });
        // buildSnapshot already explains exactly why it refused, so a second,
        // vaguer toast on top of it only adds noise.
        if (!applied) return false;
        saveSettingsDebounced();
        onChange();
        return true;
    };

    const render = () => {
        badges.empty();
        const present = SNAPSHOT_SCOPE_TAGS.filter(([key]) => snapshot.scopes?.[key] === true);
        for (const [key, label] of present) {
            const tag = $('<span class="ocs-scope-badge ocs-scope-tag"></span>');
            const configuration = SNAPSHOT_SCOPE_SOURCE_OPTIONS[key];
            if (configuration) {
                tag.append($('<button type="button" class="ocs-scope-tag-configure"></button>')
                    .attr('title', `编辑${label}的记录来源`)
                    .text(label)
                    .on('click', async () => {
                        const draft = normalizedSnapshotScopes(snapshot.scopes);
                        if (!await configureSnapshotScopeSources(draft, key)) return;
                        // Recording from different places means the stored
                        // content has to come from those places too.
                        snapshot.scopes[configuration.sourcesKey] = draft[configuration.sourcesKey];
                        await capture(key);
                        render();
                    }));
            } else {
                tag.append(document.createTextNode(label));
            }
            tag.append($('<button type="button" class="ocs-scope-tag-remove"></button>')
                .attr({ title: `不再记录${label}`, 'aria-label': `不再记录${label}` })
                .append('<i class="fa-solid fa-xmark"></i>')
                .on('click', async () => {
                    if (!await Popup.show.confirm('移除记录范围', `这个快照将不再记录${label}，已经记下的内容会丢失。`)) return;
                    snapshot.payload[key] = null;
                    snapshot.scopes[key] = false;
                    snapshot.updatedAt = Date.now();
                    saveSettingsDebounced();
                    onChange();
                    render();
                }));
            badges.append(tag);
        }

        const available = SNAPSHOT_SCOPE_TAGS.filter(([key]) => snapshot.scopes?.[key] !== true);
        if (!available.length) return;
        const add = $('<button type="button" class="ocs-scope-add" title="添加记录范围" aria-label="添加记录范围"><i class="fa-solid fa-plus"></i></button>');
        add.on('click', async () => {
            const selector = $('<select class="text_pole"></select>');
            for (const [key, label] of available) selector.append($('<option></option>').val(key).text(label));
            const popup = new Popup(selector.get(0), POPUP_TYPE.TEXT, '添加记录范围', {
                wide: false,
                leftAlign: true,
                okButton: '添加',
                cancelButton: '取消',
            });
            popup.dlg.classList.add('ocs-dialog');
            if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;

            const key = String(selector.val());
            const configuration = SNAPSHOT_SCOPE_SOURCE_OPTIONS[key];
            if (configuration) {
                const draft = normalizedSnapshotScopes(snapshot.scopes);
                if (!await configureSnapshotScopeSources(draft, key)) return;
                snapshot.scopes[configuration.sourcesKey] = draft[configuration.sourcesKey];
            }
            // Recorded straight away: a scope with no content behind it would
            // be a snapshot that cannot be applied.
            await capture(key);
            render();
        });
        badges.append(add);
    };

    render();
    return badges;
}

function hasSnapshotScope(scopes) {
    return SNAPSHOT_SCOPE_TAGS.some(([key]) => scopes[key] === true);
}

function fillGroupSelect(select, { all = false } = {}) {
    const current = String(select.val() ?? '');
    select.empty();
    if (all) select.append('<option value="__all__">全部分组</option>');
    select.append('<option value="">未分组</option>');
    for (const group of settings().snapshotGroups) select.append($('<option></option>').val(group).text(group));
    select.val(current || (all ? '__all__' : ''));
}

async function renameSnapshot(snapshot) {
    const name = await Popup.show.input('重命名快照', '为这份快照设置一个易于识别的名称。', snapshot.name);
    if (name === null) return;
    snapshot.name = name.trim() || snapshot.name;
    snapshot.updatedAt = Date.now();
    saveSettingsDebounced();
}

async function setSnapshotGroup(snapshot) {
    const group = await chooseGroup(snapshot.group, [
        ...settings().snapshotGroups,
        ...settings().snapshots.map(item => String(item.group ?? '').trim()),
    ]);
    if (group === null) return;
    snapshot.group = group;
    if (snapshot.group && !settings().snapshotGroups.includes(snapshot.group)) settings().snapshotGroups.push(snapshot.group);
    pruneSnapshotGroups();
    snapshot.updatedAt = Date.now();
    saveSettingsDebounced();
}

/** Marks a version scope that should get a fresh "初始版本" on finishing. */
const PENDING_INITIAL_VERSION = '__ocs_pending_initial__';

async function showSnapshotContents(snapshot, onChange = () => {}) {
    // Bound to the snapshot's own object, not a stand-in: edit mode writes
    // through this reference, and `?? {}` would hand back a detached copy for
    // a snapshot that has no payload yet.
    snapshot.payload ??= {};
    const payload = snapshot.payload;
    const root = $('<div class="ocs-contents-popup"></div>');
    const header = $('<header><span class="ocs-kicker">快照内容</span></header>');
    root.append(header);
    // The title and the add control share a row, so the plus reads as acting on
    // this snapshot rather than as another mode button up in the bar.
    const titleRow = $('<div class="ocs-content-title-row"></div>').append($('<h3></h3>').text(snapshot.name));
    root.append(titleRow);

    // Edit mode belongs to the page rather than to one section, so the sections
    // that become editable later join it without growing a button each.
    let editing = false;
    // Closing the popup mid-edit means the same as cancelling: nothing was
    // confirmed, so nothing should stick. Set once edit mode exists.
    let discardEdits = () => {};

    /**
     * Sections that swap between a read-only and an editable rendering.
     *
     * Each keeps its own host node and rebuilds into it, so toggling the mode
     * -- or a change that adds or removes a row -- never has to close and
     * reopen the popup.
     *
     * @type {(() => void)[]}
     */
    const sections = [];
    const renderSections = () => sections.forEach(render => render());
    /**
     * @param {(editing: boolean, rerender: () => void) => JQuery<HTMLElement>|null} build
     * @param {string} [scope] Scope key, which edit mode offers to drop
     */
    const mount = (build, scope = null) => {
        const host = $('<div class="ocs-content-host"></div>');
        const render = () => {
            // A drawer the user had opened stays open across a rebuild, and
            // edit mode opens it so what is editable is visible at once.
            const wasOpen = host.children('details').prop('open') === true;
            host.empty();
            const node = build(editing, render);
            if (!node) return;
            if (node.is('details')) node.prop('open', editing || wasOpen);
            if (editing && scope) attachScopeRemove(node, scope);
            host.append(node);
        };
        sections.push(render);
        render();
        root.append(host);
    };

    /** Puts a drop control on a section: into its heading, or onto the row. */
    const attachScopeRemove = (node, scope) => {
        const label = SNAPSHOT_SCOPE_LABELS[scope] ?? scope;
        const button = $('<button type="button" class="ocs-content-scope-remove"></button>')
            .attr({ title: `不再记录${label}`, 'aria-label': `不再记录${label}` })
            .append('<i class="fa-solid fa-xmark"></i>')
            .on('click', async (event) => {
                // In a <summary> this would otherwise toggle the drawer too.
                event.preventDefault();
                event.stopPropagation();
                if (!await Popup.show.confirm('移除记录范围', `这个快照将不再记录${label}，已经记下的内容会丢失。`)) return;
                payload[scope] = null;
                snapshot.scopes[scope] = false;
                snapshot.updatedAt = Date.now();
                saveSettingsDebounced();
                renderSections();
            });
        if (node.is('details')) node.children('summary').append(button);
        else node.append(button);
    };
    // Edits are written as they are made, so undoing them means keeping a copy
    // from before the mode was entered. The recorded sources travel with it:
    // filing a book into a slot switches that source on.
    let restorePoint = null;
    // Resolved once on entering edit mode: reading a chat that is not open
    // costs a request, and the answer cannot change while the popup is up.
    let chatWorlds = [];
    const EDITABLE_SCOPES = ['character', 'persona', 'theme', 'worldInfo', 'preset', 'regex'];
    if (feature('snapshot.contentEditor') && EDITABLE_SCOPES.some(scope => snapshot.scopes?.[scope])) {
        const toggle = $('<button type="button" class="ocs-button ocs-content-edit-toggle">修改</button>');
        const cancel = $('<button type="button" class="ocs-button ocs-content-edit-cancel">取消</button>');
        const badge = $('<small class="ocs-content-editing-badge">修改中</small>');
        // Icon only, in the same shape the regex section uses for adding a
        // source: one affordance for "add something here", not two.
        const addScope = $('<button type="button" class="ocs-content-add-scope-button"><i class="fa-solid fa-plus"></i></button>')
            .attr({ title: '添加记录范围', 'aria-label': '添加记录范围' });

        addScope.on('click', async () => {
            // `api` is left out: it has no editor, so adding it here would
            // record the live connection and then offer no way to change it.
            const missing = Object.entries(SNAPSHOT_SCOPE_LABELS)
                .filter(([key]) => snapshot.scopes?.[key] !== true && emptyScopePayload(key));
            if (!missing.length) return toastr.info('这个快照已经记录了所有可编辑的范围。', '一键快照');

            const root = $('<div class="ocs-scope-source-picker"></div>');
            const select = $('<select class="text_pole"></select>');
            for (const [key, label] of missing) select.append($('<option></option>').val(key).text(label));
            root.append($('<p></p>').text('新增的范围是空的，加进来之后在这一页挑选内容。'), select);
            const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, '添加记录范围', {
                wide: false,
                leftAlign: true,
                okButton: '添加',
                cancelButton: '取消',
            });
            popup.dlg.classList.add('ocs-dialog');
            if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;

            const key = String(select.val() ?? '');
            const shell = emptyScopePayload(key);
            if (!shell) return;
            payload[key] = shell;
            snapshot.scopes[key] = true;
            if (key === 'regex') snapshot.scopes.regexSources = Object.fromEntries(REGEX_SCOPE_TYPES.map(([source]) => [source, true]));
            snapshot.updatedAt = Date.now();
            saveSettingsDebounced();
            renderSections();
        });

        /**
         * Turns any "create one on finish" choice into a real version.
         *
         * Deferred to here rather than done at pick time so that cancelling
         * discards the intent instead of leaving an unused version behind --
         * the restore point covers the snapshot, not the version library.
         */
        const materialisePendingVersions = () => {
            let created = false;
            for (const scope of ['character', 'persona']) {
                const record = payload[scope];
                if (!record?.pendingInitial) continue;
                const version = createInitialVersionFor(scope, record.data?.avatar ?? '');
                if (!version) {
                    toastr.warning(`没能为${scope === 'character' ? '角色' : '用户'}新建初始版本，该范围仍未指向任何版本。`, '一键快照');
                    continue;
                }
                record.versionId = version.id;
                record.versionName = version.name;
                delete record.pendingInitial;
                created = true;
                toastr.info(`已为「${record.data?.name || version.data?.name || ''}」新建「初始版本」。`, '一键快照');
            }
            if (!created) return;
            saveSettingsDebounced();
            refreshVersionIndicators();
        };

        const leave = () => {
            editing = false;
            materialisePendingVersions();
            toggle.text('修改').removeClass('ocs-active');
            cancel.removeClass('is-shown');
            addScope.removeClass('is-shown');
            badge.removeClass('is-shown');
            root.removeClass('ocs-editing');
            renderSections();
            // The library behind the popup shows the scope badges and the
            // updated time, both of which an edit moves.
            onChange();
        };

        /** Puts everything back the way it was on entering edit mode. */
        const revert = () => {
            if (!restorePoint) return false;
            // Restored into the existing object rather than replacing it:
            // every section holds a reference to this one, and swapping it out
            // would leave them all editing something detached.
            for (const key of Object.keys(payload)) delete payload[key];
            Object.assign(payload, deepClone(restorePoint.payload));
            snapshot.scopes = deepClone(restorePoint.scopes);
            snapshot.updatedAt = restorePoint.updatedAt;
            saveSettingsDebounced();
            return true;
        };

        cancel.on('click', () => {
            revert();
            leave();
        });

        discardEdits = () => {
            if (!editing) return;
            // Not `leave()`: the popup is already gone, so there is nothing to
            // redraw, and any "create a version on finish" choice must not be
            // acted on either.
            editing = false;
            if (revert()) onChange();
        };

        toggle.on('click', async () => {
            if (editing) return leave();
            editing = true;
            restorePoint = {
                payload: deepClone(payload),
                scopes: deepClone(snapshot.scopes ?? {}),
                updatedAt: snapshot.updatedAt,
            };
            if (snapshot.scopes?.worldInfo) chatWorlds = await allChatWorlds();
            toggle.text('完成').addClass('ocs-active');
            cancel.addClass('is-shown');
            addScope.addClass('is-shown');
            badge.addClass('is-shown');
            root.addClass('ocs-editing');
            renderSections();
        });
        header.append($('<div class="ocs-content-edit-actions"></div>').append(badge, cancel, toggle));
        titleRow.append(addScope);
    }
    // The native inline-drawer rhythm is clearer than a cascade of tiny,
    // indented disclosure rows. Every level keeps the same reading size.
    const makeDrawer = (className, title, count = '') => {
        const details = $(`<details class="ocs-content-drawer ${className}"></details>`);
        const summary = $('<summary></summary>');
        summary.append($('<b></b>').text(title));
        if (count) summary.append($('<small></small>').text(count));
        details.append(summary, $('<div class="ocs-content-drawer-body"></div>'));
        return details;
    };
    const drawerBody = drawer => drawer.children('.ocs-content-drawer-body');
    const itemList = (entries, emptyText = '没有启用条目') => {
        const list = $('<ul class="ocs-content-items"></ul>');
        if (!entries.length) return list.append($('<li class="ocs-content-empty"></li>').text(emptyText));
        for (const entry of entries) list.append($('<li></li>').attr('title', entry).text(entry));
        return list;
    };
    const appendBookEntries = (bookNode, entries, livePtGroups = new Map()) => {
        const body = drawerBody(bookNode);
        const groups = new Map();
        const ungrouped = [];
        for (const entry of entries) {
            const group = entry.ptGroup || livePtGroups.get(String(entry.uid)) || entry.group || '';
            if (!group) { ungrouped.push(entry.label); continue; }
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(entry.label);
        }
        // Unnamed entries stay as a flat list in their saved order. Named
        // groups remain collapsible so a lorebook with many entries is tidy.
        if (ungrouped.length) body.append(itemList(ungrouped));
        for (const [group, labels] of groups) {
            const entryGroup = makeDrawer('ocs-content-entry-group', group, `${labels.length} 条`);
            drawerBody(entryGroup).append(itemList(labels));
            body.append(entryGroup);
        }
        if (!entries.length) body.append(itemList([]));
    };
    const bookDetails = (book) => {
        const enabled = (book.entries ?? []).filter(entry => entry.enabled);
        const livePtGroups = getPresetTransferWorldbookEntryGroups(book.name, (book.entries ?? []).map(entry => entry.uid));
        const bookNode = makeDrawer('ocs-content-book', book.name, `${enabled.length} 条`).data('ocs-book-name', book.name);
        // Appended inside the <b> so it stays next to the name: that heading
        // pushes everything after it to the far end of the row.
        const owner = worldBookOwnerLabel(book, chatWorlds);
        if (owner) bookNode.children('summary').children('b').append($('<small class="ocs-world-owner"></small>').text(` · ${owner}`));
        appendBookEntries(bookNode, enabled, livePtGroups);
        return bookNode;
    };
    /** One labelled row, either read-only text or a dropdown. */
    const valueRow = (title, text) => $('<div class="ocs-version-value"><span></span><strong></strong></div>')
        .find('span').text(title).end()
        .find('strong').text(text).end();

    /**
     * A labelled dropdown. `options` may be a flat list, or `{label, options}`
     * groups which render as `<optgroup>`.
     */
    const selectRow = (title, options, current, onPick) => {
        const row = $('<div class="ocs-version-value"></div>').append($('<span></span>').text(title));
        const select = $('<select class="text_pole ocs-content-select"></select>');
        const groups = options.length && Array.isArray(options[0]?.options) ? options : [{ label: '', options }];
        const flat = groups.flatMap(group => group.options);

        // A scope that holds nothing yet starts genuinely unset. Without this
        // the dropdown shows whichever option sorts first while the snapshot
        // still holds nothing, and no change event ever fires to load it in.
        if (!current) select.append($('<option value="">请选择…</option>'));
        // A recorded value that no longer exists is kept as its own option, or
        // `val()` would silently fall through to the first one and read as a
        // change the user never made.
        else if (!flat.some(option => option.value === current)) select.append($('<option></option>').val(current).text(`${current}（已删除）`));

        for (const group of groups) {
            const target = group.label ? $('<optgroup></optgroup>').attr('label', group.label).appendTo(select) : select;
            for (const option of group.options) target.append($('<option></option>').val(option.value).text(option.label));
        }
        select.val(current || '');
        select.on('change', function () {
            if (!this.value) return;
            onPick(String(this.value));
        });
        return row.append(select);
    };

    /** Every preset name, in the order the preset manager lists them. */
    /** Two dropdowns on one row: pick the owner, then one of its versions. */
    const twoStepRow = (title, owners, currentOwner, currentValue, onPick) => {
        const row = $('<div class="ocs-version-value ocs-version-pick"></div>').append($('<span></span>').text(title));
        const pair = $('<div class="ocs-version-pick-pair"></div>');

        const ownerSelect = $('<select class="text_pole ocs-content-select"></select>');
        for (const owner of owners) ownerSelect.append($('<option></option>').val(owner.value).text(owner.label));
        const valueSelect = $('<select class="text_pole ocs-content-select"></select>');

        // Two short lists instead of one long one: with many characters, or
        // many versions of one, a single flat list is unusable on a phone.
        // A scope that holds nothing yet starts genuinely unset. Showing the
        // first entry preselected would claim a pairing the snapshot does not
        // hold, which then reads as "未知角色" the moment the row is redrawn.
        const placeholder = '__ocs_unset__';
        if (!currentOwner) ownerSelect.append($('<option></option>').val(placeholder).text('请选择…'));

        const fillValues = (ownerValue, selected) => {
            const owner = owners.find(item => item.value === ownerValue);
            valueSelect.empty();
            if (!owner) {
                valueSelect.append($('<option></option>').val(placeholder).text('请先选择'));
                valueSelect.val(placeholder);
                return '';
            }
            for (const option of owner.options) valueSelect.append($('<option></option>').val(option.value).text(option.label));
            const known = owner.options.some(option => option.value === selected);
            valueSelect.val(known ? selected : (owner.options[0]?.value ?? ''));
            return String(valueSelect.val() ?? '');
        };

        ownerSelect.val(currentOwner || placeholder);
        fillValues(currentOwner, currentValue);

        ownerSelect.on('change', function () {
            // Choosing an owner commits its first version straight away, so the
            // row never shows a pairing the snapshot does not hold.
            const picked = fillValues(String(this.value), '');
            if (picked) onPick(String(this.value), picked);
        });
        valueSelect.on('change', function () { onPick(String(ownerSelect.val() ?? ''), String(this.value)); });

        return row.append(pair.append(ownerSelect, valueSelect));
    };

    const presetOptions = () => {
        const { preset_names: names } = getPresetManager()?.getPresetList?.() ?? {};
        return (Array.isArray(names) ? names : Object.keys(names ?? {}))
            .filter(Boolean)
            .map(name => ({ value: name, label: name }));
    };

    const mountVersion = (scope, title, store, fallback, nameOf) => {
        mount((isEditing) => {
            // Checked here rather than around the mount: a scope added while
            // the popup is open has to be able to appear without rebuilding it.
            if (!snapshot.scopes?.[scope]) return null;
            const record = payload[scope];
            const name = record?.data?.name ?? fallback;
            const stored = `${name} · ${record?.versionName ?? '当前未命名状态'}`;
            if (!isEditing) return valueRow(title, stored);

            // Every owner that has versions, not only the recorded one: moving
            // a snapshot to a different character is as reasonable an edit as
            // moving it to a different version of the same one.
            const owners = Object.entries(settings()[store] ?? {})
                .filter(([, versions]) => Array.isArray(versions) && versions.length)
                .map(([avatar, versions]) => ({
                    value: avatar,
                    label: nameOf(avatar) || avatar,
                    options: versions.map(version => ({ value: version.id, label: version.name })),
                }));

            // With auto-initial on, owners that have no version yet are offered
            // too. The version is not made here but on leaving edit mode, so
            // cancelling does not leave one behind in the library.
            if (feature('version.autoInitial')) {
                const covered = new Set(owners.map(owner => owner.value));
                const candidates = scope === 'character'
                    ? (characters ?? []).map(item => item.avatar)
                    : Object.keys(power_user.personas ?? {});
                for (const avatar of candidates) {
                    if (!avatar || covered.has(avatar)) continue;
                    owners.push({
                        value: avatar,
                        label: nameOf(avatar) || avatar,
                        options: [{ value: PENDING_INITIAL_VERSION, label: '新建「初始版本」' }],
                    });
                }
            }
            if (!owners.length) return valueRow(title, stored);

            const currentValue = record?.pendingInitial ? PENDING_INITIAL_VERSION : record?.versionId ?? '';
            return twoStepRow(title, owners, record?.data?.avatar ?? '', currentValue, (avatar, versionId) => {
                if (versionId === PENDING_INITIAL_VERSION) {
                    payload[scope] = {
                        ...record,
                        versionId: null,
                        versionName: '初始版本',
                        pendingInitial: true,
                        data: { ...(record?.data ?? {}), avatar, name: nameOf(avatar) || fallback },
                    };
                    snapshot.updatedAt = Date.now();
                    saveSettingsDebounced();
                    return;
                }
                const picked = (settings()[store]?.[avatar] ?? []).find(version => version.id === versionId);
                if (!picked) return;
                // Only the reference moves. The version's own content stays in
                // the version library, which is what lets a later edit there
                // reach every snapshot pointing at it.
                payload[scope] = {
                    ...record,
                    versionId: picked.id,
                    versionName: picked.name,
                    pendingInitial: false,
                    data: { ...(record?.data ?? {}), avatar, name: nameOf(avatar) || fallback },
                };
                snapshot.updatedAt = Date.now();
                saveSettingsDebounced();
            });
        }, scope);
    };
    mountVersion('character', '角色版本', 'characterVersions', '未知角色',
        avatar => (characters ?? []).find(item => item.avatar === avatar)?.name ?? '');
    mountVersion('persona', '用户版本', 'personaVersions', '未知用户',
        avatar => String(power_user.personas?.[avatar] ?? ''));

    {
        mount((isEditing) => {
            if (!snapshot.scopes?.theme) return null;
            const savedName = themeNameFromPayload(payload);
            const themes = $('#themes option').toArray().map(option => String(option.value)).filter(Boolean);
            if (!isEditing) {
                const label = savedName ? (themes.includes(savedName) ? savedName : `${savedName}（已删除）`) : '未选择美化';
                return valueRow('界面美化', label);
            }
            return selectRow('界面美化', themes.map(name => ({ value: name, label: name })), savedName, (value) => {
                payload.theme = { name: value };
                snapshot.updatedAt = Date.now();
                saveSettingsDebounced();
            });
        }, 'theme');
    }
    {
        const buildWorldView = () => {
            const section = makeDrawer('ocs-content-section ocs-content-world', '世界书启用');
            const sectionBody = drawerBody(section);
            const books = payload.worldInfo?.books ?? [];
            const appendSource = (source, { collapsible = false } = {}) => {
                const sourceBooks = books.filter(book => book.sources?.includes(source));
                if (!sourceBooks.length) return;
                const sourceBlock = collapsible
                    ? makeDrawer('ocs-content-source ocs-content-global-source', source, `${sourceBooks.length} 本`)
                    : $('<section class="ocs-content-source"></section>');
                const sourceBody = collapsible ? drawerBody(sourceBlock) : $('<div class="ocs-content-source-body"></div>');
                if (!collapsible) sourceBlock.append($('<div class="ocs-content-source-title"></div>').append($('<b></b>').text(source), $('<small></small>').text(`${sourceBooks.length} 本`)), sourceBody);
                sourceBooks.forEach(book => sourceBody.append(bookDetails(book)));
                sectionBody.append(sourceBlock);
            };
            // A single global book reads better as a normal source row. Only a
            // collection needs the extra disclosure level.
            appendSource('全局世界书', { collapsible: books.filter(book => book.sources?.includes('全局世界书')).length >= 2 });
            appendSource('角色主世界书');
            appendSource('角色附加世界书');
            appendSource('用户绑定世界书');
            appendSource('聊天世界书');
            if (!books.length) {
                sectionBody.append(itemList([], '没有已保存的世界书'));
            }
            return section;
        };
        mount((isEditing, rerender) => {
            if (!snapshot.scopes?.worldInfo) return null;
            return isEditing ? renderWorldEditor(snapshot, rerender, chatWorlds) : buildWorldView();
        }, 'worldInfo');
        // Chat names are only known once the archive answers. Rendering waits
        // for nothing and redraws when they arrive; the lookup is cached, so
        // this costs one request per session.
        void allChatWorlds().then((list) => {
            chatWorlds = list;
            renderSections();
        });
    }
    {
        const buildPresetView = () => {
            const presetLabel = payload.preset?.presetName ?? '未选择预设';
            const manager = getPresetManager();
            const selectedPreset = manager?.getCompletionPresetByName?.(payload.preset?.presetName);
            const livePromptGroups = getPresetPromptGroups(SillyTavern.getContext().chatCompletionSettings, selectedPreset);
            const usePresetGroups = Boolean(presetGroupingProvider());
            const nodes = [];
            const groups = new Map();
            const enabledEntries = (payload.preset?.promptEntries ?? []).filter(entry => entry.enabled);
            const presetDrawer = makeDrawer('ocs-content-section ocs-content-preset', '预设启用', presetLabel);
            const presetBody = drawerBody(presetDrawer);
            const parameterLines = presetParameterLines(payload.preset?.parameters);
            const parameterDrawer = makeDrawer('ocs-content-preset-section', '预设参数', parameterLines.length ? `${parameterLines.length} 项` : '');
            drawerBody(parameterDrawer).append(itemList(parameterLines, '该快照未保存预设参数'));
            presetBody.append(parameterDrawer);

            const entriesDrawer = makeDrawer('ocs-content-preset-section', '启用条目', `${enabledEntries.length} 条`);
            const entriesBody = drawerBody(entriesDrawer);
            for (const entry of enabledEntries) {
                const group = usePresetGroups ? entry.group || livePromptGroups.get(entry.identifier) || '' : '';
                if (!group) { nodes.push(entry.label); continue; }
                let node = groups.get(group);
                if (!node) {
                    node = { group, entries: [] };
                    groups.set(group, node);
                    nodes.push(node);
                }
                node.entries.push(entry.label);
            }
            const pendingFlat = [];
            const flushFlat = () => {
                if (pendingFlat.length) entriesBody.append(itemList(pendingFlat.splice(0)));
            };
            for (const node of nodes) {
                if (typeof node === 'string') { pendingFlat.push(node); continue; }
                flushFlat();
                const group = makeDrawer('ocs-content-group', node.group, `${node.entries.length} 条`);
                drawerBody(group).append(itemList(node.entries));
                entriesBody.append(group);
            }
            flushFlat();
            if (!nodes.length) entriesBody.append(itemList([], '没有启用的预设条目'));
            presetBody.append(entriesDrawer);
                return presetDrawer;
        };

        /** Which preset the snapshot points at, its entries and its parameters. */
        const buildPresetEditor = () => {
            const state = payload.preset ??= { api: main_api, presetName: '', promptEntries: [], parameters: null };
            const manager = getPresetManager();
            const selectedPreset = manager?.getCompletionPresetByName?.(state.presetName);

            const section = $('<details class="ocs-content-drawer ocs-content-section ocs-content-preset" open></details>');
            section.append(
                $('<summary></summary>').append($('<b></b>').text('预设与条目'), $('<small></small>').text(state.presetName || '未选择预设')),
                $('<div class="ocs-content-drawer-body"></div>'),
            );
            const body = section.children('.ocs-content-drawer-body');

            body.append(selectRow('预设', presetOptions(), state.presetName ?? '', (value) => {
                const preset = manager?.getCompletionPresetByName?.(value);
                if (!preset) return toastr.warning('读不到这个预设的内容。', '一键快照');
                const labels = new Map((preset.prompts ?? []).map(prompt => [prompt.identifier, prompt.name || prompt.identifier]));
                const groups = getPresetPromptGroups(SillyTavern.getContext().chatCompletionSettings, preset);
                // Read straight off the preset object, so a snapshot can point
                // at a preset that was never loaded.
                state.presetName = value;
                state.presetValue = null;
                state.promptEntries = (preset.prompt_order ?? []).flatMap(list => (list.order ?? []).map(item => ({
                    identifier: item.identifier,
                    label: labels.get(item.identifier) ?? item.identifier,
                    enabled: !!item.enabled,
                    group: groups.get(item.identifier) ?? '',
                })));
                state.parameters = presetParametersOf(preset);
                snapshot.updatedAt = Date.now();
                saveSettingsDebounced();
                renderSections();
            }));

            /* ---------------------------------------------------- parameters -- */
            const parameters = state.parameters ?? {};
            const paramKeys = [...PRESET_PARAMETER_KEYS].filter(key => Object.hasOwn(parameters, key));
            const paramDrawer = makeDrawer('ocs-content-preset-section', '预设参数', paramKeys.length ? `共 ${paramKeys.length} 项` : '未记录');
            const paramBody = drawerBody(paramDrawer);
            if (!paramKeys.length) {
                paramBody.append($('<small></small>').text('该快照未保存预设参数。'));
            } else {
                for (const key of paramKeys) {
                    const [, , isCheckbox] = settingsToUpdate[key] ?? [];
                    const label = PRESET_PARAMETER_LABELS[key] ?? key;
                    const row = $('<div class="ocs-content-param"></div>').append($('<span></span>').text(label));
                    if (isCheckbox) {
                        const input = $('<input type="checkbox">').prop('checked', !!parameters[key]);
                        input.on('change', function () {
                            parameters[key] = this.checked;
                            snapshot.updatedAt = Date.now();
                            saveSettingsDebounced();
                        });
                        row.append($('<label class="ocs-world-entry ocs-content-param-toggle"></label>').append(input, '<i class="ocs-toggle-icon"></i>'));
                    } else {
                        const numeric = typeof parameters[key] === 'number';
                        const input = $('<input class="text_pole ocs-content-param-input">')
                            .attr('type', numeric ? 'number' : 'text')
                            .attr('step', 'any')
                            .val(parameters[key] ?? '');
                        input.on('change', function () {
                            const raw = String(this.value);
                            // Kept in the type it was captured as, so applying
                            // writes back what the preset control expects.
                            parameters[key] = numeric ? (raw === '' ? null : Number(raw)) : raw;
                            snapshot.updatedAt = Date.now();
                            saveSettingsDebounced();
                        });
                        row.append(input);
                    }
                    paramBody.append(row);
                }
            }
            body.append(paramDrawer);

            /* ------------------------------------------------------- entries -- */
            const entries = state.promptEntries ?? [];
            const liveGroups = getPresetPromptGroups(SillyTavern.getContext().chatCompletionSettings, selectedPreset);
            const useGroups = Boolean(presetGroupingProvider());
            const groupOf = entry => (useGroups ? entry.group || liveGroups.get(entry.identifier) || '' : '');

            const entryToggle = (entry, afterChange) => {
                const input = $('<input type="checkbox">').prop('checked', entry.enabled !== false);
                input.on('change', function () {
                    entry.enabled = this.checked;
                    snapshot.updatedAt = Date.now();
                    saveSettingsDebounced();
                    afterChange();
                });
                return $('<label class="ocs-world-entry"></label>').append(input, '<i class="ocs-toggle-icon"></i>', $('<span></span>').text(entry.label || entry.identifier));
            };

            const entriesDrawer = makeDrawer('ocs-content-preset-section', '条目', `已开启 ${entries.filter(entry => entry.enabled !== false).length} / ${entries.length} 条`);
            const entriesBody = drawerBody(entriesDrawer);
            const list = $('<div class="ocs-world-entries is-open"></div>');
            if (!entries.length) list.append($('<small></small>').text('这个预设没有可记录的条目。'));

            const counters = [];
            const refresh = () => {
                for (const [node, members] of counters) node.text(`${members.filter(entry => entry.enabled !== false).length} / ${members.length}`);
                list.find('.ocs-world-bulk').trigger('ocs:sync');
                entriesDrawer.children('summary').children('small').text(`已开启 ${entries.filter(entry => entry.enabled !== false).length} / ${entries.length} 条`);
            };
            const bulk = (members) => {
                const icon = $('<i class="ocs-toggle-icon"></i>');
                const button = $('<button type="button" class="ocs-world-bulk"></button>').append(icon);
                const sync = () => {
                    const any = members.some(entry => entry.enabled !== false);
                    const all = members.length > 0 && members.every(entry => entry.enabled !== false);
                    icon.toggleClass('is-on', any);
                    button.attr('title', all ? '全部关闭' : '全部开启');
                    return all;
                };
                sync();
                button.on('ocs:sync', sync);
                button.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const value = !sync();
                    for (const entry of members) entry.enabled = value;
                    snapshot.updatedAt = Date.now();
                    saveSettingsDebounced();
                    renderSections();
                });
                return button;
            };

            // Walked in the preset's own order, with each group's drawer placed
            // where its first member falls. Collecting the ungrouped entries
            // separately would hoist them above every group, so the list would
            // stop matching what the prompt manager shows.
            const drawers = new Map();
            for (const entry of entries) {
                const group = groupOf(entry);
                if (!group) {
                    list.append(entryToggle(entry, refresh));
                    continue;
                }
                let body = drawers.get(group);
                if (!body) {
                    const members = entries.filter(item => groupOf(item) === group);
                    const counter = $('<small></small>');
                    counters.push([counter, members]);
                    body = $('<div class="ocs-world-entry-group-body"></div>');
                    drawers.set(group, body);
                    list.append($('<details class="ocs-world-entry-group"></details>').append(
                        $('<summary></summary>').append($('<b></b>').text(group), counter, bulk(members)),
                        body,
                    ));
                }
                body.append(entryToggle(entry, refresh));
            }
            refresh();
            entriesBody.append(list);
            body.append(entriesDrawer);
            return section;
        };

        mount((isEditing) => {
            if (!snapshot.scopes?.preset) return null;
            return isEditing ? buildPresetEditor() : buildPresetView();
        }, 'preset');
    }
    if (snapshot.scopes?.api) {
        const state = payload.api ?? {};
        const section = makeDrawer('ocs-content-section ocs-content-api', 'API', state.chatCompletion?.model || API_MAIN_LABELS[state.mainApi] || '未选择');
        drawerBody(section).append(itemList(apiStateLines(state), '该快照未保存 API 设置'));
        root.append(section);
    }
    {
        const REGEX_SOURCE_TITLES = [['global', '全局正则'], ['scoped', '角色局部正则'], ['preset', '当前预设正则']];
        const REGEX_SOURCE_TYPES = { global: SCRIPT_TYPES.GLOBAL, scoped: SCRIPT_TYPES.SCOPED, preset: SCRIPT_TYPES.PRESET };

        /** Loads an owner's rules in, keeping the switches already chosen. */
        const loadRegexScripts = (source, type, owner) => {
            // Recording an owner's rules at all implies they are meant to run,
            // so the permission SillyTavern keeps per character/preset is set
            // along with them rather than left at its default.
            source.allowed = true;
            const chosen = new Map((source.scripts ?? []).map(script => [script.id, !!script.enabled]));
            source.scripts = regexScriptsOf(type, owner).map(script => ({
                id: script.id,
                label: script.scriptName || script.id,
                // Default off: this page is for choosing what to record, not
                // for taking a copy of how the owner happens to be set up.
                enabled: chosen.get(script.id) ?? false,
            }));
        };

        /** Picks whose rules a source describes: a character, or a preset. */
        const regexOwnerRow = (key, source, context) => {
            if (key === 'scoped') {
                const owners = (characters ?? [])
                    .filter(character => Array.isArray(character?.data?.extensions?.regex_scripts) && character.data.extensions.regex_scripts.length)
                    .map(character => ({ value: character.avatar, label: character.name }));
                if (!owners.length) return $('<small></small>').text('没有任何角色卡带有局部正则。');
                return selectRow('角色', owners, context.characterAvatar ?? '', (value) => {
                    context.characterAvatar = value;
                    context.characterName = owners.find(owner => owner.value === value)?.label ?? '';
                    loadRegexScripts(source, SCRIPT_TYPES.SCOPED, value);
                    snapshot.updatedAt = Date.now();
                    saveSettingsDebounced();
                    renderSections();
                });
            }

            const owners = presetOptions();
            if (!owners.length) return null;
            return selectRow('预设', owners, context.presetName ?? '', (value) => {
                context.presetName = value;
                context.presetApi = getCurrentPresetAPI();
                loadRegexScripts(source, SCRIPT_TYPES.PRESET, value);
                snapshot.updatedAt = Date.now();
                saveSettingsDebounced();
                renderSections();
            });
        };

        /** A source starts with whatever it can list without being told more. */
        const emptyRegexSource = key => (key === 'global'
            ? { scripts: getScriptsByType(SCRIPT_TYPES.GLOBAL).map(script => ({ id: script.id, label: script.scriptName || script.id, enabled: false })) }
            : { scripts: [], allowed: true });

        /** Asks which source to bring back, or answers straight off for one. */
        const pickRegexSource = async (options) => {
            if (options.length === 1) return options[0][0];
            const root = $('<div class="ocs-scope-source-picker"></div>');
            const select = $('<select class="text_pole"></select>');
            for (const [value, label] of options) select.append($('<option></option>').val(value).text(label));
            root.append($('<p></p>').text('选择要重新记录的正则来源。'), select);
            const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, '添加正则来源', {
                wide: false,
                leftAlign: true,
                okButton: '确定',
                cancelButton: '取消',
            });
            popup.dlg.classList.add('ocs-dialog');
            if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return '';
            return String(select.val() ?? '');
        };

        const buildRegexSection = (isEditing) => {
            const state = payload.regex ??= { context: {}, sources: {} };
            const sources = state.sources ??= {};
            const context = state.context ??= {};
            const section = makeDrawer('ocs-content-section ocs-content-regex', '正则与启用规则');
            const body = drawerBody(section);

            // Unlike a lorebook, a regex source holds nothing that can be
            // deleted down to nothing, so dropping a whole category needs its
            // own control -- and a way back.
            if (isEditing) {
                const absent = REGEX_SOURCE_TITLES.filter(([key]) => !sources[key]);
                if (absent.length) {
                    section.children('summary').append($('<button type="button" class="ocs-content-source-add"></button>')
                        .attr({ title: '添加正则来源', 'aria-label': '添加正则来源' })
                        .append('<i class="fa-solid fa-plus"></i>')
                        .on('click', async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const key = await pickRegexSource(absent);
                            if (!key) return;
                            sources[key] = emptyRegexSource(key);
                            snapshot.scopes.regexSources ??= {};
                            snapshot.scopes.regexSources[key] = true;
                            snapshot.updatedAt = Date.now();
                            saveSettingsDebounced();
                            renderSections();
                        }));
                }
            }

            for (const [key, title] of REGEX_SOURCE_TITLES) {
                const source = sources[key];
                if (!source) continue;
                const groups = regexGroupMap(key, context);
                const scripts = source.scripts ?? [];
                const enabled = scripts.filter(script => script.enabled);
                const owner = key === 'scoped' ? context.characterName : key === 'preset' ? context.presetName : '';
                const count = owner
                    ? `${owner} · ${enabled.length}${isEditing ? ` / ${scripts.length}` : ''} 条`
                    : `${enabled.length}${isEditing ? ` / ${scripts.length}` : ''} 条`;
                // Regex categories are source markers, like worldbook sources;
                // keep their children behind the same optional disclosure layer.
                const drawer = makeDrawer('ocs-content-source ocs-content-regex-source', title, count);
                const sourceBody = drawerBody(drawer);

                if (isEditing) {
                    drawer.children('summary').append($('<button type="button" class="ocs-content-scope-remove"></button>')
                        .attr({ title: `不再记录${title}`, 'aria-label': `不再记录${title}` })
                        .append('<i class="fa-solid fa-xmark"></i>')
                        .on('click', async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!await Popup.show.confirm('移除正则来源', `这个快照将不再记录${title}，已经选好的规则会丢失。`)) return;
                            delete sources[key];
                            snapshot.scopes.regexSources ??= {};
                            snapshot.scopes.regexSources[key] = false;
                            snapshot.updatedAt = Date.now();
                            saveSettingsDebounced();
                            renderSections();
                        }));
                }

                if (!isEditing) {
                    // Grouped exactly as the editor groups them, so a rule does
                    // not move between the two views.
                    const grouped = new Map();
                    const flat = [];
                    for (const script of enabled) {
                        const group = groups.get(String(script.id));
                        if (!group) { flat.push(script.label || script.id); continue; }
                        if (!grouped.has(group)) grouped.set(group, []);
                        grouped.get(group).push(script.label || script.id);
                    }
                    if (flat.length || !grouped.size) sourceBody.append(itemList(flat));
                    for (const [group, labels] of grouped) {
                        const groupDrawer = makeDrawer('ocs-content-entry-group', group, `${labels.length} 条`);
                        drawerBody(groupDrawer).append(itemList(labels));
                        sourceBody.append(groupDrawer);
                    }
                    body.append(drawer);
                    continue;
                }

                drawer.prop('open', true);
                if (key !== 'global') {
                    const ownerRow = regexOwnerRow(key, source, context);
                    if (ownerRow) sourceBody.append(ownerRow);
                }

                // Every recorded rule shows in edit mode, not only the enabled
                // ones: turning one back on is the point of being here.
                const list = $('<div class="ocs-world-entries is-open"></div>');
                if (!scripts.length) {
                    list.append($('<small></small>').text(key === 'global' ? '这一类没有记录规则。' : '先选一个来源，再挑要记录的规则。'));
                }

                const grouped = new Map();
                const ungrouped = [];
                for (const script of scripts) {
                    const group = groups.get(String(script.id));
                    if (!group) { ungrouped.push(script); continue; }
                    if (!grouped.has(group)) grouped.set(group, []);
                    grouped.get(group).push(script);
                }

                const scriptToggle = (script, afterChange) => {
                    const input = $('<input type="checkbox">').prop('checked', script.enabled !== false);
                    input.on('change', function () {
                        script.enabled = this.checked;
                        snapshot.updatedAt = Date.now();
                        saveSettingsDebounced();
                        afterChange();
                    });
                    return $('<label class="ocs-world-entry"></label>').append(input, '<i class="ocs-toggle-icon"></i>', $('<span></span>').text(script.label || script.id));
                };
                const counters = [];
                const refresh = () => {
                    for (const [node, members] of counters) node.text(`${members.filter(script => script.enabled !== false).length} / ${members.length}`);
                    list.find('.ocs-world-bulk').trigger('ocs:sync');
                };
                const groupToggle = (members) => {
                    const icon = $('<i class="ocs-toggle-icon"></i>');
                    const button = $('<button type="button" class="ocs-world-bulk"></button>').append(icon);
                    const sync = () => {
                        const any = members.some(script => script.enabled !== false);
                        const all = members.length > 0 && members.every(script => script.enabled !== false);
                        icon.toggleClass('is-on', any);
                        button.attr('title', all ? '全部关闭' : '全部开启');
                        return all;
                    };
                    sync();
                    button.on('ocs:sync', sync);
                    button.on('click', (event) => {
                        // This sits inside a <summary>, whose default action is
                        // to open and close the drawer it is in.
                        event.preventDefault();
                        event.stopPropagation();
                        const value = !sync();
                        for (const script of members) script.enabled = value;
                        snapshot.updatedAt = Date.now();
                        saveSettingsDebounced();
                        renderSections();
                    });
                    return button;
                };

                for (const script of ungrouped) list.append(scriptToggle(script, refresh));
                for (const [group, members] of grouped) {
                    const counter = $('<small></small>');
                    counters.push([counter, members]);
                    const groupDrawer = $('<details class="ocs-world-entry-group"></details>');
                    groupDrawer.append($('<summary></summary>').append($('<b></b>').text(group), counter, groupToggle(members)));
                    const groupBody = $('<div class="ocs-world-entry-group-body"></div>');
                    for (const script of members) groupBody.append(scriptToggle(script, refresh));
                    list.append(groupDrawer.append(groupBody));
                }
                refresh();
                sourceBody.append(list);
                body.append(drawer);
            }
            return section;
        };
        mount((isEditing) => {
            if (!snapshot.scopes?.regex) return null;
            return buildRegexSection(isEditing);
        }, 'regex');
    }
    /**
     * An empty shell for a scope, ready to be filled in by hand.
     *
     * Deliberately not a capture of the current state: this page exists to
     * assemble a snapshot piece by piece, and seeding it from whatever happens
     * to be loaded would mean deleting someone else's settings before choosing
     * your own. `api` is the exception -- it has no editor, so there is nothing
     * to fill in and recording the live connection is the only thing it can do.
     *
     * @param {string} key Scope key
     * @returns {object|null} Payload shell, or null to record from the current state
     */
    const emptyScopePayload = (key) => {
        switch (key) {
            case 'character':
            case 'persona':
                return { versionId: null, versionName: '', data: {} };
            case 'theme':
                return { name: '' };
            case 'worldInfo':
                return { globalSelected: null, context: {}, books: [] };
            case 'preset':
                return { api: main_api, presetValue: null, presetName: '', promptEntries: [], promptGates: [], parameters: null };
            case 'regex':
                // Global rules are listed straight away because they have no
                // owner to pick. The other two stay empty until a character or
                // a preset is chosen, which is what decides what belongs there.
                return {
                    context: {},
                    sources: {
                        global: { scripts: getScriptsByType(SCRIPT_TYPES.GLOBAL).map(script => ({ id: script.id, label: script.scriptName || script.id, enabled: false })) },
                        scoped: { scripts: [], allowed: true },
                        preset: { scripts: [], allowed: true },
                    },
                };
            default:
                return null;
        }
    };

    await showOcsPopup(root);
    discardEdits();
}

/** Per-page choices for the snapshot library, mirroring SillyTavern's lists. */
const SNAPSHOT_PAGE_SIZES = [5, 10, 25, 50, 100];
const SNAPSHOT_PAGE_KEY = 'OcsSnapshots_PerPage';
const VERSION_PAGE_KEY = 'OcsVersions_PerPage';

/** Ids of the snapshots ticked while bulk mode is on. */
const snapshotSelection = new Set();
let snapshotBulkMode = false;
let snapshotPage = 1;

/** Deletes a snapshot and every reference to it. */
function deleteSnapshotById(id) {
    const snapshot = getSnapshot(id);
    if (!snapshot) return;
    const themeManagerBindings = themeManagerCharacterBindings();
    const snapshotTheme = themeNameFromPayload(snapshot.payload);
    settings().snapshots = settings().snapshots.filter(item => item.id !== id);
    if (binding().snapshotId === id) binding().snapshotId = null;
    if (binding().lastAppliedSnapshotId === id) binding().lastAppliedSnapshotId = null;
    delete settings().snapshotBindings[id];
    for (const [avatar, record] of Object.entries(settings().characterBindings)) {
        if (record?.snapshotId === id) {
            if (themeManagerBindings?.[avatar] === snapshotTheme) delete themeManagerBindings[avatar];
            delete settings().characterBindings[avatar];
        }
    }
    for (const [avatar, records] of Object.entries(settings().greetingBindings)) {
        for (const [key, record] of Object.entries(records ?? {})) {
            if (record?.snapshotId === id) delete settings().greetingBindings[avatar][key];
        }
        if (!Object.keys(settings().greetingBindings[avatar] ?? {}).length) delete settings().greetingBindings[avatar];
    }
}

/** Ways to order the library, in the order they appear in the dropdown. */
const SNAPSHOT_SORTS = {
    'updated-desc': { label: '最近更新', compare: (a, b) => b.updatedAt - a.updatedAt },
    'updated-asc': { label: '最早更新', compare: (a, b) => a.updatedAt - b.updatedAt },
    'created-desc': { label: '最近创建', compare: (a, b) => b.createdAt - a.createdAt },
    'created-asc': { label: '最早创建', compare: (a, b) => a.createdAt - b.createdAt },
    'applied-desc': { label: '最近应用', compare: (a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0) || b.updatedAt - a.updatedAt },
    'name-asc': { label: '名称 A-Z', compare: (a, b) => String(a.name).localeCompare(String(b.name)) },
    'name-desc': { label: '名称 Z-A', compare: (a, b) => String(b.name).localeCompare(String(a.name)) },
};

function librarySort() {
    const stored = settings().librarySort;
    return Object.hasOwn(SNAPSHOT_SORTS, stored) ? stored : 'updated-desc';
}

/** The snapshots matching the current group filter, search box and sort. */
function visibleSnapshots(root) {
    const filter = String(root.find('.ocs-library-filter').val() ?? '__all__');
    const query = String(root.find('.ocs-library-search').val() ?? '').trim().toLocaleLowerCase();
    const activeSnapshotId = currentAppliedSnapshotId();
    const compare = SNAPSHOT_SORTS[librarySort()].compare;
    return [...settings().snapshots]
        .filter(snapshot => filter === '__all__' || (snapshot.group ?? '') === filter)
        .filter(snapshot => !query || `${snapshot.name ?? ''} ${snapshot.group ?? ''}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => {
            // The snapshot in use stays on top whatever the order: with the list
            // paginated, it would otherwise be several pages away.
            const currentOrder = Number(b.id === activeSnapshotId) - Number(a.id === activeSnapshotId);
            return currentOrder || compare(a, b);
        });
}

/** One snapshot, collapsed to its summary until opened. */
function renderSnapshotCard(root, snapshot) {
    const isBound = binding().snapshotId === snapshot.id;
    const characterBindings = snapshotCharacterBindings(snapshot.id);
    const greetingBindings = snapshotGreetingBindings(snapshot.id);
    const currentCharacterDefault = currentCharacterBinding()?.snapshotId === snapshot.id;
    const currentGreetingBindings = greetingBindings.filter(item => item.avatar === currentCharacter()?.avatar);
    const isActive = currentAppliedSnapshotId() === snapshot.id;

    const card = $('<details class="ocs-snapshot-card"></details>')
        .attr('data-ocs-snapshot-id', snapshot.id)
        .toggleClass('ocs-bound', isBound || characterBindings.length > 0)
        .toggleClass('ocs-active', isActive);

    const summary = $('<summary></summary>');
    if (snapshotBulkMode) {
        const tick = $('<input type="checkbox" class="ocs-card-tick">').prop('checked', snapshotSelection.has(snapshot.id));
        tick.on('click', event => event.stopPropagation());
        tick.on('change', function () {
            if (this.checked) snapshotSelection.add(snapshot.id);
            else snapshotSelection.delete(snapshot.id);
            updateSnapshotBulkControls(root);
        });
        summary.append(tick);
    }
    summary.append($('<span class="ocs-card-title"></span>').text(snapshot.name));
    if (snapshot.group) summary.append($('<span class="ocs-card-group"></span>').text(snapshot.group));
    summary.append($('<time></time>').text(new Date(snapshot.updatedAt).toLocaleString()));
    card.append(summary);

    const body = $('<div class="ocs-card-body"></div>');
    body.append(scopeBadges(snapshot, () => renderSnapshotList(root)));

    const boundChats = snapshotChatBindings(snapshot.id);
    if (boundChats.length) {
        const currentChat = currentChatReference();
        const labels = boundChats.map(chat => `${chat.name}${isBound && binding().enabled === false && chat.id === currentChat?.id ? '（已停用）' : ''}`);
        body.append($('<p class="ocs-bound-chats"></p>').text(`已绑定：${labels.join('、')}`));
    }
    if (characterBindings.length) {
        body.append($('<p class="ocs-bound-chats"></p>').text(`角色默认：${characterBindings.map(item => `${item.name}${item.enabled ? '' : '（已停用）'}`).join('、')}`));
    }
    if (greetingBindings.length) {
        body.append($('<p class="ocs-bound-chats"></p>').text(`开场白：${greetingBindings.map(item => `${item.characterName} · ${item.label}${item.enabled ? '' : '（已停用）'}`).join('、')}`));
    }

    const actions = $('<div class="ocs-card-actions"></div>');
    actions.append($('<button class="ocs-button">应用</button>').on('click', async () => {
        if (await applySnapshot(snapshot)) renderSnapshotList(root);
    }));
    actions.append($('<button class="ocs-button">查看内容</button>').on('click', () => showSnapshotContents(snapshot, () => renderSnapshotList(root))));
    actions.append($('<button class="ocs-button">更新</button>').on('click', async () => {
        if (!hasSnapshotScope(snapshot.scopes)) {
            toastr.warning('这个快照没有记录范围，先在上方添加一个。', '一键快照');
            return;
        }
        if (await updateSnapshot(snapshot)) renderSnapshotList(root);
    }));
    actions.append($('<button class="ocs-button">重命名</button>').on('click', async () => { await renameSnapshot(snapshot); renderSnapshotList(root); }));
    actions.append($('<button class="ocs-button">分组</button>').on('click', async () => { await setSnapshotGroup(snapshot); renderGroups(root); renderSnapshotList(root); }));
    actions.append($(`<button class="ocs-button">${isBound ? '解绑聊天' : '绑定聊天'}</button>`).on('click', async () => {
        if (await bindSnapshot(isBound ? null : snapshot.id)) renderSnapshotList(root);
    }));
    if (isBound) {
        const enabled = binding().enabled !== false;
        actions.append($(`<button class="ocs-button">${enabled ? '停用聊天应用' : '启用聊天应用'}</button>`).on('click', () => {
            toggleBinding();
            renderSnapshotList(root);
        }));
    }
    actions.append($(`<button class="ocs-button">${currentCharacterDefault ? '解绑角色' : '绑定角色'}</button>`).on('click', async () => {
        const changed = currentCharacterDefault
            ? unbindSnapshotFromCurrentCharacter(snapshot.id)
            : await bindSnapshotToCurrentCharacter(snapshot);
        if (changed) renderSnapshotList(root);
    }));
    if (currentCharacterDefault) {
        const enabled = currentCharacterBinding()?.enabled !== false;
        actions.append($(`<button class="ocs-button">${enabled ? '停用角色应用' : '启用角色应用'}</button>`).on('click', async () => {
            if (await toggleCurrentCharacterBinding(snapshot.id)) renderSnapshotList(root);
        }));
    }
    actions.append($('<button class="ocs-button">绑定开场白</button>').on('click', async () => {
        if (await bindSnapshotToGreeting(snapshot)) renderSnapshotList(root);
    }));
    if (currentGreetingBindings.length) {
        actions.append($('<button class="ocs-button">解绑开场白</button>').on('click', async () => {
            if (await unbindSnapshotFromGreeting(snapshot.id)) renderSnapshotList(root);
        }));
    }
    actions.append($('<button class="ocs-button ocs-danger">删除</button>').on('click', async () => {
        if (!await Popup.show.confirm('删除快照', `删除“${snapshot.name}”？角色、世界书和预设本身不会删除。`)) return;
        deleteSnapshotById(snapshot.id);
        pruneSnapshotGroups();
        saveSettingsDebounced();
        saveMetadataDebounced();
        renderGroups(root);
        renderSnapshotList(root);
    }));
    body.append(actions);
    card.append(body);
    return card;
}

/** Keeps the bulk toolbar in step with the current selection. */
function updateSnapshotBulkControls(root) {
    // A class, not .toggle(): `.ocs-button` is `display: inline-flex !important`,
    // and an inline `display: none` from jQuery loses to it.
    root.find('.ocs-library-tools').toggleClass('ocs-bulk-on', snapshotBulkMode);
    root.find('.ocs-bulk-count').text(String(snapshotSelection.size));
    root.find('.ocs-library-bulk').toggleClass('ocs-primary', snapshotBulkMode);
}

/**
 * Renders the snapshot library: one flat, paginated list of collapsible cards.
 *
 * Groups used to be collapsible sections here, which meant two nested levels of
 * folding and a page that got taller the more groups existed. The group filter
 * already answers "show me one group", so the list itself stays flat.
 */
function renderSnapshotList(root) {
    const open = new Set(root.find('.ocs-snapshot-card[open]').toArray().map(node => node.dataset.ocsSnapshotId));
    const list = root.find('.ocs-snapshot-list').empty();
    const pager = root.find('.ocs-library-pagination');
    const snapshots = visibleSnapshots(root);

    // Ticks on snapshots that scrolled out of the filter would be invisible but
    // still act on the next bulk operation.
    const visibleIds = new Set(snapshots.map(snapshot => snapshot.id));
    for (const id of [...snapshotSelection]) {
        if (!visibleIds.has(id)) snapshotSelection.delete(id);
    }
    updateSnapshotBulkControls(root);

    if (!snapshots.length) {
        pager.empty();
        const query = String(root.find('.ocs-library-search').val() ?? '').trim();
        return list.append(`<div class="ocs-empty">${query ? '没有匹配的快照。' : '这个分组还没有快照。'}</div>`);
    }

    const perPage = Number(accountStorage.getItem(SNAPSHOT_PAGE_KEY)) || 10;
    pager.pagination({
        dataSource: snapshots,
        pageSize: perPage,
        sizeChangerOptions: SNAPSHOT_PAGE_SIZES,
        pageRange: 1,
        pageNumber: snapshotPage,
        position: 'top',
        showPageNumbers: false,
        showSizeChanger: true,
        formatSizeChanger: renderPaginationDropdown(perPage, SNAPSHOT_PAGE_SIZES),
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        showNavigator: true,
        callback: function (data) {
            list.empty();
            for (const snapshot of data) {
                list.append(renderSnapshotCard(root, snapshot).prop('open', open.has(snapshot.id)));
            }
            localizePagination(pager);
        },
        afterSizeSelectorChange: function (event, size) {
            accountStorage.setItem(SNAPSHOT_PAGE_KEY, event.target.value);
            paginationDropdownChangeHandler(event, size);
        },
        afterPaging: function (page) {
            snapshotPage = page;
        },
    });
}

function renderGroups(root) {
    fillGroupSelect(root.find('.ocs-capture-group'));
    fillGroupSelect(root.find('.ocs-library-filter'), { all: true });
}

function setSnapshotMobilePage(root, page) {
    const library = page === 'library';
    root.toggleClass('ocs-mobile-page-library', library);
    root.find('.ocs-mobile-page-tab').each((_, element) => {
        const active = String($(element).data('ocsPage')) === page;
        $(element).toggleClass('is-active', active).attr('aria-selected', active ? 'true' : 'false');
    });
}

async function openSnapshotPopup() {
    await pruneMissingCharacterChatBindings();
    if (pruneSnapshotGroups()) saveSettingsDebounced();
    const root = $(
        `<div class="ocs-popup">
            <header class="ocs-popup-header"><div><span class="ocs-kicker">SNAPSHOT LIBRARY</span><h3>一键快照</h3></div></header>
            <div class="ocs-mobile-page-tabs" role="tablist" aria-label="一键快照页面"><button type="button" class="ocs-mobile-page-tab is-active" role="tab" aria-selected="true" data-ocs-page="capture">保存当前状态</button><button type="button" class="ocs-mobile-page-tab" role="tab" aria-selected="false" data-ocs-page="library">快照库</button></div>
            <div class="ocs-workspace">
                <section class="ocs-capture">
                    <h4>保存当前状态</h4>
                    <label class="ocs-field-label" for="ocs-snapshot-name">名称<input id="ocs-snapshot-name" class="text_pole ocs-name" placeholder="例如：现代版"></label>
                    <label class="ocs-field-label" for="ocs-snapshot-group">分组<select id="ocs-snapshot-group" class="text_pole ocs-capture-group"></select></label>
                    <div class="ocs-scope-grid">
                        <label class="checkbox_label ocs-scope" for="ocs-scope-character"><input id="ocs-scope-character" type="checkbox" value="character" data-snapshot-scope checked>角色版本</label>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-persona"><input id="ocs-scope-persona" type="checkbox" value="persona" data-snapshot-scope checked>用户版本</label>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-theme"><input id="ocs-scope-theme" type="checkbox" value="theme" data-snapshot-scope checked>界面美化</label>
                        <div class="ocs-world-scope is-enabled"><label class="checkbox_label ocs-scope" for="ocs-scope-world"><input id="ocs-scope-world" type="checkbox" value="worldInfo" data-snapshot-scope checked>世界书与条目</label><div class="ocs-world-sources"><label class="checkbox_label ocs-scope" for="ocs-world-global"><input id="ocs-world-global" type="checkbox" value="global" checked>全局世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-char-main"><input id="ocs-world-char-main" type="checkbox" value="characterMain" checked>角色主世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-char-extra"><input id="ocs-world-char-extra" type="checkbox" value="characterExtra" checked>角色附加世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-user"><input id="ocs-world-user" type="checkbox" value="user" checked>用户绑定世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-chat"><input id="ocs-world-chat" type="checkbox" value="chat" checked>聊天世界书</label></div></div>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-preset"><input id="ocs-scope-preset" type="checkbox" value="preset" data-snapshot-scope checked>预设与条目</label>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-api"><input id="ocs-scope-api" type="checkbox" value="api" data-snapshot-scope checked>聊天补全 API</label>
                        <div class="ocs-world-scope is-enabled ocs-regex-scope"><label class="checkbox_label ocs-scope" for="ocs-scope-regex"><input id="ocs-scope-regex" type="checkbox" value="regex" data-snapshot-scope checked>正则规则</label><div class="ocs-world-sources"><label class="checkbox_label ocs-scope" for="ocs-regex-global"><input id="ocs-regex-global" type="checkbox" value="global" checked>全局正则</label><label class="checkbox_label ocs-scope" for="ocs-regex-scoped"><input id="ocs-regex-scoped" type="checkbox" value="scoped" checked>角色局部正则</label><label class="checkbox_label ocs-scope" for="ocs-regex-preset"><input id="ocs-regex-preset" type="checkbox" value="preset" checked>当前预设正则</label></div></div>
                    </div>
                    <button class="ocs-button ocs-primary ocs-capture-button"><i class="fa-solid fa-camera"></i> 保存快照</button>
                </section>
                <section class="ocs-library"><div class="ocs-library-heading"><div><h4>快照库</h4></div><div class="ocs-library-controls"><input class="text_pole ocs-library-search" type="search" placeholder="搜索快照名称"><select class="text_pole ocs-library-filter"></select></div><div class="ocs-library-tools"><button type="button" class="ocs-button ocs-icon-button ocs-library-expand" title="全部展开"><i class="fa-solid fa-angles-down"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-collapse" title="全部折叠"><i class="fa-solid fa-angles-up"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk" title="批量操作"><i class="fa-solid fa-list-check"></i></button><span class="ocs-library-bulk-only ocs-bulk-count">0</span><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-bulk-all" title="全选 / 取消全选"><i class="fa-solid fa-check-double"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-bulk-refresh" title="更新选中的快照"><i class="fa-solid fa-rotate"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-bulk-drop" title="移除选中快照的某个范围"><i class="fa-solid fa-eraser"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-library-bulk-only ocs-bulk-group" title="移动选中的快照到分组"><i class="fa-solid fa-folder-tree"></i></button><button type="button" class="ocs-button ocs-icon-button ocs-danger ocs-library-bulk-only ocs-bulk-delete" title="删除选中的快照"><i class="fa-solid fa-trash"></i></button></div><div class="ocs-library-footer"><div class="ocs-library-pagination"></div><select class="text_pole ocs-library-sort" title="排序方式"></select></div></div><div class="ocs-snapshot-list"></div></section>
            </div>
        </div>`);
    const applyCaptureScopeSelection = () => {
        const saved = settings().lastCaptureScopes;
        root.find('input[data-snapshot-scope]').each((_, input) => {
            input.checked = saved[input.value] === true;
        });
        // The character and persona scopes are the version feature: they store
        // a version reference, not content. With versions switched off there is
        // nothing to point at, so take them out rather than let a snapshot
        // capture something the user can no longer manage.
        if (!feature('version')) {
            for (const scope of VERSION_SCOPES) {
                const input = root.find(`input[data-snapshot-scope][value="${scope}"]`);
                // A class, not .hide(): `.checkbox_label.ocs-scope` is
                // `display: flex !important`, which an inline style loses to.
                input.prop('checked', false).closest('.ocs-scope').addClass('ocs-feature-off');
            }
        }
        root.find('.ocs-world-scope:not(.ocs-regex-scope) .ocs-world-sources input').each((_, input) => {
            input.checked = saved.worldSources?.[input.value] === true;
        });
        root.find('.ocs-regex-scope .ocs-world-sources input').each((_, input) => {
            input.checked = saved.regexSources?.[input.value] === true;
        });
        root.find('.ocs-world-scope').toggleClass('is-enabled', saved.worldInfo === true);
        root.find('.ocs-regex-scope').toggleClass('is-enabled', saved.regex === true);
    };
    const rememberCaptureScopeSelection = () => {
        const saved = {};
        root.find('input[data-snapshot-scope]').each((_, input) => { saved[input.value] = input.checked; });
        saved.worldSources = {};
        root.find('.ocs-world-scope:not(.ocs-regex-scope) .ocs-world-sources input').each((_, input) => { saved.worldSources[input.value] = input.checked; });
        saved.regexSources = {};
        root.find('.ocs-regex-scope .ocs-world-sources input').each((_, input) => { saved.regexSources[input.value] = input.checked; });
        settings().lastCaptureScopes = saved;
        saveSettingsDebounced();
    };
    const sortSelect = root.find('.ocs-library-sort');
    for (const [value, { label }] of Object.entries(SNAPSHOT_SORTS)) {
        sortSelect.append($('<option></option>').attr('value', value).text(label));
    }
    sortSelect.val(librarySort()).on('change', function () {
        settings().librarySort = String($(this).val());
        saveSettingsDebounced();
        snapshotPage = 1;
        renderSnapshotList(root);
    });

    root.find('.ocs-library-expand').on('click', () => root.find('.ocs-snapshot-card').prop('open', true));
    root.find('.ocs-library-collapse').on('click', () => root.find('.ocs-snapshot-card').prop('open', false));
    root.find('.ocs-library-bulk').on('click', () => {
        snapshotBulkMode = !snapshotBulkMode;
        if (!snapshotBulkMode) snapshotSelection.clear();
        renderSnapshotList(root);
    });
    root.find('.ocs-bulk-all').on('click', () => {
        const ids = visibleSnapshots(root).map(snapshot => snapshot.id);
        const allPicked = ids.length > 0 && ids.every(id => snapshotSelection.has(id));
        snapshotSelection.clear();
        if (!allPicked) for (const id of ids) snapshotSelection.add(id);
        renderSnapshotList(root);
    });
    root.find('.ocs-bulk-refresh').on('click', async () => {
        await batchUpdateSnapshots([...snapshotSelection]);
        renderSnapshotList(root);
    });
    root.find('.ocs-bulk-drop').on('click', async () => {
        await batchRemoveScopes([...snapshotSelection]);
        renderSnapshotList(root);
    });
    root.find('.ocs-bulk-group').on('click', async () => {
        if (!snapshotSelection.size) return toastr.info('请先选择快照。', '一键快照');
        const group = await chooseGroup('', settings().snapshotGroups, { title: '移动到分组', okButton: '确认移动' });
        if (group === null) return;
        for (const id of snapshotSelection) {
            const snapshot = getSnapshot(id);
            if (snapshot) snapshot.group = group;
        }
        pruneSnapshotGroups();
        saveSettingsDebounced();
        renderGroups(root);
        renderSnapshotList(root);
    });
    root.find('.ocs-bulk-delete').on('click', async () => {
        const ids = [...snapshotSelection];
        if (!ids.length) return toastr.info('请先选择快照。', '一键快照');
        const names = ids.map(id => getSnapshot(id)?.name).filter(Boolean).join('、');
        if (!await Popup.show.confirm('删除快照', `删除这 ${ids.length} 个快照？<br><br>${names}<br><br>角色、世界书和预设本身不会删除。`)) return;
        for (const id of ids) deleteSnapshotById(id);
        snapshotSelection.clear();
        pruneSnapshotGroups();
        saveSettingsDebounced();
        saveMetadataDebounced();
        renderGroups(root);
        renderSnapshotList(root);
    });
    root.find('.ocs-capture-button').on('click', async () => {
        const scopes = Object.fromEntries(root.find('.ocs-scope-grid input[data-snapshot-scope]:checked').toArray().map(input => [input.value, true]));
        if (!Object.keys(scopes).length) return toastr.warning('至少选择一项。', '一键快照');
        scopes.worldSources = scopes.worldInfo
            ? Object.fromEntries(root.find('.ocs-world-scope:not(.ocs-regex-scope) .ocs-world-sources input:checked').toArray().map(input => [input.value, true]))
            : {};
        scopes.regexSources = scopes.regex
            ? Object.fromEntries(root.find('.ocs-regex-scope .ocs-world-sources input:checked').toArray().map(input => [input.value, true]))
            : {};
        const snapshot = await createSnapshot(String(root.find('.ocs-name').val() ?? ''), scopes, String(root.find('.ocs-capture-group').val() ?? ''));
        if (!snapshot) return;
        root.find('.ocs-name').val('');
        renderSnapshotList(root);
        toastr.success(`已保存：${snapshot.name}`, '一键快照');
    });
    root.find('#ocs-scope-world').on('change', event => {
        root.find('.ocs-world-scope:not(.ocs-regex-scope)').toggleClass('is-enabled', event.currentTarget.checked);
    });
    root.find('#ocs-scope-regex').on('change', event => {
        root.find('.ocs-regex-scope').toggleClass('is-enabled', event.currentTarget.checked);
    });
    root.find('.ocs-scope-grid input[type="checkbox"]').on('change', rememberCaptureScopeSelection);
    root.find('.ocs-library-filter').on('change', () => renderSnapshotList(root));
    root.find('.ocs-library-search').on('input', () => renderSnapshotList(root));
    root.find('.ocs-mobile-page-tab').on('click', event => {
        event.preventDefault();
        setSnapshotMobilePage(root, String($(event.currentTarget).data('ocsPage')));
    });
    applyCaptureScopeSelection();
    renderGroups(root); renderSnapshotList(root);
    await showOcsPopup(root);
}

async function showOcsPopup(root) {
    // Match Timeline Memory: a normal TEXT popup is naturally centered by the
    // browser and grows around the viewport centre as its content changes.
    // The close button receives focus, never a text input on iOS.
    const popup = new Popup(root.get(0), POPUP_TYPE.TEXT, '', {
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
    });
    popup.dlg.classList.add('ocs-dialog');
    await popup.show();
}

function registerQrAssistantShortcut() {
    // QR助手 discovers third-party actions through this optional shared
    // registry. Registering the actual DOM id lets it list, sort and whitelist
    // the entry instead of treating it as an anonymous QR-looking element.
    globalThis.qrAssistantExtensionApi ??= [];
    if (!Array.isArray(globalThis.qrAssistantExtensionApi)) return;
    const entry = globalThis.qrAssistantExtensionApi.find(item => item?.dom_id === 'one_click_snapshot_qr');
    if (entry) Object.assign(entry, { group_name: '一键快照', button_name: '一键快照' });
    else globalThis.qrAssistantExtensionApi.push({ dom_id: 'one_click_snapshot_qr', group_name: '一键快照', button_name: '一键快照' });
}

function renderQrShortcut() {
    const existing = document.getElementById('one_click_snapshot_qr');
    // The quick-reply button is the only way into the library, so the master
    // switch takes it away with the rest of the feature. Handled here rather
    // than at install time so the switch applies without a reload.
    if (!feature('snapshot')) {
        existing?.remove();
        return;
    }
    registerQrAssistantShortcut();
    const bar = document.getElementById('qr--bar');
    if (!bar) return;
    const isCombined = window.quickReplyApi?.settings?.isCombined === true;
    const holder = isCombined
        ? Array.from(bar.children).find(element => element.classList.contains('qr--buttons')) ?? bar
        : bar;
    // The old implementation wrapped this button in its own .qr--buttons.
    // Do not leave that legacy wrapper behind after an extension hot reload or
    // a switch between QR layouts: it carries the full-width group styling.
    if (existing?.parentElement === holder) return;
    const legacyGroup = existing?.closest('.ocs-qr-shortcut-set');
    existing?.remove();
    if (legacyGroup?.childElementCount === 0) legacyGroup.remove();

    // In combined QR mode, native sets share one .qr--buttons holder. Put the
    // actual button directly in it. In non-combined mode it stays a direct
    // #qr--bar child, which is the shape QR Assistant expects for a registered
    // third-party button (rather than a full-width native QR set).
    const button = document.createElement('div');
    button.id = 'one_click_snapshot_qr';
    button.className = 'qr--button menu_button';
    button.title = '打开一键快照';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.innerHTML = '<div class="qr--button-label">一键快照</div>';
    button.addEventListener('click', openSnapshotPopup);
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSnapshotPopup();
        }
    });
    holder.append(button);
    window.quickReplyMenu?.applyWhitelistDOMChanges?.();
}

function installQrShortcut() {
    if (!qrShortcutObserver) {
        qrShortcutObserver = new MutationObserver(() => {
            if (qrShortcutRefreshQueued) return;
            qrShortcutRefreshQueued = true;
            queueMicrotask(() => {
                qrShortcutRefreshQueued = false;
                renderQrShortcut();
            });
        });
        qrShortcutObserver.observe(document.body, { childList: true, subtree: true });
    }
    renderQrShortcut();
}

function currentGreetingSnapshot() {
    const character = currentCharacter();
    const chat = SillyTavern.getContext()?.chat;
    if (!character?.avatar || !Array.isArray(chat) || !chat.length) return null;
    const opening = chat[0];
    if (!opening || opening.is_user || opening.is_system) return null;
    // A greeting binding is only a startup rule. Once an assistant reply has
    // been added, the promoted chat binding is the sole source of truth.
    if (chat.slice(1).some(message => message && !message.is_user && !message.is_system)) return null;
    const swipeId = Number(opening.swipe_id ?? 0);
    const candidate = openingGreetingCandidates(character).find(item => item.swipeIndex === swipeId);
    if (!candidate) return null;
    const record = greetingBindingRecords(character)[candidate.key];
    if (!record || record.enabled === false || record.fingerprint !== candidate.fingerprint) return null;
    const snapshot = getSnapshot(record.snapshotId);
    return snapshot ? { snapshot, candidate, record, character } : null;
}

async function applyCurrentGreetingSnapshot({ showToast = true } = {}) {
    if (applying) return false;
    // Explicit chat bindings (even disabled ones) are intentionally stronger
    // than any greeting. They are the user's direct choice for this chat.
    if (chat_metadata?.[METADATA_KEY]?.snapshotId) return false;
    // CHAT_CHANGED normally creates this map, but also do it here for a newly
    // created chat whose first greeting arrives after that event.
    cacheOpeningGreetingMap();
    const selection = currentGreetingSnapshot();
    const chatId = String(getCurrentChatId() ?? '');
    if (!selection) return false;
    greetingGenerationStopped = false;
    if (greetingSnapshotPending?.chatId === chatId
        && greetingSnapshotPending?.snapshotId === selection.snapshot.id
        && greetingSnapshotPending?.greetingKey === selection.candidate.key) return true;
    if (!snapshotCanBindToCurrentCharacter(selection.snapshot, { notify: true })) return false;

    const compatibility = applyCompatibility(selection.snapshot);
    const applied = await applySnapshot(selection.snapshot, { skipMismatchPrompt: true, persistCharacter: false, preserveGreetingCatalog: true });
    if (!applied) return false;
    greetingSnapshotPending = {
        chatId,
        snapshotId: selection.snapshot.id,
        greetingKey: selection.candidate.key,
        // “仅应用兼容内容” is a deliberate binding policy. Preserve it when
        // this temporary greeting rule turns into a chat-specific rule.
        compatibleOnly: (selection.record.userMode === 'compatible' && compatibility.requirements.needsPersona)
            || compatibility.personaMismatch || compatibility.characterMismatch,
    };
    if (showToast) toastr.success(`已按开场白应用快照：${selection.snapshot.name}`, '一键快照');
    return true;
}

async function applyGreetingSnapshotBeforeGeneration(type, _params, isDryRun) {
    if (isDryRun || applying || ['quiet', 'impersonate', 'continue', 'append', 'appendFinal'].includes(type)) return;
    const chatId = String(getCurrentChatId() ?? '');
    if (await applyCurrentGreetingSnapshot()) return;
    // The chat initially opened on a bound greeting, but the user then chose
    // an unbound alternate before sending their first message. In that case,
    // fall back to the role default exactly once.
    if (type === 'normal' && greetingDeferredCharacterDefaultChatId === chatId) {
        greetingDeferredCharacterDefaultChatId = null;
        await applyCurrentCharacterDefault();
    }
}

async function applyGreetingSnapshotAfterSwipe(messageId) {
    if (Number(messageId) !== 0 || chat_metadata?.[METADATA_KEY]?.snapshotId) return;
    const chatId = String(getCurrentChatId() ?? '');
    if (await applyCurrentGreetingSnapshot()) return;
    // Do not allow the prior greeting's pending snapshot to be promoted after
    // the user chooses an unbound alternate greeting instead.
    if (greetingSnapshotPending?.chatId === chatId) greetingSnapshotPending = null;
    if (greetingDeferredCharacterDefaultChatId === chatId) {
        greetingDeferredCharacterDefaultChatId = null;
        await applyCurrentCharacterDefault();
    }
}

async function promoteGreetingSnapshotAfterReply(messageId, type) {
    if (type !== 'normal' || !greetingSnapshotPending) return;
    const pending = greetingSnapshotPending;
    const chatId = String(getCurrentChatId() ?? '');
    if (pending.chatId !== chatId || Number(messageId) < 1) {
        if (pending.chatId !== chatId) greetingSnapshotPending = null;
        return;
    }
    if (greetingGenerationStopped) return;
    const reply = SillyTavern.getContext()?.chat?.[Number(messageId)];
    if (!reply || reply.is_user || reply.is_system || !String(reply.mes ?? '').trim()) return;
    const snapshot = getSnapshot(pending.snapshotId);
    greetingSnapshotPending = null;
    if (!snapshot) return;
    const bound = pending.compatibleOnly || !snapshotCanBindCurrentChat(snapshot)
        ? bindCompatibleSnapshot(snapshot.id)
        : await bindSnapshot(snapshot.id, { userMode: 'lock' });
    if (!bound) return;
    toastr.success(`开场白快照已绑定到此聊天：${snapshot.name}`, '一键快照');
}

function markGreetingGenerationStopped() {
    if (greetingSnapshotPending) greetingGenerationStopped = true;
}

async function applyCurrentCharacterDefault() {
    const characterBinding = currentCharacterBinding();
    if (!characterBinding?.snapshotId || characterBinding.enabled === false) return;
    const snapshot = getSnapshot(characterBinding.snapshotId);
    if (!snapshot) {
        delete settings().characterBindings[currentCharacter()?.avatar];
        saveSettingsDebounced();
        return;
    }
    if (!snapshotCanBindToCurrentCharacter(snapshot, { notify: true })) return;
    // Role defaults never carry a single chat's lorebook into another chat.
    // User-specific parts are automatically skipped when the native persona
    // selection for this chat does not match the snapshot's user.
    await applySnapshot(snapshot, { skipMismatchPrompt: true, excludeChatWorldbook: true, persistCharacter: false, preserveGreetingCatalog: true });
}

async function onChatChanged() {
    await new Promise(resolve => setTimeout(resolve, 0));
    // This must run before a chat-, greeting-, or character-bound snapshot
    // can apply a different character version.
    cacheOpeningGreetingMap();
    const chatId = String(getCurrentChatId() ?? '');
    if (greetingSnapshotPending?.chatId !== chatId) greetingSnapshotPending = null;
    // A chat-specific binding always wins. A disabled specific binding is an
    // explicit opt-out and therefore does not fall back to the character one.
    const value = chat_metadata?.[METADATA_KEY];
    if (value?.snapshotId) {
        if (value.enabled !== true || applying) return;
        const snapshot = getSnapshot(value.snapshotId);
        if (!snapshot) {
            delete value.snapshotId;
            rememberCurrentChatBinding(null);
            saveMetadataDebounced();
            return;
        }
        if (value.compatibleOnly) {
            if (!snapshotCanBindToCurrentCharacter(snapshot, { notify: true })) return;
        } else if (!snapshotCanBindCurrentChat(snapshot, { notify: true })) return;
        // Populate the human-readable binding list for bindings created
        // before this version as soon as their chat is visited.
        rememberCurrentChatBinding(snapshot.id);
        saveSettingsDebounced();
        await applySnapshot(snapshot, { skipMismatchPrompt: true, persistCharacter: false, preserveGreetingCatalog: true, allowThemeOverride: true });
        // Theme Manager applies its character binding shortly after a role is
        // selected. A chat binding is more specific, so re-assert its theme
        // after that deferred role-level application has finished.
        if (snapshot.scopes?.theme) {
            const boundChatId = chatId;
            setTimeout(() => {
                if (String(getCurrentChatId() ?? '') !== boundChatId) return;
                const currentBinding = chat_metadata?.[METADATA_KEY];
                if (currentBinding?.snapshotId !== snapshot.id || currentBinding.enabled !== true) return;
                applyTheme(snapshot.payload?.theme);
            }, 80);
        }
        return;
    }

    if (applying) return;
    // A selected opening greeting is more specific than the role default.
    // Apply it as soon as the fresh chat opens; its first real reply will
    // later promote this temporary choice to a chat-specific binding.
    if (currentGreetingSnapshot()) {
        greetingDeferredCharacterDefaultChatId = chatId;
        await applyCurrentGreetingSnapshot();
        return;
    }
    greetingDeferredCharacterDefaultChatId = null;
    await applyCurrentCharacterDefault();
}

$(async () => {
    settings();
    initFeatures(settings);
    onFeatureChange(applyFeatureState);
    installFeatureSettings();
    setTimeout(installFeatureSettings, 1000);
    if (syncStoredSnapshotVersionNames()) saveSettingsDebounced();

    // Keeping snapshots pointed at a renamed theme, and the version avatar
    // picker, are part of their features rather than switchable extras.
    installThemeRenameObserver();
    setTimeout(installThemeRenameObserver, 1000);
    // Everything installs unconditionally and the feature guards decide whether
    // it does anything. Listeners and observers are cheap; a teardown path that
    // has to unbind them all is where the bugs would be.
    installAvatarGallerySelectionObserver();
    setTimeout(installAvatarGallerySelectionObserver, 1000);
    installVersionMenu();
    installVersionAutoSync();
    installQrShortcut();
    installGreetingCatalogIntegration();
    installPersonaManager(settings);
    installPersonaTitleLock();
    installPresetMacroAutocompleteFix();
    installNativeEditorMaximizers();
    installCharacterBulkActionButtons();
    setTimeout(installCharacterBulkActionButtons, 1000);
    applyFeatureState();
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(refreshNameMirrorLocks, 0));
    eventSource.on(event_types.PERSONA_CHANGED, () => setTimeout(refreshNameMirrorLocks, 0));
    setTimeout(refreshNameMirrorLocks, 0);
    eventSource.on(event_types.SETTINGS_UPDATED, refreshConnectionStatusDisplay);
    eventSource.on(event_types.CHAT_CHANGED, whenSnapshot(onChatChanged));
    eventSource.on(event_types.CHAT_RENAMED, whenSnapshot(updateChatBindingAfterRename));
    eventSource.on(event_types.GENERATION_STARTED, whenSnapshot(applyGreetingSnapshotBeforeGeneration));
    eventSource.on(event_types.MESSAGE_SWIPED, whenSnapshot(applyGreetingSnapshotAfterSwipe));
    eventSource.on(event_types.MESSAGE_RECEIVED, whenSnapshot(promoteGreetingSnapshotAfterReply));
    eventSource.on(event_types.GENERATION_STOPPED, whenSnapshot(markGreetingGenerationStopped));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(refreshVersionIndicators, 0));
    // Chat-bound / character-bound personas are selected asynchronously after
    // CHAT_CHANGED. Refresh again once SillyTavern has finished selecting the
    // actual persona, otherwise the previous chat's version label can linger.
    eventSource.on(event_types.PERSONA_CHANGED, refreshVersionIndicators);
    setTimeout(refreshVersionIndicators, 0);
    console.log('[One-click Snapshot] ready');
});
