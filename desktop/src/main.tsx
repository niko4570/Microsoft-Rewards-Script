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
    const idle = ['idle', 'sleeping'].includes(snapshot.state)
    const configured = Boolean(snapshot.settings.email)
    const loggedIn = ['mobile', 'desktop'].every(platform =>
        snapshot.sessions.some(session => session.platform === platform && session.hasStorageState)
    )
    const balance = snapshot.balance

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
                                <p className="eyebrow">每日任务 · 单账号</p>
                                <h2>
                                    {!configured
                                        ? '从登录你的账号开始'
                                        : loggedIn
                                          ? snapshot.state === 'running'
                                              ? '正在执行任务'
                                              : snapshot.automation.completedToday
                                                ? '今天的任务已完成'
                                                : '可以开始今天的任务'
                                          : '完成浏览器登录'}
                                </h2>
                                <p>
                                    {!configured
                                        ? '点击打开浏览器登录，在浏览器中登录你的 Microsoft 账号。应用不会保存你的密码。'
                                        : '使用已保存的手机端和电脑端会话运行；如提示登录失效或需要验证，请重新登录。'}
                                </p>
                            </div>
                            <div className="actions">
                                <button
                                    className="primary"
                                    disabled={busy || !idle || !configured || !loggedIn || !snapshot.browser.selected}
                                    onClick={() =>
                                        void act(
                                            () => window.desktop.start(),
                                            '任务已启动，结束后会自动更新运行结果与今日状态'
                                        )
                                    }
                                >
                                    开始任务
                                </button>
                                <button
                                    disabled={
                                        busy || !['starting', 'running', 'stopping', 'login'].includes(snapshot.state)
                                    }
                                    onClick={() => void act(() => window.desktop.stop())}
                                >
                                    停止 / 取消
                                </button>
                            </div>
                        </section>
                        <section className="panel">
                            <h3>
                                运行模式：{snapshot.settings.mode === 'tasks-search' ? '任务＋搜索模式' : '任务模式'}
                            </h3>
                            <p className="muted">
                                {snapshot.settings.mode === 'tasks-search'
                                    ? '执行当前账号可用的签到、活动、阅读等任务，并尝试完成电脑端和手机端的每日搜索额度；实际到账以报告和 Rewards 页面为准。'
                                    : '执行当前账号可用的签到、活动、阅读等任务，以及任务要求的搜索；不会额外刷满每日普通搜索额度。'}
                            </p>
                            <button
                                disabled={busy || !idle}
                                onClick={() => {
                                    const mode = snapshot.settings.mode === 'tasks-search' ? 'tasks' : 'tasks-search'
                                    void act(
                                        () => window.desktop.saveSettings({ ...snapshot.settings, mode }),
                                        '运行模式已保存，下次运行生效'
                                    )
                                }}
                            >
                                切换为{snapshot.settings.mode === 'tasks-search' ? '任务模式' : '任务＋搜索模式'}
                            </button>
                        </section>
                        <div className="cards">
                            <section className="card">
                                <p className="label">登录会话</p>
                                <h3>{loggedIn ? '已保存' : '待登录'}</h3>
                                <p>
                                    {snapshot.sessions.filter(session => session.hasStorageState).length} / 2 个会话 ·
                                    有效性会在运行时检查
                                </p>
                                <p className="muted">
                                    在浏览器中完成 Microsoft
                                    登录与验证，应用保存登录会话。当前按中国区域和中文配置执行任务。
                                </p>
                                <button
                                    disabled={busy || !idle || !snapshot.browser.selected}
                                    onClick={() => void act(() => window.desktop.login(), '请在浏览器中完成登录')}
                                >
                                    打开浏览器登录
                                </button>
                                {snapshot.state === 'login' && (
                                    <button
                                        disabled={busy}
                                        onClick={() => void act(() => window.desktop.cancelLogin())}
                                    >
                                        取消登录
                                    </button>
                                )}
                            </section>
                            <section className="card">
                                <p className="label">自动运行</p>
                                <h3>
                                    {
                                        {
                                            pending: '今日待运行',
                                            running: '任务运行中',
                                            completed: '今日已完成',
                                            review: '结果待确认'
                                        }[snapshot.automation.status]
                                    }
                                </h3>
                                <p>{snapshot.automation.message}</p>
                                <p className="muted">
                                    {snapshot.automation.date} · 当前账号与模式 · 自动运行
                                    {snapshot.settings.schedule.enabled ? '已开启' : '已关闭'}
                                </p>
                                <button onClick={() => setTab('settings')}>自动运行设置</button>
                            </section>
                            <section className="card">
                                <p className="label">积分余额</p>
                                <h3>{balance.value == null ? '暂无数据' : balance.value.toLocaleString('zh-CN')}</h3>
                                <p>
                                    {balance.updatedAt
                                        ? `更新于 ${formatTime(balance.updatedAt)}`
                                        : '登录后点击刷新余额'}
                                </p>
                                <p className="muted">
                                    {balance.error
                                        ? `刷新失败：${balance.error}${balance.value == null ? '' : '；保留上次余额'}`
                                        : '显示最近一次读取的可用积分余额'}
                                </p>
                                <button
                                    disabled={
                                        busy ||
                                        !idle ||
                                        !configured ||
                                        !snapshot.browser.selected ||
                                        !snapshot.sessions.some(
                                            session => session.platform === 'desktop' && session.hasStorageState
                                        )
                                    }
                                    onClick={() => void act(() => window.desktop.refreshBalance(), '积分余额已更新')}
                                >
                                    {snapshot.state === 'balance' ? '正在刷新…' : '刷新余额'}
                                </button>
                            </section>
                        </div>
                        <section className="panel">
                            <h3>使用步骤</h3>
                            <ol>
                                <li>点击「打开浏览器登录」，按提示用同一账号依次完成手机端和电脑端登录。</li>
                                <li>点击「开始任务」，结束后到「运行结果」查看完成、跳过及需要处理的项目。</li>
                                <li>
                                    需要每日自动执行时，在「应用设置」开启自动运行并保存；避免其他脚本同时运行同一账号。
                                </li>
                            </ol>
                            <p className="muted">
                                关闭窗口后应用继续在托盘运行；完全退出会停止任务。开启自动运行后，启动应用和休眠恢复时会检查电脑日期，常驻时跨日约一分钟内检查。
                            </p>
                        </section>
                        {snapshot.lastExit && (
                            <p className="muted">
                                最近进程退出：
                                {snapshot.lastExit.code === 0
                                    ? '正常结束；任务完成情况以报告为准'
                                    : `退出码 ${snapshot.lastExit.code ?? snapshot.lastExit.signal ?? '未知'}，请检查日志`}
                            </p>
                        )}
                    </>
                )}

                {tab === 'results' && (
                    <>
                        <p className="muted">
                            这里展示本机最近 20
                            份报告中属于当前账号的记录，重启后仍可查看。积分变化不等于每项任务均已完成；失败、需手动处理和未确认项目请逐项查看原因。
                        </p>
                        {!snapshot.reports.length && (
                            <section className="empty">
                                <h2>还没有运行报告</h2>
                                <p>首次运行生成报告后会自动显示；运行中可返回总览查看状态。</p>
                            </section>
                        )}
                        {snapshot.reports.map((item, index) => (
                            <section className="panel" key={`${item.startedAt}-${index}`}>
                                <div className="report-heading">
                                    <h3>{formatTime(item.startedAt)}</h3>
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
                                void act(
                                    () => window.desktop.saveSettings({ ...settings, email: snapshot.settings.email }),
                                    '设置已保存'
                                )
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
                                按当前账号、运行模式和电脑日期分别记录完成情况。启动应用时若今日未完成，会尝试自动运行；常驻时每分钟检查，休眠恢复后也会检查。
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
                                检查并下载桌面安装包，下载后校验文件。请完全退出应用再安装；升级保留本地设置、登录会话和报告。安装包暂未签名。
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
                                    <p>
                                        v{snapshot.update.version} 下载完成，SHA256 校验通过。请退出应用后运行安装包。
                                    </p>
                                )}
                                {snapshot.update.error && <p className="notice error">{snapshot.update.error}</p>}
                            </div>
                            <div className="actions">
                                <button
                                    disabled={updateBusy}
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
                                        下载新版安装包
                                    </button>
                                )}
                                {snapshot.update.status === 'downloaded' && (
                                    <button onClick={() => void act(() => window.desktop.showUpdateFile())}>
                                        打开下载位置
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
