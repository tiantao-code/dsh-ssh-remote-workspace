/**
 * A long-lived test SSH server for live verification of the plugin inside a
 * real DSH host: `node test/standalone-sshd.mjs [port] [root]`.
 *
 * It is transparent (remote paths are real host paths) and password-gated; its
 * SFTP side refuses anything outside `root`.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { startTestSshServer } from './sshd.mjs'

const port = Number(process.argv[2] ?? process.env.SSH_TEST_PORT ?? 2222)
const root = resolve(process.argv[3] ?? process.env.SSH_TEST_ROOT ?? '/tmp/dsh-ssh-ws-live')
mkdirSync(root, { recursive: true })

const server = await startTestSshServer({ root, port })
console.log(`READY port=${server.port} root=${server.root} user=tester password=secret`)

const stop = async () => {
    await server.close()
    process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
