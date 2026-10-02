'use strict'
/* PanBox 自检（在他们那台机器上跑，把键盘敲出来的这几行原样贴回来即可）。
 *
 * 为什么要这个：报障时「装的是哪个版本 / 装在哪 / 那条下载地址在**这台机器上**
 * 到底返回什么」这三件事，光看截图分不出来，来回猜要花好几天。
 *
 * 用法（不用管装在哪，随便找个地方双击或命令行都行）：
 *    把本文件拖到 PanBox 的安装目录旁都行 —— 直接：
 *    node panbox-selfcheck.js
 *
 * 它只读，不改任何设置、不下载、不删除东西。
 * 输出里**不含**任何 Cookie 值（那属于凭证），只报「有没有、几条」。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const OUT = []
function say(s) {
  OUT.push(s)
  console.log(s)
}

function findInstalls() {
  const hits = []
  const exeName = 'PanBox.exe'
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    process.env.LOCALAPPDATA || '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
    process.env.TEMP || '',
    'D:\\workSpace',
  ]
  const seen = new Set()
  const push = (p) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    hits.push(p)
  }
  /* 浅扫一层：直接就是安装目录，或者下面还有一层（三角套得再往下看一层） */
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (fs.existsSync(path.join(dir, exeName))) push(path.join(dir, exeName))
    const asar = path.join(dir, 'resources', 'app.asar')
    if (fs.existsSync(asar)) push(asar)
    if (depth <= 0) return
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (/^(node_modules|\.git|System32|WinSxS|Windows|assembly|Microsoft|Packages|Temp)$/i.test(e.name)) continue
      if (depth === 1 && !/panbox|ns[ct]|electron|app|dist|release/i.test(e.name)) continue
      walk(path.join(dir, e.name), depth - 1)
    }
  }
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    walk(root, 2)
  }
  return hits
}

function versionOf(asarPath) {
  /* 不依赖任何外部包，直接读 asar 的头部：它是一段 Pickle 编码的 JSON。
   * 一家工具写出来的头长度不一定对得上（对齐补位不止一种），所以尾部往回退着试；
   * 真解析不了就退回「在文件里找 version」这种笨办法 —— 自检工具不该在这里卡住。 */
  const fd = fs.openSync(asarPath, 'r')
  try {
    const pre = Buffer.alloc(16)
    fs.readSync(fd, pre, 0, 16, 0)
    let json = null
    /* jsonLen 才是 JSON 的真实长度；头里那个 headerSize 带对齐补位，用它去定位文件
     * 内容会整体偏掉几字节（读完 JSON.parse 就报 "Unexpected non-whitespace…"）。 */
    let contentAt = 0
    for (const off of [8, 12]) {
      const headerSize = pre.readUInt32LE(off)
      if (!headerSize || headerSize > 256 * 1024 * 1024) continue
      const head = Buffer.alloc(headerSize)
      fs.readSync(fd, head, 0, headerSize, 16)
      for (let len = headerSize; len > Math.max(2, headerSize - 64); len -= 1) {
        const text = head.subarray(0, len).toString('utf8').replace(/[\0\s]+$/, '')
        try {
          json = JSON.parse(text)
          contentAt = 16 + len
          break
        } catch {
          /* 再退一格 */
        }
      }
      if (json) break
    }
    let out = ''
    if (json) {
      const readFile = (node) => {
        if (!node || typeof node.offset !== 'string') return ''
        const buf = Buffer.alloc(node.size)
        fs.readSync(fd, buf, 0, node.size, contentAt + Number(node.offset))
        return buf.toString('utf8')
      }
      const pkg = JSON.parse(readFile(json.files && json.files['package.json']) || '{}')
      out = String(pkg.version || '')
      const rsc = json.files && json.files.resources && json.files.resources.files
      const extDir = rsc && rsc.extension && rsc.extension.files
      if (extDir && extDir['manifest.json']) {
        try {
          const v = JSON.parse(readFile(extDir['manifest.json'])).version
          if (v) out += '（插件 ' + v + '）'
        } catch {
          /* 插件版本读不到就算了 */
        }
      }
    }
    if (out) return out
  } catch {
    /* 掉到下面的兜底 */
  } finally {
    fs.closeSync(fd)
  }
  /* 兜底：整份扫一遍找 "version": "x.y.z"。asar 头里 package.json 的内容就在开头不远 */
  try {
    const fd2 = fs.openSync(asarPath, 'r')
    const size = Math.min(fs.statSync(asarPath).size, 4 * 1024 * 1024)
    const buf = Buffer.alloc(size)
    fs.readSync(fd2, buf, 0, size, 0)
    fs.closeSync(fd2)
    const m = buf.toString('utf8').match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)
    if (m) return m[1] + '（取自文件内容，可能不准）'
  } catch {
    /* ignore */
  }
  return '(版本读不出来)'
}

/* 只读 256KB 探一下：既看响应头，也看**这台机器上真的能不能下下来一点点**。
 * 光看响应头会骗人 —— 「回 200 但正文拉不动」和「能拉」是两件事。 */
function probe(url) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let req
    try {
      req = require('node:https').request(
        url,
        {
          method: 'GET',
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            range: 'bytes=0-262143',
          },
        },
        (res) => {
          const h = res.headers
          let got = 0
          const t1 = Date.now()
          /* 正文计时从「连接真正建立」算起，别把 DNS/TLS 那段算进去 */
          let tBody = 0
          res.on('data', (c) => {
            if (!tBody) tBody = Date.now()
            got += c.length
            if (got >= 262144) {
              const ms = Date.now() - (tBody || t1)
              res.destroy()
              resolve({
                status: res.statusCode,
                ct: h['content-type'] || '',
                cd: h['content-disposition'] || '',
                len: h['content-length'] || '',
                ranges: h['accept-ranges'] || '',
                got,
                ms,
                headMs: (tBody || t1) - t0,
              })
            }
          })
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              ct: h['content-type'] || '',
              cd: h['content-disposition'] || '',
              len: h['content-length'] || '',
              ranges: h['accept-ranges'] || '',
              got,
              ms: Date.now() - t1,
              headMs: t1 - t0,
            }),
          )
          res.on('error', (e) =>
            resolve({
              status: res.statusCode,
              ct: h['content-type'] || '',
              cd: h['content-disposition'] || '',
              ranges: h['accept-ranges'] || '',
              got,
              ms: Date.now() - t1,
              headMs: t1 - t0,
              err: '读正文出错：' + String(e && e.message),
            }),
          )
        },
      )
    } catch (e) {
      resolve({ err: String(e && e.message) })
      return
    }
    req.setTimeout(20000, () => {
      req.destroy()
      resolve({ err: '超时（20 秒）' })
    })
    req.on('error', (e) => resolve({ err: String(e && e.message) }))
    req.end()
  })
}

async function main() {
  say('=== PanBox 自检 ' + new Date().toLocaleString() + ' ===')
  say('系统：' + os.platform() + ' ' + os.release() + ' / node ' + process.version)

  /* 开发用：只想核对某一个包里的版本号时，PANBOX_SELFCHECK_ASAR=<路径> */
  if (process.env.PANBOX_SELFCHECK_ASAR) {
    const p = process.env.PANBOX_SELFCHECK_ASAR
    say('指定包：' + p + ' → version=' + versionOf(p))
    return
  }

  say('\n--- 这台机器上的 PanBox 都在哪、是什么版本 ---')
  const hits = findInstalls()
  if (!hits.length) say('没找到 PanBox.exe 或 app.asar（可能装在别处）')
  for (const h of hits) {
    let ver = ''
    if (h.endsWith('app.asar')) {
      try {
        ver = ' version=' + versionOf(h)
      } catch (e) {
        ver = ' (读版本失败 ' + String(e.message) + ')'
      }
    }
    say('  ' + h + ver)
  }

  say('\n--- 正在跑的是哪一个 ---')
  let tasklist = ''
  try {
    tasklist = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PanBox.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'latin1',
    })
  } catch (e) {
    tasklist = '（问不出来：' + String(e.message) + '）'
  }
  const pids = String(tasklist)
    .split(/\r?\n/)
    .map((l) => l.split('","')[1])
    .filter(Boolean)
  if (!pids.length) say('PanBox 没在运行')
  for (const pid of pids) {
    let exe = ''
    try {
      exe = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`],
        { encoding: 'latin1' },
      ).trim()
    } catch {
      exe = '(问不出来)'
    }
    say('  pid ' + pid + ' → ' + exe)
  }

  say('\n--- 解析设置里有没有自定义接口 ---')
  const cfg = path.join(process.env.APPDATA || '', 'PanBox', 'settings.json')
  if (fs.existsSync(cfg)) {
    try {
      const s = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      const eps = s.parseEndpoints
      say('  设置文件：' + cfg)
      say('  parseEndpoints：' + (Array.isArray(eps) ? eps.length + ' 条' : String(eps)))
      say('  自定义 UA：' + (s.userAgent ? '有（不打印内容）' : '没设'))
      say('  代理：' + (s.proxy && (s.proxy.server || s.proxy.mode) ? s.proxy.mode + ' ' + (s.proxy.server || '') : '没设'))
    } catch (e) {
      say('  设置文件读不动：' + String(e.message))
    }
  } else {
    say('  没有 ' + cfg)
  }

  /* 要查的那条地址：命令行第一个参数，或者直接改下面这行 */
  const url = process.argv[2] || ''
  say('\n--- 那条下载地址在这台机器上回什么 ---')
  if (!url) {
    say('  （没给地址）用法：node panbox-selfcheck.js "https://…/xxx.exe"')
  } else {
    const r = await probe(url)
    say('  ' + url.slice(0, 160))
    if (r.err) say('  连不上：' + r.err)
    else {
      say(
        '  HTTP ' +
          r.status +
          ' | content-type: ' +
          (r.ct || '(无)') +
          ' | content-disposition: ' +
          (r.cd || '(无)') +
          ' | accept-ranges: ' +
          (r.ranges || '(无)') +
          ' | content-length: ' +
          (r.len || '(无)'),
      )
      say(
        '  实拉：' +
          r.got +
          ' 字节 / ' +
          r.ms +
          ' ms（首字节 ' +
          r.headMs +
          ' ms）' +
          (r.got > 0 ? '  → 这台机器上正文拉得动' : '  → 正文一个字节都没下来'),
      )
    }
    say('  ↑ 若这里是 200/206 + octet-stream 且实拉得到字节，说明这台机器上链接是活的，')
    say('    问题在 PanBox 怎么用这条链接；若是 403/404/过期或拉不动，说明链接本身不能用。')
  }

  const outFile = path.join(process.cwd(), 'panbox-selfcheck.txt')
  fs.writeFileSync(outFile, OUT.join('\r\n') + '\r\n')
  say('\n结果已写到：' + outFile + '（把这个文件发回来即可）')
}

main().catch((e) => {
  console.error('自检出错：', (e && e.stack) || String(e))
  process.exit(1)
})