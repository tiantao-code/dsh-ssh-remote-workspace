/**
 * End-to-end test against the in-process SSH server in `sshd.mjs`: real SSH
 * handshake, real SFTP, real exec — no external host required.
 *
 *   node test/local-e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '../lib/ssh.js'
import { SshFileSystem, SshShellExecutor, shellQuote } from '../lib/session.js'
import { startTestSshServer } from './sshd.mjs'

let checks = 0
const ok = (condition, message) => {
    assert.ok(condition, message)
    checks += 1
}

async function rejects(promise, code, message) {
    try {
        await promise
    } catch (error) {
        assert.equal(error.code, code, `${message}: expected ${code}, got ${error.code} (${error.message})`)
        checks += 1
        return error
    }
    assert.fail(`${message}: expected rejection`)
}

const workspace = mkdtempSync(join(tmpdir(), 'ssh-ws-e2e-'))
const remoteRoot = join(workspace, 'work')
mkdirSync(remoteRoot, { recursive: true })
const server = await startTestSshServer({ root: workspace })
const host = { alias: 'local', host: '127.0.0.1', port: server.port, user: 'tester', root: remoteRoot, auth: { kind: 'password', password: 'secret' } }

const connection = new SshConnection(() => host)
const ctx = new Context()
const shared = {
    host: host.alias,
    hostLabel: `${host.user}@${host.host}:${host.port}`,
    root: host.root,
    enforceRoot: true,
    maxTextBytes: 1024 * 1024,
}
const fs = new SshFileSystem(ctx, shared, connection)
const shell = new SshShellExecutor(ctx, shared, connection)

try {
    // --- the providers register themselves on the context --------------------
    ok(ctx.get('fs') instanceof SshFileSystem, 'the context registers the SSH filesystem as ctx.fs')
    ok(ctx.get('shell') instanceof SshShellExecutor, 'the context registers the SSH shell executor as ctx.shell')
    ok(fs.sandboxMode === undefined, 'filesystem reports no local sandbox mode')

    // --- shell ---------------------------------------------------------------
    const echo = await (await shell.execute(shell.resolve({ command: 'echo hello; pwd' }))).result()
    ok(echo.exitCode === 0, `remote command exits 0 (got ${echo.exitCode})`)
    ok(echo.stdout.text.includes('hello'), 'remote stdout is captured')
    ok(echo.stdout.text.trim().endsWith('/work'), `remote pwd is the remote root (${echo.stdout.text.trim().split('\n').pop()})`)

    const envRun = await (await shell.execute(shell.resolve({ command: 'printf "%s" "$GREETING"', env: { GREETING: 'bonjour' } }))).result()
    ok(envRun.stdout.text === 'bonjour', `env values are exported (got ${JSON.stringify(envRun.stdout.text)})`)

    const nonzero = await (await shell.execute(shell.resolve({ command: 'echo bad >&2; exit 7' }))).result()
    ok(nonzero.exitCode === 7, 'nonzero exit code is reported')
    ok(nonzero.stderr.text.includes('bad'), 'stderr is captured separately')

    const fallback = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: '/does-not-exist' }))).result()
    ok(fallback.stdout.text.trim().endsWith('/work'), 'an unknown workdir falls back to the remote root')

    const started = Date.now()
    const killed = await (await shell.execute(shell.resolve({ command: 'sleep 5', timeoutMs: 400 }))).result()
    ok(killed.timedOut === true, 'a timeout is reported')
    ok(Date.now() - started < 4000, 'the timed out command is killed, not awaited')

    const trimmed = await (await shell.execute(shell.resolve({ command: 'printf "abcdefghij"', stdoutMaxBytes: 4 }))).result()
    ok(trimmed.stdout.truncated === true && trimmed.stdout.text.length <= 4, 'stdout is capped and flagged as truncated')

    // --- filesystem ----------------------------------------------------------
    const notes = await fs.resolve('notes', { cwd: remoteRoot })
    ok(fs.processPath(notes) === join(remoteRoot, 'notes'), `processPath re-roots the session cwd (${fs.processPath(notes)})`)
    ok(fs.fileUrl(notes).startsWith('ssh://'), 'fileUrl uses the ssh scheme')

    const created = await fs.writeText(notes, 'alpha\nbeta\n', { kind: 'createIfAbsent' })
    ok(created.operation === 'create' && created.after === 'alpha\nbeta\n', 'writeText creates the remote file')
    ok((await fs.readText(notes)) === 'alpha\nbeta\n', 'readText returns the content')
    const info = await fs.stat(notes)
    ok(info.type === 'file' && info.size === 11, 'stat reports type and size')
    ok((await fs.listDir(await fs.resolve(remoteRoot, { cwd: remoteRoot }))).some((entry) => entry.name === 'notes'), 'listDir sees the file')

    await rejects(fs.writeText(notes, 'x', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED', 'createIfAbsent over an existing file')
    await rejects(fs.writeText(notes, 'x', { kind: 'replaceIfVersion', version: 'stale' }), 'FS_STALE_VERSION', 'stale write')
    await rejects(fs.editText(notes, { oldString: 'nope', newString: 'x', replaceAll: false }), 'FS_EDIT_NOT_FOUND', 'edit with no match')
    await rejects(fs.editText(notes, { oldString: 'a', newString: 'x', replaceAll: false }), 'FS_AMBIGUOUS_EDIT', 'ambiguous edit')

    const edited = await fs.editText(notes, { oldString: 'beta', newString: 'gamma', replaceAll: false })
    ok(edited.before === 'alpha\nbeta\n' && edited.after === 'alpha\ngamma\n', 'editText returns before/after')
    ok((await fs.readText(notes)) === 'alpha\ngamma\n', 'the edit is durable')

    const replacing = await fs.writeText(notes, 'delta\n', { kind: 'replaceIfVersion', version: edited.version })
    ok(replacing.operation === 'update' && replacing.before === 'alpha\ngamma\n', 'replaceIfVersion updates and reports the previous text')

    const nested = await fs.resolve('deep/nested/file.txt', { cwd: remoteRoot })
    const nestedOutcome = await fs.writeText(nested, 'deep\n', { kind: 'createIfAbsent' })
    ok(nestedOutcome.operation === 'create', 'missing parent directories are created')
    ok((await fs.readText(nested)) === 'deep\n', 'the nested file is readable')

    writeFileSync(join(remoteRoot, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]))
    await rejects(fs.readText(await fs.resolve('binary.bin', { cwd: remoteRoot })), 'FS_NOT_TEXT', 'binary read')
    await rejects(fs.readText(await fs.resolve('missing.txt', { cwd: remoteRoot })), 'FS_NOT_FOUND', 'missing read')
    await rejects(fs.resolve('/etc/passwd', { cwd: remoteRoot }), 'FS_SANDBOX_DENIED', 'a path outside the remote root')

    const bytes = await fs.readBytes(await fs.resolve('notes', { cwd: remoteRoot }), undefined, 64)
    ok(Buffer.from(bytes).toString() === 'delta\n', 'readBytes works over SFTP')

    const streamed = []
    for await (const chunk of await fs.streamText(await fs.resolve('notes', { cwd: remoteRoot }))) streamed.push(chunk)
    ok(streamed.join('') === 'delta\n', 'streamText yields the content')

    const removed = await shell.execute(shell.resolve({ command: `rm -rf ${shellQuote(join(remoteRoot, 'deep'))} ${shellQuote(join(remoteRoot, 'notes'))}` }))
    await removed.result()
    await rejects(fs.readText(notes), 'FS_NOT_FOUND', 'the deleted file is gone')

    // --- proxy receivers (cordis registers services through a tracker Proxy) --
    const fsProxy = new Proxy(fs, {})
    const shellProxy = new Proxy(shell, {})
    const proxyTarget = await fsProxy.resolve('proxy.txt', { cwd: remoteRoot })
    await fsProxy.writeText(proxyTarget, 'proxy-ok', { kind: 'createIfAbsent' })
    ok((await fsProxy.readText(proxyTarget)) === 'proxy-ok', 'filesystem methods work with a Proxy receiver')
    const proxied = await (await shellProxy.execute(shellProxy.resolve({ command: 'pwd' }))).result()
    ok(proxied.exitCode === 0 && proxied.stdout.text.trim().endsWith('/work'), 'shell methods work with a Proxy receiver')
    ok((await fsProxy.stat(proxyTarget)).type === 'file', 'stat works with a Proxy receiver')
} finally {
    await connection.dispose()
    await server.close()
    rmSync(workspace, { recursive: true, force: true })
}

console.log(`local-e2e: ${checks} checks passed over real SSH`)
