/**
 * dsh-ssh-workspace — browser half.
 *
 * Hand-written in the client module format (`window.__ModuleLoader__.load`),
 * so no bundler is needed: React comes from the host module system through
 * `require("react")`, everything else is plain DOM-free React elements.
 *
 * The panel manages the saved remote hosts (add / edit / delete / probe) and
 * owns the workspace-directory field. "连接" asks the host to open a session on
 * that server's `ssh-<alias>` preset and then navigates to it — a session's
 * preset is fixed at creation, so connecting always means a new session.
 */
window.__ModuleLoader__.load({
    id: 'dsh-ssh-workspace',
    factory: (require) => {
        var module = { exports: {} }
        var exports = module.exports
        const React = require('react')
        const h = React.createElement

        const API = '/api/dsh-ssh-workspace'
        const PANEL_ID = 'ssh-workspace'

        // --- host API --------------------------------------------------------

        async function request(path, options) {
            const response = await fetch(path, options)
            const text = await response.text()
            let payload
            try {
                payload = text === '' ? undefined : JSON.parse(text)
            } catch {
                payload = undefined
            }
            if (!response.ok) throw new Error((payload && payload.error) || `${response.status} ${response.statusText}`)
            return payload
        }

        const json = (value) => ({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(value),
        })

        const listHosts = async () => (await request(`${API}/hosts`)).hosts ?? []
        const saveHost = (host) => request(`${API}/hosts`, json(host))
        const removeHost = (alias) => request(`${API}/hosts?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
        const testHost = (alias) => request(`${API}/test`, json({ alias }))
        const reloadHosts = async () => (await request(`${API}/reload`, { method: 'POST' })).hosts ?? []
        const startSession = (alias) => request(`${API}/connect`, json({ alias }))
        const browseRemote = (target, path) => request(`${API}/browse`, json({ target, path }))

        // --- styles ----------------------------------------------------------

        const styles = {
            page: { padding: '16px 20px', overflowY: 'auto', height: '100%', font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif' },
            title: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
            hint: { opacity: 0.65, margin: '0 0 14px' },
            row: { border: '1px solid var(--dsh-border, rgba(128,128,128,.28))', borderRadius: 8, padding: '10px 12px', marginBottom: 8 },
            rowHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
            alias: { fontWeight: 600 },
            meta: { opacity: 0.7, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
            actions: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' },
            button: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            primary: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsh-accent, #3b82f6)', background: 'var(--dsh-accent, #3b82f6)', color: '#fff', cursor: 'pointer' },
            danger: { padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(220,80,80,.5)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            form: { border: '1px solid var(--dsh-border, rgba(128,128,128,.28))', borderRadius: 8, padding: '12px', marginTop: 12 },
            field: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 10px', alignItems: 'center', marginBottom: 8 },
            input: { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', width: '100%' },
            status: { padding: '6px 10px', borderRadius: 6, margin: '8px 0', background: 'rgba(128,128,128,.14)' },
            browser: { border: '1px solid var(--dsh-border, rgba(128,128,128,.28))', borderRadius: 8, padding: '10px 12px', marginTop: 10, maxHeight: 220, overflowY: 'auto' },
            browserHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
            link: { display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px', borderRadius: 6, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            error: { padding: '6px 10px', borderRadius: 6, margin: '8px 0', background: 'rgba(220,80,80,.16)' },
        }

        const EMPTY = { alias: '', host: '127.0.0.1', port: 22, user: '', authKind: 'agent', password: '', keyPath: '', passphrase: '', root: '/', description: '' }

        // --- components ------------------------------------------------------

        function Field(props) {
            return h(
                React.Fragment,
                null,
                h('label', { style: { opacity: 0.75 } }, props.label),
                props.children,
            )
        }

        function HostForm(props) {
            const [draft, setDraft] = React.useState(props.value)
            const [browser, setBrowser] = React.useState(null)
            const [browserBusy, setBrowserBusy] = React.useState(false)
            const [browserError, setBrowserError] = React.useState('')
            const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
            React.useEffect(() => setDraft(props.value), [props.value])
            const submit = () => props.onSubmit(draft)
            const listing = async (path) => {
                setBrowserBusy(true)
                setBrowserError('')
                try {
                    setBrowser(await props.browse(draft, path))
                } catch (reason) {
                    setBrowserError(String((reason && reason.message) || reason))
                } finally {
                    setBrowserBusy(false)
                }
            }
            const pick = (path) => {
                setDraft((current) => ({ ...current, root: path }))
                setBrowser(null)
                setBrowserError('')
            }
            const browserBox = () =>
                h(
                    'div',
                    { style: styles.browser },
                    h(
                        'div',
                        { style: styles.browserHead },
                        h('span', { style: styles.meta }, `远端目录：${browser.path}`),
                        h('span', null, h('button', { style: styles.button, disabled: browserBusy, onClick: () => pick(browser.path) }, '用此目录')),
                    ),
                    browserError ? h('div', { style: styles.error }, browserError) : null,
                    browser.parent
                        ? h('button', { style: styles.link, disabled: browserBusy, onClick: () => listing(browser.parent) }, '↑ 上一级')
                        : null,
                    browser.directories.length === 0
                        ? h('div', { style: styles.hint }, '（没有子目录）')
                        : browser.directories.map((entry) =>
                              h(
                                  'button',
                                  { key: entry.path, style: styles.link, disabled: browserBusy, onClick: () => listing(entry.path) },
                                  `📁 ${entry.name}`,
                              ),
                          ),
                )
            return h(
                'div',
                { style: styles.form },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, props.editing ? `编辑 ${props.value.alias}` : '新增远程服务器'),
                h(
                    'div',
                    { style: styles.field },
                    h(Field, { label: '别名 alias' }, h('input', { style: styles.input, value: draft.alias, onChange: set('alias'), placeholder: 'my-server' })),
                    h(Field, { label: '主机 host' }, h('input', { style: styles.input, value: draft.host, onChange: set('host'), placeholder: '10.0.0.5' })),
                    h(Field, { label: '端口 port' }, h('input', { style: styles.input, value: draft.port, onChange: set('port'), placeholder: '22' })),
                    h(Field, { label: '用户 user' }, h('input', { style: styles.input, value: draft.user, onChange: set('user'), placeholder: 'root' })),
                    h(
                        Field,
                        { label: '认证方式' },
                        h(
                            'select',
                            { style: styles.input, value: draft.authKind, onChange: set('authKind') },
                            h('option', { value: 'agent' }, 'agent (ssh-agent)'),
                            h('option', { value: 'password' }, 'password'),
                            h('option', { value: 'key' }, 'key (私钥文件)'),
                        ),
                    ),
                    draft.authKind === 'password' ? h(Field, { label: '密码' }, h('input', { style: styles.input, type: 'password', value: draft.password, onChange: set('password') })) : null,
                    draft.authKind === 'key' ? h(Field, { label: '私钥路径' }, h('input', { style: styles.input, value: draft.keyPath, onChange: set('keyPath'), placeholder: '~/.ssh/id_ed25519' })) : null,
                    h(Field, { label: '工作目录 root' }, h('input', { style: styles.input, value: draft.root, onChange: set('root'), placeholder: '/root' })),
                    h(Field, { label: '备注' }, h('input', { style: styles.input, value: draft.description, onChange: set('description') })),
                ),
                h(
                    'div',
                    { style: { opacity: 0.65, margin: '2px 0 10px' } },
                    '「工作目录」就是该会话的 workspace 根目录：文件读写与 bash 都落在远端这个目录下。不确定就点「浏览远端目录」选一个。',
                ),
                h(
                    'div',
                    { style: styles.actions },
                    h('button', { style: styles.primary, onClick: submit }, '保存'),
                    h('button', { style: styles.button, disabled: browserBusy, onClick: () => listing(draft.root) }, '浏览远端目录'),
                    h('button', { style: styles.button, onClick: () => props.onCancel() }, '取消'),
                ),
                browser ? browserBox() : null,
            )
        }

        function HostRow(props) {
            const host = props.host
            const auth = host.auth && host.auth.kind === 'key' ? `key ${host.auth.keyPath}` : (host.auth && host.auth.kind) || 'agent'
            return h(
                'div',
                { style: styles.row },
                h(
                    'div',
                    { style: styles.rowHead },
                    h('span', { style: styles.alias }, host.alias),
                    h('span', { style: styles.meta }, `${host.user}@${host.host}:${host.port}  ·  ${auth}`),
                ),
                h('div', { style: styles.meta }, `workspace root: ${host.root}  ·  preset: ssh-${host.alias}`),
                host.description ? h('div', { style: { opacity: 0.7 } }, host.description) : null,
                h(
                    'div',
                    { style: styles.actions },
                    h('button', { style: styles.primary, disabled: props.busy, onClick: () => props.onConnect(host.alias) }, '连接'),
                    h('button', { style: styles.button, disabled: props.busy, onClick: () => props.onTest(host.alias) }, '测试连接'),
                    h('button', { style: styles.button, disabled: props.busy, onClick: () => props.onEdit(host) }, '编辑'),
                    h('button', { style: styles.danger, disabled: props.busy, onClick: () => props.onRemove(host.alias) }, '删除'),
                ),
            )
        }

        function Panel(props) {
            const [hosts, setHosts] = React.useState(null)
            const [draft, setDraft] = React.useState(EMPTY)
            const [editing, setEditing] = React.useState(false)
            const [busy, setBusy] = React.useState(false)
            const [formOpen, setFormOpen] = React.useState(false)
            const [status, setStatus] = React.useState('')
            const [error, setError] = React.useState('')

            const refresh = async () => {
                try {
                    setHosts(await listHosts())
                    setError('')
                } catch (reason) {
                    setError(String((reason && reason.message) || reason))
                }
            }
            React.useEffect(() => {
                refresh()
            }, [])

            const guard = async (work, busyMessage) => {
                setBusy(true)
                setStatus(busyMessage || '')
                setError('')
                try {
                    await work()
                } catch (reason) {
                    setError(String((reason && reason.message) || reason))
                } finally {
                    setBusy(false)
                }
            }

            const open = (sessionId) => {
                if (typeof props.openSession === 'function') return props.openSession(sessionId)
                return undefined
            }

            return h(
                'div',
                { style: styles.page },
                h('h2', { style: styles.title }, 'SSH 远程工作区'),
                h('p', { style: styles.hint }, '把一台远程服务器保存成 Agent preset「ssh-<别名>」，新会话的文件与命令就都跑在那台服务器的工作目录里。'),
                error ? h('div', { style: styles.error }, error) : null,
                status ? h('div', { style: styles.status }, status) : null,
                hosts === null
                    ? h('div', { style: styles.hint }, '加载中…')
                    : hosts.length === 0
                      ? h('div', { style: styles.hint }, '还没有保存任何远程服务器。')
                      : hosts.map((host) =>
                            h(HostRow, {
                                key: host.alias,
                                host,
                                busy,
                                onConnect: (alias) =>
                                    guard(async () => {
                                        const started = await startSession(alias)
                                        setStatus(
                                            `已创建远程会话 ${started.sessionId}：workspace root ${started.root}` +
                                                (started.anchor ? `（本地锚点 ${started.anchor}）` : '') +
                                                '。',
                                        )
                                        await open(started.sessionId)
                                    }, '正在创建远程会话…'),
                                onTest: (alias) => guard(async () => setStatus((await testHost(alias)).message), '正在测试连接…'),
                                onEdit: (host) => {
                                    setDraft({
                                        alias: host.alias,
                                        host: host.host,
                                        port: host.port,
                                        user: host.user,
                                        authKind: (host.auth && host.auth.kind) || 'agent',
                                        password: '',
                                        keyPath: (host.auth && host.auth.keyPath) || '',
                                        passphrase: '',
                                        root: host.root,
                                        description: host.description || '',
                                    })
                                    setEditing(true)
                                    setFormOpen(true)
                                },
                                onRemove: (alias) =>
                                    guard(async () => {
                                        await removeHost(alias)
                                        setStatus(`已删除 ${alias}。`)
                                        await refresh()
                                    }),
                            }),
                        ),
                h(
                    'div',
                    { style: styles.actions },
                    h('button', { style: styles.button, disabled: busy, onClick: () => { setDraft(EMPTY); setEditing(false); setFormOpen(true) } }, '新增服务器'),
                    h('button', { style: styles.button, disabled: busy, onClick: () => guard(async () => { setHosts(await reloadHosts()); setStatus('已重新读取主机列表。') }) }, '重新加载'),
                ),
                formOpen
                    ? h(HostForm, {
                          value: draft,
                          editing,
                          browse: browseRemote,
                          onCancel: () => {
                              setDraft(EMPTY)
                              setEditing(false)
                              setFormOpen(false)
                          },
                          onSubmit: (value) =>
                              guard(async () => {
                                  const port = Number(value.port)
                                  const payload = {
                                      alias: value.alias,
                                      host: value.host,
                                      port: Number.isFinite(port) && port > 0 ? port : 22,
                                      user: value.user,
                                      root: value.root,
                                      description: value.description,
                                      authKind: value.authKind,
                                      ...(value.authKind === 'password' ? { password: value.password } : {}),
                                      ...(value.authKind === 'key' ? { keyPath: value.keyPath, ...(value.passphrase ? { passphrase: value.passphrase } : {}) } : {}),
                                  }
                                  const saved = await saveHost(payload)
                                  setStatus(`已保存 ${saved.host.alias}：${saved.host.user}@${saved.host.host}:${saved.host.port}，workspace root ${saved.host.root}。点「连接」即可开一个远程会话。`)
                                  setDraft(EMPTY)
                                  setEditing(false)
                                  setFormOpen(false)
                                  await refresh()
                              }),
                      })
                    : null,
            )
        }

        // The panellist slot renders `label()` itself, so this component is the
        // icon only — rendering the title here duplicated the entry name.
        function SidebarEntry() {
            return h('span', { style: { fontSize: 15, lineHeight: 1 } }, '🖧')
        }

        // --- plugin ----------------------------------------------------------

        const inject = ['slots']

        function apply(ctx) {
            const slots = ctx.slots
            if (slots === undefined) return
            // The panel's "连接" button navigates the main column to the session
            // the host just created (the layout service owns that selection).
            // The session catalog is fed by list snapshots, so a brand-new id is
            // unknown to it until a refresh — `sessions.retain: unknown session`
            // otherwise comes back from the workspace view.
            const reveal = (sessionId) => {
                const uiWorkspace = ctx.get('uiWorkspace')
                if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
                    uiWorkspace.openSession(sessionId)
                    return
                }
                const layout = ctx.get('layout')
                if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
            }
            const openSession = async (sessionId) => {
                const sessions = ctx.get('sessions')
                if (sessions !== undefined && typeof sessions.refresh === 'function') {
                    try {
                        await sessions.refresh()
                    } catch {
                        /* navigate anyway: the view may still resolve the id */
                    }
                }
                reveal(sessionId)
            }
            ctx.effect(
                () =>
                    slots.inject('sidebar.panellist', () =>
                        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => 'SSH 远程工作区' }, SidebarEntry),
                    ),
                'dsh-ssh-workspace: sidebar entry',
            )
            ctx.effect(
                () => slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ openSession }) }, Panel)),
                'dsh-ssh-workspace: panel',
            )
        }

        exports.apply = apply
        exports.inject = inject
        return module.exports
    },
})
