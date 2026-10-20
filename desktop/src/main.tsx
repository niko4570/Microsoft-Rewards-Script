import './bridge'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings, Snapshot } from './types'
import './styles.css'

const stateNames: Record<string, string> = {
    idle: '等待运行',
    running: '任务运行中',
    starting: '正在启动',
    stopping: '正在停止',
    login: '等待浏览器登录',
    scanning: '正在检查重置时间',
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

function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
    const [settings, setSettings] = useState<Settings | null>(null)
    const [tab, setTab] = useState('overview')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [failed, setFailed] = useState(false)
    const [updateBusy, setUpdateBusy] = useState(false)
    const logEnd = useRef<HTMLDivElement>(null)

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
        if (tab === 'logs') logEnd.current?.scrollIntoView({ block: 'end' })
    }, [snapshot?.logs.length, tab])

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
    const idle = snapshot.state === 'idle'
    const configured = Boolean(snapshot.settings.email)
    const loggedIn = ['mobile', 'desktop'].every(platform =>
        snapshot.sessions.some(session => session.platform === platform && session.hasStorageState)
    )
    const report = snapshot.reports[0]
    const gained =
        report?.initialPoints != null && report?.finalPoints != null ? report.finalPoints - report.initialPoints : null

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
                        ['logs', '实时日志'],
                        ['settings', '应用设置']
                    ].map(([id, label]) => (
                        <button key={id} className={tab === id ? 'nav active' : 'nav'} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-bottom">
                    <span className={snapshot.backendReady ? 'dot online' : 'dot'} />
                    {snapshot.backendReady ? '本地服务已连接' : '本地服务未连接'}
                    <small>v{snapshot.version} · 私人测试版</small>
                </div>
            </aside>
            <main className="content">
                <header>
                    <div>
                        <p className="eyebrow">MICROSOFT REWARDS</p>
                        <h1>
                            {{ overview: '任务总览', results: '运行结果', logs: '实时日志', settings: '应用设置' }[tab]}
                        </h1>
                    </div>
                    <span className="state-pill">{stateNames[snapshot.state] || snapshot.state}</span>
                </header>
                {(message || snapshot.error) && (
                    <div role="status" className={failed || snapshot.error ? 'notice error' : 'notice'}>
                        {message || snapshot.error}
                    </div>
                )}

                {tab === 'overview' && (
                    <>
                        <section className="hero">
                            <div>
                                <p className="eyebrow">每日任务 · 单账号</p>
                                <h2>
                                    {!configured
                                        ? '从登录你的账号开始'
                                        : loggedIn
                                          ? '准备好运行今天的任务'
                                          : '完成浏览器登录'}
                                </h2>
                                <p>
                                    {!configured
                                        ? '点击打开浏览器登录，在浏览器中登录你的 Microsoft 账号。应用不会保存你的密码。'
                                        : '账号由浏览器登录会话管理。会话过期后请重新打开浏览器登录。'}
                                </p>
                            </div>
                            <div className="actions">
                                <button
                                    className="primary"
                                    disabled={busy || !idle || !configured || !loggedIn}
                                    onClick={() =>
                                        void act(() => window.desktop.start(), '任务已启动，请查看日志和运行结果')
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
                        <div className="cards">
                            <section className="card">
                                <p className="label">登录会话</p>
                                <h3>{loggedIn ? '已保存' : '待登录'}</h3>
                                <p>
                                    {snapshot.sessions.filter(session => session.hasStorageState).length} / 2 个会话 ·
                                    保存不代表仍有效
                                </p>
                                <p className="muted">
                                    使用手动浏览器登录，不填写或保存密码。第一版按中国区域、中文运行。
                                </p>
                                <button
                                    disabled={busy || !idle}
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
                                    {snapshot.settings.schedule.enabled
                                        ? formatTime(snapshot.automation.nextResetAt)
                                        : '尚未开启'}
                                </h3>
                                <p>
                                    {snapshot.settings.schedule.enabled
                                        ? snapshot.automation.message
                                        : '开启后自动检查每日任务与重置时间'}
                                </p>
                                <p className="muted">下一次服务端重置 · 应用需在托盘运行</p>
                                <button onClick={() => setTab('settings')}>自动运行设置</button>
                            </section>
                            <section className="card">
                                <p className="label">最近积分变化</p>
                                <h3>{gained == null ? '未确认' : gained >= 0 ? `+${gained}` : gained}</h3>
                                <p>
                                    {report ? formatTime(report.finishedAt || report.startedAt) : '完成一次运行后显示'}
                                </p>
                                <button onClick={() => setTab('results')}>查看详细结果</button>
                            </section>
                        </div>
                        <section className="panel">
                            <h3>第一次使用</h3>
                            <ol>
                                <li>点击打开浏览器登录，用同一个账号完成手机和桌面两次浏览器登录。</li>
                                <li>先手动运行一次，检查每项任务的结果。</li>
                                <li>暂停旧 Docker 的定时任务后，开启自动运行。</li>
                            </ol>
                            <p className="muted">
                                关闭窗口会留在托盘。退出应用会停止任务；重新打开或休眠恢复后会检查当前周期的未完成任务。
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
                            报告保存在本机，重启应用后仍可查看。积分变化与各项任务是否完成分别展示。
                        </p>
                        {!snapshot.reports.length && (
                            <section className="empty">
                                <h2>还没有运行报告</h2>
                                <p>完成首次任务后，结果会显示在这里。</p>
                            </section>
                        )}
                        {snapshot.reports.map((item, index) => (
                            <section className="panel" key={`${item.startedAt}-${index}`}>
                                <div className="report-heading">
                                    <h3>{formatTime(item.startedAt)}</h3>
                                    <span>{item.finishedAt ? '已生成报告' : '状态未确认'}</span>
                                </div>
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

                {tab === 'logs' && (
                    <>
                        <div className="toolbar">
                            <p className="muted">显示最近 300 条脱敏日志，本地按日保留 30 天。</p>
                            <button
                                disabled={busy}
                                onClick={() => void act(() => window.desktop.exportDiagnostics(), '诊断导出操作已完成')}
                            >
                                导出诊断
                            </button>
                        </div>
                        <section className="log-view" aria-label="运行日志">
                            {snapshot.logs.length ? (
                                snapshot.logs.map((line, index) => <div key={index}>{line}</div>)
                            ) : (
                                <p>等待运行日志…</p>
                            )}
                            <div ref={logEnd} />
                        </section>
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
                            <h3>自动运行</h3>
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
                                按 Rewards 重置时间自动运行
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
                                打开应用、登录完成或休眠恢复后自动检查连胜和积分卡片。尚未自动运行的周期每 5
                                分钟检查新增任务； 每周期最多自动启动一次，运行后等待服务端重置。读取失败 5
                                分钟后重试，任务失败可手动重试。
                            </p>
                            <button className="primary" type="submit" disabled={busy || !idle}>
                                保存设置
                            </button>
                        </form>
                        <section className="panel">
                            <h3>维护与版本</h3>
                            <p>Rewards Desktop v{snapshot.version} · Windows 11 x64 私人测试版</p>
                            <p className="muted">
                                检查 GitHub
                                上的桌面新版本，直接下载安装包。下载完成后退出应用并运行安装包；本地账号、会话和设置会保留。测试包暂未签名。
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
