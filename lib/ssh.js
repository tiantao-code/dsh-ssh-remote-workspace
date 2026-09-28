/**
 * ssh2 connection management for dsh-ssh-workspace.
 *
 * One `SshConnection` per bound host. It owns a single ssh2 client, a lazily
 * opened SFTP session, and the exec channels opened for shell execution. It is
 * deliberately lazy: nothing is dialled until a tool actually calls the
 * filesystem or the shell, because an Agent preset mounts eagerly and a remote
 * server that is down must not break the preset roster.
 */
import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'

/** SFTP protocol status codes that carry a useful meaning. */
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3
const SFTP_FAILURE = 4
const SFTP_FILE_ALREADY_EXISTS = 11

/** Node errno strings that ssh2 surfaces for local-side failures. */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', SFTP_NO_SUCH_FILE, 'No such file'])
const DENIED_CODES = new Set(['EACCES', 'EPERM', SFTP_PERMISSION_DENIED])

/** True when an ssh2 error means the transport is gone and a reconnect is needed. */
export function isTransportError(error) {
    const code = error?.code
    return (
        error?.level === 'client-socket' ||
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH' ||
        (typeof code === 'string' && code.startsWith('ERR_SOCKET'))
    )
}

/** Translate an ssh2/SFTP/node error into a filesystem error code. */
export function fsErrorCode(error) {
    const code = error?.code
    if (NOT_FOUND_CODES.has(code) || /no such file/i.test(error?.message ?? '')) return 'FS_NOT_FOUND'
    if (DENIED_CODES.has(code) || /permission denied/i.test(error?.message ?? '')) return 'FS_PERMISSION_DENIED'
    if (typeof code === 'number') {
        if (code === SFTP_NO_SUCH_FILE) return 'FS_NOT_FOUND'
        if (code === SFTP_PERMISSION_DENIED) return 'FS_PERMISSION_DENIED'
        if (code === SFTP_FILE_ALREADY_EXISTS) return 'FS_IO_ERROR'
        if (code === SFTP_FAILURE) return 'FS_IO_ERROR'
    }
    return 'FS_IO_ERROR'
}

/**
 * Build the ssh2 connect options for one stored host.
 * @param host - stored host record (`auth.kind` is `agent` | `password` | `key`).
 * @param options - `{ timeoutMs, keepaliveInterval }`.
 */
export function connectConfig(host, options = {}) {
    const auth = host.auth ?? { kind: 'agent' }
    const base = {
        host: host.host,
        port: host.port ?? 22,
        username: host.user,
        readyTimeout: options.timeoutMs ?? 20_000,
        keepaliveInterval: options.keepaliveInterval ?? 15_000,
        keepaliveCountMax: 3,
    }
    if (host.proxyCommand) base.sock = undefined
    if (auth.kind === 'password') {
        return { ...base, password: auth.password, tryKeyboard: true, keyboardInteractive: () => {} }
    }
    if (auth.kind === 'key') {
        return { ...base, privateKey: readFileSync(auth.keyPath), passphrase: auth.passphrase }
    }
    return { ...base, agent: auth.agentPath || process.env.SSH_AUTH_SOCK }
}

/** Describe a host for log/error messages without leaking credentials. */
export function describeHost(host) {
    const auth = host.auth ?? { kind: 'agent' }
    const how = auth.kind === 'key' ? `key:${auth.keyPath}` : auth.kind === 'password' ? 'password' : 'agent'
    return `${host.user}@${host.host}:${host.port ?? 22} (${how})`
}

/**
 * A single remote SSH endpoint: connection, SFTP session and exec channels.
 */
export class SshConnection {
    /** @type {import('ssh2').Client | null} */
    #client = null
    /** @type {import('ssh2').SFTPWrapper | null} */
    #sftp = null
    /** In-flight connect attempt, shared by concurrent callers. */
    #connecting = null
    /** Open exec channels, so teardown can stop them. */
    #channels = new Set()
    #ready = false
    #disposed = false
    #lastError = null

    /**
     * @param host - stored host record, or a resolver called before every dial so
     * a credential edit in the store takes effect on the next reconnect.
     * @param logger - optional Cordis logger.
     * @param options - dial tuning: `attempts` (default 3) and a fallback
     * `readyTimeoutMs` used when the host record carries none.
     */
    constructor(host, logger, options = {}) {
        this.host = host
        this.logger = logger
        this.attempts = options.attempts ?? 3
        this.readyTimeoutMs = options.readyTimeoutMs
        const initial = typeof host === 'function' ? undefined : host
        this.label = initial ? (initial.alias ?? `${initial.user}@${initial.host}`) : 'ssh'
    }

    /** Read the current host record, keeping the resolver as the source of truth. */
    #record() {
        const host = typeof this.host === 'function' ? this.host() : this.host
        if (!host) throw new Error(`unknown remote host for ${this.label}`)
        this.label = host.alias ?? `${host.user}@${host.host}`
        return host
    }

    get connected() {
        return this.#ready && !this.#disposed
    }

    /**
     * Resolve a live client, dialling when necessary.
     * @returns {Promise<import('ssh2').Client>}
     */
    async client() {
        if (this.#disposed) throw new Error(`SSH connection to ${this.label} was disposed`)
        if (this.#ready && this.#client) return this.#client
        if (this.#connecting) return this.#connecting
        this.#connecting = this.#dial().finally(() => {
            this.#connecting = null
        })
        return this.#connecting
    }

    async #dial() {
        const host = this.#record()
        const attempts = this.attempts
        let lastError
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await this.#dialOnce()
            } catch (error) {
                lastError = error
                this.#lastError = error
                this.logger?.debug?.(`ssh-workspace: connect to ${this.label} failed (attempt ${attempt}/${attempts}): ${error.message}`)
                if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
            }
        }
        throw new Error(`cannot connect to ${describeHost(host)}: ${lastError?.message ?? lastError}`)
    }

    #dialOnce() {
        const host = this.#record()
        const config = connectConfig(host, { timeoutMs: host.readyTimeoutMs ?? this.readyTimeoutMs })
        return new Promise((resolve, reject) => {
            const client = new Client()
            const settle = (fn, value) => {
                client.removeListener('ready', onReady)
                client.removeListener('error', onError)
                client.removeListener('close', onClose)
                fn(value)
            }
            const onReady = () => {
                this.#client = client
                this.#ready = true
                this.#lastError = null
                this.#wireLifecycle(client)
                settle(resolve, client)
            }
            const onError = (error) => settle(reject, error)
            const onClose = () => settle(reject, this.#lastError ?? new Error('connection closed before ready'))
            client.once('ready', onReady)
            client.once('error', onError)
            client.once('close', onClose)
            try {
                client.connect(config)
            } catch (error) {
                settle(reject, error)
            }
        })
    }

    /** Invalidate state whenever the transport ends, so the next call reconnects. */
    #wireLifecycle(client) {
        const drop = (error) => {
            if (error) this.#lastError = error
            if (this.#client !== client) return
            this.#ready = false
            this.#sftp = null
            this.#client = null
            this.#channels.clear()
        }
        client.on('error', (error) => {
            this.logger?.debug?.(`ssh-workspace: ${this.label} transport error: ${error.message}`)
            drop(error)
        })
        client.on('close', () => drop(null))
        client.on('end', () => drop(null))
    }

    /** Resolve the SFTP session, opening it on first use. */
    async sftp() {
        if (this.#sftp) return this.#sftp
        const client = await this.client()
        this.#sftp = await new Promise((resolve, reject) => {
            client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)))
        })
        return this.#sftp
    }

    /**
     * Run one SFTP operation with a single transparent reconnect on transport loss.
     * @param operation - receives the live SFTP session.
     */
    async withSftp(operation) {
        try {
            return await operation(await this.sftp())
        } catch (error) {
            if (!isTransportError(error) || this.#disposed) throw error
            this.logger?.debug?.(`ssh-workspace: ${this.label} sftp retry after ${error.message}`)
            this.#ready = false
            this.#sftp = null
            this.#client = null
            return operation(await this.sftp())
        }
    }

    /**
     * Open one exec channel. The caller owns the channel and must close it.
     * @param command - remote command line, interpreted by the remote login shell.
     * @returns {Promise<import('ssh2').ClientChannel>}
     */
    async exec(command) {
        const client = await this.client()
        const stream = await new Promise((resolve, reject) => {
            client.exec(command, (error, channel) => (error ? reject(error) : resolve(channel)))
        })
        this.#channels.add(stream)
        stream.once('close', () => this.#channels.delete(stream))
        return stream
    }

    /** Whether this connection is usable right now (dialling excluded). */
    async ping() {
        try {
            await this.client()
            return true
        } catch {
            return false
        }
    }

    /** Stop channels and close the transport. Safe to call more than once. */
    async dispose() {
        if (this.#disposed) return
        this.#disposed = true
        this.#ready = false
        for (const channel of this.#channels) {
            try {
                channel.signal('KILL')
                channel.close()
            } catch {
                /* the channel is already gone */
            }
        }
        this.#channels.clear()
        const client = this.#client
        this.#client = null
        this.#sftp = null
        if (client) {
            try {
                client.end()
            } catch {
                /* already closed */
            }
        }
    }
}
