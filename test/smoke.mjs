/**
 * Standalone smoke test — no DSH host required.
 *
 *   node test/smoke.mjs            unit checks only (store, preset transform)
 *   SSH_WS_LIVE=1 node test/smoke.mjs   also dial the first saved host and
 *                                       exercise the SSH-backed fs + shell
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostStore, publicHost, normalizeHost } from '../lib/store.js'
import {
    REMOTE_GROUP_ID,
    REMOTE_SESSION_ID,
    SESSION_MODULE,
    WORKSPACE_TOOL_IDS,
    buildPresetPlugins,
    loadTemplateRows,
    presetForHost,
} from '../lib/preset.js'
import { SshConnection } from '../lib/ssh.js'
import { SshFileSystem, SshShellExecutor, shellQuote } from '../lib/session.js'
import { presetForHost as presetForHost2 } from '../lib/preset.js'

let checks = 0
function ok(condition, message) {
    assert.ok(condition, message)
    checks += 1
}

// --- store -----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'ssh-ws-store-'))
const path = join(dir, 'hosts.json')
const store = new HostStore({ path, foreign: [] })
ok(store.list().length === 0, 'fresh store is empty')
const saved = store.save({ alias: 'demo', host: 'example.com', user: 'root', root: '/srv/app', auth: { kind: 'password', password: 'hunter2' } })
ok(saved.root === '/srv/app', 'root is stored')
ok(store.get('demo').root === '/srv/app', 'get returns the record')
ok(publicHost(store.get('demo')).auth.password === '***', 'publicHost masks the password')
ok(store.remove('demo') === true, 'remove reports true once')
ok(store.remove('demo') === false, 'remove reports false twice')
assert.throws(() => normalizeHost({ alias: 'bad alias', host: 'h', user: 'u' }), /alias/, 'invalid alias rejected')
assert.throws(() => normalizeHost({ alias: 'ok', host: '', user: 'u' }), /host/, 'empty host rejected')
const saved2 = store.save({ alias: 'demo2', host: 'h2', user: 'u2', root: 'relative/dir' })
ok(saved2.root === '/relative/dir', 'relative root is normalized to absolute')

// foreign import ------------------------------------------------------------
const foreignPath = join(dir, 'foreign.json')
const write = (p, value) => import('node:fs').then((fs) => fs.writeFileSync(p, JSON.stringify(value)))
await write(foreignPath, {
    version: 1,
    hosts: [{ alias: 'ext', host: '10.0.0.9', port: 2222, user: 'ops', auth: { kind: 'key', keyPath: '/keys/id' }, root: '/opt' }],
})
const importing = new HostStore({ path: join(dir, 'hosts2.json'), foreign: [foreignPath] })
ok(importing.list().length === 1 && importing.get('ext').port === 2222, 'foreign hosts are imported')
ok(importing.get('ext').root === '/opt', 'foreign root is kept')

// --- preset transform ------------------------------------------------------
const rows = loadTemplateRows()
ok(Array.isArray(rows) && rows.length > 10, 'template is a plugin list')
ok(rows[0].id === 'persona' && rows.some((row) => row.id === 'tool-fs'), 'template is the standard preset')
const toolRowsInTemplate = rows.filter((row) => WORKSPACE_TOOL_IDS.has(row.id))
ok(toolRowsInTemplate.length === 3, `template carries 3 of the 4 workspace rows (found ${toolRowsInTemplate.map((r) => r.id).join(',')})`)

const host = store.save({ alias: 'demo3', host: 'h3', user: 'u3', root: '/work' })
const preset = presetForHost(host)
ok(preset.id === 'ssh-demo3', 'preset id is ssh-<alias>')
const group = preset.plugins.find((row) => row.id === REMOTE_GROUP_ID)
ok(group !== undefined, 'remote group exists')
ok(group.group === true && group.name === 'cordis:group', 'remote group is a cordis group')
ok(group.isolate.fs === true && group.isolate.shell === true, 'remote group isolates fs and shell')
ok(group.config[0].id === REMOTE_SESSION_ID && group.config[0].name === SESSION_MODULE, 'session row heads the group')
ok(group.config[0].config.host === 'demo3' && group.config[0].config.root === '/work', 'session row carries host + root')
const movedIds = group.config.slice(1).map((row) => row.id)
ok(['tool-fs', 'tool-fs-search', 'tool-bash'].every((id) => movedIds.includes(id)), `fs/bash tools moved into the group (${movedIds.join(',')})`)
ok(!preset.plugins.some((row) => row.id === 'tool-fs' || row.id === 'tool-fs-search'), 'workspace rows no longer sit at preset top level')
ok(JSON.stringify(preset.plugins).includes('SSH'), 'persona suffix names the remote host')
ok(!JSON.stringify(preset.plugins).includes('hunter2'), 'no secret leaks into the preset document')
ok(presetForHost2(host).id === preset.id, 'preset build is deterministic')

// --- live round trip -------------------------------------------------------
if (process.env.SSH_WS_LIVE === '1') {
    const live = new HostStore({})
    const hosts = live.list()
    ok(hosts.length > 0, 'at least one saved host')
    const target = process.env.SSH_WS_HOST ? live.get(process.env.SSH_WS_HOST) : hosts[0]
    const connection = new SshConnection(() => live.get(target.alias) ?? target)
    const ctx = new Context()
    const shared = {
        host: target.alias,
        hostLabel: `${target.user}@${target.host}:${target.port}`,
        root: target.root,
        enforceRoot: true,
        maxTextBytes: 32 * 1024 * 1024,
    }
    const fs = new SshFileSystem(ctx, shared, connection)
    const shell = new SshShellExecutor(ctx, shared, connection)
    const name = `dsh-ssh-workspace-smoke-${Date.now()}.txt`

    const spec = shell.resolve({ command: 'echo hello; pwd' })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    ok(result.exitCode === 0, `remote command exits 0 (got ${result.exitCode})`)
    ok(result.stdout.text.includes('hello'), 'remote command output captured')
    console.log('      remote pwd:', result.stdout.text.trim().split('\n').pop())

    const cwd = target.root
    const created = await fs.resolve(name, { cwd })
    const outcome = await fs.writeText(created, 'alpha\nbeta\n', undefined, undefined)
    ok(outcome.operation === 'create', 'writeText creates the remote file')
    const text = await fs.readText(created)
    ok(text === 'alpha\nbeta\n', 'readText returns what was written')
    const edited = await fs.editText(created, { oldString: 'beta', newString: 'gamma', replaceAll: false }, undefined, undefined)
    ok((await fs.readText(created)) === 'alpha\ngamma\n', 'editText rewrites the remote file')
    const listed = await fs.listDir(await fs.resolve('.', { cwd }))
    ok(listed.some((entry) => entry.name === name), 'listDir sees the remote file')
    const info = await fs.stat(created)
    ok(info.type === 'file' && info.size === 'alpha\ngamma\n'.length, 'stat reports the remote size')
    ok(fs.processPath(created).startsWith('/'), 'processPath yields a remote path')
    ok(fs.contains(await fs.resolve('.', { cwd }), created) === true, 'contains accepts a child')
    await fs.writeText(created, '', { kind: 'replaceIfVersion', version: 'stale' }, undefined).then(
        () => assert.fail('stale version must fail'),
        (error) => ok(error.code === 'FS_STALE_VERSION', 'stale version is rejected'),
    )
    await shell.execute(shell.resolve({ command: `rm -f ${shellQuote(created.processPath)}` })).then((e) => e.result())
    await connection.dispose()
}

rmSync(dir, { recursive: true, force: true })
console.log(`smoke: ${checks} checks passed`)
