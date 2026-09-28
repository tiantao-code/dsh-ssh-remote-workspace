/**
 * Remote workspace seam providers for dsh-ssh-workspace.
 *
 * Mounted inside an Agent preset's `isolate` group, this file supplies
 * `ctx.fs` (SFTP) and `ctx.shell` (SSH exec) so the stock `read` / `write` /
 * `edit` / `glob` / `grep` / `bash` tools operate on a remote server.
 */
import { posix } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { SshConnection, fsErrorCode } from './ssh.js'

const BINARY_SAMPLE_BYTES = 8192
const DEFAULT_MAX_TEXT_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DIFF_BASIS_MAX_BYTES = 1024 * 1024
const STREAM_CHUNK_BYTES = 64 * 1024

/** Remote path of a target, which is the SFTP path itself. */
function remoteOf(target) {
    return String(target?.targetKey ?? target)
}

function typeOf(stats) {
    if (typeof stats.isDirectory === 'function' && stats.isDirectory()) return 'directory'
    if (typeof stats.isFile === 'function' && stats.isFile()) return 'file'
    if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return 'symlink'
    return 'other'
}

/** Identity plus freshness; the SFTP protocol exposes no content hash. */
function versionOf(stats) {
    return FsVersion(`${stats.mode}:${stats.size}:${Math.round(Number(stats.mtime) * 1000)}:${Math.round(Number(stats.atime) * 1000)}`)
}

function wrap(error, verb, displayPath) {
    if (error instanceof FsError) return error
    const code = fsErrorCode(error)
    const reason = code === 'FS_NOT_FOUND' ? 'no such file or directory' : (error?.message ?? String(error))
    return new FsError(`cannot ${verb} "${displayPath}": ${reason}`, code)
}

/** Serialize writes to the same path, mirroring dsh-fs-local's per-target lock. */
const locks = new Map()

function withLock(key, operation) {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    locks.set(
        key,
        next.then(
            () => {},
            () => {},
        ),
    )
    return next.finally(() => {
        if (locks.get(key) === undefined) locks.delete(key)
    })
}

/** Keep the newest `cap` bytes of a stream and remember how much was dropped. */
class TailBuffer {
    constructor(cap) {
        this.cap = cap
        this.chunks = []
        this.length = 0
        this.dropped = 0
    }

    push(chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (buffer.length === 0) return
        this.chunks.push(buffer)
        this.length += buffer.length
        while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.cap) {
            this.dropped += this.chunks[0].length
            this.length -= this.chunks[0].length
            this.chunks.shift()
        }
        if (this.length > this.cap) {
            const cut = this.length - this.cap
            this.chunks[0] = this.chunks[0].subarray(cut)
            this.length -= cut
            this.dropped += cut
        }
    }

    get truncated() {
        return this.dropped > 0
    }

    text() {
        return Buffer.concat(this.chunks).toString('utf8')
    }

    /** Incremental read; `lossy` when the requested offset is already gone. */
    readFrom(offset) {
        const start = Number.isFinite(offset) && offset > 0 ? offset : 0
        const total = this.dropped + this.length
        if (start < this.dropped) return { text: this.text(), nextOffset: total, lossy: true }
        let skip = start - this.dropped
        const parts = []
        for (const chunk of this.chunks) {
            if (skip >= chunk.length) {
                skip -= chunk.length
                continue
            }
            parts.push(skip > 0 ? chunk.subarray(skip) : chunk)
            skip = 0
        }
        return { text: Buffer.concat(parts).toString('utf8'), nextOffset: total, lossy: false }
    }
}

/**
 * `ctx.fs` backed by an SSH/SFTP connection.
 */
export class SshFileSystem extends FileSystem {
    _connection
    _config

    constructor(ctx, config, connection) {
        super(ctx)
        this._config = config
        this._connection = connection
    }

    get sandboxMode() {
        return undefined
    }

    get root() {
        return this._config.root
    }

    /**
     * Map a model-supplied path onto the remote filesystem.
     *
     * Relative paths resolve against the remote root. Absolute paths that sit
     * under `cwd` — the session's local working directory, which the tool layer
     * always supplies — are re-rooted onto the remote root, so the model can use
     * the paths the runtime context shows it. Any other absolute path is taken
     * as a remote path, which is what the tool output displays.
     */
    resolveRemote(input, cwd) {
        const raw = typeof input === 'string' ? input.trim() : ''
        if (raw.length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
        const root = this._config.root
        if (!posix.isAbsolute(raw)) return joinRemote(root, raw)
        if (typeof cwd === 'string' && posix.isAbsolute(cwd)) {
            const relative = posix.relative(cwd, raw)
            if (relative === '') return root
            if (!relative.startsWith('..') && !posix.isAbsolute(relative)) return joinRemote(root, relative)
        }
        return posix.normalize(raw)
    }

    _assertInRoot(remotePath, verb) {
        if (this._config.enforceRoot === false) return
        const root = this._config.root
        if (remotePath === root || root === '/' || remotePath.startsWith(root.endsWith('/') ? root : `${root}/`)) return
        throw new FsError(`cannot ${verb} "${remotePath}": outside the remote workspace root ${root}`, 'FS_SANDBOX_DENIED')
    }

    /** stat over SFTP; `undefined` when the path does not exist. */
    async _stat(remotePath, signal, noFollow = false) {
        signal?.throwIfAborted?.()
        try {
            return await this._connection.withSftp((sftp) =>
                new Promise((resolve, reject) => {
                    const callback = (error, stats) => (error ? reject(error) : resolve(stats))
                    if (noFollow) sftp.lstat(remotePath, callback)
                    else sftp.stat(remotePath, callback)
                }),
            )
        } catch (error) {
            if (fsErrorCode(error) === 'FS_NOT_FOUND') return undefined
            throw wrap(error, 'stat', remotePath)
        }
    }

    /** Read a whole file as bytes. */
    async _readBytes(remotePath, signal, maxBytes) {
        signal?.throwIfAborted?.()
        const stats = await this._stat(remotePath, signal)
        if (stats === undefined) throw new FsError(`cannot read "${remotePath}": no such file or directory`, 'FS_NOT_FOUND')
        const type = typeOf(stats)
        if (type === 'directory') throw new FsError(`cannot read "${remotePath}": is a directory`, 'FS_NOT_DIRECTORY')
        if (type !== 'file') throw new FsError(`cannot read "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        const limit = maxBytes ?? this._config.maxTextBytes
        if (typeof limit === 'number' && Number(stats.size) > limit) {
            throw new FsError(`cannot read "${remotePath}": ${stats.size} bytes exceeds the ${limit}-byte limit`, 'FS_TOO_LARGE')
        }
        try {
            return await this._connection.withSftp(
                (sftp) =>
                    new Promise((resolve, reject) => {
                        sftp.readFile(remotePath, (error, data) => (error ? reject(error) : resolve(data)))
                    }),
            )
        } catch (error) {
            throw wrap(error, 'read', remotePath)
        }
    }

    /** Decode UTF-8 text, refusing binary content. */
    _decode(remotePath, buffer) {
        const sample = buffer.subarray(0, BINARY_SAMPLE_BYTES)
        if (sample.includes(0)) throw new FsError(`cannot read "${remotePath}": binary file`, 'FS_NOT_TEXT')
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        } catch {
            throw new FsError(`cannot read "${remotePath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
        }
    }

    async _readText(remotePath, signal) {
        return this._decode(remotePath, await this._readBytes(remotePath, signal))
    }

    /** Create missing parent directories of `remotePath`. */
    async _ensureParent(remotePath) {
        const parent = posix.dirname(remotePath)
        if (parent === '/' || parent === '.' || parent === remotePath) return
        const root = this._config.root
        const parts = parent.split('/').filter(Boolean)
        let current = ''
        for (const part of parts) {
            current = `${current}/${part}`
            if (current.length < root.length && root.startsWith(current)) continue
            const stats = await this._stat(current, undefined)
            if (stats !== undefined) continue
            await this._connection.withSftp(
                (sftp) =>
                    new Promise((resolve, reject) => {
                        sftp.mkdir(current, (error) => (error ? reject(error) : resolve()))
                    }),
            )
        }
    }

    /** Atomic-ish write: stage beside the target, then rename over it. */
    async _writeFile(remotePath, content) {
        await this._ensureParent(remotePath)
        const staged = `${remotePath}.dsh-${randomBytes(6).toString('hex')}.tmp`
        const sftp = await this._connection.sftp()
        try {
            await new Promise((resolve, reject) => {
                sftp.writeFile(staged, content, { encoding: 'utf8', mode: 0o644 }, (error) => (error ? reject(error) : resolve()))
            })
            await new Promise((resolve, reject) => {
                sftp.rename(staged, remotePath, (error) => (error ? reject(error) : resolve()))
            })
        } catch (error) {
            try {
                await new Promise((resolve) => sftp.unlink(staged, () => resolve()))
            } catch {
                /* the staging file was never created */
            }
            throw error
        }
    }

    // --- FileSystem contract -------------------------------------------------

    async resolve(path, options = {}) {
        options.signal?.throwIfAborted?.()
        const remotePath = this.resolveRemote(path, options.cwd ?? this._config.root)
        if (path !== '' && remotePath.length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
        this._assertInRoot(remotePath, 'resolve')
        return { targetKey: FsTargetKey(remotePath), displayPath: remotePath }
    }

    processPath(target) {
        return remoteOf(target)
    }

    fileUrl(target) {
        return `ssh://${this._config.hostLabel ?? 'ssh'}${remoteOf(target)}`
    }

    contains(parent, child) {
        const outer = remoteOf(parent)
        const inner = remoteOf(child)
        if (outer === inner) return true
        const relative = posix.relative(outer, inner)
        return relative !== '' && !relative.startsWith('..') && !posix.isAbsolute(relative)
    }

    async stat(target, signal) {
        const remotePath = remoteOf(target)
        const stats = await this._stat(remotePath, signal)
        if (stats === undefined) return undefined
        return { version: versionOf(stats), type: typeOf(stats), size: Number(stats.size) }
    }

    async lstat(path, options = {}, signal) {
        const remotePath = this.resolveRemote(path, options.cwd ?? this._config.root)
        this._assertInRoot(remotePath, 'inspect')
        const stats = await this._stat(remotePath, signal, true)
        if (stats === undefined) return undefined
        return { version: versionOf(stats), type: typeOf(stats), size: Number(stats.size) }
    }

    async readText(target, signal) {
        return this._readText(remoteOf(target), signal)
    }

    async streamText(target, signal) {
        const remotePath = remoteOf(target)
        const stats = await this._stat(remotePath, signal)
        if (stats === undefined) throw new FsError(`cannot read "${remotePath}": no such file or directory`, 'FS_NOT_FOUND')
        const type = typeOf(stats)
        if (type === 'directory') throw new FsError(`cannot read "${remotePath}": is a directory`, 'FS_NOT_DIRECTORY')
        if (type !== 'file') throw new FsError(`cannot read "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        if (Number(stats.size) <= STREAM_CHUNK_BYTES) return [this._readText(remotePath, signal)]
        const connection = this._connection
        const file = remotePath
        async function* generate() {
            const sftp = await connection.sftp()
            const stream = sftp.createReadStream(file, { highWaterMark: STREAM_CHUNK_BYTES })
            const decoder = new TextDecoder('utf-8', { fatal: true })
            let first = true
            try {
                for await (const chunk of stream) {
                    if (first) {
                        first = false
                        if (chunk.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
                            throw new FsError(`cannot read "${file}": binary file`, 'FS_NOT_TEXT')
                        }
                    }
                    yield decoder.decode(chunk, { stream: true })
                }
                const tail = decoder.decode()
                if (tail.length > 0) yield tail
            } catch (error) {
                if (error instanceof FsError) throw error
                throw wrap(error, 'read', file)
            } finally {
                stream.destroy?.()
            }
        }
        return generate()
    }

    async readBytes(target, signal, maxBytes) {
        return this._readBytes(remoteOf(target), signal, maxBytes)
    }

    async readByteRange(target, options = {}, signal) {
        const remotePath = remoteOf(target)
        const offset = Math.max(0, Number(options.offset ?? 0))
        const length = Math.max(0, Number(options.length ?? 0))
        if (length === 0) return new Uint8Array()
        const connection = this._connection
        try {
            const sftp = await connection.sftp()
            const chunks = []
            let total = 0
            const stream = sftp.createReadStream(remotePath, { start: offset, end: offset + length - 1, highWaterMark: Math.min(length, STREAM_CHUNK_BYTES) })
            for await (const chunk of stream) {
                chunks.push(chunk)
                total += chunk.length
            }
            return new Uint8Array(Buffer.concat(chunks, total))
        } catch (error) {
            throw wrap(error, 'read', remotePath)
        }
    }

    async listDir(target, signal) {
        const remotePath = remoteOf(target)
        const stats = await this._stat(remotePath, signal)
        if (stats === undefined) throw new FsError(`cannot list "${remotePath}": no such file or directory`, 'FS_NOT_FOUND')
        if (typeOf(stats) !== 'directory') throw new FsError(`cannot list "${remotePath}": not a directory`, 'FS_NOT_DIRECTORY')
        let entries
        try {
            entries = await this._connection.withSftp(
                (sftp) =>
                    new Promise((resolve, reject) => {
                        sftp.readdir(remotePath, (error, list) => (error ? reject(error) : resolve(list)))
                    }),
            )
        } catch (error) {
            throw wrap(error, 'list', remotePath)
        }
        const base = remotePath === '/' ? '' : remotePath
        return entries
            .map((entry) => {
                const child = `${base}/${entry.filename}`
                const type = typeOf(entry.attrs ?? {})
                return {
                    name: entry.filename,
                    type,
                    target: { targetKey: FsTargetKey(child), displayPath: child },
                    version: entry.attrs === undefined ? undefined : versionOf(entry.attrs),
                    size: type === 'file' ? Number(entry.attrs?.size ?? 0) : undefined,
                }
            })
            .sort((left, right) => left.name.localeCompare(right.name))
    }

    async writeText(target, content, expected, signal, _sandboxPolicy) {
        const remotePath = remoteOf(target)
        this._assertInRoot(remotePath, 'write')
        return withLock(remotePath, async () => {
            const stats = await this._stat(remotePath, signal)
            if (stats !== undefined && typeOf(stats) !== 'file') {
                throw new FsError(`cannot write "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
            }
            if (expected?.kind === 'replaceIfVersion') {
                if (stats === undefined) throw new FsError(`cannot write "${remotePath}": file no longer exists`, 'FS_STALE_VERSION')
                if (versionOf(stats) !== expected.version) {
                    throw new FsError(`cannot write "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
                }
            }
            if (expected?.kind === 'createIfAbsent' && stats !== undefined) {
                throw new FsError(`cannot overwrite existing "${remotePath}" without reading it first`, 'FS_NOT_OBSERVED')
            }
            let before = null
            if (stats !== undefined && Number(stats.size) <= DIFF_BASIS_MAX_BYTES) {
                try {
                    before = await this._readText(remotePath, signal)
                } catch {
                    before = null
                }
            }
            try {
                await this._writeFile(remotePath, content)
            } catch (error) {
                throw wrap(error, 'write', remotePath)
            }
            const after = await this._stat(remotePath, signal)
            return {
                operation: stats === undefined ? 'create' : 'update',
                version: after === undefined ? FsVersion(`missing:${remotePath}`) : versionOf(after),
                before,
                after: content,
            }
        })
    }

    async editText(target, edit, expected, signal, _sandboxPolicy) {
        const remotePath = remoteOf(target)
        this._assertInRoot(remotePath, 'edit')
        return withLock(remotePath, async () => {
            const stats = await this._stat(remotePath, signal)
            if (stats === undefined) throw new FsError(`cannot edit "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
            if (typeOf(stats) !== 'file') throw new FsError(`cannot edit "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
            if (expected !== undefined && versionOf(stats) !== expected.version) {
                throw new FsError(`cannot edit "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
            }
            const original = this._decode(remotePath, await this._readBytes(remotePath, signal))
            const crlf = original.includes('\r\n')
            const normalized = crlf ? original.replace(/\r\n/g, '\n') : original
            const oldString = edit.oldString
            const replacement = edit.newString
            if (oldString.length === 0) throw new FsError(`cannot edit "${remotePath}": old_string must not be empty`, 'FS_EDIT_NOT_FOUND')
            let count = 0
            let index = normalized.indexOf(oldString)
            while (index !== -1) {
                count += 1
                index = normalized.indexOf(oldString, index + oldString.length)
            }
            if (count === 0) throw new FsError(`old_string was not found in "${remotePath}"`, 'FS_EDIT_NOT_FOUND')
            if (count > 1 && !edit.replaceAll) {
                throw new FsError(
                    `old_string matched ${count} times in "${remotePath}"; provide a more specific old_string or set replace_all to true`,
                    'FS_AMBIGUOUS_EDIT',
                )
            }
            const edited = edit.replaceAll ? normalized.split(oldString).join(replacement) : normalized.replace(oldString, replacement)
            const restored = crlf ? edited.replace(/\n/g, '\r\n') : edited
            try {
                await this._writeFile(remotePath, restored)
            } catch (error) {
                throw wrap(error, 'edit', remotePath)
            }
            const after = await this._stat(remotePath, signal)
            return {
                version: after === undefined ? FsVersion(`missing:${remotePath}`) : versionOf(after),
                before: original,
                after: restored,
            }
        })
    }
}

function joinRemote(root, relative) {
    const clean = relative.replace(/^\.\/+/, '')
    const joined = posix.join(root, clean)
    return joined.length === 0 ? '/' : joined
}

/** One remote shell process, started by {@link SshShellExecutor}. */
class SshShellProcess {
    _connection
    _spec
    _command
    _logger
    _stream = null
    _stdout
    _stderr
    _outCursor = 0
    _errCursor = 0
    _settle
    _resolved = false
    _exitCode = null
    _signal = null
    _timedOut = false
    _aborted = false
    _killed = false
    _error = null
    _timer = null
    _onAbort = null
    done

    constructor(connection, spec, command, logger) {
        this._connection = connection
        this._spec = spec
        this._command = command
        this._logger = logger
        this._stdout = new TailBuffer(spec.stdoutMaxBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
        this._stderr = new TailBuffer(spec.stdoutMaxBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
        this.done = new Promise((resolve) => {
            this._settle = resolve
        })
    }

    get status() {
        if (!this._resolved) return 'running'
        return this._killed ? 'killed' : 'completed'
    }

    get exitCode() {
        return this._exitCode
    }

    get signal() {
        return this._signal
    }

    get sandbox() {
        return undefined
    }

    get observed() {
        return {
            stdout: { readFrom: (offset) => this._stdout.readFrom(offset) },
            stderr: { readFrom: (offset) => this._stderr.readFrom(offset) },
        }
    }

    async start() {
        const stream = await this._connection.exec(this._command)
        this._stream = stream
        stream.on('data', (chunk) => this._stdout.push(chunk))
        stream.stderr.on('data', (chunk) => this._stderr.push(chunk))
        stream.on('exit', (code, signal) => {
            this._exitCode = typeof code === 'number' ? code : null
            this._signal = signal ?? null
        })
        stream.on('close', (code, signal) => {
            if (this._exitCode === null && typeof code === 'number') this._exitCode = code
            if (this._signal === null && signal) this._signal = signal
            this._finish()
        })
        stream.on('error', (error) => {
            this._error = error
            this._killed = true
            this._logger?.debug?.(`ssh-workspace: command stream failed: ${error.message}`)
            this._finish()
        })
        if (this._spec.signal) {
            if (this._spec.signal.aborted) {
                this._aborted = true
                this.kill()
            } else {
                this._onAbort = () => {
                    this._aborted = true
                    this.kill()
                }
                this._spec.signal.addEventListener('abort', this._onAbort, { once: true })
            }
        }
        const timeoutMs = this._spec.timeoutMs
        if (typeof timeoutMs === 'number' && timeoutMs > 0 && this._spec.onExpiry !== 'none') {
            this._timer = setTimeout(() => {
                this._timedOut = true
                this.kill()
            }, timeoutMs)
        }
        if (this._spec.stdin !== undefined && this._spec.stdin !== null) {
            stream.end(this._spec.stdin)
        }
        return this
    }

    _finish() {
        if (this._resolved) return
        this._resolved = true
        if (this._timer !== null) clearTimeout(this._timer)
        if (this._onAbort && this._spec.signal) this._spec.signal.removeEventListener('abort', this._onAbort)
        this._settle()
    }

    kill() {
        if (this._resolved || this._stream === null) return false
        this._killed = true
        try {
            this._stream.signal('KILL')
        } catch {
            /* the server refused the signal */
        }
        try {
            this._stream.close()
        } catch {
            /* the channel is already closed */
        }
        return true
    }

    readOutput() {
        const out = this._stdout.readFrom(this._outCursor)
        this._outCursor = out.nextOffset
        const err = this._stderr.readFrom(this._errCursor)
        this._errCursor = err.nextOffset
        const parts = []
        if (out.text.length > 0) parts.push(out.text)
        if (err.text.length > 0) parts.push(`\n[stderr]\n${err.text}`)
        return { delta: parts.join(''), lossy: out.lossy || err.lossy }
    }

    async result() {
        await this.done
        if (this._error !== null && this._exitCode === null) {
            throw this._error
        }
        return {
            exitCode: this._exitCode,
            signal: this._signal,
            timedOut: this._timedOut,
            aborted: this._aborted,
            timeoutMs: this._spec.timeoutMs ?? 0,
            stdout: { text: this._stdout.text(), truncated: this._stdout.truncated },
            stderr: { text: this._stderr.text(), truncated: this._stderr.truncated },
        }
    }
}

/**
 * `ctx.shell` backed by `ssh <host> <command>`, honouring the seam contract.
 */
export class SshShellExecutor extends ShellExecutor {
    _connection
    _config
    _processes = new Set()
    _directories = new Map()

    constructor(ctx, config, connection) {
        super(ctx)
        this._config = config
        this._connection = connection
        ctx.on('dispose', () => {
            for (const process of [...this._processes]) process.kill()
        })
    }

    get sandboxMode() {
        return undefined
    }

    resolve(request) {
        return {
            command: request.command,
            workdir: request.workdir,
            timeoutMs: request.timeoutMs,
            onExpiry: request.onExpiry,
            stdoutMaxBytes: request.stdoutMaxBytes,
            signal: request.signal,
            stdin: request.stdin,
            env: request.env,
            dshEnv: request.dshEnv,
            sandboxPolicy: request.sandboxPolicy,
        }
    }

    /** A local session path that does not exist remotely falls back to the root. */
    async _workdir(requested) {
        if (typeof requested !== 'string' || requested.length === 0) return this._config.root
        if (this._directories.has(requested)) {
            return this._directories.get(requested) ? requested : this._config.root
        }
        let exists = false
        try {
            const sftp = await this._connection.sftp()
            const stats = await new Promise((resolve, reject) => {
                sftp.stat(requested, (error, value) => (error ? reject(error) : resolve(value)))
            })
            exists = typeof stats.isDirectory === 'function' && stats.isDirectory()
        } catch {
            exists = false
        }
        this._directories.set(requested, exists)
        return exists ? requested : this._config.root
    }

    async execute(spec) {
        const workdir = await this._workdir(spec.workdir)
        const command = buildCommand(spec, workdir)
        const process = new SshShellProcess(this._connection, spec, command, this.ctx.logger)
        this._processes.add(process)
        process.done.then(() => this._processes.delete(process))
        return process.start()
    }
}

/** Quote one shell word for the remote login shell. */
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Compose the remote command line: working directory, environment, then the command. */
export function buildCommand(spec, workdir) {
    const lines = []
    if (typeof workdir === 'string' && workdir.length > 0) lines.push(`cd ${shellQuote(workdir)} || exit 1`)
    for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        lines.push(`export ${key}=${shellQuote(value)}`)
    }
    lines.push(spec.command)
    return lines.join('\n')
}

/**
 * Preset row plugin: provides the SSH-backed `ctx.fs` and `ctx.shell` and owns
 * the shared connection. Services are created through their constructors, which
 * registers them in this row's scope — the preset's `isolate` realm.
 */
export class SshWorkspaceSession {
    static inject = ['sshWorkspace']

    static Config = z.object({
        host: z.string().required(),
        root: z.string().default('/'),
        enforceRoot: z.boolean().default(true),
        maxTextBytes: z.number().default(DEFAULT_MAX_TEXT_BYTES),
    })

    constructor(ctx, config) {
        this.ctx = ctx
        this.config = config
    }

    async *[Service.init]() {
        const registry = this.ctx.sshWorkspace
        const host = registry.get(this.config.host)
        if (host === undefined) throw new Error(`dsh-ssh-workspace: unknown remote host "${this.config.host}"`)
        const connection = new SshConnection(() => registry.get(this.config.host), this.ctx.logger)
        const shared = {
            host: this.config.host,
            hostLabel: `${host.user}@${host.host}:${host.port ?? 22}`,
            root: this.config.root,
            enforceRoot: this.config.enforceRoot,
            maxTextBytes: this.config.maxTextBytes,
        }
        this.connection = connection
        // Constructing a provider registers it in this row's scope — the
        // preset's isolate realm — so the tools beside it resolve these.
        this.fs = new SshFileSystem(this.ctx, shared, connection)
        this.shell = new SshShellExecutor(this.ctx, shared, connection)
        yield () => connection.dispose()
    }
}

export default SshWorkspaceSession
