// 浏览器侧采样与同意面板处理；正文仍由本地 Reader 的 ARIA 提取器产生。
// 以字符串传给 page.evaluate：打包器会往函数体里注入辅助符号，序列化到页面后找不到。
// Web Components 把内容放在 shadow root 里，innerText 和 outerHTML 都看不到，所以采样和快照都要自己走进去。
import { CONSENT_ACTIONS, CONSENT_SELECTORS, CONSENT_WORDS, GATE_PATTERNS } from './signals.ts'

const SHADOW_ROOTS = `(() => {
  const roots = []
  const walk = root => { for (const element of root.querySelectorAll('*')) if (element.shadowRoot) { roots.push(element.shadowRoot); walk(element.shadowRoot) } }
  walk(document)
  return roots
})()`
const CONSENT_HELPERS = `
  const roots = [document, ...${SHADOW_ROOTS}]
  const consentSelector = ${JSON.stringify(CONSENT_SELECTORS.join(', '))}
  const consent = roots.flatMap(root => [...root.querySelectorAll(consentSelector + ', dialog, [role="dialog"], [aria-modal="true"]')])
    .filter(element => element.matches(consentSelector) || (${CONSENT_WORDS}.test(element.textContent || '') && [...element.querySelectorAll('button, input, a')].some(control => ${CONSENT_ACTIONS}.test(control.textContent || control.value || ''))))
  const visibility = new WeakMap()
  const visible = element => {
    if (visibility.has(element)) return visibility.get(element)
    const style = getComputedStyle(element)
    const parent = element.parentElement || element.getRootNode().host
    const shown = !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && (!parent || visible(parent))
    visibility.set(element, shown)
    return shown
  }
`

/** 只点明示的拒绝/仅必要选项，不接受追踪、不提交年龄、不处理登录。每次读取最多点一次。 */
export const DISMISS_CONSENT_SCRIPT = `(() => {
  ${CONSENT_HELPERS}
  const refusal = /^(?:reject all(?: cookies)?|decline(?: all)?(?: cookies)?|deny(?: all)?(?: cookies)?|(?:use |allow |accept )?(?:only (?:strictly )?necessary cookies|(?:strictly )?necessary cookies only)|(?:拒绝|全部拒绝|所有拒绝)(?:全部|所有)?(?:非必要)?(?:cookie|cookies)?|仅(?:使用|允许|接受)?必要(?:的)?(?:cookie|cookies))$/i
  for (const panel of consent.filter(visible)) for (const control of panel.querySelectorAll('button, a, input[type="button"]')) {
    if (!visible(control) || control.disabled || control.getAttribute('aria-disabled') === 'true' || !refusal.test((control.innerText || control.textContent || control.value || '').trim().replace(/\\s+/g, ' '))) continue
    if (control.tagName === 'A' && !/^(?:#|javascript:)/i.test(control.getAttribute('href') || '')) continue
    control.click()
    return true
  }
  return false
})()`

export const SAMPLE_SCRIPT = `(() => {
  ${CONSENT_HELPERS}
  const chrome = 'script, style, template, noscript, nav, footer, header, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .breadcrumb, .breadcrumbs, button, select'
  const clean = element => {
    if (!visible(element)) return ''
    const clone = element.cloneNode(true)
    const originals = [element, ...element.querySelectorAll('*')]
    const copies = [clone, ...clone.querySelectorAll('*')]
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]
      if (original.matches(chrome) || consent.includes(original) || !visible(original)) {
        if (index === 0) return ''
        copies[index].remove()
      }
    }
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim()
  }
  const longest = values => values.sort((a, b) => b.length - a.length)[0] || ''
  const nonLinked = element => Math.max(0, clean(element).length - [...element.querySelectorAll('a')].reduce((sum, link) => sum + clean(link).length, 0))
  // 没有语义化 article 的站点，正文常与 h1 同处一个容器；不要把 body 当成这个候选。
  const headingParents = roots.flatMap(root => [...root.querySelectorAll('h1')].map(heading => heading.parentElement))
    .filter(element => element && element !== document.body && element.querySelector('p, pre') && nonLinked(element) > 120)
  const articles = [...roots.flatMap(root => [...root.querySelectorAll('article, .article-body, .article-content, .post-content, .entry-content')]), ...headingParents]
  const mains = roots.flatMap(root => [...root.querySelectorAll('main, [role="main"], #main-content, #content')])
  const mainRegions = mains.length > 0 ? mains : [document.body]
  const article = longest(articles.map(clean))
  const main = longest(mains.map(clean))
  const body = [document.body, ...roots.slice(1).flatMap(root => [...root.children])].filter(Boolean).map(clean).join(' ').trim()
  // 嵌套菜单的外层 li 会把所有游戏名合成一大段；只让叶子列表项贡献证据。
  const prose = roots.flatMap(root => [...root.querySelectorAll('p, pre, td, li')]).filter(element => !element.closest('nav, header, footer') && !consent.some(panel => panel.contains(element)))
    .filter(element => !element.querySelector('p, pre, td, li, ul, ol, [role="list"]') && nonLinked(element) > 80)
  const proseText = prose.map(clean).join(' ')
  const tables = roots.flatMap(root => [...root.querySelectorAll('table')])
  const tableText = tables.map(clean).filter(Boolean).join(' ')
  // 短数据表本身就是正文；单元格的链接标题同样是数据，不要求非链接字数。
  const shortTable = tables.some(table => !table.closest(chrome) && !consent.some(panel => panel.contains(table))
    && [...table.querySelectorAll('td')].some(cell => !cell.querySelector('td, th, table') && !cell.closest(chrome) && clean(cell).length > 0))
  // 视频页的主内容就是播放器；它往往比标题/评论骨架更早就绪，不能一直等到整页“稳定”。
  const videos = roots.flatMap(root => [...root.querySelectorAll('video')])
  const mediaEvidence = videos.some(video => {
    const rect = video.getBoundingClientRect()
    return visible(video) && rect.width >= 320 && rect.height >= 180 && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0
  })
  // GitHub issue/搜索结果/论坛列表没有 <p>，但每条标题本身就是正文；不能仅因链接比例高就判“无正文”。
  const lists = mainRegions.flatMap(region => [...region.querySelectorAll('ul, ol')])
    .filter(element => !element.closest('nav, header, footer') && !consent.some(panel => panel.contains(element)))
  const cardTitles = mainRegions.flatMap(region => [...region.querySelectorAll('h2, h3, h4')])
    .filter(element => !element.closest(chrome + ', form') && !consent.some(panel => panel.contains(element)) && element.querySelector('a[href]') && clean(element).length >= 8)
  const cardEvidence = cardTitles.length >= 5 && cardTitles.reduce((sum, element) => sum + clean(element).length, 0) > 100
  const listEvidence = cardEvidence || lists.some(list => {
    const items = [...list.querySelectorAll('li')].filter(item => !item.querySelector('li') && visible(item))
    const substantive = items.filter(item => clean(item).length >= 40)
    return substantive.length >= 5 && substantive.reduce((sum, item) => sum + clean(item).length, 0) > 300
  })
  const listText = listEvidence ? longest(lists.map(clean)) : ''
  const text = article || main || proseText || tableText || listText || body
  // 完整的短文和浏览器的 JSON/text 响应也可以是正文；长度不是就绪条件。
  const shortProse = roots.some(root => [...root.querySelectorAll('p, pre')].some(element => !element.closest(chrome) && !consent.some(panel => panel.contains(element)) && nonLinked(element) > 0))
  let structuredData = false
  try { structuredData = text.trim().length > 0 && typeof JSON.parse(text) === 'object' } catch {}
  const plainText = text.length > 0 && (document.contentType === 'text/plain' || [...(document.body?.childNodes || [])].some(node => node.nodeType === 3 && node.textContent.trim().length > 0))
  // 名言、说明等正文常只用 div/span；只累加叶子长文本，不让菜单容器拼接出正文。
  const leafText = roots.flatMap(root => [...root.querySelectorAll('div, span, blockquote, dd')])
    .filter(element => !element.closest(chrome + ', form, a') && !consent.some(panel => panel.contains(element))
      && !element.querySelector('div, span, blockquote, dd, p, pre, table, ul, ol') && nonLinked(element) > 80)
    .reduce((sum, element) => sum + nonLinked(element), 0)
  const contentEvidence = articles.some(element => nonLinked(element) > 80) || mains.some(element => element.querySelector('p, pre, table') && nonLinked(element) > 200) || proseText.length > 120 || tableText.length > 120 || listEvidence || shortProse || shortTable || structuredData || plainText || leafText > 120
  const visibleArea = element => {
    if (!visible(element)) return 0
    const rect = element.getBoundingClientRect()
    return Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0))
  }
  const busy = roots.some(root => [...root.querySelectorAll('main[aria-busy="true"], article[aria-busy="true"], main [aria-busy="true"], article [aria-busy="true"]')]
    .some(element => visibleArea(element) > 0))
  // 视口外的懒加载不阻塞当前页面；保留对视口内骨架的等待，不按猜测放宽。
  const skeletonArea = roots.flatMap(root => [...root.querySelectorAll('main .skeleton, article .skeleton')]).reduce((sum, element) => {
    const rect = element.getBoundingClientRect()
    const area = visibleArea(element)
    return sum + (rect.width >= 40 && rect.height >= 8 && area >= 400 ? area : 0)
  }, 0)
  const skeletons = skeletonArea > 0
  // 语言构成、阅读进度、播放进度也用 role=progressbar；只有加载语义或页面尚无正文时才当作加载指示。
  const progressLoading = roots.some(root => [...root.querySelectorAll('main [role="progressbar"], article [role="progressbar"]')].some(element => {
    if (visibleArea(element) === 0) return false
    const label = (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('aria-valuetext') || '') + ' ' + (element.textContent || '').slice(0, 80)
    const rect = element.getBoundingClientRect()
    const loadingLabel = /(?:loading|please wait|加载|载入|请稍候|处理中|正在加载)/i.test(label)
    const loadingShape = rect.width >= 120 && rect.height >= 24 && rect.width * rect.height >= 4000
    return loadingLabel || (!contentEvidence && loadingShape)
  }))
  const textLoading = text.length < 200 && /^(?:(?:loading|加载中|正在加载|载入中|请稍候|please wait)[.\\s…]*)$/i.test(text)
  const pendingContent = busy || skeletons || progressLoading || textLoading
  const consentText = consent.filter(visible).map(element => element.innerText || element.textContent || '').join(' ').replace(/\\s+/g, ' ').trim()
  const gateText = article || main || body
  const gate = [${GATE_PATTERNS.map(([, pattern]) => pattern.toString()).join(', ')}].map(pattern => pattern.exec(gateText)).find(Boolean)
  const excerptStart = gate ? Math.max(0, gate.index - 80) : 0
  // 登录表单比页头的普通登录链接更可靠；长篇正文旁的登录表单不应遮蔽正文。
  const loginForm = text.length < 600 && roots.some(root => [...root.querySelectorAll('input')].some(input => visible(input) && (
    /^(?:password|tel|email)$/.test(input.type) || input.autocomplete === 'username' || /手机|手机号|验证码|phone|email|verification code/i.test(input.placeholder || input.getAttribute('aria-label') || '')
  ))) && /sign in|log in|登录|登陆/i.test(text)
  const securityWall = articles.length === 0 && !listEvidence && text.length < 1200
    && /blocked by network security|unusual traffic from your computer network|我们的系统检测到您的计算机网络中存在异常流量/i.test(text)
  return { title: document.title, textLength: text.length, text: (gate ? gateText : text).slice(excerptStart, excerptStart + 600), contentEvidence, listEvidence, mediaEvidence, pendingContent, restrictionEvidence: securityWall ? 'bot_check' : loginForm ? 'login_wall' : undefined, consentText: consentText.slice(0, 500) }
})()`

/** 等正文就绪后清理同意面板，避免污染 ARIA 覆盖率与返回文本。 */
export const CLEAN_CONSENT_SCRIPT = `(() => {
  ${CONSENT_HELPERS}
  for (const panel of consent) panel.remove()
})()`
