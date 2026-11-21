import './bridge'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings, Snapshot, TaskReport } from './types'
import './styles.css'

const stateNames: Record<string, string> = {
    idle: '等待运行',
    sleeping: '按需启动',
    running: '任务运行中',
    starting: '正在启动',
    stopping: '正在停止',
    login: '等待浏览器登录',
    scanning: '正在检查任务状态',
    balance: '正在查询积分余额',
    offline: '后台未连接',
    saving: '保存设置中',
    restarting: '重启后台中',
    clearing: '清除数据中',
    exiting: '正在退出'
}
const taskNames: Record<string, string> = {
    completed: '已完成',
    skipped: '已跳过',
    failed: '失败',
    manual: '需手动处理',
    unconfirmed: '未确认'
}
const formatTime = (value?: string | null) => (value ? new Date(value).toLocaleString('zh-CN') : '暂无')

function ReportSummary({ tasks }: Pick<TaskReport, 'tasks'>) {
    const completed = tasks.filter(task => task.status === 'completed').length
    const skipped = tasks.filter(task => task.status === 'skipped').length
    const needsReview = tasks.filter(task => !['completed', 'skipped'].includes(task.status))
    const titles = [...new Set(needsReview.map(task => task.title))]
    return (
        <div>
            <p>
                完成 {completed} 项，正常跳过 {skipped} 项
            </p>
            <p className={needsReview.length ? 'notice' : 'muted'}>
                {needsReview.length
                    ? `需要检查 ${needsReview.length} 项：${titles.slice(0, 3).join('、')}${titles.length > 3 ? '等' : ''}（原因见明细）`
                    : '本报告各项均已完成或跳过；跳过原因请查看明细。'}
            </p>
        </div>
    )
}

function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
    const [settings, setSettings] = useState<Settings | null>(null)
    const [tab, setTab] = useState('overview')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [failed, setFailed] = useState(false)
    const [selectedAccount, setSelectedAccount] = useState('')
    const [reportAccount, setReportAccount] = useState('')
    const [updateBusy, setUpdateBusy] = useState(false)

    useEffect(() => {
        const update = (value: Snapshot) => {
            setSnapshot(value)
            setSettings(previous => previous ?? value.settings)
        }
        const unsubscribe = window.desktop.onState(update)
        window.desktop
            .snapshot()
            .then(update)
            .catch(error => {
                setFailed(true)
                setMessage(error.message)
            })
        return unsubscribe
    }, [])

    useEffect(() => {
        const last = snapshot?.accounts.at(-1)
        if (last) setSelectedAccount(last.id)
    }, [snapshot?.accounts.length])

    async function act(action: () => Promise<unknown>, success = '') {
        setBusy(true)
        setMessage('')
        setFailed(false)
        try {
            await action()
            const value = await window.desktop.snapshot()
            setSnapshot(value)
            setSettings(value.settings)
            setMessage(success)
        } catch (error) {
            setFailed(true)
            setMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy(false)
        }
    }

    async function updateApp(action: () => Promise<unknown>) {
        setUpdateBusy(true)
        try {
            await action()
        } catch {
            // The updater publishes its own error and retry state.
        } finally {
            try {
                setSnapshot(await window.desktop.snapshot())
            } catch (error) {
                setFailed(true)
                setMessage(error instanceof Error ? error.message : String(error))
            }
            setUpdateBusy(false)
        }
    }

    if (!snapshot || !settings)
        return (
            <main className="loading">
                <h1>Rewards Desktop</h1>
                <p>{message || '正在连接桌面服务…'}</p>
            </main>
        )
    const idle = ['idle', 'sleeping'].includes(snapshot.state) && !snapshot.queue?.running
    const accountLabel = (email?: string) => {
        const account = snapshot.accounts.find(a => a.email === email)
        return (
            account?.name ||
            (email === 'local@rewards.invalid'
                ? '账户 1'
                : email?.endsWith('@rewards.invalid')
                  ? `账户 ${email.slice(8, 16)}`
                  : email) ||
            '未知账户'
        )
    }
    const currentAccount = snapshot.accounts.find(a => a.id === selectedAccount) || snapshot.accounts[0]
    const knownBalances = snapshot.accounts.filter(a => a.balance.value !== null)
    const totalBalance = knownBalances.reduce((sum, a) => sum + (a.balance.value ?? 0), 0)
    const reports = snapshot.reports.filter(r => !reportAccount || r.account === reportAccount).slice(0, 20)

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="brand">
                    <span className="brand-icon">R</span>
                    <div>
                        Rewards<span className="brand-sub">DESKTOP</span>
                    </div>
                </div>
                <nav aria-label="主导航">
                    {[
                        ['overview', '任务总览'],
                        ['results', '运行结果'],
                        ['settings', '应用设置']
                    ].map(([id, label]) => (
                        <button key={id} className={tab === id ? 'nav active' : 'nav'} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-bottom">
                    <span className={snapshot.backendReady ? 'dot online' : 'dot'} />
                    {snapshot.backendReady
                        ? '本地服务已连接'
                        : snapshot.state === 'offline'
                          ? '本地服务未连接'
                          : '任务后台按需启动'}
                    <small>v{snapshot.version} · 桌面版</small>
                </div>
            </aside>
            <main className="content">
                <header>
                    <div>
                        <p className="eyebrow">MICROSOFT REWARDS</p>
                        <h1>{{ overview: '任务总览', results: '运行结果', settings: '应用设置' }[tab]}</h1>
                    </div>
                    <span className="state-pill">{stateNames[snapshot.state] || snapshot.state}</span>
                </header>
                {(message || snapshot.error) && (
                    <div role="status" className={failed || snapshot.error ? 'notice error' : 'notice'}>
                        {message || snapshot.error}
                    </div>
                )}
                {snapshot.review && (
                    <div role="status" className="notice">
                        <p>{snapshot.review}</p>
                        <button onClick={() => setTab('results')}>查看运行结果</button>
                        <button disabled={busy} onClick={() => void act(() => window.desktop.exportDiagnostics())}>
                            导出诊断
                        </button>
                    </div>
                )}
                {snapshot.interruption && (
                    <div role="status" className="notice">
                        {snapshot.interruption}
                    </div>
                )}

                <section className="panel" aria-label="浏览器状态">
                    <p>任务浏览器：{snapshot.browser.selected?.name || '未检测到可用浏览器'}</p>
                    {snapshot.browser.error && (
                        <p role="status" className="notice error">
                            {snapshot.browser.error}
                        </p>
                    )}
                    <div className="actions">
                        <button
                            disabled={busy}
                            onClick={() => void act(() => window.desktop.detectBrowser(), '浏览器检测完成')}
                        >
                            重新检测
                        </button>
                        {!snapshot.browser.selected && (
                            <>
                                <button onClick={() => void act(() => window.desktop.downloadChrome())}>
                                    下载 Chrome
                                </button>
                                <button onClick={() => void act(() => window.desktop.downloadEdge())}>下载 Edge</button>
                            </>
                        )}
                    </div>
                </section>
                {tab === 'overview' && (
                    <>
                        <section className="hero">
                            <div>
                                <p className="eyebrow">每日任务 · 多账号</p>
                                <h2>账号与任务</h2>
                                <p>所有账号共用运行模式和自动运行设置，按列表顺序依次执行。</p>
                            </div>
                            <div className="actions">
                                <button
                                    className="primary"
                                    disabled={
                                        busy ||
                                        !idle ||
                                        !snapshot.accounts.some(a => a.enabled) ||
                                        !snapshot.browser.selected
                                    }
                                    onClick={() => void act(() => window.desktop.startAll(), '任务已加入队列')}
                                >
                                    运行全部已启用账号
                                </button>
                                <button
                                    disabled={
                                        busy ||
                                        !(
                                            snapshot.queue?.running ||
                                            snapshot.state === 'login' ||
                                            snapshot.state === 'running'
                                        )
                                    }
                                    onClick={() => void act(() => window.desktop.stop())}
                                >
                                    停止 / 取消
                                </button>
                            </div>
                        </section>
                        <section className="panel" aria-label="所有账户总余额">
                            <h3>总积分余额</h3>
                            <strong>{knownBalances.length ? totalBalance.toLocaleString('zh-CN') : '暂无'}</strong>
                            <p className="muted">
                                已读取 {knownBalances.length} / {snapshot.accounts.length}{' '}
                                个账户；余额为各账户最近一次读取值之和。
                            </p>
                            <button
                                disabled={busy || !idle || !snapshot.browser.selected || !snapshot.accounts.length}
                                onClick={() =>
                                    void act(async () => {
                                        const errors: string[] = []
                                        for (const account of snapshot.accounts) {
                                            try {
                                                await window.desktop.refreshBalance({ accountId: account.id })
                                            } catch {
                                                errors.push(accountLabel(account.email))
                                            }
                                        }
                                        if (errors.length) throw new Error(`部分账户余额未更新：${errors.join('、')}`)
                                    }, '总余额已更新')
                                }
                            >
                                刷新总余额
                            </button>
                        </section>
                        <section className="panel">
                            <h3>统一运行设置</h3>
                            <p>
                                {snapshot.settings.mode === 'tasks-search' ? '任务＋搜索模式' : '任务模式'} ·
                                每日自动运行{snapshot.settings.schedule.enabled ? '已开启' : '已关闭'}
                            </p>
                            <p className="muted">
                                任务模式执行签到、活动、阅读及任务要求的搜索；任务＋搜索模式还会尝试完成每日普通搜索额度。实际到账以报告为准。
                            </p>
                            <button
                                disabled={busy || !idle}
                                onClick={() =>
                                    void act(() =>
                                        window.desktop.saveSettings({
                                            ...snapshot.settings,
                                            mode: snapshot.settings.mode === 'tasks' ? 'tasks-search' : 'tasks'
                                        })
                                    )
                                }
                            >
                                更改运行模式
                            </button>
                            <button onClick={() => setTab('settings')}>自动运行设置</button>
                        </section>
                        {snapshot.queue && (
                            <section className="panel" aria-live="polite">
                                <h3>{snapshot.queue.running ? '队列运行中' : '队列已结束'}</h3>
                                <p>
                                    {
                                        snapshot.queue.items.filter(i => !['pending', 'running'].includes(i.status))
                                            .length
                                    }{' '}
                                    / {snapshot.queue.items.length} 个账号已处理
                                </p>
                                {snapshot.queue.items.map(item => (
                                    <p key={item.id}>
                                        {accountLabel(snapshot.accounts.find(a => a.id === item.id)?.email)}：
                                        {
                                            (
                                                {
                                                    pending: '等待执行',
                                                    running: '正在运行',
                                                    completed: '已完成',
                                                    review: '结果待确认',
                                                    failed: '启动失败',
                                                    cancelled: '已取消',
                                                    skipped: '今日已完成，已跳过'
                                                } as Record<string, string>
                                            )[item.status]
                                        }
                                        {item.error ? ` · ${item.error}` : ''}
                                    </p>
                                ))}
                            </section>
                        )}
                        <section className="panel" aria-label="账户登录">
                            <div className="actions account-tabs" role="tablist" aria-label="账户">
                                {snapshot.accounts.map(account => (
                                    <button
                                        key={account.id}
                                        role="tab"
                                        aria-selected={currentAccount?.id === account.id}
                                        onClick={() => setSelectedAccount(account.id)}
                                    >
                                        {accountLabel(account.email)}
                                    </button>
                                ))}
                                <button
                                    disabled={busy || !idle || !snapshot.browser.selected}
                                    onClick={() => void act(() => window.desktop.login(), '请在浏览器完成新账户登录')}
                                >
                                    {snapshot.accounts.length ? '＋ 添加其他账户' : '打开浏览器登录'}
                                </button>
                            </div>
                            {!snapshot.accounts.length && <p>在浏览器完成登录后，账户会自动添加，无需填写邮箱。</p>}
                        </section>
                        {snapshot.accounts
                            .filter(a => a.id === currentAccount?.id)
                            .map(account => {
                                const loggedIn = ['mobile', 'desktop'].every(platform =>
                                    account.sessions.some(s => s.platform === platform && s.hasStorageState)
                                )
                                return (
                                    <section className="panel account-row" key={account.id}>
                                        <div className="report-heading">
                                            <h3>{accountLabel(account.email)}</h3>
                                            <span>{account.enabled ? '参与批量运行' : '已停用'}</span>
                                        </div>

                                        <p>
                                            {loggedIn ? '登录会话已保存' : '待完成登录'} · 今日
                                            {account.automation.completedToday ? '已完成' : '未确认完成'}
                                        </p>
                                        <p className="muted">{account.automation.message}</p>
                                        {(account.error || account.interruption) && (
                                            <p role="status" className="notice">
                                                {account.error || account.interruption}
                                            </p>
                                        )}
                                        <div className="actions">
                                            <button
                                                disabled={busy || !idle || !snapshot.browser.selected}
                                                onClick={() =>
                                                    void act(
                                                        () => window.desktop.login({ accountId: account.id }),
                                                        `请在浏览器登录 ${accountLabel(account.email)}`
                                                    )
                                                }
                                            >
                                                打开浏览器登录
                                            </button>
                                            <button
                                                disabled={busy || !idle || !loggedIn || !snapshot.browser.selected}
                                                onClick={() =>
                                                    void act(() => window.desktop.start({ accountId: account.id }))
                                                }
                                            >
                                                运行此账号
                                            </button>
                                            <button
                                                disabled={busy || !idle}
                                                onClick={() =>
                                                    void act(() =>
                                                        window.desktop.saveAccount({
                                                            id: account.id,
                                                            name: account.name,
                                                            enabled: !account.enabled
                                                        })
                                                    )
                                                }
                                            >
                                                {account.enabled ? '停用' : '启用'}
                                            </button>
                                            <button
                                                disabled={busy}
                                                onClick={() => {
                                                    const name = window.prompt('账号备注', account.name)
                                                    if (name !== null)
                                                        void act(() =>
                                                            window.desktop.saveAccount({
                                                                id: account.id,
                                                                name
                                                            })
                                                        )
                                                }}
                                            >
                                                修改备注
                                            </button>
                                            <button
                                                className="danger"
                                                disabled={busy || !idle}
                                                onClick={() => {
                                                    if (
                                                        window.confirm(
                                                            `移除 ${accountLabel(account.email)}？将清除该账号的登录会话、余额和调度状态，保留历史报告。`
                                                        )
                                                    )
                                                        void act(() =>
                                                            window.desktop.removeAccount({ accountId: account.id })
                                                        )
                                                }}
                                            >
                                                移除
                                            </button>
                                        </div>
                                    </section>
                                )
                            })}
                        <p className="muted">
                            关闭窗口后继续在托盘运行；完全退出会停止当前任务并取消剩余队列。登录会依次保存手机端和电脑端会话。
                        </p>
                    </>
                )}

                {tab === 'results' && (
                    <>
                        <label htmlFor="report-account">筛选报告账号</label>
                        <select
                            id="report-account"
                            value={reportAccount}
                            onChange={e => setReportAccount(e.target.value)}
                        >
                            <option value="">全部账号</option>
                            {[...new Set(snapshot.reports.map(r => r.account).filter(Boolean))].map(email => (
                                <option key={email} value={email}>
                                    {accountLabel(email)}
                                </option>
                            ))}
                        </select>
                        <p className="muted">
                            这里展示筛选后的最近 20
                            份报告，重启后仍可查看。积分变化不等于每项任务均已完成；失败、需手动处理和未确认项目请逐项查看原因。
                        </p>
                        {!reports.length && (
                            <section className="empty">
                                <h2>还没有运行报告</h2>
                                <p>首次运行生成报告后会自动显示；运行中可返回总览查看状态。</p>
                            </section>
                        )}
                        {reports.map((item, index) => (
                            <section className="panel" key={`${item.startedAt}-${index}`}>
                                <div className="report-heading">
                                    <h3>
                                        {accountLabel(item.account)} · {formatTime(item.startedAt)}
                                    </h3>
                                    <span>{item.finishedAt ? '已生成报告' : '状态未确认'}</span>
                                </div>
                                <ReportSummary tasks={item.tasks} />
                                {item.error && <p className="notice error">{item.error}</p>}
                                <p className="muted">
                                    积分：{item.initialPoints ?? '未读取'} → {item.finalPoints ?? '未读取'}
                                </p>
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>任务</th>
                                                <th>状态</th>
                                                <th>说明</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {item.tasks.map((task, taskIndex) => (
                                                <tr key={`${task.id}-${taskIndex}`}>
                                                    <td>{task.title}</td>
                                                    <td>
                                                        <span className={`task-status ${task.status}`}>
                                                            {taskNames[task.status] || task.status}
                                                        </span>
                                                    </td>
                                                    <td>{task.reason}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        ))}
                    </>
                )}

                {tab === 'settings' && (
                    <>
                        <form
                            className="panel settings"
                            onSubmit={event => {
                                event.preventDefault()
                                void act(() => window.desktop.saveSettings(settings), '设置已保存')
                            }}
                        >
                            <h3>浏览器与自动运行</h3>
                            <label htmlFor="task-browser">任务浏览器</label>
                            <select
                                id="task-browser"
                                value={settings.browser}
                                disabled={busy || !idle}
                                onChange={event =>
                                    setSettings({ ...settings, browser: event.target.value as Settings['browser'] })
                                }
                            >
                                <option value="auto">自动（优先系统默认，备用 Edge / Chrome）</option>
                                <option value="chrome">Google Chrome</option>
                                <option value="edge">Microsoft Edge</option>
                            </select>
                            <p className="muted">
                                自动选择会优先使用系统默认的 Chrome 或 Edge，找不到时尝试已安装的
                                Edge、Chrome。任务使用应用独立会话；指定浏览器不可用时，请安装或重新选择。
                            </p>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={settings.schedule.enabled}
                                    onChange={event =>
                                        setSettings({
                                            ...settings,
                                            schedule: { ...settings.schedule, enabled: event.target.checked }
                                        })
                                    }
                                />
                                按电脑系统日期每天自动运行
                            </label>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={settings.startOnLogin}
                                    onChange={event => setSettings({ ...settings, startOnLogin: event.target.checked })}
                                />
                                登录 Windows 后启动到托盘
                            </label>
                            <p className="muted">
                                按每个账号、运行模式和电脑日期分别记录完成情况。启动应用时若今日未完成，会尝试自动运行；常驻时每分钟检查，休眠恢复后也会检查。
                                本次应用启动期间，同一账号和模式每天只自动尝试一次；未完成时可手动重试，完全退出后重新打开也可再次自动尝试。
                                只有正常结束且报告各项均已完成或跳过，才记为今日完成。手动运行随时可用；关闭自动运行不影响已有完成记录。
                            </p>
                            <button className="primary" type="submit" disabled={busy || !idle}>
                                保存设置
                            </button>
                        </form>
                        <section className="panel">
                            <h3>维护与版本</h3>
                            <p>Rewards Desktop v{snapshot.version} · Windows x64 桌面版</p>
                            <p className="muted">
                                排查问题时，请先查看「运行结果」，再导出诊断。日志在本机保留 30 天，诊断包含最近 7
                                天的脱敏日志；也可打开数据目录查看 logs 文件夹。
                            </p>
                            <p className="muted">
                                从 GitHub
                                下载更新后，应用将自动退出、静默安装并重新启动。请先停止任务并完成或取消登录；升级保留本地设置、登录会话和报告。自动更新仅支持安装版，便携版请从发布页下载新版
                                ZIP。安装包暂未签名。
                            </p>
                            <div role="status" aria-live="polite">
                                {snapshot.update.status === 'checking' && <p>正在检查更新…</p>}
                                {snapshot.update.status === 'latest' && <p>当前已是最新桌面版本</p>}
                                {snapshot.update.status === 'available' && <p>发现新版本 v{snapshot.update.version}</p>}
                                {snapshot.update.status === 'downloading' && (
                                    <p>
                                        正在下载 v{snapshot.update.version}：{snapshot.update.progress}%{' '}
                                        <progress value={snapshot.update.progress} max={100} />
                                    </p>
                                )}
                                {snapshot.update.status === 'downloaded' && (
                                    <p>v{snapshot.update.version} 下载完成，可重试安装。</p>
                                )}
                                {snapshot.update.status === 'installing' && (
                                    <p>正在退出应用并安装更新，完成后将自动重新启动…</p>
                                )}
                                {snapshot.update.error && <p className="notice error">{snapshot.update.error}</p>}
                            </div>
                            <div className="actions">
                                <button
                                    disabled={updateBusy || snapshot.update.status === 'installing'}
                                    onClick={() => void updateApp(() => window.desktop.checkUpdate())}
                                >
                                    检查更新
                                </button>
                                {snapshot.update.status === 'available' && (
                                    <button
                                        className="primary"
                                        disabled={updateBusy}
                                        onClick={() => void updateApp(() => window.desktop.downloadUpdate())}
                                    >
                                        立即更新
                                    </button>
                                )}
                                {snapshot.update.status === 'downloaded' && (
                                    <button
                                        disabled={updateBusy}
                                        onClick={() => void updateApp(() => window.desktop.installUpdate())}
                                    >
                                        重试安装
                                    </button>
                                )}
                                <button
                                    disabled={busy}
                                    onClick={() => void act(() => window.desktop.openDataDirectory())}
                                >
                                    打开数据目录
                                </button>
                                <button
                                    disabled={busy}
                                    onClick={() => void act(() => window.desktop.exportDiagnostics())}
                                >
                                    导出诊断
                                </button>
                                <button
                                    disabled={busy || (!idle && snapshot.state !== 'offline')}
                                    onClick={() => void act(() => window.desktop.restartBackend(), '后台已重启')}
                                >
                                    重启后台
                                </button>
                                <button
                                    className="danger"
                                    disabled={busy || !idle}
                                    onClick={() => void act(() => window.desktop.clearData())}
                                >
                                    清除本地数据
                                </button>
                                <button disabled={busy} onClick={() => void act(() => window.desktop.quit())}>
                                    退出并停止任务
                                </button>
                            </div>
                        </section>
                    </>
                )}
            </main>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(<App />)
