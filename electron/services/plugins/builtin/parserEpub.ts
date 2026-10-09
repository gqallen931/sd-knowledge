/**
 * 内建解析器插件：`.epub`。
 *
 * 从 `ProcessingEngine.extractEpub` 原样搬出（jszip 解包 → META-INF/container.xml 定位 OPF →
 * 按 spine 顺序逐章抽 XHTML 正文，文本口径复用 html 分支的 htmlToText），并新增锚点归一：
 * 每个非空章节产出一个 `{ kind: 'chapter', value: 章节序（1 起）, start, end }`。
 * `metadata.chapters` 与改造前一致（存章节 zip 路径），与锚点按序号一一对应。
 */
import * as fs from 'fs'
import { ChunkAnchor, ParserParseInput, ParserParseResult, ParserPlugin } from '../types'
import { measure, measureSync } from '../../perfLogger'
import { normalizeLineBreaks } from '../../chunks'
import { decodeEntities, htmlToText, normalizeZipPath, xmlAttr } from './xmlText'

async function parseEpub(input: ParserParseInput): Promise<ParserParseResult> {
  const { filePath, perf } = input
  const JSZip = require('jszip')
  const data = measureSync(perf, 'read', () => fs.readFileSync(filePath))
  let zip: any
  try {
    zip = await measure(perf, 'epub.open', () => JSZip.loadAsync(data))
  } catch (e: any) {
    throw new Error(`epub 不是有效的 zip 包：${e?.message || e}`)
  }

  const container = zip.file('META-INF/container.xml')
  if (!container) throw new Error('epub 文件结构异常，缺少 META-INF/container.xml')
  const containerXml = await container.async('string')
  const rootMatch = containerXml.match(/<rootfile\b[^>]*full-path="([^"]+)"/)
  if (!rootMatch) throw new Error('epub 文件结构异常，未能定位 OPF 清单文件')

  const opfPath = normalizeZipPath(decodeEntities(rootMatch[1]))
  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error(`epub 文件结构异常，未找到 OPF 清单文件：${opfPath}`)
  const opf = await opfFile.async('string')

  // manifest：id → href；spine：按 itemref 的 idref 还原阅读顺序
  const manifest = new Map<string, string>()
  const itemRe = /<item\b[^>]*>/g
  let item: RegExpExecArray | null
  while ((item = itemRe.exec(opf)) !== null) {
    const id = xmlAttr(item[0], 'id')
    const href = xmlAttr(item[0], 'href')
    if (id && href) manifest.set(id, href)
  }

  const order: string[] = []
  const refRe = /<itemref\b[^>]*>/g
  let ref: RegExpExecArray | null
  while ((ref = refRe.exec(opf)) !== null) {
    const idref = xmlAttr(ref[0], 'idref')
    const href = idref ? manifest.get(idref) : undefined
    if (href) order.push(href)
  }
  if (!order.length) throw new Error('epub 文件结构异常，未找到正文顺序（spine）')

  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  let text = ''
  const chapters: string[] = []
  const anchors: ChunkAnchor[] = []
  for (const href of order) {
    const zipPath = normalizeZipPath(decodeURIComponent(baseDir + href.split('#')[0]))
    const chapterFile = zip.file(zipPath)
    if (!chapterFile) continue
    const raw = await chapterFile.async('string')
    // 章节文本先归一化换行，锚点偏移才能与写库后的 content_text 对齐
    const chapterText = normalizeLineBreaks(measureSync(perf, 'epub.chapter', () => htmlToText(raw)))
    if (!chapterText) continue
    chapters.push(zipPath)
    if (text) text += '\n\n'
    const start = text.length
    text += chapterText
    anchors.push({ kind: 'chapter', value: chapters.length, start, end: text.length })
  }
  if (!text.trim()) throw new Error('epub 文件结构异常，未能从 spine 章节中提取到文本')
  return { text, anchors, metadata: { chapters } }
}

export function createEpubParser(): ParserPlugin {
  return { kind: 'parser', extensions: ['epub'], parse: parseEpub }
}
