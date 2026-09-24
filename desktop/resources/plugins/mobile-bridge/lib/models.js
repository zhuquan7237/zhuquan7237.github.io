/**
 * The shared model-configuration document: one list both ends edit, with an
 * explicit owner for every field and a merge rule that never overwrites silently.
 *
 * Two layers, because the engine's own configuration genuinely has two:
 *
 *   1. The engine's `llm-pi-ai` namespace owns what the engine needs — providers,
 *      their endpoint/api-mode/key reference, and each model's params. Its
 *      `baseURL`, `api` and `apiKeyEnv` are **provider-level**: every model of one
 *      provider shares them. The phone shows them per row, so this module says so
 *      out loud instead of pretending each model has its own endpoint.
 *   2. The overlay owns what the engine has no field for: a display name, enabled
 *      state, tags and ordering. Inventing keys inside the engine's namespace would
 *      be rejected by its schema, so they live in the bridge's own document.
 *
 * Writes carry the revision the caller last saw. The engine enforces the same idea
 * with `expectedRevision`, and this module adds the layer above it: changes to
 * *different* fields merge, changes to the *same* field stop and are reported.
 *
 * @module @dsh-desktop/dsh-mobile-bridge/models
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
/** Stable identity for one provider's model. */
export function modelId(provider, model) {
    return `${provider}::${model}`;
}
/** Split an identity back into its parts. */
export function splitModelId(id) {
    const at = id.indexOf('::');
    return at < 0 ? { provider: '', modelId: id } : { provider: id.slice(0, at), modelId: id.slice(at + 2) };
}
/** Field equality that is order-insensitive for modality lists. */
export function sameFieldValue(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        const left = [...a].map(String).sort();
        const right = [...b].map(String).sort();
        return left.every((value, index) => value === right[index]);
    }
    if (isRecord(a) && isRecord(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys)
            if (!sameFieldValue(a[key], b[key]))
                return false;
        return true;
    }
    return false;
}
/**
 * Build the document the phone reads.
 *
 * @param namespaceView - `settings.describe`'s `llm-pi-ai` namespace view.
 * @param overlay - bridge-owned metadata.
 * @param keyConfigured - which credential references currently resolve.
 * @param now - clock, injectable for tests.
 * @returns the shared document.
 */
export function buildDoc(namespaceView, overlay, keyConfigured = {}, now = Date.now(), network = {}) {
    const value = isRecord(namespaceView?.value) ? namespaceView?.value : {};
    const providers = isRecord(value.providers) ? value.providers : {};
    const disabled = new Set(overlay.disabled ?? []);
    const items = [];
    const providerRows = [];
    for (const [provider, rawProvider] of Object.entries(providers)) {
        if (!isRecord(rawProvider))
            continue;
        const baseURL = text(rawProvider.baseURL);
        const apiMode = text(rawProvider.api);
        const apiKeyRef = text(rawProvider.apiKeyEnv);
        const providerName = text(rawProvider.displayName);
        const configured = apiKeyRef !== undefined ? keyConfigured[apiKeyRef] === true : true;
        providerRows.push({
            id: provider,
            ...(providerName !== undefined ? { name: providerName } : {}),
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...(apiMode !== undefined ? { apiMode } : {}),
            ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
            apiKeyConfigured: configured,
            // 网络路由：direct/proxy；null = 自动（默认走代理）
            network: network[provider] ?? null,
        });
        const models = Array.isArray(rawProvider.models) ? rawProvider.models : [];
        let index = 0;
        for (const rawModel of models) {
            if (!isRecord(rawModel))
                continue;
            const model = text(rawModel.id) ?? text(rawModel.model);
            if (model === undefined)
                continue;
            const id = modelId(provider, model);
            const params = {};
            for (const [key, fieldValue] of Object.entries(rawModel)) {
                if (key === 'id' || key === 'model')
                    continue;
                params[key] = fieldValue;
            }
            items.push({
                id,
                provider,
                ...(providerName !== undefined ? { providerName } : {}),
                ...(baseURL !== undefined ? { baseURL } : {}),
                ...(apiMode !== undefined ? { apiMode } : {}),
                ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
                apiKeyConfigured: configured,
                modelId: model,
                ...(overlay.names?.[id] !== undefined ? { name: overlay.names[id] } : {}),
                params,
                enabled: !disabled.has(id),
                tags: overlay.tags?.[id] ?? [],
                order: overlay.order?.[id] ?? index,
            });
            index += 1;
        }
    }
    items.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
    return {
        revision: typeof namespaceView?.revision === 'number' ? namespaceView.revision : 0,
        overlayRevision: overlay.revision,
        updatedAt: new Date(now).toISOString(),
        providers: providerRows,
        items,
    };
}
/** Comparable view of one item's fields, for diffing. */
export function itemFields(item) {
    return {
        provider: item.provider,
        baseURL: item.baseURL ?? null,
        apiMode: item.apiMode ?? null,
        apiKeyRef: item.apiKeyRef ?? null,
        modelId: item.modelId,
        name: item.name ?? null,
        enabled: item.enabled,
        tags: [...item.tags].sort(),
        order: item.order,
        params: item.params,
    };
}
/**
 * Field-level comparison of two documents.
 *
 * @param base - what the caller last saw.
 * @param against - the other revision (desktop's current document).
 * @returns one entry per changed field per item.
 */
export function diffDocs(base, against) {
    const left = new Map(base.map((item) => [item.id, item]));
    const right = new Map(against.map((item) => [item.id, item]));
    const out = [];
    for (const id of new Set([...left.keys(), ...right.keys()])) {
        const a = left.get(id);
        const b = right.get(id);
        if (a === undefined || b === undefined) {
            out.push({ id, field: a === undefined ? 'added' : 'removed', theirs: b ?? null, ours: a ?? null });
            continue;
        }
        const fa = itemFields(a);
        const fb = itemFields(b);
        for (const field of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
            if (!sameFieldValue(fa[field], fb[field]))
                out.push({ id, field, theirs: fb[field], ours: fa[field] });
        }
    }
    return out;
}
/**
 * Merge a phone's edit onto the desktop's current document.
 *
 * @param base - the document revision the phone edited.
 * @param theirs - the desktop's current document.
 * @param ours - the phone's version of the document.
 * @returns conflicts (same field, different values), plus what can be applied.
 */
export function mergeDocs(base, theirs, ours) {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const theirsById = new Map(theirs.map((item) => [item.id, item]));
    const oursById = new Map(ours.map((item) => [item.id, item]));
    const desktopChanged = diffDocs(base, theirs);
    const phoneChanged = diffDocs(base, ours);
    const key = (diff) => `${diff.id}\\u0000${diff.field}`;
    const desktopKeys = new Map(desktopChanged.map((diff) => [key(diff), diff]));
    const conflicts = [];
    const applied = [];
    for (const diff of phoneChanged) {
        const other = desktopKeys.get(key(diff));
        if (other === undefined) {
            applied.push(diff);
            continue;
        }
        if (sameFieldValue(other.theirs, diff.ours)) {
            // Both ends set the same value: agreement, not a conflict.
            continue;
        }
        conflicts.push({ id: diff.id, field: diff.field, theirs: other.theirs, ours: diff.ours });
    }
    const incoming = desktopChanged.filter((diff) => {
        const mine = phoneChanged.find((candidate) => key(candidate) === key(diff));
        return mine === undefined;
    });
    void baseById;
    void theirsById;
    void oursById;
    return { merged: conflicts.length === 0, conflicts, applied, incoming };
}
/**
 * Path ops that write the engine-owned half of a document.
 *
 * Arrays are always rewritten whole: the settings path walker never indexes into
 * an array, so `providers.<p>.models` is replaced as one value and a per-row
 * `models[n]` op would be silently ignored.
 *
 * @param current - the desktop's current document.
 * @param next - the document the phone wants.
 * @returns ops for `settings.mutate` covering only what the engine owns.
 */
export function engineOps(current, next) {
    const ops = [];
    const currentItems = new Map(current.items.map((item) => [item.id, item]));
    const nextItems = new Map(next.items.map((item) => [item.id, item]));
    for (const provider of new Set([...next.items.map((item) => item.provider), ...current.items.map((item) => item.provider)])) {
        const rows = next.items.filter((item) => item.provider === provider);
        const before = current.items.filter((item) => item.provider === provider);
        const providerFieldsChanged = rows.some((row) => {
            const was = before.find((item) => item.id === row.id);
            if (was === undefined)
                return true;
            return (was.baseURL !== row.baseURL ||
                was.apiMode !== row.apiMode ||
                was.apiKeyRef !== row.apiKeyRef ||
                was.providerName !== row.providerName);
        });
        const modelsChanged = rows.length !== before.length ||
            rows.some((row) => {
                const was = before.find((item) => item.id === row.id);
                return was === undefined || !sameFieldValue(was.params, row.params) || was.modelId !== row.modelId;
            });
        if (rows.length === 0 && before.length > 0) {
            ops.push({ op: 'unset', path: ['providers', provider] });
            continue;
        }
        const first = rows[0];
        if (first === undefined)
            continue;
        if (providerFieldsChanged || before.length === 0) {
            if (first.providerName !== undefined)
                ops.push({ op: 'set', path: ['providers', provider, 'displayName'], value: first.providerName });
            if (first.baseURL !== undefined)
                ops.push({ op: 'set', path: ['providers', provider, 'baseURL'], value: first.baseURL });
            if (first.apiMode !== undefined)
                ops.push({ op: 'set', path: ['providers', provider, 'api'], value: first.apiMode });
            if (first.apiKeyRef !== undefined)
                ops.push({ op: 'set', path: ['providers', provider, 'apiKeyEnv'], value: first.apiKeyRef });
        }
        if (modelsChanged) {
            ops.push({
                op: 'set',
                path: ['providers', provider, 'models'],
                value: rows.map((row) => ({ id: row.modelId, ...row.params })),
            });
        }
        void currentItems;
        void nextItems;
    }
    return ops;
}
/** Overlay changes implied by a new document. */
export function overlayFor(next, previous) {
    const disabled = [];
    const tags = {};
    const order = {};
    const names = {};
    next.items.forEach((item, index) => {
        if (!item.enabled)
            disabled.push(item.id);
        if (item.tags.length > 0)
            tags[item.id] = item.tags;
        if (item.order !== index)
            order[item.id] = item.order;
        if (item.name !== undefined)
            names[item.id] = item.name;
    });
    return {
        revision: previous.revision + 1,
        ...(disabled.length > 0 ? { disabled } : {}),
        ...(Object.keys(tags).length > 0 ? { tags } : {}),
        ...(Object.keys(order).length > 0 ? { order } : {}),
        ...(Object.keys(names).length > 0 ? { names } : {}),
    };
}
/** A new document with one field applied, for auto-merged writes. */
export function applyDiffs(doc, diffs) {
    const items = doc.items.map((item) => ({ ...item, params: { ...item.params } }));
    for (const diff of diffs) {
        const item = items.find((candidate) => candidate.id === diff.id);
        if (item === undefined || diff.field === 'added' || diff.field === 'removed')
            continue;
        if (diff.field === 'name')
            item.name = diff.ours === null ? undefined : String(diff.ours);
        else if (diff.field === 'enabled')
            item.enabled = diff.ours === true;
        else if (diff.field === 'tags')
            item.tags = Array.isArray(diff.ours) ? diff.ours.map(String) : [];
        else if (diff.field === 'order')
            item.order = Number(diff.ours);
        else if (diff.field === 'modelId')
            item.modelId = String(diff.ours);
        else if (diff.field === 'provider')
            item.provider = String(diff.ours);
        else if (diff.field === 'baseURL')
            item.baseURL = diff.ours === null ? undefined : String(diff.ours);
        else if (diff.field === 'apiMode')
            item.apiMode = diff.ours === null ? undefined : String(diff.ours);
        else if (diff.field === 'apiKeyRef')
            item.apiKeyRef = diff.ours === null ? undefined : String(diff.ours);
        else if (diff.field === 'params')
            item.params = (diff.ours ?? {});
    }
    return { ...doc, items };
}
/**
 * 手机改动并入桌面当前文档——**保住桌面侧的任何改动**。
 *
 * 旧实现在手机快照过期（revision 不匹配但无字段级冲突）时会整表用手机的列表覆盖：
 * 手机没看到过的「桌面新增」会被静默丢掉。2026-09-24 实锤过这种数据丢失
 * （某提供商的模型列表被回退到旧快照），这里改成：只应用手机**明确改过**的部分。
 *
 * 规则：
 *  - 手机删掉、桌面没再动过 → 删；桌面动过 → 保留桌面版本（宁可保留，不可丢）。
 *  - 手机新增 → 加进来（桌面已有同 id 则跳过）。
 *  - 手机改过某字段 → 应用该字段值；桌面没改过的字段天然安全（进入此路径时
 *    已由 `mergeDocs` 保证没有同字段冲突）。
 *  - 手机完全没碰的条目 → 一律以桌面当前版本为准。
 *
 * @param current - 桌面当前文档条目
 * @param base - 手机上次看到的版本（它的 baseRevision 对应内容）
 * @param phone - 手机提交的条目
 * @returns 合并后的条目列表
 */
export function mergePhoneEditsOnto(current, base, phone) {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const phoneById = new Map(phone.map((item) => [item.id, item]));
    const items = current.map((item) => ({ ...item, params: { ...item.params } }));
    // 1) 手机删除（相对 base）：桌面没再动过才真删
    const removed = new Set();
    for (const [id, baseItem] of baseById) {
        if (phoneById.has(id))
            continue;
        const desk = items.find((item) => item.id === id);
        if (desk === undefined) {
            removed.add(id);
            continue;
        }
        if (sameFieldValue(itemFields(desk), itemFields(baseItem)))
            removed.add(id);
        // 桌面改过 → 保留（保守策略：不因过期快照丢东西）
    }
    // 2) 手机新增
    for (const [id, phoneItem] of phoneById) {
        if (baseById.has(id))
            continue;
        if (!items.some((item) => item.id === id))
            items.push({ ...phoneItem, params: { ...phoneItem.params } });
    }
    // 3) 手机改过的字段（只认手机真改了的；其余字段以桌面为准）
    for (const [id, phoneItem] of phoneById) {
        const baseItem = baseById.get(id);
        if (baseItem === undefined)
            continue;
        const desk = items.find((item) => item.id === id);
        if (desk === undefined)
            continue;
        const pf = itemFields(phoneItem);
        const bf = itemFields(baseItem);
        for (const field of Object.keys(pf)) {
            if (sameFieldValue(pf[field], bf[field]))
                continue;
            setItemField(desk, field, pf[field]);
        }
    }
    return items.filter((item) => !removed.has(item.id));
}
/** 单字段写入（与 `applyDiffs` 同语义；这里给三方合并复用）。 */
function setItemField(item, field, value) {
    if (field === 'name')
        item.name = value === null ? undefined : String(value);
    else if (field === 'enabled')
        item.enabled = value === true;
    else if (field === 'tags')
        item.tags = Array.isArray(value) ? value.map(String) : [];
    else if (field === 'order')
        item.order = Number(value);
    else if (field === 'modelId')
        item.modelId = String(value);
    else if (field === 'provider')
        item.provider = String(value);
    else if (field === 'baseURL')
        item.baseURL = value === null ? undefined : String(value);
    else if (field === 'apiMode')
        item.apiMode = value === null ? undefined : String(value);
    else if (field === 'apiKeyRef')
        item.apiKeyRef = value === null ? undefined : String(value);
    else if (field === 'params')
        item.params = (value ?? {});
}
