/**
 * 功能设置 / Feature settings
 *
 * One registry describing every optional behaviour, plus the block that edits
 * it inside SillyTavern's Extensions page. Features are addressed by dotted key
 * and read through `feature()`, so a call site never has to know where the
 * value is stored or what its default is.
 *
 * Only things worth switching off appear here. Behaviour that is simply part of
 * a feature — the version avatar picker, greeting-to-snapshot binding, keeping
 * snapshots pointed at a renamed theme — is not a setting.
 *
 * Every switch takes effect immediately: the extension installs its hooks once
 * and they consult `feature()` on each call, so nothing needs a reload.
 */
import { saveSettingsDebounced } from '../../../../script.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

/**
 * @typedef {object} FeatureNode
 * @property {string} key Dotted identifier, also the storage key
 * @property {string} label Shown in the panel
 * @property {string} [note] One short line under the label
 * @property {boolean} [default=true] Value when nothing is stored yet
 * @property {FeatureNode[]} [children] Sub-settings, revealed only while the parent is on
 */

/**
 * The five features, each with a master switch.
 *
 * A sub-setting only exists where there is a real choice to make — one that
 * changes what happens to the user's data. Anything that is simply part of the
 * feature working (the version avatar picker, greeting-to-snapshot binding,
 * persona bulk actions, the regex expand buttons) is not a setting, and the
 * two version sync switches already live in the version manager where they
 * are used.
 *
 * @type {FeatureNode[]}
 */
export const FEATURES = [
    {
        key: 'snapshot',
        label: '状态快照',
        note: '把当前的角色、用户、预设、世界书、正则等状态整套存下来，之后一键还原。',
        children: [
            {
                key: 'snapshot.askScope',
                label: '更新时询问范围',
                note: '更新时先让你挑这次要刷新哪些范围，没挑的保持原样。\n\n用来只更新快照里的一部分——比如快照存了世界书和预设，你只想把世界书换成现在的，预设照旧。',
                children: [
                    {
                        key: 'snapshot.askScopeOnUpdate',
                        label: '单个更新时询问范围',
                        note: '更新单个快照时，先列出它现在记录的范围，你挑哪些就刷新哪些。\n\n想增减这个快照记录的范围本身，去快照卡片上改。',
                        default: false,
                    },
                    {
                        key: 'snapshot.askScopeOnBatch',
                        label: '批量更新时询问范围',
                        note: '更新多个快照时，先列出可选的范围，你挑哪些就给这批快照刷新哪些。\n\n默认只列出这些快照已经记录过的范围——只要其中任意一个包含某个范围，它就会出现。',
                        children: [
                            {
                                key: 'snapshot.addMissingScope',
                                label: '允许给快照补上新范围',
                                note: '决定批量更新能不能改变快照记录的范围。\n\n关闭：只更新本来就包含所选范围的快照，其余跳过。\n\n开启：缺少所选范围的快照会补上该范围，并录入当前状态。\n\n范围列表里每行右侧的数字，是已包含该范围的快照数。',
                                default: false,
                            },
                        ],
                    },
                ],
            },
        ],
    },
    {
        key: 'version',
        label: 'U/C多版本',
        note: '给同一个角色或用户保存多套人设，随时切换。',
        children: [
            {
                key: 'version.autoInitial',
                label: '保存快照时自动建初始版本',
                note: '快照勾了「角色版本」或「用户版本」，但当前角色 / 用户还没有任何版本时，自动按现在的描述建一个叫「初始版本」的版本，并让快照指向它。\n\n关闭的话，这种情况下快照虽然勾了这个范围，实际什么都没记住，应用时也不会还原描述——需要先去「更多 → 管理版本」手动建一个。',
                default: false,
            },
        ],
    },
    { key: 'greeting', label: '开场白管理', note: '在酒馆的开场白编辑面板里加上搜索、分组、拖拽排序和批量操作。' },
    { key: 'persona', label: 'User标签管理', note: '将原生标签管理系统注入用户管理之中。' },
    {
        key: 'native',
        label: '原生小优化',
        children: [
            { key: 'native.regexMaximize', label: '正则字段展开按钮', note: '「替换为」和「修剪掉」旁边多一个展开按钮，长内容可以全屏编辑。' },
            { key: 'native.characterBulkButtons', label: '角色卡批量操作入口', note: '批量模式下，把右键菜单里的收藏、标签、复制、转为用户做成看得见的按钮。' },
            {
                key: 'native.quietMacroAutocomplete',
                label: '预设里不自动弹宏提示',
                note: '在预设条目的提示词框里写 {{setvar::}} 这类宏时，酒馆会自动弹出补全和说明，挡住正在写的内容。\n\n开启后，输入框里改为跟随用户设置里的「Show in all macro fields」，按 Ctrl+Space 仍可手动调出补全；点展开按钮进入的全屏编辑器里则完全不弹。',
            },
        ],
    },
];

/** Flat lookup, so `feature()` stays O(1) and defaults live in one place. */
const NODES = new Map();
const indexNodes = (nodes, parentKey = null) => {
    for (const node of nodes) {
        NODES.set(node.key, { ...node, parentKey });
        if (node.children) indexNodes(node.children, node.key);
    }
};
indexNodes(FEATURES);

/** @type {(() => object)|null} */
let settingsAccessor = null;

/** @type {((key: string, value: boolean) => void)[]} */
const changeHandlers = [];

/**
 * Registers a callback for switch changes, so the parts that can be applied
 * without a reload are applied immediately.
 * @param {(key: string, value: boolean) => void} handler Called after the value is stored
 */
export function onFeatureChange(handler) {
    changeHandlers.push(handler);
}

function store() {
    const root = settingsAccessor();
    root.features ??= {};
    return root.features;
}

/**
 * Whether a feature is on. A child is only on when its ancestors are too, so
 * call sites can test the leaf alone.
 *
 * @param {string} key Dotted feature key
 * @returns {boolean}
 */
export function feature(key) {
    const node = NODES.get(key);
    if (!node) {
        console.warn('[One-click Snapshot] unknown feature key', key);
        return true;
    }
    if (node.parentKey && !feature(node.parentKey)) return false;

    const stored = store()[key];
    return typeof stored === 'boolean' ? stored : node.default !== false;
}

/**
 * @param {string} key Dotted feature key
 * @param {boolean} value Desired state
 */
export function setFeature(key, value) {
    store()[key] = Boolean(value);
    saveSettingsDebounced();
    for (const handler of changeHandlers) {
        try {
            handler(key, Boolean(value));
        } catch (error) {
            console.error('[One-click Snapshot] feature change handler failed', error);
        }
    }
}

/**
 * Installs the accessor. Called once, before anything reads a feature.
 * @param {() => object} getSettings Accessor for the extension settings root
 */
export function initFeatures(getSettings) {
    settingsAccessor = getSettings;

    // Drop values left behind by earlier versions of the registry. They are
    // inert, but settings.json is shared with everything else in SillyTavern
    // and there is no reason to carry dead keys in it forever.
    const values = store();
    const stale = Object.keys(values).filter(key => !NODES.has(key));
    if (!stale.length) return;

    for (const key of stale) delete values[key];
    console.info('[One-click Snapshot] removed stale feature keys', stale);
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ panel -- */

/** Ids let the name act as the switch's label without wrapping the whole row. */
function inputId(key) {
    return `ocs-f-${key.replace(/\./g, '-')}`;
}

/**
 * Builds the name plus, when there is something to explain, an info dot.
 *
 * The dot is deliberately a sibling of the name rather than sitting inside a
 * row-wide label: with the whole row acting as the switch's label, every tap
 * near the text toggles it, and an info button in that area is a mis-tap
 * waiting to happen. Name and switch toggle; the dot only opens the note.
 *
 * @param {FeatureNode} node Feature or sub-setting
 * @param {string} nameClass Class for the name element
 * @returns {JQuery<HTMLElement>}
 */
function renderLabel(node, nameClass) {
    const wrap = $('<span class="ocs-label"></span>');
    wrap.append($('<label></label>').addClass(nameClass).attr('for', inputId(node.key)).text(node.label));
    if (!node.note) return wrap;

    // A real <button> for keyboard and screen readers, with the icon nested so
    // Font Awesome keeps its own font-family — putting the classes on the
    // button itself would lose them to `font: inherit`.
    const info = $('<button type="button" class="ocs-info" aria-label="说明"><i class="fa-solid fa-circle-info"></i></button>');
    info.on('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void callGenericPopup($('<div class="ocs-info-body"></div>').text(node.note), POPUP_TYPE.TEXT);
    });
    wrap.append(info);
    return wrap;
}

/**
 * One sub-setting: a checkbox, its name, and an optional info dot. Sub-settings
 * of a sub-setting nest one level further and follow the same reveal rule.
 */
function renderChild(node) {
    const row = $('<div class="ocs-sub"></div>');
    const head = $('<div class="ocs-sub-head"></div>');
    const input = $('<input type="checkbox">').attr('id', inputId(node.key)).prop('checked', feature(node.key));
    head.append(input, renderLabel(node, 'ocs-sub-name'));
    row.append(head);

    if (node.children?.length) {
        // One inner wrapper, always: the 0fr/1fr collapse only sizes the first
        // grid row, so several direct children would each land in an implicit
        // auto row and keep their height while the parent fades out.
        const nested = $('<div class="ocs-collapse ocs-sub-nest"></div>').toggleClass('is-open', feature(node.key));
        const inner = $('<div class="ocs-collapse-inner"></div>');
        for (const child of node.children) inner.append(renderChild(child));
        nested.append(inner);
        row.append(nested);
        input.on('change', function () {
            setFeature(node.key, this.checked);
            nested.toggleClass('is-open', this.checked);
        });
        return row;
    }

    input.on('change', function () {
        setFeature(node.key, this.checked);
    });
    return row;
}

/** One feature: a master switch, and the sub-settings it reveals. */
function renderFeature(node) {
    const enabled = feature(node.key);
    const block = $('<section class="ocs-feat"></section>').toggleClass('is-on', enabled);

    const head = $('<div class="ocs-feat-head"></div>');
    const text = $('<span class="ocs-feat-text"></span>');
    text.append(renderLabel(node, 'ocs-feat-name'));

    // A track-and-thumb switch for the master, plain checkboxes for the
    // sub-settings: the shape difference carries the hierarchy on its own,
    // without needing headings or boxes.
    const control = $('<span class="ocs-switch"></span>');
    const input = $('<input type="checkbox">').attr('id', inputId(node.key)).prop('checked', enabled);
    control.append(input, '<span class="ocs-switch-track"><span class="ocs-switch-thumb"></span></span>');
    head.append(text, control);
    block.append(head);

    if (node.children?.length) {
        const body = $('<div class="ocs-collapse ocs-feat-body"></div>').toggleClass('is-open', enabled);
        const inner = $('<div class="ocs-collapse-inner"></div>');
        for (const child of node.children) inner.append(renderChild(child));
        body.append(inner);
        block.append(body);
        input.on('change', function () {
            setFeature(node.key, this.checked);
            block.toggleClass('is-on', this.checked);
            body.toggleClass('is-open', this.checked);
        });
        return block;
    }

    input.on('change', function () {
        setFeature(node.key, this.checked);
        block.toggleClass('is-on', this.checked);
    });
    return block;
}

/**
 * Adds the settings block to SillyTavern's Extensions page.
 *
 * A stock `inline-drawer`, so it sits in the extension list like every other
 * entry and its open/close is handled by SillyTavern's delegated handler.
 */
export function installFeatureSettings() {
    const host = $('#extensions_settings2');
    if (!host.length) return;

    if (!$('#ocs_feature_settings').length) {
        const drawer = $(
            '<div id="ocs_feature_settings" class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header"><b>一键快照</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content"><div class="ocs-settings"></div></div>' +
            '</div>',
        );

        const panel = drawer.find('.ocs-settings');
        for (const node of FEATURES) panel.append(renderFeature(node));
        host.append(drawer);
    }

    watchHost(host[0]);
}

/** @type {MutationObserver|null} */
let hostObserver = null;

/**
 * Puts the block back if it ever leaves the Extensions page.
 *
 * It has been seen to go missing when that page is opened while SillyTavern is
 * still starting up. Nothing in SillyTavern empties the container, and the
 * extension that does render into it only appends, so rather than pin the
 * blame the block is simply restored whenever it is gone -- rebuilding it is
 * cheap and reads the current values, so a restored block is never stale.
 *
 * @param {HTMLElement} host The container the block lives in
 */
function watchHost(host) {
    if (hostObserver) return;

    hostObserver = new MutationObserver(() => {
        // Our own append re-enters here and finds the block present, so this
        // settles after one extra pass rather than looping.
        if (!$('#ocs_feature_settings').length) installFeatureSettings();
    });
    hostObserver.observe(host, { childList: true });
}
