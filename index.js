/**
 * 一键快照 / One-click Snapshot
 * Native-page version selectors + a wand-menu snapshot popup.
 */
import {
    characters,
    chat_metadata,
    createOrEditCharacter,
    eventSource,
    event_types,
    getCurrentChatDetails,
    getCurrentChatId,
    getPastCharacterChats,
    main_api,
    reloadCurrentChat,
    saveSettingsDebounced,
    select_selected_character,
    this_chid,
} from '../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { getWorldInfoSettings, loadWorldInfo, onWorldInfoChange, saveWorldInfo, world_names } from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';
import { getPresetManager } from '../../../preset-manager.js';
import { power_user } from '../../../power-user.js';
import { getConnectedPersonas, setPersonaDescription, setPersonaLockState, setUserAvatar, user_avatar } from '../../../personas.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { allowPresetScripts, allowScopedScripts, disallowPresetScripts, disallowScopedScripts, getCurrentPresetAPI, getCurrentPresetName, getScriptsByType, isPresetScriptsAllowed, isScopedScriptsAllowed, saveScriptsByType, SCRIPT_TYPES } from '../../regex/engine.js';

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

const deepClone = value => value === undefined ? undefined : structuredClone(value);
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `ocs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DEFAULT_CAPTURE_SCOPES = { character: true, persona: true, worldInfo: true, preset: true, regex: true, worldSources: { global: true, characterMain: true, characterExtra: true, user: true, chat: true }, regexSources: { global: true, scoped: true, preset: true } };

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
    value.lastCaptureScopes ??= deepClone(DEFAULT_CAPTURE_SCOPES);
    for (const key of ['character', 'persona', 'worldInfo', 'preset', 'regex']) value.lastCaptureScopes[key] ??= DEFAULT_CAPTURE_SCOPES[key];
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

function refreshVersionIndicators() {
    $('#one_click_snapshot_character_version_hint, #one_click_snapshot_persona_version_hint').remove();
    const characterVersion = currentCharacterVersion();
    if (characterVersion?.name) {
        $('#description_textarea').after($('<span id="one_click_snapshot_character_version_hint" class="ocs-native-version-hint"></span>').text(`当前版本：${characterVersion.name}`));
    }
    const personaVersion = currentPersonaVersion();
    if (personaVersion?.name) {
        $('#persona_description').after($('<span id="one_click_snapshot_persona_version_hint" class="ocs-native-version-hint"></span>').text(`当前版本：${personaVersion.name}`));
    }
}

function captureCharacter() {
    const character = currentCharacter();
    if (!character) return null;
    return {
        avatar: character.avatar,
        name: character.name,
        description: character.description ?? '',
        personality: character.personality ?? '',
        scenario: character.scenario ?? '',
        first_mes: character.first_mes ?? '',
        mes_example: character.mes_example ?? '',
        talkativeness: character.talkativeness,
        data: deepClone(character.data ?? {}),
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

async function captureWorldInfo(includedSources) {
    const books = [];
    const groups = getPresetTransferWorldbookGroups();
    for (const descriptor of worldBookDescriptors(includedSources)) {
        const data = await loadWorldInfo(descriptor.name);
        if (!data?.entries) continue;
        const entries = Object.entries(data.entries)
            .sort(([, a], [, b]) => Number(a?.displayIndex ?? 0) - Number(b?.displayIndex ?? 0));
        const ptGroups = getPresetTransferWorldbookEntryGroups(descriptor.name, entries.map(([uid]) => uid), data);
        const ptGates = getPresetTransferWorldbookEntryGates(descriptor.name, entries.map(([uid]) => uid), data);
        const gatedOffUids = new Set(ptGates.filter(gate => !gate.enabled).flatMap(gate => gate.uids));
        books.push({
            ...descriptor,
            group: groups.get(descriptor.name) ?? '',
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
        });
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
    const promptEntries = main_api === 'openai'
        ? (oai?.prompt_order ?? []).flatMap(list => (list.order ?? []).map(item => ({
            identifier: item.identifier,
            label: prompts.get(item.identifier) ?? item.identifier,
            enabled: !!item.enabled,
            group: groups.get(item.identifier) ?? '',
        })))
        : [];
    return {
        api: main_api,
        presetValue: manager?.getSelectedPreset() ?? null,
        presetName: manager?.getSelectedPresetName() ?? '未选择预设',
        // A snapshot is a set of switches, not a copy of a preset. The
        // identifier remains stable when the entry is renamed or edited, so
        // applying it later uses the preset's current text and only restores
        // the enabled state recorded here.
        promptEntries,
    };
}

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
        // the stored chat once after any actual regex-state change. When the
        // snapshot already matches, this branch is deliberately skipped.
        if (getCurrentChatId()) await reloadCurrentChat();
    }
}

async function applyCharacter(state, versionId = null, { persist = true, preserveGreetingCatalog = false } = {}) {
    const character = currentCharacter();
    if (!state || !character) return;
    if (state.avatar !== character.avatar) {
        toastr.warning(`“${state.name}”不是当前角色，已跳过角色版本。`, '一键快照');
        return;
    }
    const currentFirstMes = character.first_mes;
    const hasAlternateGreetings = Array.isArray(character.data?.alternate_greetings);
    const currentAlternateGreetings = deepClone(character.data?.alternate_greetings ?? []);
    const data = deepClone(state.data ?? {});
    data.extensions ??= {};
    data.extensions.one_click_snapshot = { versionId };
    if (preserveGreetingCatalog) {
        if (hasAlternateGreetings) data.alternate_greetings = currentAlternateGreetings;
        else delete data.alternate_greetings;
    }
    if (versionId) settings().activeCharacterVersions[character.avatar] = versionId;
    else delete settings().activeCharacterVersions[character.avatar];
    Object.assign(character, {
        description: state.description,
        personality: state.personality,
        scenario: state.scenario,
        first_mes: preserveGreetingCatalog ? currentFirstMes : state.first_mes,
        mes_example: state.mes_example,
        talkativeness: state.talkativeness,
        data,
    });
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
        const gatedOffBySnapshot = new Set();

        if (savedGates.length) {
            const ptSetGate = window.PT_setWorldbookGroupGate;
            if (typeof ptSetGate === 'function') {
                for (const gate of savedGates) {
                    const members = gate.uids.filter(uid => orderedUids.includes(String(uid))).map(String);
                    if (!members.length) continue;
                    const ok = await ptSetGate(book.name, gate.id, !gate.enabled, members, orderedUids);
                    if (ok) {
                        members.forEach(uid => protectedUids.delete(uid));
                        if (!gate.enabled) members.forEach(uid => gatedOffBySnapshot.add(uid));
                    }
                    if (!ok) members.forEach(uid => protectedUids.add(uid));
                }
                // PT's own setter persists grouping metadata. Reload the file
                // before touching individual entry switches so we never write
                // a stale, grouping-less object back over it.
                data = await loadWorldInfo(book.name);
            } else {
                // If PT is absent/not ready, leave all grouped entries alone.
                // Preserving the user's group gate is safer than flattening it.
                savedGates.flatMap(gate => gate.uids).forEach(uid => protectedUids.add(String(uid)));
                if (!warnedAboutPtGate) {
                    toastr.warning('预设转移的世界书分组尚未就绪，已跳过相关条目以保护分组状态。', '一键快照');
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
            const desiredEnabled = gatedOffBySnapshot.has(String(saved.uid))
                ? (saved.rawEnabled ?? !entry.disable)
                : saved.enabled;
            if (!!entry.disable === !!desiredEnabled) {
                entry.disable = !desiredEnabled;
                changed = true;
            }
        }
        if (changed) await saveWorldInfo(book.name, data, true);
    }
}

async function applyPreset(state) {
    if (!state || state.api !== main_api) return;
    const manager = getPresetManager();
    const selectedValue = manager?.getSelectedPreset?.();
    const samePreset = state.presetValue !== null
        && state.presetValue !== undefined
        && selectedValue !== null
        && selectedValue !== undefined
        && String(selectedValue) === String(state.presetValue);
    if (manager && state.presetValue !== null && state.presetValue !== undefined && !samePreset) {
        // Selecting a preset starts an asynchronous native load. Waiting for
        // it is essential: otherwise that load writes the preset file's old
        // prompt_order over the snapshot state we just restored.
        const presetLoaded = main_api === 'openai'
            ? new Promise(resolve => eventSource.once(event_types.OAI_PRESET_CHANGED_AFTER, resolve))
            : null;
        manager.selectPreset(state.presetValue);
        if (presetLoaded) await presetLoaded;
    }
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
        let changed = false;
        for (const list of context.chatCompletionSettings.prompt_order ?? []) {
            for (const item of list.order ?? []) {
                if (!enabledByIdentifier.has(item.identifier)) continue;
                const enabled = enabledByIdentifier.get(item.identifier);
                if (!!item.enabled !== enabled) {
                    item.enabled = enabled;
                    changed = true;
                }
            }
        }
        if (changed) {
            saveSettingsDebounced();
            await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        }
    }
}

function validateSnapshotVersionScopes(scopes) {
    const missing = [];
    if (scopes.character && !currentCharacterVersion()) {
        missing.push(characterVersions().length ? '角色尚未应用已保存版本' : '角色尚未创建版本');
    }
    if (scopes.persona && !currentPersonaVersion()) {
        missing.push(personaVersions().length ? '用户尚未应用已保存版本' : '用户尚未创建版本');
    }
    if (!missing.length) return true;
    toastr.warning(`${missing.join('；')}，请先在“更多”中完成版本管理后再保存快照。`, '一键快照');
    return false;
}

async function buildSnapshot(name, scopes) {
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
            worldInfo: scopes.worldInfo ? await captureWorldInfo(scopes.worldSources) : null,
            preset: scopes.preset ? capturePreset() : null,
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

async function updateSnapshot(snapshot) {
    const replacement = await buildSnapshot(snapshot.name, snapshot.scopes);
    if (!replacement) return false;
    Object.assign(snapshot, replacement, { id: snapshot.id, name: snapshot.name, group: snapshot.group ?? '', createdAt: snapshot.createdAt, updatedAt: Date.now() });
    saveSettingsDebounced();
    toastr.success(`已更新快照：${snapshot.name}`, '一键快照');
    return true;
}

function getSnapshot(snapshotId) {
    return settings().snapshots.find(snapshot => snapshot.id === snapshotId) ?? null;
}

function snapshotRequirements(snapshot) {
    const payload = snapshot?.payload ?? {};
    const sources = new Set((payload.worldInfo?.books ?? []).flatMap(book => book.sources ?? []));
    const context = payload.worldInfo?.context ?? {};
    const regexContext = payload.regex?.context ?? {};
    const hasScopedRegex = Boolean(payload.regex?.sources?.scoped);
    const needsCharacter = Boolean(snapshot?.scopes?.character || sources.has('角色主世界书') || sources.has('角色附加世界书') || hasScopedRegex);
    const needsPersona = Boolean(snapshot?.scopes?.persona || sources.has('用户绑定世界书'));
    return {
        needsCharacter,
        needsPersona,
        hasChatWorldbook: sources.has('聊天世界书'),
        characterAvatar: payload.character?.data?.avatar ?? (needsCharacter ? context.characterAvatar ?? regexContext.characterAvatar ?? null : null),
        characterName: payload.character?.data?.name ?? payload.character?.versionName ?? '该快照中的角色',
        personaAvatar: payload.persona?.data?.avatar ?? (needsPersona ? context.personaAvatar ?? null : null),
        personaName: payload.persona?.data?.name ?? payload.persona?.versionName ?? '该快照中的用户',
        chatId: context.chatId ? String(context.chatId) : null,
    };
}

function applyCompatibility(snapshot) {
    const requirements = snapshotRequirements(snapshot);
    const activeCharacter = currentCharacter()?.avatar ?? null;
    const activeChatId = String(getCurrentChatId() ?? '');
    return {
        requirements,
        characterMismatch: requirements.needsCharacter && (!requirements.characterAvatar || requirements.characterAvatar !== activeCharacter),
        personaMismatch: requirements.needsPersona && (!requirements.personaAvatar || requirements.personaAvatar !== user_avatar),
        chatMismatch: requirements.hasChatWorldbook && (!requirements.chatId || requirements.chatId !== activeChatId),
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

async function applySnapshot(snapshot, { silent = false, skipMismatchPrompt = false, excludeChatWorldbook = false, persistCharacter = true, preserveGreetingCatalog = false } = {}) {
    if (!snapshot || applying) return false;
    const compatibility = applyCompatibility(snapshot);
    const incompatible = [];
    if (compatibility.characterMismatch) incompatible.push(`角色内容（${compatibility.requirements.characterName}）`);
    if (compatibility.personaMismatch) incompatible.push(`用户内容（${compatibility.requirements.personaName}）`);
    if (compatibility.chatMismatch) incompatible.push('聊天绑定世界书');
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

    applying = true;
    try {
        const payload = snapshot.payload ?? {};
        // Opening greetings belong to the character card's greeting catalog,
        // not to a snapshot's version/switch state. Preserve them for manual
        // applications as well as automatic bindings, otherwise an older
        // version could silently overwrite (or remove) the first greeting
        // just before regex forces a chat reload.
        if (snapshot.scopes?.character && !compatibility.characterMismatch) await applySnapshotCharacterVersion(payload.character, { persist: persistCharacter, preserveGreetingCatalog: true });
        if (snapshot.scopes?.persona && !compatibility.personaMismatch) await applySnapshotPersonaVersion(payload.persona);
        if (snapshot.scopes?.worldInfo) await applyWorldInfo(payload.worldInfo, { excludedSources });
        if (snapshot.scopes?.preset) await applyPreset(payload.preset);
        if (snapshot.scopes?.regex) await applyRegex(payload.regex);
        saveSettingsDebounced();
        saveMetadataDebounced();
        if (!silent) toastr.success(`${incompatible.length ? '已应用兼容内容' : '已应用'}：${snapshot.name}`, '一键快照');
        return true;
    } catch (error) {
        console.error('[One-click Snapshot]', error);
        toastr.error(`应用失败：${error.message}`, '一键快照');
        return false;
    } finally {
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
    return matches;
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
    saveSettingsDebounced();
    toastr.success(`已绑定为“${character.name}”的角色默认快照。`, '一键快照');
    return true;
}

function unbindSnapshotFromCurrentCharacter(snapshotId) {
    const character = currentCharacter();
    if (!character?.avatar || settings().characterBindings[character.avatar]?.snapshotId !== snapshotId) return false;
    delete settings().characterBindings[character.avatar];
    saveSettingsDebounced();
    return true;
}

function toggleCurrentCharacterBinding(snapshotId) {
    const record = currentCharacterBinding();
    if (!record || record.snapshotId !== snapshotId) return false;
    record.enabled = record.enabled === false;
    saveSettingsDebounced();
    return true;
}

function greetingFingerprint(text) {
    const value = String(text ?? '').trim();
    let hash = 5381;
    for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function greetingCandidates(character = currentCharacter()) {
    if (!character) return [];
    const greetings = [{ key: 'first', label: '主开场白', text: String(character.first_mes ?? '') }];
    const alternates = Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings : [];
    alternates.forEach((text, index) => greetings.push({ key: `alternate:${index}`, label: `备选开场白 ${index + 1}`, text: String(text ?? '') }));

    // This order exactly follows SillyTavern's getFirstMessage(): when the
    // primary greeting is empty, it is removed before the swipe list exists.
    const effective = greetings[0].text ? greetings : greetings.slice(1);
    return effective.map((greeting, swipeIndex) => ({
        ...greeting,
        swipeIndex,
        fingerprint: greetingFingerprint(greeting.text),
    })).filter(greeting => greeting.text.trim());
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
    return Object.entries(settings().greetingBindings).flatMap(([avatar, records]) => {
        const character = characters.find(item => item?.avatar === avatar);
        const candidates = greetingCandidates(character);
        return Object.entries(records ?? {})
            .filter(([, record]) => record?.snapshotId === snapshotId)
            .map(([key, record]) => ({
                avatar,
                characterName: character?.name ?? avatar,
                key,
                label: record.label ?? candidates.find(candidate => candidate.key === key)?.label ?? '已变更的开场白',
                enabled: record.enabled !== false,
            }));
    });
}

async function chooseGreetingCandidate(character, { onlySnapshotId = null, title = '绑定开场白快照', confirmLabel = '确认绑定' } = {}) {
    const records = greetingBindingRecords(character);
    const candidates = greetingCandidates(character).filter(candidate => !onlySnapshotId || records[candidate.key]?.snapshotId === onlySnapshotId);
    if (!candidates.length) {
        toastr.warning(onlySnapshotId ? '当前角色没有可解绑的开场白。' : '当前角色还没有可绑定的开场白。', '一键快照');
        return null;
    }
    const root = $('<div class="ocs-greeting-choice"><label class="ocs-greeting-choice-label">开场白<select class="text_pole ocs-greeting-choice-select"></select></label><p class="ocs-greeting-choice-preview"></p></div>');
    const select = root.find('select');
    for (const candidate of candidates) {
        const preview = candidate.text.replace(/\s+/g, ' ').trim();
        select.append($('<option></option>').val(candidate.key).text(`${candidate.label}：${preview.slice(0, 42)}${preview.length > 42 ? '…' : ''}`));
    }
    const updatePreview = () => root.find('.ocs-greeting-choice-preview').text(candidates.find(candidate => candidate.key === select.val())?.text ?? '');
    select.on('change', updatePreview);
    updatePreview();
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
    saveSettingsDebounced();
    refreshVersionIndicators();
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
    refreshVersionIndicators();
}

async function setVersionGroup(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    const group = await Popup.show.input('移动到分组', '输入分组名称；留空为未分组。', version.group ?? '');
    if (group === null) return;
    version.group = group.trim();
    if (version.group && !versionGroups(type).includes(version.group)) versionGroups(type).push(version.group);
    pruneVersionGroups(type);
    version.updatedAt = Date.now();
    saveSettingsDebounced();
}

async function deleteVersion(type, versionId) {
    const context = versionContext(type);
    const version = context.list.find(item => item.id === versionId);
    if (!version) return;
    if (!await Popup.show.confirm(`删除${context.title}`, `删除“${version.name}”？已保存的快照不会受影响。`)) return;
    context.list.splice(context.list.findIndex(item => item.id === versionId), 1);
    if (type === 'character' && settings().activeCharacterVersions[currentCharacter()?.avatar] === versionId) delete settings().activeCharacterVersions[currentCharacter()?.avatar];
    if (type === 'persona' && settings().activePersonaVersions[user_avatar] === versionId) delete settings().activePersonaVersions[user_avatar];
    pruneVersionGroups(type);
    saveSettingsDebounced();
    refreshVersionIndicators();
}

function getVersionDescription(type, version) {
    return type === 'character' ? String(version.data?.description ?? '') : String(version.data?.descriptor?.description ?? '');
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
    preview.append($('<div class="ocs-version-preview-label"></div>').text(type === 'character' ? '角色描述' : '用户描述'));
    preview.append($('<p></p>').text(content || '（空白描述）'));
    return preview;
}

async function openVersionManager(type) {
    const context = versionContext(type);
    if (!context.capture()) return toastr.warning(`请先选择${type === 'character' ? '角色' : '用户人设'}。`, '一键快照');
    if (pruneVersionGroups(type)) saveSettingsDebounced();
    const root = $(`<div class="ocs-version-popup"><header><span class="ocs-kicker">VERSION LIBRARY</span><h3>${context.title}</h3><p>展开版本可查看和编辑描述；保存当前正在使用的版本会同步原生描述框，保存其他版本只更新版本本身。</p></header><div class="ocs-version-toolbar"><button class="ocs-button ocs-version-blank"><i class="fa-solid fa-plus"></i> 新建空白版本</button><button class="ocs-button ocs-version-copy"><i class="fa-solid fa-copy"></i> 另存当前描述</button><button class="ocs-button ocs-version-auto-sync"></button></div><div class="ocs-version-list"></div></div>`);
    const syncButton = root.find('.ocs-version-auto-sync');
    const renderAutoSyncButton = () => {
        const enabled = settings().autoSyncVersions === true;
        syncButton.toggleClass('ocs-auto-sync-enabled', enabled).html(`<i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> 自动同步：${enabled ? '开' : '关'}`).attr('title', '开启后，原生描述框的修改会自动保存到当前应用版本。');
    };
    syncButton.on('click', () => {
        settings().autoSyncVersions = !settings().autoSyncVersions;
        saveSettingsDebounced();
        renderAutoSyncButton();
    });
    const render = () => {
        const list = root.find('.ocs-version-list').empty();
        const fresh = versionContext(type);
        if (!fresh.list.length) list.append('<div class="ocs-empty">还没有版本。可新建空白版本，或把当前原生描述另存为版本。</div>');
        const grouped = new Map();
        for (const version of [...fresh.list].sort((a, b) => b.updatedAt - a.updatedAt)) {
            const group = version.group || '未分组';
            if (!grouped.has(group)) grouped.set(group, []);
            grouped.get(group).push(version);
        }
        const renderCards = versions => {
            const fragment = $('<div class="ocs-version-cards"></div>');
            for (const version of versions) {
                const card = $('<details class="ocs-version-card"></details>').toggleClass('ocs-active-version', fresh.current?.id === version.id).prop('open', fresh.current?.id === version.id);
                const summary = $('<summary></summary>');
                summary.append($('<strong></strong>').text(version.name), $('<small></small>').text(`更新于 ${new Date(version.updatedAt).toLocaleString()}`));
                card.append(summary, versionPreview(type, version));
                const actions = $('<div class="ocs-card-actions"></div>');
                if (fresh.current?.id === version.id && !versionDataEquals(type, version.data, captureVersionFormState(type))) {
                    card.append($('<div class="ocs-version-change-state"></div>').text('原生描述已更改'));
                    actions.append($('<button class="ocs-button ocs-primary">更新</button>').on('click', async () => { await updateCurrentVersion(type); render(); }));
                }
                actions.append($('<button class="ocs-button">展开编辑</button>').on('click', async () => { await openVersionDescriptionEditor(type, version); render(); }));
                actions.append($('<button class="ocs-button">应用</button>').on('click', async () => { await applyVersion(type, version.id); render(); }));
                actions.append($('<button class="ocs-button">重命名</button>').on('click', async () => { await renameVersion(type, version.id); render(); }));
                actions.append($('<button class="ocs-button">分组</button>').on('click', async () => { await setVersionGroup(type, version.id); render(); }));
                actions.append($('<button class="ocs-button ocs-danger">删除</button>').on('click', async () => { await deleteVersion(type, version.id); render(); }));
                card.append(actions); fragment.append(card);
            }
            return fragment;
        };
        const hasGroups = versionGroups(type).length > 0 || fresh.list.some(version => version.group);
        if (!hasGroups) list.append(renderCards([...fresh.list].sort((a, b) => b.updatedAt - a.updatedAt)));
        else for (const [group, versions] of grouped) list.append($('<details class="ocs-snapshot-group" open></details>').append($('<summary></summary>').text(`${group} · ${versions.length}`), renderCards(versions)));
    };
    root.find('.ocs-version-blank').on('click', async () => { await createBlankVersion(type); render(); });
    root.find('.ocs-version-copy').on('click', async () => { await saveCurrentAsVersion(type); render(); });
    const nativeSelector = type === 'character' ? '#description_textarea, #personality_textarea, #scenario_pole, #firstmessage_textarea, #mes_example_textarea' : '#persona_description';
    $(nativeSelector).off('input.oneClickSnapshotVersion').on('input.oneClickSnapshotVersion', render);
    const autoSyncRenderHandler = (_, syncedType) => {
        if (syncedType === type) render();
    };
    $(document).on('oneClickSnapshotVersionAutoSynced.oneClickSnapshotVersionUi', autoSyncRenderHandler);
    renderAutoSyncButton();
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

function scopeBadges(snapshot) {
    const badges = $('<div class="ocs-scope-badges"></div>');
    const scopes = snapshot.scopes ?? {};
    if (scopes.character) badges.append('<span>角色</span>');
    if (scopes.persona) badges.append('<span>用户</span>');
    if (scopes.worldInfo) badges.append('<span>世界书</span>');
    if (scopes.preset) badges.append('<span>预设</span>');
    if (scopes.regex) badges.append('<span>正则</span>');
    return badges;
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
    const group = await Popup.show.input('移动到分组', '输入分组名称；留空可移到“未分组”。', snapshot.group ?? '');
    if (group === null) return;
    snapshot.group = group.trim();
    if (snapshot.group && !settings().snapshotGroups.includes(snapshot.group)) settings().snapshotGroups.push(snapshot.group);
    pruneSnapshotGroups();
    snapshot.updatedAt = Date.now();
    saveSettingsDebounced();
}

async function showSnapshotContents(snapshot) {
    const payload = snapshot.payload ?? {};
    const root = $('<div class="ocs-contents-popup"></div>');
    root.append($('<header><span class="ocs-kicker">快照内容</span></header>'));
    root.append($('<h3></h3>').text(snapshot.name));
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
        appendBookEntries(bookNode, enabled, livePtGroups);
        return bookNode;
    };
    if (snapshot.scopes?.character) {
        const name = payload.character?.data?.name ?? '未知角色';
        const version = payload.character?.versionName ?? '当前未命名状态';
        root.append($('<div class="ocs-version-value"><span>角色版本</span><strong></strong></div>').find('strong').text(`${name} · ${version}`).end());
    }
    if (snapshot.scopes?.persona) {
        const name = payload.persona?.data?.name ?? '未知用户';
        const version = payload.persona?.versionName ?? '当前未命名状态';
        root.append($('<div class="ocs-version-value"><span>用户版本</span><strong></strong></div>').find('strong').text(`${name} · ${version}`).end());
    }
    if (snapshot.scopes?.worldInfo) {
        const section = makeDrawer('ocs-content-section ocs-content-world', '世界书与启用条目');
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
        root.append(section);
    }
    if (snapshot.scopes?.preset) {
        const presetLabel = `${payload.preset?.api ?? ''} · ${payload.preset?.presetName ?? '未选择预设'}`;
        const manager = getPresetManager();
        const selectedPreset = manager?.getCompletionPresetByName?.(payload.preset?.presetName);
        const livePromptGroups = getPresetPromptGroups(SillyTavern.getContext().chatCompletionSettings, selectedPreset);
        const usePresetGroups = Boolean(presetGroupingProvider());
        const nodes = [];
        const groups = new Map();
        const enabledEntries = (payload.preset?.promptEntries ?? []).filter(entry => entry.enabled);
        const entriesDrawer = makeDrawer('ocs-content-section ocs-content-preset', '预设与启用条目', presetLabel);
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
        root.append(entriesDrawer);
    }
    if (snapshot.scopes?.regex) {
        const sources = payload.regex?.sources ?? {};
        const section = makeDrawer('ocs-content-section ocs-content-regex', '正则与启用规则');
        const body = drawerBody(section);
        const labels = [
            ['global', '全局正则'],
            ['scoped', '角色局部正则'],
            ['preset', '当前预设正则'],
        ];
        for (const [key, title] of labels) {
            const source = sources[key];
            if (!source) continue;
            const enabled = (source.scripts ?? []).filter(script => script.enabled).map(script => script.label || script.id);
            // Regex categories are source markers, like worldbook sources;
            // keep their children behind the same optional disclosure layer.
            const drawer = makeDrawer('ocs-content-source ocs-content-regex-source', title, `${enabled.length} 条`);
            drawerBody(drawer).append(itemList(enabled));
            body.append(drawer);
        }
        root.append(section);
    }
    await showOcsPopup(root);
}

function renderSnapshotList(root) {
    const expandedGroups = new Set(root.find('.ocs-snapshot-group[open]').toArray().map(element => element.dataset.ocsGroup));
    const list = root.find('.ocs-snapshot-list').empty();
    const filter = String(root.find('.ocs-library-filter').val() ?? '__all__');
    const snapshots = [...settings().snapshots]
        .filter(snapshot => filter === '__all__' || (snapshot.group ?? '') === filter)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!snapshots.length) return list.append('<div class="ocs-empty">这个分组还没有快照。</div>');
    const grouped = new Map();
    for (const snapshot of snapshots) {
        const group = snapshot.group || '未分组';
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(snapshot);
    }
    const renderCards = (items) => {
        const cards = $('<div class="ocs-snapshot-cards"></div>');
        for (const snapshot of items) {
            const isBound = binding().snapshotId === snapshot.id;
            const characterBindings = snapshotCharacterBindings(snapshot.id);
            const greetingBindings = snapshotGreetingBindings(snapshot.id);
            const currentCharacterDefault = currentCharacterBinding()?.snapshotId === snapshot.id;
            const currentGreetingBindings = greetingBindings.filter(item => item.avatar === currentCharacter()?.avatar);
            const card = $('<article class="ocs-snapshot-card"></article>').toggleClass('ocs-bound', isBound || characterBindings.length > 0);
            const cardHeader = $('<div class="ocs-card-header"></div>');
            cardHeader.append($('<h4></h4>').text(snapshot.name));
            card.append(cardHeader);
            card.append($('<time></time>').text(`更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`));
            card.append(scopeBadges(snapshot));
            const boundChats = snapshotChatBindings(snapshot.id);
            if (boundChats.length) {
                const currentChat = currentChatReference();
                const labels = boundChats.map(chat => `${chat.name}${isBound && binding().enabled === false && chat.id === currentChat?.id ? '（已停用）' : ''}`);
                card.append($('<p class="ocs-bound-chats"></p>').text(`已绑定：${labels.join('、')}`));
            }
            if (characterBindings.length) {
                const labels = characterBindings.map(item => `${item.name}${item.enabled ? '' : '（已停用）'}`);
                card.append($('<p class="ocs-bound-chats"></p>').text(`角色默认：${labels.join('、')}`));
            }
            if (greetingBindings.length) {
                const labels = greetingBindings.map(item => `${item.characterName} · ${item.label}${item.enabled ? '' : '（已停用）'}`);
                card.append($('<p class="ocs-bound-chats"></p>').text(`开场白：${labels.join('、')}`));
            }
            const actions = $('<div class="ocs-card-actions"></div>');
            actions.append($('<button class="ocs-button">应用</button>').on('click', () => applySnapshot(snapshot)));
            actions.append($('<button class="ocs-button">查看内容</button>').on('click', () => showSnapshotContents(snapshot)));
            actions.append($('<button class="ocs-button">更新</button>').on('click', async () => { await updateSnapshot(snapshot); renderSnapshotList(root); }));
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
                actions.append($(`<button class="ocs-button">${enabled ? '停用角色应用' : '启用角色应用'}</button>`).on('click', () => {
                    if (toggleCurrentCharacterBinding(snapshot.id)) renderSnapshotList(root);
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
                settings().snapshots = settings().snapshots.filter(item => item.id !== snapshot.id);
                if (binding().snapshotId === snapshot.id) binding().snapshotId = null;
                delete settings().snapshotBindings[snapshot.id];
                for (const [avatar, record] of Object.entries(settings().characterBindings)) {
                    if (record?.snapshotId === snapshot.id) delete settings().characterBindings[avatar];
                }
                for (const [avatar, records] of Object.entries(settings().greetingBindings)) {
                    for (const [key, record] of Object.entries(records ?? {})) {
                        if (record?.snapshotId === snapshot.id) delete settings().greetingBindings[avatar][key];
                    }
                    if (!Object.keys(settings().greetingBindings[avatar] ?? {}).length) delete settings().greetingBindings[avatar];
                }
                pruneSnapshotGroups();
                saveSettingsDebounced(); saveMetadataDebounced(); renderGroups(root); renderSnapshotList(root);
            }));
            card.append(actions); cards.append(card);
        }
        return cards;
    };
    // A selected group is already an explicit category. Showing a second
    // collapsible header around it only wastes space, particularly on mobile.
    // The expandable group overview belongs exclusively to “全部分组”.
    const hasNamedGroups = settings().snapshotGroups.length > 0 || snapshots.some(snapshot => snapshot.group);
    if (filter !== '__all__' || !hasNamedGroups) {
        list.append(renderCards(snapshots));
        return;
    }
    for (const [group, items] of grouped) {
        const section = $('<details class="ocs-snapshot-group"></details>');
        section.attr('data-ocs-group', group).prop('open', expandedGroups.has(group));
        section.append($('<summary></summary>').text(`${group} · ${items.length}`));
        section.append(renderCards(items));
        list.append(section);
    }
}

function renderGroups(root) {
    fillGroupSelect(root.find('.ocs-capture-group'));
    fillGroupSelect(root.find('.ocs-library-filter'), { all: true });
}

async function openSnapshotPopup() {
    await pruneMissingCharacterChatBindings();
    if (pruneSnapshotGroups()) saveSettingsDebounced();
    const root = $(
        `<div class="ocs-popup">
            <header class="ocs-popup-header"><div><span class="ocs-kicker">SNAPSHOT LIBRARY</span><h3>一键快照</h3></div></header>
            <div class="ocs-workspace">
                <section class="ocs-capture">
                    <h4>保存当前状态</h4>
                    <label class="ocs-field-label" for="ocs-snapshot-name">名称<input id="ocs-snapshot-name" class="text_pole ocs-name" placeholder="例如：现代版"></label>
                    <label class="ocs-field-label" for="ocs-snapshot-group">分组<select id="ocs-snapshot-group" class="text_pole ocs-capture-group"></select></label>
                    <div class="ocs-scope-grid">
                        <label class="checkbox_label ocs-scope" for="ocs-scope-character"><input id="ocs-scope-character" type="checkbox" value="character" data-snapshot-scope checked>角色版本</label>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-persona"><input id="ocs-scope-persona" type="checkbox" value="persona" data-snapshot-scope checked>用户版本</label>
                        <div class="ocs-world-scope is-enabled"><label class="checkbox_label ocs-scope" for="ocs-scope-world"><input id="ocs-scope-world" type="checkbox" value="worldInfo" data-snapshot-scope checked>世界书与条目</label><div class="ocs-world-sources"><label class="checkbox_label ocs-scope" for="ocs-world-global"><input id="ocs-world-global" type="checkbox" value="global" checked>全局世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-char-main"><input id="ocs-world-char-main" type="checkbox" value="characterMain" checked>角色主世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-char-extra"><input id="ocs-world-char-extra" type="checkbox" value="characterExtra" checked>角色附加世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-user"><input id="ocs-world-user" type="checkbox" value="user" checked>用户绑定世界书</label><label class="checkbox_label ocs-scope" for="ocs-world-chat"><input id="ocs-world-chat" type="checkbox" value="chat" checked>聊天世界书</label></div></div>
                        <label class="checkbox_label ocs-scope" for="ocs-scope-preset"><input id="ocs-scope-preset" type="checkbox" value="preset" data-snapshot-scope checked>预设与条目</label>
                        <div class="ocs-world-scope is-enabled ocs-regex-scope"><label class="checkbox_label ocs-scope" for="ocs-scope-regex"><input id="ocs-scope-regex" type="checkbox" value="regex" data-snapshot-scope checked>正则规则</label><div class="ocs-world-sources"><label class="checkbox_label ocs-scope" for="ocs-regex-global"><input id="ocs-regex-global" type="checkbox" value="global" checked>全局正则</label><label class="checkbox_label ocs-scope" for="ocs-regex-scoped"><input id="ocs-regex-scoped" type="checkbox" value="scoped" checked>角色局部正则</label><label class="checkbox_label ocs-scope" for="ocs-regex-preset"><input id="ocs-regex-preset" type="checkbox" value="preset" checked>当前预设正则</label></div></div>
                    </div>
                    <button class="ocs-button ocs-primary ocs-capture-button"><i class="fa-solid fa-camera"></i> 保存快照</button>
                </section>
                <section class="ocs-library"><div class="ocs-library-heading"><div><h4>快照库</h4></div><select class="text_pole ocs-library-filter"></select></div><div class="ocs-snapshot-list"></div></section>
            </div>
        </div>`);
    const applyCaptureScopeSelection = () => {
        const saved = settings().lastCaptureScopes;
        root.find('input[data-snapshot-scope]').each((_, input) => {
            input.checked = saved[input.value] === true;
        });
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
    registerQrAssistantShortcut();
    const existing = document.getElementById('one_click_snapshot_qr');
    const bar = document.getElementById('qr--bar');
    if (!bar) return;
    if (existing && existing.closest('#qr--bar') === bar) return;
    existing?.remove();

    // Quick Reply renders groups as .qr--buttons. Keeping this tiny isolated
    // group makes the injected action inherit QR's native colors, density,
    // icon/label behavior, and does not mutate any user-created QR set.
    const group = document.createElement('div');
    group.className = 'qr--buttons ocs-qr-shortcut-set';
    const button = document.createElement('div');
    button.id = 'one_click_snapshot_qr';
    button.className = 'qr--button menu_button';
    button.title = '打开一键快照';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.innerHTML = '<div class="qr--button-icon fa-solid fa-camera"></div><div class="qr--button-label">一键快照</div>';
    button.addEventListener('click', openSnapshotPopup);
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSnapshotPopup();
        }
    });
    group.append(button);
    bar.append(group);
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
        await applySnapshot(snapshot, { skipMismatchPrompt: true, persistCharacter: false, preserveGreetingCatalog: true });
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
    if (syncStoredSnapshotVersionNames()) saveSettingsDebounced();
    registerQrAssistantShortcut();
    installQrShortcut();
    installVersionMenu();
    installVersionAutoSync();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_RENAMED, updateChatBindingAfterRename);
    eventSource.on(event_types.GENERATION_STARTED, applyGreetingSnapshotBeforeGeneration);
    eventSource.on(event_types.MESSAGE_SWIPED, applyGreetingSnapshotAfterSwipe);
    eventSource.on(event_types.MESSAGE_RECEIVED, promoteGreetingSnapshotAfterReply);
    eventSource.on(event_types.GENERATION_STOPPED, markGreetingGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(refreshVersionIndicators, 0));
    // Chat-bound / character-bound personas are selected asynchronously after
    // CHAT_CHANGED. Refresh again once SillyTavern has finished selecting the
    // actual persona, otherwise the previous chat's version label can linger.
    eventSource.on(event_types.PERSONA_CHANGED, refreshVersionIndicators);
    setTimeout(refreshVersionIndicators, 0);
    console.log('[One-click Snapshot] ready');
});
