/**
 * Remote-host store for dsh-ssh-workspace.
 *
 * Persists the servers DSH can open a remote workspace on. The file lives
 * beside the other DSH state (`$DSH_HOME/ssh-workspace.json`, mode 0600) and
 * is written atomically. Hosts already saved by the `@linxin666/dsh-ssh`
 * plugin (`$DSH_HOME/dsh-ssh.json`) are imported so one host list serves both.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'

export const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
export const DEFAULT_STORE_VERSION = 1

/** Resolve `$DSH_HOME`, matching the rest of DSH. */
export function dshHome() {
    return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function defaultStorePath() {
    return join(dshHome(), 'ssh-workspace.json')
}

/** Foreign stores we import hosts from, in priority order (ours wins). */
export function foreignStorePaths() {
    return [join(dshHome(), 'dsh-ssh.json')]
}

/** Normalize one host payload; throws with a human-readable reason when unusable. */
export function normalizeHost(input, previous) {
    if (input === null || typeof input !== 'object') throw new Error('host must be an object')
    const alias = String(input.alias ?? previous?.alias ?? '').trim()
    if (!ALIAS_RE.test(alias)) throw new Error(`invalid alias ${JSON.stringify(alias)}: use letters, digits, dot, dash or underscore`)
    const host = String(input.host ?? previous?.host ?? '').trim()
    if (!host) throw new Error(`host ${alias}: "host" is required`)
    const user = String(input.user ?? previous?.user ?? '').trim()
    if (!user) throw new Error(`host ${alias}: "user" is required`)
    const port = Number(input.port ?? previous?.port ?? 22)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`host ${alias}: "port" must be an integer in 1..65535`)
    const rootRaw = input.root ?? previous?.root ?? '/'
    const root = posix.normalize(String(rootRaw).startsWith('/') ? String(rootRaw) : `/${rootRaw}`)
    const auth = normalizeAuth(input.auth ?? previous?.auth, { alias, user, host })
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : (previous?.tags ?? [])
    const description = input.description ?? previous?.description
    const now = new Date().toISOString()
    return {
        alias,
        host,
        port,
        user,
        root,
        auth,
        description: description === undefined ? undefined : String(description),
        tags,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    }
}

/**
 * Map the flat field set shared by the model-facing tool and the browser
 * routes (`authKind` / `password` / `keyPath` / `passphrase`) onto the nested
 * payload {@link normalizeHost} reads. A nested `auth` object, when present,
 * wins; unknown keys are ignored.
 */
export function hostInputFromFields(fields) {
    if (fields === null || typeof fields !== 'object') throw new Error('host must be an object')
    const flatAuth =
        fields.authKind !== undefined || fields.password !== undefined || fields.keyPath !== undefined || fields.passphrase !== undefined || fields.agentPath !== undefined
    const auth =
        fields.auth ??
        (flatAuth
            ? {
                  kind: fields.authKind ?? (fields.password !== undefined ? 'password' : fields.keyPath !== undefined ? 'key' : 'agent'),
                  ...(fields.password !== undefined ? { password: fields.password } : {}),
                  ...(fields.keyPath !== undefined ? { keyPath: fields.keyPath } : {}),
                  ...(fields.passphrase !== undefined ? { passphrase: fields.passphrase } : {}),
                  ...(fields.agentPath !== undefined ? { agentPath: fields.agentPath } : {}),
              }
            : undefined)
    return {
        alias: fields.alias,
        host: fields.host,
        port: fields.port,
        user: fields.user,
        root: fields.root,
        description: fields.description,
        tags: fields.tags,
        ...(auth !== undefined ? { auth } : {}),
    }
}

function normalizeAuth(auth, { alias, user, host }) {
    const kind = auth?.kind ?? (auth?.password ? 'password' : auth?.keyPath ? 'key' : 'agent')
    if (!['agent', 'password', 'key'].includes(kind)) throw new Error(`host ${alias}: unknown auth kind ${kind}`)
    if (kind === 'password') {
        const password = auth?.password
        if (typeof password !== 'string' || password.length === 0) throw new Error(`host ${alias}: password auth needs "password"`)
        return { kind, password, user, host }
    }
    if (kind === 'key') {
        const keyPath = String(auth?.keyPath ?? '').trim()
        if (!keyPath) throw new Error(`host ${alias}: key auth needs "keyPath"`)
        return { kind, keyPath, ...(auth?.passphrase ? { passphrase: String(auth.passphrase) } : {}) }
    }
    return { kind: 'agent', ...(auth?.agentPath ? { agentPath: String(auth.agentPath) } : {}) }
}

/** Public projection of a host (never exposes the password). */
export function publicHost(host) {
    const auth = host.auth ?? { kind: 'agent' }
    return {
        alias: host.alias,
        host: host.host,
        port: host.port ?? 22,
        user: host.user,
        root: host.root ?? '/',
        auth:
            auth.kind === 'password'
                ? { kind: 'password', password: '***' }
                : auth.kind === 'key'
                  ? { kind: 'key', keyPath: auth.keyPath, hasPassphrase: Boolean(auth.passphrase) }
                  : { kind: 'agent', agentPath: auth.agentPath ?? process.env.SSH_AUTH_SOCK },
        description: host.description,
        tags: host.tags ?? [],
        updatedAt: host.updatedAt,
    }
}

/** Read a JSON file, returning undefined when absent or unparsable. */
function readJson(path) {
    if (!existsSync(path)) return undefined
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`cannot read ${path}: ${error.message}`)
    }
}

/**
 * Durable host store with mtime/size cache invalidation.
 */
export class HostStore {
    #path
    #hosts = new Map()
    #cacheKey = ''
    #logger

    constructor(options = {}) {
        this.#path = options.path ?? defaultStorePath()
        this.foreign = options.foreign ?? foreignStorePaths()
        this.#logger = options.logger
    }

    get path() {
        return this.#path
    }

    /** Re-read the file when the imported copies changed; returns the host list. */
    list() {
        this.#sync()
        return [...this.#hosts.values()]
    }

    get(alias) {
        this.#sync()
        return this.#hosts.get(alias)
    }

    has(alias) {
        this.#sync()
        return this.#hosts.has(alias)
    }

    /** Create or update a host, then persist. */
    save(input) {
        this.#sync()
        const aliasHint = String(input?.alias ?? '').trim()
        const previous = aliasHint ? this.#hosts.get(aliasHint) : undefined
        const host = normalizeHost(input, previous)
        this.#hosts.set(host.alias, host)
        this.#flush()
        return host
    }

    /** Remove a host; returns true when it existed. */
    remove(alias) {
        this.#sync()
        const existed = this.#hosts.delete(alias)
        if (existed) this.#flush()
        return existed
    }

    /** Force a re-read of our own file and of every foreign store. */
    reload() {
        this.#cacheKey = ''
        return this.list()
    }

    /** Host records from foreign stores that we do not already own. */
    #sync() {
        const own = statSync(this.#path, { throwIfNoEntry: false })
        const key = own ? `${own.mtimeMs}:${own.size}` : 'absent'
        const foreignKey = this.foreign
            .map((path) => {
                const stat = statSync(path, { throwIfNoEntry: false })
                return stat ? `${stat.mtimeMs}:${stat.size}` : 'absent'
            })
            .join('|')
        const cacheKey = `${key}#${foreignKey}`
        if (cacheKey === this.#cacheKey) return
        this.#cacheKey = cacheKey
        const hosts = new Map()
        for (const path of this.foreign) {
            const document = readJson(path)
            for (const raw of document?.hosts ?? []) {
                try {
                    const host = normalizeHost(raw)
                    if (!hosts.has(host.alias)) hosts.set(host.alias, { ...host, source: path })
                } catch (error) {
                    this.#logger?.warn?.(`ssh-workspace: ignoring host in ${path}: ${error.message}`)
                }
            }
        }
        const document = readJson(this.#path)
        for (const raw of document?.hosts ?? []) {
            try {
                hosts.set(raw.alias, normalizeHost(raw))
            } catch (error) {
                this.#logger?.warn?.(`ssh-workspace: ignoring host in ${this.#path}: ${error.message}`)
            }
        }
        this.#hosts = hosts
    }

    /** Atomic write: temp file in the same directory, then rename. */
    #flush() {
        const payload = JSON.stringify({ version: DEFAULT_STORE_VERSION, hosts: [...this.#hosts.values()] }, null, 2)
        mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
        const temporary = `${this.#path}.tmp-${process.pid}-${Date.now()}`
        try {
            writeFileSync(temporary, `${payload}\n`, { mode: 0o600 })
            renameSync(temporary, this.#path)
            chmodSync(this.#path, 0o600)
        } catch (error) {
            try {
                unlinkSync(temporary)
            } catch {
                /* the temp file was never created */
            }
            throw new Error(`cannot write ${this.#path}: ${error.message}`)
        }
        const stat = statSync(this.#path)
        this.#cacheKey = `${stat.mtimeMs}:${stat.size}#${this.foreign
            .map((path) => {
                const s = statSync(path, { throwIfNoEntry: false })
                return s ? `${s.mtimeMs}:${s.size}` : 'absent'
            })
            .join('|')}`
    }
}
