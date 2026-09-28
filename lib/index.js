/**
 * dsh-ssh-workspace — host plane.
 *
 * Owns the saved remote-host list (`ctx.sshWorkspace`), the model-facing
 * `ssh_workspace` tool, and one Agent preset per saved host
 * (`ssh-<alias>`). Each preset is composed from `preset-remote.yml` with its
 * workspace rows moved inside an `isolate` group that supplies the SSH-backed
 * `ctx.fs` and `ctx.shell`, so selecting that preset gives the session a
 * workspace on the remote server.
 *
 * @module dsh-ssh-workspace
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HostStore, dshHome, hostInputFromFields, normalizeHost, publicHost } from './store.js'
import { SshConnection, describeHost } from './ssh.js'
import { presetForHost } from './preset.js'
import { makeWorkspaceRoutes } from './routes.js'

const TOOL_NAME = 'ssh_workspace'

const DESCRIPTION = `Save and inspect the remote SSH servers DSH can open a workspace on.
Each saved server also becomes an Agent preset named "ssh-<alias>"; starting a session with that preset replaces the local filesystem and shell with that server's, so the read/write/edit/glob/grep tools and bash all operate there.
Use action "save" to add or update a server, "list" to show what is saved, "test" to verify a connection, and "remove" to forget one.
Triggers: ssh host, remote server, remote workspace, save server, connect over ssh.`

/**
 * The saved-host service, exposed to the rest of the host composition and to
 * every preset as `ctx.sshWorkspace`.
 */
export class SshWorkspaceRegistry extends Service {
    static inject = ['tools']

    static Config = z.object({
        /** Override the store path (defaults to `$DSH_HOME/ssh-workspace.json`). */
        store: z.string(),
        /** Import hosts saved by other SSH plugins (default true). */
        importForeign: z.boolean().default(true),
        /** Register one Agent preset per saved host (default true). */
        presets: z.boolean().default(true),
    })

    constructor(ctx, config) {
        super(ctx, 'sshWorkspace')
        this.config = config ?? {}
        this.store = new HostStore({
            path: this.config.store,
            ...(this.config.importForeign === false ? { foreign: [] } : {}),
            logger: ctx.logger,
        })
        this.presets = new Map()
        this.registerTool()
        ctx.inject(['webServer'], (scope) => {
            scope.effect(() => {
                const disposers = makeWorkspaceRoutes(this)
                    .map((route) => scope.webServer.register(route))
                    .filter((dispose) => typeof dispose === 'function')
                return () => {
                    for (const dispose of disposers) dispose()
                }
            })
        })
        ctx.inject(['sessionController'], (scope) => {
            this.sessionController = scope.sessionController
        })
        ctx.inject(['workspaceRegistry'], (scope) => {
            this.workspaceRegistry = scope.workspaceRegistry
        })
        ctx.inject(['agentPresets'], (scope) => {
            this.presetService = scope.agentPresets
            scope.effect(() => () => {
                this.presets.clear()
            })
            void this.syncPresets()
        })
        ctx.logger.info(
            `dsh-ssh-workspace: ${this.store.list().length} saved remote host(s); tool "${TOOL_NAME}" and an "ssh-<alias>" Agent preset per host`,
        )
    }

    // --- service surface -----------------------------------------------------

    /** Every saved host record. */
    list() {
        return this.store.list()
    }

    /** One host record, or undefined. */
    get(alias) {
        return this.store.get(alias)
    }

    /** Create or update a host; refreshes the preset roster. */
    async save(input) {
        const host = this.store.save(input)
        await this.syncPresets()
        return host
    }

    /** Forget a host; refreshes the preset roster. */
    async remove(alias) {
        const existed = this.store.remove(alias)
        if (existed) await this.syncPresets()
        return existed
    }

    /** Re-read the store, then refresh the preset roster. */
    async reload() {
        this.store.reload()
        await this.syncPresets()
        return this.list()
    }

    /**
     * Open a throwaway connection to verify credentials and the root. The probe
     * is deliberately fast (one attempt, 8s handshake budget): it answers the
     * panel's "测试连接" button instead of stalling behind the reconnect policy
     * a long-lived session connection uses.
     */
    async test(alias) {
        const host = this.store.get(alias)
        if (host === undefined) throw new Error(`unknown remote host "${alias}"`)
        const connection = new SshConnection(() => this.store.get(alias) ?? host, this.ctx.logger, { attempts: 1, readyTimeoutMs: 8000 })
        try {
            const sftp = await connection.sftp()
            const stats = await new Promise((resolve, reject) => {
                sftp.stat(host.root ?? '/', (error, value) => (error ? reject(error) : resolve(value)))
            })
            if (typeof stats.isDirectory !== 'function' || !stats.isDirectory()) {
                throw new Error(`${host.root ?? '/'} is not a directory on the remote host`)
            }
            return `${describeHost(host)} reachable; workspace root ${host.root ?? '/'} exists.`
        } finally {
            await connection.dispose()
        }
    }

    /**
     * Start a session on this host's preset and return its id. A session's
     * Agent preset is fixed when it is created, so "connecting" to a remote
     * server always means opening a new session on `ssh-<alias>`; the browser
     * half navigates to the returned id.
     *
     * The session's own working directory must be a LOCAL directory: the
     * workspace registry stats and creates it with `node:fs`, so a remote root
     * can never be the recorded path. Each host therefore gets a dedicated
     * anchor directory under `$DSH_HOME/ssh-workspaces/<alias>` (holding a
     * marker that names the remote root) and a workspace titled
     * `SSH · <alias> → <root>`; the preset remaps that directory onto the
     * remote root for every read, write and command.
     */
    async connect(alias) {
        const host = this.store.get(alias)
        if (host === undefined) throw new Error(`unknown remote host "${alias}"`)
        const preset = `ssh-${host.alias}`
        await this.syncPresets()
        const roster = await this.presetService?.list()
        const row = roster?.find((entry) => entry.id === preset)
        if (row !== undefined && row.broken !== undefined) throw new Error(`preset "${preset}" is unusable: ${row.broken}`)
        const controller = this.sessionController ?? this.ctx.get('sessionController')
        if (controller === undefined) throw new Error('the session controller is unavailable; start the session from the Agent preset picker instead')
        const anchor = await this.anchorDirectory(host)
        const workspace = await this.anchorWorkspace(host, anchor)
        const created = await controller.create({
            agentPreset: preset,
            ...(workspace === undefined ? { cwd: anchor } : { workspaceId: workspace.id }),
        })
        return {
            sessionId: created.sessionId,
            agentPreset: created.agentPreset ?? preset,
            alias: host.alias,
            root: host.root,
            anchor,
            ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        }
    }

    /**
     * Ensure this host's local session anchor exists and describes the remote
     * root it stands for.
     * @returns the anchor directory path.
     */
    async anchorDirectory(host) {
        const directory = join(dshHome(), 'ssh-workspaces', host.alias)
        await mkdir(directory, { recursive: true })
        const marker = join(directory, '.dsh-ssh-workspace.json')
        const payload = {
            alias: host.alias,
            host: host.host,
            port: host.port,
            user: host.user,
            root: host.root,
            preset: `ssh-${host.alias}`,
            note: 'This directory is only the local anchor of a remote workspace: the ssh-<alias> preset remaps it onto `root` on the server.',
        }
        await writeFile(marker, `${JSON.stringify(payload, null, 2)}\n`)
        return directory
    }

    /**
     * Register (or reuse) the DSH workspace that presents this host in the
     * sidebar. Workspaces are keyed by their canonical local path, so the title
     * is applied when the record is first created.
     */
    async anchorWorkspace(host, anchor) {
        const registry = this.workspaceRegistry ?? this.ctx.get('workspaceRegistry')
        if (registry === undefined || typeof registry.create !== 'function') return undefined
        try {
            return await registry.create(anchor, `SSH · ${host.alias} → ${host.root}`)
        } catch (error) {
            this.ctx.logger.warn(`dsh-ssh-workspace: could not register the workspace for "${host.alias}": ${error?.message ?? error}`)
            return undefined
        }
    }

    /**
     * List the directories inside a remote path, for the panel's workspace-root
     * picker. The target may be a saved alias or a full set of host fields, so
     * the form can browse before the host is saved.
     * @param target - saved alias, or an inline host payload.
     * @param path - remote directory to list; defaults to the host's root.
     * @returns `{path, parent, directories}`.
     */
    async browse(target, path) {
        const alias = typeof target === 'string' && target !== '' ? target : undefined
        const saved = alias === undefined ? undefined : this.store.get(alias)
        let host = saved
        if (host === undefined) {
            if (target === undefined || target === null || target === '') throw new Error(`unknown remote host "${String(target)}"`)
            const fields = hostInputFromFields(target)
            // A host that has not been saved yet has no alias; browsing only
            // needs one as a label, so fill in a placeholder instead of failing.
            if (String(fields.alias ?? '').trim() === '') fields.alias = 'unsaved'
            host = normalizeHost(fields, undefined)
        }
        const requested = typeof path === 'string' && path.trim() !== '' ? path.trim() : (host.root ?? '/')
        const connection = new SshConnection(() => (alias === undefined ? host : (this.store.get(alias) ?? host)), this.ctx.logger, {
            attempts: 1,
            readyTimeoutMs: 8000,
        })
        try {
            const sftp = await connection.sftp()
            const current = posix.resolve(requested)
            const entries = await new Promise((resolve, reject) => {
                sftp.readdir(current, (error, list) => (error ? reject(error) : resolve(list)))
            })
            const directories = entries
                .filter((entry) => entry.attrs?.isDirectory?.() === true)
                .map((entry) => ({ name: entry.filename, path: posix.join(current, entry.filename) }))
                .sort((left, right) => left.name.localeCompare(right.name))
            return { path: current, parent: current === '/' ? null : posix.dirname(current), directories }
        } finally {
            await connection.dispose()
        }
    }

    // --- preset roster -------------------------------------------------------

    /**
     * Register one preset per saved host and drop presets for hosts that are
     * gone. Presets are declared lazily on the host plane, so a remote server
     * being down never blocks the composition from loading.
     */
    async syncPresets() {
        const service = this.presetService
        if (service === undefined || this.config.presets === false) return
        try {
            const wanted = new Map(this.store.list().map((host) => [`ssh-${host.alias}`, host]))
            for (const [id, entry] of [...this.presets]) {
                if (wanted.has(id)) continue
                this.presets.delete(id)
                await entry.dispose()
            }
            for (const [id, host] of wanted) {
                const signature = JSON.stringify([host.host, host.port, host.user, host.root, host.alias])
                const existing = this.presets.get(id)
                if (existing !== undefined && existing.signature === signature) continue
                if (existing !== undefined) {
                    this.presets.delete(id)
                    await existing.dispose()
                }
                const dispose = await service.register(presetForHost(host))
                this.presets.set(id, { dispose, signature })
            }
            const roster = await service.list()
            const broken = roster.filter((row) => row.broken !== undefined && this.presets.has(row.id))
            for (const row of broken) this.ctx.logger.warn(`dsh-ssh-workspace: preset ${row.id} is unusable: ${row.broken}`)
            if (this.presets.size > 0) {
                this.ctx.logger.info(`dsh-ssh-workspace: remote workspace presets ready: ${[...this.presets.keys()].join(', ')}`)
            }
        } catch (error) {
            this.ctx.logger.warn(`dsh-ssh-workspace: could not register remote workspace presets: ${error?.message ?? error}`)
        }
    }

    // --- model-facing tool ---------------------------------------------------

    registerTool() {
        const tool = defineTool({
            name: TOOL_NAME,
            description: DESCRIPTION,
            parameters: {
                action: {
                    type: 'string',
                    required: true,
                    enum: ['list', 'save', 'remove', 'test', 'reload'],
                    description: 'Operation to perform.',
                },
                alias: { type: 'string', description: 'Short name for the server, used in the preset name "ssh-<alias>" (save/remove/test).' },
                host: { type: 'string', description: 'Hostname or IP address (save).' },
                port: { type: 'number', description: 'SSH port, default 22 (save).' },
                user: { type: 'string', description: 'Login user (save).' },
                authKind: { type: 'string', enum: ['agent', 'password', 'key'], description: 'Authentication method, default agent (save).' },
                password: { type: 'string', description: 'Password for authKind "password" (save).' },
                keyPath: { type: 'string', description: 'Local private key path for authKind "key" (save).' },
                passphrase: { type: 'string', description: 'Passphrase for that private key (save).' },
                root: { type: 'string', description: 'Remote directory that becomes the workspace root, default "/" (save).' },
                description: { type: 'string', description: 'Free-form note about the server (save).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Labels for the server (save).' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        message: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.message }],
            },
            execute: async (args, exec) => {
                return await this.run(args, exec.signal)
            },
        })
        this.ctx.effect(() => this.ctx.tools.register(tool))
    }

    async run(args, signal) {
        signal?.throwIfAborted?.()
        switch (args.action) {
            case 'list':
            case 'reload': {
                const hosts = args.action === 'reload' ? await this.reload() : this.list()
                if (hosts.length === 0) {
                    return { ok: true, message: 'No remote host is saved yet. Use action "save" with alias, host and user.' }
                }
                const lines = hosts.map((raw) => {
                    const host = publicHost(raw)
                    const auth = host.auth.kind === 'key' ? `key ${host.auth.keyPath}` : host.auth.kind
                    return `- ${host.alias}: ${host.user}@${host.host}:${host.port} (${auth}), root ${host.root}, preset "ssh-${host.alias}"${host.description ? ` — ${host.description}` : ''}`
                })
                return { ok: true, message: `Saved remote hosts:\n${lines.join('\n')}` }
            }
            case 'save': {
                const host = await this.save({
                    alias: args.alias,
                    host: args.host,
                    port: args.port,
                    user: args.user,
                    root: args.root,
                    description: args.description,
                    tags: args.tags,
                    ...(args.authKind !== undefined || args.password !== undefined || args.keyPath !== undefined || args.passphrase !== undefined
                        ? {
                              auth: {
                                  kind: args.authKind ?? (args.password !== undefined ? 'password' : args.keyPath !== undefined ? 'key' : 'agent'),
                                  ...(args.password !== undefined ? { password: args.password } : {}),
                                  ...(args.keyPath !== undefined ? { keyPath: args.keyPath } : {}),
                                  ...(args.passphrase !== undefined ? { passphrase: args.passphrase } : {}),
                              },
                          }
                        : {}),
                })
                return {
                    ok: true,
                    message: `Saved ${host.alias}: ${describeHost(host)} with workspace root ${host.root}. Start a session with the Agent preset "ssh-${host.alias}" to work on it; every file path and command then runs on that server.`,
                }
            }
            case 'remove': {
                const existed = await this.remove(args.alias)
                return {
                    ok: existed,
                    message: existed
                        ? `Removed ${args.alias} and its "ssh-${args.alias}" preset.`
                        : `No saved remote host named "${args.alias}".`,
                }
            }
            case 'test': {
                const message = await this.test(args.alias)
                return { ok: true, message }
            }
            default:
                return { ok: false, message: `Unknown action "${args.action}". Use list, save, remove, test or reload.` }
        }
    }
}

export default SshWorkspaceRegistry
