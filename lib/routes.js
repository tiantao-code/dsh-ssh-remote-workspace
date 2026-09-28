/**
 * dsh-ssh-workspace — host HTTP surface.
 *
 * The browser half (lib/client.js) is a plain same-origin fetch client, so
 * every operation it needs is one exact route here: host CRUD, connectivity
 * test, store reload, and "connect" (create a session on the `ssh-<alias>`
 * preset and hand its id back to the client, which navigates to it).
 *
 * Every route carries a loopback-only fence: these endpoints write host
 * credentials and start sessions, so a LAN-exposed `dsh web` must not serve
 * them.
 *
 * @module dsh-ssh-workspace/routes
 */
import { hostInputFromFields, publicHost } from './store.js'

/** Declared request-body cap for JSON payloads. */
const MAX_JSON_BYTES = 1024 * 1024

/** True when the request arrived over the loopback interface. */
function isLoopbackRequest(req) {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function writeJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    })
    res.end(body)
}

/** Read and parse a JSON request body (undefined body parses as null). */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_JSON_BYTES) {
                reject(new Error(`request body exceeds ${MAX_JSON_BYTES} bytes`))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim()
            if (text === '') {
                resolve(null)
                return
            }
            try {
                resolve(JSON.parse(text))
            } catch (error) {
                reject(new Error(`invalid JSON body: ${error?.message ?? error}`))
            }
        })
        req.on('error', reject)
    })
}

/** Human-readable message for any thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Build the /api/dsh-ssh-workspace route family.
 * @param registry - the host-plane `sshWorkspace` service.
 * @returns exact WebRoutes for `ctx.webServer.register`.
 */
export function makeWorkspaceRoutes(registry) {
    /** Loopback fence + method dispatch shared by every route. */
    const handle = (methods, fn) => async (req, res) => {
        if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' })
            return
        }
        const method = req.method ?? 'GET'
        if (!methods.includes(method)) {
            writeJson(res, 405, { error: `method not allowed: ${method}` })
            return
        }
        try {
            await fn(req, res, method)
        } catch (error) {
            writeJson(res, 400, { error: messageOf(error) })
        }
    }

    return [
        {
            kind: 'exact',
            path: '/api/dsh-ssh-workspace/hosts',
            handler: handle(['GET', 'POST', 'DELETE'], async (req, res, method) => {
                const url = new URL(req.url ?? '/', 'http://localhost')
                if (method === 'GET') {
                    writeJson(res, 200, { hosts: registry.list().map(publicHost) })
                    return
                }
                if (method === 'POST') {
                    const body = await readJsonBody(req)
                    const host = await registry.save(hostInputFromFields(body ?? {}))
                    writeJson(res, 200, { host: publicHost(host) })
                    return
                }
                const alias = url.searchParams.get('alias') ?? ''
                if (alias === '') throw new Error('query parameter "alias" is required')
                const removed = await registry.remove(alias)
                writeJson(res, 200, { removed })
            }),
        },
        {
            kind: 'exact',
            path: '/api/dsh-ssh-workspace/test',
            handler: handle(['POST'], async (req, res) => {
                const body = await readJsonBody(req)
                const alias = body?.alias
                if (typeof alias !== 'string' || alias === '') throw new Error('field "alias" is required')
                const message = await registry.test(alias)
                writeJson(res, 200, { ok: true, message })
            }),
        },
        {
            kind: 'exact',
            path: '/api/dsh-ssh-workspace/reload',
            handler: handle(['POST'], async (_req, res) => {
                const hosts = await registry.reload()
                writeJson(res, 200, { hosts: hosts.map(publicHost) })
            }),
        },
        {
            kind: 'exact',
            path: '/api/dsh-ssh-workspace/browse',
            handler: handle(['POST'], async (req, res) => {
                const body = await readJsonBody(req)
                // `target` is either a saved alias or a full set of host fields,
                // so the panel can browse before saving; a bare `alias` stays
                // accepted for compatibility.
                const target = body?.target ?? body?.alias
                if (target === undefined || target === null || target === '') throw new Error('field "target" or "alias" is required')
                const listing = await registry.browse(target, body?.path)
                writeJson(res, 200, listing)
            }),
        },
        {
            kind: 'exact',
            path: '/api/dsh-ssh-workspace/connect',
            handler: handle(['POST'], async (req, res) => {
                const body = await readJsonBody(req)
                const alias = body?.alias
                if (typeof alias !== 'string' || alias === '') throw new Error('field "alias" is required')
                const started = await registry.connect(alias)
                writeJson(res, 200, started)
            }),
        },
    ]
}
