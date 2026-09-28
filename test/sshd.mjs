/**
 * Minimal in-process SSH server for tests: password auth, `exec` over
 * /bin/sh, and an SFTP subsystem backed by a real directory.
 *
 * It exists so the SSH-backed FileSystem and ShellExecutor can be exercised
 * end to end without any external host.
 */
import { spawn } from 'node:child_process'
import {
    closeSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    opendirSync,
    readdirSync,
    readSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
    writeSync,
} from 'node:fs'
import { posix, resolve, sep } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { OPEN_MODE, STATUS_CODE } = utils.sftp

const HOST_KEY = utils.generateKeyPairSync('ed25519').private

/**
 * The test server is transparent: a client path is the real host path, exactly
 * as it would be on a real SSH server. Only paths outside the test workspace
 * are refused, so a runaway test cannot touch the rest of the machine.
 */
function localPath(root, clientPath) {
    const clean = posix.normalize(String(clientPath ?? '/').replace(/\\/g, '/'))
    const local = resolve(clean)
    if (local !== root && !local.startsWith(root + sep)) throw Object.assign(new Error('outside root'), { code: 'EPERM' })
    return local
}

function attrsOf(stats) {
    return {
        mode: stats.mode,
        uid: stats.uid,
        gid: stats.gid,
        size: stats.size,
        atime: Math.floor(stats.atimeMs / 1000),
        mtime: Math.floor(stats.mtimeMs / 1000),
    }
}

function entryOf(root, name) {
    const full = resolve(root, name)
    let stats
    try {
        stats = lstatSync(full)
    } catch {
        return undefined
    }
    return {
        filename: name,
        longname: `${stats.isDirectory() ? 'd' : '-'}rw-r--r-- 1 root root ${stats.size} ${name}`,
        attrs: attrsOf(stats),
    }
}

/**
 * Start the test server on an ephemeral loopback port.
 * @returns {Promise<{port: number, root: string, close: () => Promise<void>}>}
 */
export function startTestSshServer(options) {
    const root = resolve(options.root)
    const user = options.user ?? 'tester'
    const password = options.password ?? 'secret'
    mkdirSync(root, { recursive: true })

    const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
        client.on('authentication', (ctx) => {
            if (ctx.method === 'password' && ctx.username === user && ctx.password === password) return ctx.accept()
            if (ctx.method === 'keyboard-interactive') ctx.prompt([], () => ctx.accept())
            else ctx.reject(['password'])
        })
        client.on('ready', () => {
            client.on('session', (accept) => {
                const session = accept()

                session.on('exec', (acceptExec, _rejectExec, info) => {
                    const stream = acceptExec()
                    let child
                    try {
                        child = spawn('/bin/sh', ['-c', info.command], { cwd: root })
                    } catch (error) {
                        stream.stderr.write(String(error.message))
                        stream.exit(127)
                        stream.end()
                        return
                    }
                    child.stdout.on('data', (chunk) => stream.write(chunk))
                    child.stderr.on('data', (chunk) => stream.stderr.write(chunk))
                    child.on('close', (code) => {
                        stream.exit(code ?? 0)
                        stream.end()
                    })
                    stream.on('close', () => child.kill('SIGKILL'))
                })

                session.on('sftp', (acceptSftp) => {
                    const sftp = acceptSftp()
                    /** @type {Map<string, {kind: 'file'|'dir', fd?: number, path: string, entries?: object[], sent?: boolean}>} */
                    const handles = new Map()
                    let counter = 0
                    const newHandle = (value) => {
                        const handle = String(++counter)
                        handles.set(handle, value)
                        return handle
                    }
                    const fail = (reqid, error) => {
                        const code = error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : error?.code === 'EACCES' || error?.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE
                        sftp.status(reqid, code, String(error?.message ?? error))
                    }
                    const stat = (reqid, path, follow) => {
                        try {
                            const stats = follow ? statSync(localPath(root, path)) : lstatSync(localPath(root, path))
                            sftp.attrs(reqid, attrsOf(stats))
                        } catch (error) {
                            fail(reqid, error)
                        }
                    }

                    sftp.on('REALPATH', (reqid, path) => {
                        const clean = posix.normalize(String(path || '/'))
                        sftp.name(reqid, [{ filename: clean, longname: clean, attrs: {} }])
                    })
                    sftp.on('STAT', (reqid, path) => stat(reqid, path, true))
                    sftp.on('LSTAT', (reqid, path) => stat(reqid, path, false))
                    sftp.on('FSTAT', (reqid, handle) => {
                        const entry = handles.get(String(handle))
                        if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
                        try {
                            sftp.attrs(reqid, attrsOf(fstatSync(entry.fd)))
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
                        const path = localPath(root, filename)
                        let mode = 'r'
                        if (flags & OPEN_MODE.APPEND) mode = 'a'
                        else if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.TRUNC ? 'w' : existsSync(path) ? 'r+' : 'w'
                        if (flags & OPEN_MODE.EXCL) mode = 'wx'
                        try {
                            const fd = openSync(path, mode)
                            sftp.handle(reqid, Buffer.from(newHandle({ kind: 'file', fd, path })))
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('READ', (reqid, handle, offset, length) => {
                        const entry = handles.get(String(handle))
                        if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
                        const buffer = Buffer.alloc(length)
                        try {
                            const read = readSync(entry.fd, buffer, 0, length, offset)
                            if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF)
                            sftp.data(reqid, buffer.subarray(0, read))
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('WRITE', (reqid, handle, offset, data) => {
                        const entry = handles.get(String(handle))
                        if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
                        try {
                            writeSync(entry.fd, data, 0, data.length, offset)
                            sftp.status(reqid, STATUS_CODE.OK)
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('CLOSE', (reqid, handle) => {
                        const entry = handles.get(String(handle))
                        handles.delete(String(handle))
                        if (entry?.fd !== undefined) {
                            try {
                                closeSync(entry.fd)
                            } catch {
                                /* already gone */
                            }
                        }
                        sftp.status(reqid, STATUS_CODE.OK)
                    })
                    sftp.on('OPENDIR', (reqid, path) => {
                        try {
                            const directory = opendirSync(localPath(root, path))
                            const entries = []
                            for (;;) {
                                const entry = directory.readSync()
                                if (entry === null) break
                                entries.push(entry)
                            }
                            directory.closeSync()
                            sftp.handle(reqid, Buffer.from(newHandle({ kind: 'dir', path, entries })))
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('READDIR', (reqid, handle) => {
                        const entry = handles.get(String(handle))
                        if (entry?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
                        if (entry.sent) return sftp.status(reqid, STATUS_CODE.EOF)
                        entry.sent = true
                        const names = ['.', '..', ...entry.entries.map((item) => item.name)]
                        sftp.name(
                            reqid,
                            names.map((name) => entryOf(entry.path, name) ?? { filename: name, longname: name, attrs: {} }),
                        )
                    })
                    sftp.on('REMOVE', (reqid, path) => {
                        try {
                            rmSync(localPath(root, path))
                            sftp.status(reqid, STATUS_CODE.OK)
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('RENAME', (reqid, from, to) => {
                        try {
                            renameSync(localPath(root, from), localPath(root, to))
                            sftp.status(reqid, STATUS_CODE.OK)
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('MKDIR', (reqid, path) => {
                        try {
                            mkdirSync(localPath(root, path), { recursive: false })
                            sftp.status(reqid, STATUS_CODE.OK)
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('RMDIR', (reqid, path) => {
                        try {
                            rmdirSync(localPath(root, path))
                            sftp.status(reqid, STATUS_CODE.OK)
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                    sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
                    sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
                    sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED))
                    sftp.on('READLINK', (reqid, path) => {
                        try {
                            sftp.name(reqid, [{ filename: readdirSafe(root, path), longname: '', attrs: {} }])
                        } catch (error) {
                            fail(reqid, error)
                        }
                    })
                })
            })
        })
    })

    function readdirSafe() {
        return '/'
    }

    return new Promise((resolvePromise, rejectPromise) => {
        server.on('error', rejectPromise)
        server.listen(options.port ?? 0, '127.0.0.1', () => {
            const { port } = server.address()
            resolvePromise({
                port,
                root,
                close: () =>
                    new Promise((done) => {
                        server.close(() => done())
                    }),
            })
        })
    })
}
