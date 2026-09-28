/**
 * Builds the per-host Agent preset.
 *
 * A preset is composed at activation time from a static row list, so it cannot
 * be selected per session at runtime. Instead every saved host gets its own
 * preset whose composition swaps the filesystem and shell providers for the
 * SSH-backed ones, while the rest of the rows mirror the stock `standard`
 * preset. `preset-remote.yml` is a copy of that stock preset; it is parsed and
 * transformed here so tool rows that touch the workspace live inside the
 * `isolate` group that carries the remote providers.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const templatePath = join(here, '..', 'preset-remote.yml')

/** Row ids that must resolve `ctx.fs` / `ctx.shell` from the remote providers. */
export const WORKSPACE_TOOL_IDS = new Set(['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search'])

/** Preset row id of the isolate group carrying the remote providers. */
export const REMOTE_GROUP_ID = 'ssh-workspace-remote'
export const REMOTE_SESSION_ID = 'ssh-workspace-session'
export const SESSION_MODULE = 'dsh-ssh-workspace/session'

/** Reads `!!js <expression>` scalars produced by the stock preset. */
const JsExpression = {
    tag: 'tag:yaml.org,2002:js',
    resolve: (value) => ({ expression: String(value) }),
}

function evaluate(expression) {
    try {
        return Boolean(Function(`"use strict"; return (${expression})`)())
    } catch {
        return false
    }
}

/** Drop rows disabled on this host and turn `!!js` conditions into booleans. */
function normalize(rows) {
    const kept = []
    for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const { disabled, ...rest } = row
        if (disabled !== undefined) {
            // `disabled` holds the condition itself: a truthy value means the row
            // is switched off on this host (e.g. `!!js process.platform === 'win32'`).
            const off = typeof disabled === 'object' && disabled !== null && 'expression' in disabled ? evaluate(disabled.expression) : Boolean(disabled)
            if (off) continue
        }
        if (rest.group === true && Array.isArray(rest.config)) rest.config = normalize(rest.config)
        kept.push(rest)
    }
    return kept
}

/** Load the stock row list this package mirrors. */
export function loadTemplateRows() {
    const document = parse(readFileSync(templatePath, 'utf8'), { customTags: [JsExpression] })
    const presetRow = document?.[0]?.insert?.[0]
    const rows = presetRow?.config?.plugins
    if (!Array.isArray(rows)) throw new Error(`${templatePath}: expected one inserted preset with a plugins list`)
    return normalize(rows)
}

/**
 * Compose one host's preset rows.
 * @param host - saved host record (`alias` names the preset, `root` is the remote workspace root).
 * @param options - `template` overrides the row list (tests).
 * @returns Cordis entry rows for `agentPresets.register`.
 */
export function buildPresetPlugins(host, options = {}) {
    const alias = host.alias
    const root = host.root ?? '/'
    const rows = normalize(options.template ?? loadTemplateRows())
    const remote = []
    const rest = []
    for (const row of rows) {
        if (WORKSPACE_TOOL_IDS.has(row.id)) remote.push(row)
        else rest.push(row)
    }
    if (remote.length === 0) throw new Error('preset template has no workspace tool rows to relocate')
    const persona = rest.findIndex((row) => row.id === 'persona')
    const group = {
        id: REMOTE_GROUP_ID,
        name: 'cordis:group',
        group: true,
        isolate: { fs: true, shell: true },
        config: [
            {
                id: REMOTE_SESSION_ID,
                name: SESSION_MODULE,
                config: { host: alias, root },
            },
            ...remote,
        ],
    }
    const plugins = [...rest]
    // The remote group takes the position of the first workspace tool it replaces,
    // so host-plane rows such as the job registry activate before the tools do.
    const firstToolIndex = rows.findIndex((row) => WORKSPACE_TOOL_IDS.has(row.id))
    const before = rest.filter((row) => rows.indexOf(row) < firstToolIndex)
    const after = rest.filter((row) => rows.indexOf(row) > firstToolIndex)
    const ordered = [...before, group, ...after]
    if (persona >= 0) {
        const entry = ordered.find((row) => row.id === 'persona')
        if (entry) {
            entry.config = {
                ...entry.config,
                suffix: `Your workspace is the remote host "${alias}" (${host.user}@${host.host}), reached over SSH. The workspace root is ${root}; every file path you read, write or search is a path on that server, and every command runs there.`,
            }
        }
    }
    return ordered
}

/**
 * Preset identity for one host.
 * @param host - saved host record.
 */
export function presetForHost(host) {
    return {
        id: `ssh-${host.alias}`,
        name: `SSH · ${host.alias}`,
        description: `Work directly on ${host.user}@${host.host}:${host.port ?? 22} over SSH (workspace root ${host.root ?? '/'}).`,
        order: 2,
        plugins: buildPresetPlugins(host),
    }
}
