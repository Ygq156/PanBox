'use strict'

const { req } = require('./util')

/* ------------------------------------------------------------------ */
/* MDPI：文章页地址 → mdpi-res.com 上的 PDF 直链                        */
/* ------------------------------------------------------------------ */

/* 为什么要这样绕：`https://www.mdpi.com/<ISSN>/<卷>/<期>/<文号>` 上的
 * 「Download PDF」指向 `…/pdf?version=…`，那一条挂在 Akamai Bot Manager 后面 ——
 * 直接请求吃到 403 Access Denied，带全套浏览器头会翻成挑战页，要跑一遍 PoW 才给
 * 302 到真 PDF；而且授权窗口很短（同一份 cookie，t=0 能下、t=+60s 又 403），
 * 拿它做下载入口不可靠。
 *
 * 真正的文件在 mdpi-res.com 上，那个域**没有任何守卫**：无 Cookie、无 Referer，
 * 连 User-Agent 都不带也能取到（实测 200 + application/pdf）。
 * 于是这一条捷径完全不需要"过反爬"，只要能把文章页地址换算成 CDN 地址。
 *
 * 换算的难点只有一个：CDN 路径里的 `<短名>` 是刊名（futureinternet / symmetry /
 * sensors…），文章页地址里只有 ISSN。而且**不能用 CDN 反推刊名** ——
 * 实测拿 1999-5903 的文章号配 `symmetry` 去请求，CDN 照样回 200 和一个完全不同的
 * 真 PDF（刊名错了也发文件）。所以刊名只能查表；表里没有的刊就明说，不猜。 */

/** ISSN → mdpi-res 上的短名。以 https://www.mdpi.com/journal/<短名> 页面上印的 ISSN 为准。
 *
 * 两条踩过的坑，改这张表时必须守住：
 *   ① **只能用电子版 ISSN**（MDPI 的文章地址用的就是它）。Medicina 同时印
 *      1648-9144（电子）与 1010-660X（印刷），文章地址是 /1648-9144/… ，
 *      拿印刷号当键会一条都匹配不上。
 *   ② **短名不能靠猜**：remote-sensing → `remotesensing`、appliedsciences →
 *      `applsci`、brainsciences → `brainsci`。猜错了 CDN 不会报错，它会给你**另一篇**
 *      真论文（见文件顶部注释），所以只能按 /journal/<短名> 那条地址抄。
 *
 * 表里没有的刊一律给提示、不猜；要加就先去 /journal/<短名> 页面上核对 ISSN。 */
const JOURNALS = {
  '1099-4300': { slug: 'entropy', name: 'Entropy' },
  '1420-3049': { slug: 'molecules', name: 'Molecules' },
  '1422-0067': { slug: 'ijms', name: 'International Journal of Molecular Sciences' },
  '1424-8220': { slug: 'sensors', name: 'Sensors' },
  '1424-8247': { slug: 'pharmaceuticals', name: 'Pharmaceuticals' },
  '1648-9144': { slug: 'medicina', name: 'Medicina' },
  '1660-4601': { slug: 'ijerph', name: 'International Journal of Environmental Research and Public Health' },
  '1996-1073': { slug: 'energies', name: 'Energies' },
  '1996-1944': { slug: 'materials', name: 'Materials' },
  '1999-4907': { slug: 'forests', name: 'Forests' },
  '1999-4915': { slug: 'viruses', name: 'Viruses' },
  '1999-4923': { slug: 'pharmaceutics', name: 'Pharmaceutics' },
  '1999-5903': { slug: 'futureinternet', name: 'Future Internet' },
  '2071-1050': { slug: 'sustainability', name: 'Sustainability' },
  '2072-4292': { slug: 'remotesensing', name: 'Remote Sensing' },
  '2072-6643': { slug: 'nutrients', name: 'Nutrients' },
  '2072-666X': { slug: 'micromachines', name: 'Micromachines' },
  '2072-6694': { slug: 'cancers', name: 'Cancers' },
  '2073-431X': { slug: 'computers', name: 'Computers' },
  '2073-4344': { slug: 'catalysts', name: 'Catalysts' },
  '2073-4352': { slug: 'crystals', name: 'Crystals' },
  '2073-4360': { slug: 'polymers', name: 'Polymers' },
  '2073-4395': { slug: 'agronomy', name: 'Agronomy' },
  '2073-4409': { slug: 'cells', name: 'Cells' },
  '2073-4425': { slug: 'genes', name: 'Genes' },
  '2073-4433': { slug: 'atmosphere', name: 'Atmosphere' },
  '2073-4441': { slug: 'water', name: 'Water' },
  '2073-445X': { slug: 'land', name: 'Land' },
  '2073-4468': { slug: 'antibodies', name: 'Antibodies' },
  '2073-8994': { slug: 'symmetry', name: 'Symmetry' },
  '2075-163X': { slug: 'minerals', name: 'Minerals' },
  '2075-1702': { slug: 'machines', name: 'Machines' },
  '2075-1729': { slug: 'life', name: 'Life' },
  '2075-4418': { slug: 'diagnostics', name: 'Diagnostics' },
  '2075-4426': { slug: 'jpm', name: 'Journal of Personalized Medicine' },
  '2075-4701': { slug: 'metals', name: 'Metals' },
  '2075-5309': { slug: 'buildings', name: 'Buildings' },
  '2076-0817': { slug: 'pathogens', name: 'Pathogens' },
  '2076-0825': { slug: 'actuators', name: 'Actuators' },
  '2076-2607': { slug: 'microorganisms', name: 'Microorganisms' },
  '2076-2615': { slug: 'animals', name: 'Animals' },
  '2076-3417': { slug: 'applsci', name: 'Applied Sciences' },
  '2076-3425': { slug: 'brainsci', name: 'Brain Sciences' },
  '2076-3921': { slug: 'antioxidants', name: 'Antioxidants' },
  '2076-393X': { slug: 'vaccines', name: 'Vaccines' },
  '2077-0375': { slug: 'membranes', name: 'Membranes' },
  '2077-0383': { slug: 'jcm', name: 'Journal of Clinical Medicine' },
  '2077-0472': { slug: 'agriculture', name: 'Agriculture' },
  '2077-1312': { slug: 'jmse', name: 'Journal of Marine Science and Engineering' },
  '2078-2489': { slug: 'information', name: 'Information' },
  '2079-4991': { slug: 'nanomaterials', name: 'Nanomaterials' },
  '2079-6382': { slug: 'antibiotics', name: 'Antibiotics' },
  '2079-6412': { slug: 'coatings', name: 'Coatings' },
  '2079-7737': { slug: 'biology', name: 'Biology' },
  '2079-8954': { slug: 'systems', name: 'Systems' },
  '2079-9292': { slug: 'electronics', name: 'Electronics' },
  '2218-273X': { slug: 'biomolecules', name: 'Biomolecules' },
  '2218-6581': { slug: 'robotics', name: 'Robotics' },
  '2223-7747': { slug: 'plants', name: 'Plants' },
  '2227-7102': { slug: 'education', name: 'Education Sciences' },
  '2227-7390': { slug: 'mathematics', name: 'Mathematics' },
  '2227-9032': { slug: 'healthcare', name: 'Healthcare' },
  '2227-9059': { slug: 'biomedicines', name: 'Biomedicines' },
  '2227-9717': { slug: 'processes', name: 'Processes' },
  '2304-8158': { slug: 'foods', name: 'Foods' },
  '2305-6304': { slug: 'toxics', name: 'Toxics' },
  '2311-7524': { slug: 'horticulturae', name: 'Horticulturae' },
  '2673-8023': { slug: 'micro', name: 'Micro' },
}

/* 测试用：把 CDN 起点换成本机假站点。生产环境不设这个变量，就是真地址。 */
function cdnBase() {
  return String(process.env.PANBOX_MDPI_BASE || 'https://mdpi-res.com').replace(/\/+$/, '')
}

/**
 * 文章页地址 → `{issn, volume, issue, art}`；不是文章页就返回 null。
 *
 * 认的形状（`/pdf`、`/epub`、`/notes` 这些后缀要去掉）：
 *   https://www.mdpi.com/1999-5903/15/6/192
 *   https://www.mdpi.com/1999-5903/15/6/192/pdf
 *   https://www.mdpi.com/1999-5903/15/6/192/htm
 */
function parseArticle(url) {
  let u = null
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)mdpi\.com$/i.test(u.hostname)) return null
  const seg = u.pathname.split('/').filter(Boolean)
  /* 末尾挂 /pdf、/epub 这类时去掉一层再看 */
  if (seg.length === 5 && /^[a-z]{2,12}$/i.test(seg[4])) seg.pop()
  if (seg.length !== 4) return null
  const [issn, volume, issue, art] = seg
  if (!/^\d{4}-\d{3}[\dXx]$/.test(issn)) return null
  if (!/^\d{1,4}$/.test(volume) || !/^\d{1,4}$/.test(issue) || !/^\d{1,5}$/.test(art)) return null
  return { issn, volume, issue, art }
}

/** 由文章页信息拼出 CDN 直链；刊名不认识时返回 null */
function cdnUrl(a, base) {
  const j = JOURNALS[a.issn]
  if (!j) return null
  const tail = `${j.slug}-${a.volume}-${String(a.art).padStart(5, '0')}`
  return `${base || cdnBase()}/d_attachment/${j.slug}/${tail}/article_deploy/${tail}.pdf`
}

/** 这个 ISSN 认不认识（给「换个入口」的提示用） */
function known(issn) {
  return !!JOURNALS[issn]
}

/* `Content-Disposition: attachment; filename="futureinternet-15-00192.pdf"` → 文件名 */
function fileNameOf(cd) {
  const s = String(cd || '')
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s)
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')).slice(0, 200)
    } catch {
      /* 编码坏了就用原样 */
    }
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(s)
  return m ? m[1].trim().slice(0, 200) : ''
}

/* 文件名兜底：CDN 不给 disposition 时用 journal-卷-文号.pdf。
 * 名字里带 `[\\/:*?"<>|]` 的文件名在 Windows 上会写不出去，统一换掉。 */
function safeName(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return t.slice(0, 180)
}

module.exports = {
  netdisk: 'mdpi',

  test(url) {
    const a = parseArticle(url)
    return !!a && known(a.issn)
  },

  async open(url) {
    const a = parseArticle(url)
    if (!a) throw new Error('这不是 MDPI 的文章页地址（形如 https://www.mdpi.com/1999-5903/15/6/192）')
    const j = JOURNALS[a.issn]
    if (!j) {
      throw new Error(`MDPI 刊名表里还没有 ISSN ${a.issn} 这个刊，暂时没法换算成 CDN 地址`)
    }

    const pdf = cdnUrl(a)
    let name = ''
    let size = 0
    try {
      /* 只要响应头：`noBody` 不读正文，就算服务器不认 HEAD 也不会白拉几百 KB。
       * 带 Range 时 CDN 回 206，所以这里只要求 2xx。
       * allowLocal 只在「CDN 起点被指向本机假站点」的测试里为真（见 cdnBase）。 */
      const r = await req(pdf, { method: 'HEAD', timeout: 20000, noBody: true, allowLocal: !!process.env.PANBOX_MDPI_BASE })
      if (r.status >= 200 && r.status < 300) {
        name = fileNameOf(r.headers.get('content-disposition'))
        size = Number(r.headers.get('content-length') || 0) || 0
      }
    } catch {
      /* HEAD 不通不算失败：直链已经算出来了，名字用兜底的，交给下载器自己去问 */
    }
    if (!name) name = safeName(`${j.slug}-${a.volume}-${String(a.art).padStart(5, '0')}.pdf`)

    return {
      title: `${j.name} ${a.volume}: ${name}`,
      shareId: url,
      files: [{ id: '0', name, size, isDir: false, dir: '' }],
      /* 直链是算出来的、不带任何会话凭证，解析与下载都不需要额外请求头 */
      resolve: async () => ({ url: pdf, headers: {}, name }),
    }
  },
}