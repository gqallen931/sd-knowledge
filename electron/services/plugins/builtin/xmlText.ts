/**
 * OOXML / XHTML 的纯文本抽取与 zip 路径工具。
 *
 * 从 `processingEngine.ts` 原样搬出（只服务于 pptx / epub 两个内建解析器），
 * 搬出后主类不再持有格式细节——新增格式不必再改 `ProcessingEngine`。
 */

/** 解码 XML/HTML 常见实体（含数字实体），供 pptx/epub 抽取纯文本时还原原始字符 */
export function decodeEntities(input: string): string {
  return String(input || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // &amp; 放最后，避免把 `&amp;lt;` 二次解码成 `<`
    .replace(/&amp;/g, '&')
}

/** 从一段标签里取属性值（属性顺序不固定，用正则逐属性匹配，避免引入 XML 解析依赖） */
export function xmlAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`))
  return m ? decodeEntities(m[1]) : undefined
}

/** zip 内的 POSIX 相对路径归一化（处理 `..` / 多余分隔符，统一 `/`） */
export function normalizeZipPath(p: string): string {
  const parts: string[] = []
  for (const seg of String(p || '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * HTML/XHTML → 纯文本。与 html 分支「按文本读取」的口径一致：去脚本/样式、去标签、解码实体、
 * 块级标签转换行，最后折叠多余空白。epub 章节即由它抽取正文。
 */
export function htmlToText(html: string): string {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|td)>/gi, '\n')
  return decodeEntities(body.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从一张 pptx 幻灯片 XML 里按段落抽取 `<a:t>` 文本块（段内 run 直接拼接，段间换行） */
export function extractSlideText(xml: string): string {
  const lines: string[] = []
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
  let para: RegExpExecArray | null
  while ((para = paraRe.exec(xml)) !== null) {
    let run: RegExpExecArray | null
    let line = ''
    runRe.lastIndex = 0
    while ((run = runRe.exec(para[1])) !== null) line += decodeEntities(run[1])
    if (line.trim()) lines.push(line.trim())
  }
  return lines.join('\n')
}
