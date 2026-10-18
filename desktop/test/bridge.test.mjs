import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

test('desktop IPC opens browser login without parameters and rejects unexpected arguments', async () => {
    const source = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')
    let invoke
    let logins = 0
    const mainFrame = { url: pathToFileURL('/test/index.html').href }
    const webContents = { mainFrame }
    const event = { sender: webContents, senderFrame: mainFrame }
    vm.runInNewContext(source.slice(source.indexOf('function registerBridge()')) + '\nregisterBridge()', {
        window: { webContents },
        indexFile: '/test/index.html',
        pathToFileURL,
        service: { login: () => ++logins },
        refresh: async () => {},
        ipcMain: {
            handle: (_channel, handler) => {
                invoke = handler
            }
        }
    })
    assert.equal(await invoke(event, 'login'), 1)
    await assert.rejects(invoke(event, 'login', 'unused@example.com'), /此操作不接受参数/)
    await assert.rejects(invoke({ ...event, senderFrame: { ...mainFrame } }, 'login'), /不允许的调用来源/)
    assert.equal(logins, 1)
})
