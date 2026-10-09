/**
 * 内建解析器插件：`.pptx`（OOXML 演示文稿）。
 *
 * 从 `ProcessingEngine.extractPptx` 原样搬出（jszip 解包 → 按 `ppt/slides/slideN.xml` 序号抽 `<a:t>`），
 * 并新增锚点归一：每张幻灯片产出一个 `{ kind: 'slide', value: 幻灯片序, start, end }`，
 * `start/end` 是该页文本在返回 `text` 中的字符偏移（块级溯源 D8 依赖它）。
 * `metadata.slides` 与改造前完全一致（供既有展示逻辑复用）。
 */
import * as fs from 'fs'
import { ChunkAnchor, ParserParseInput, ParserParseResult, ParserPlugin } from '../types'
import { measure, measureSync } from '../../perfLogger'
import { normalizeLineBreaks } from '../../chunks'
import { extractSlideText } from './xmlText'

async function parsePptx(input: ParserParseInput): Promise<ParserParseResult> {
  const { filePath, perf } = input
  const JSZip = require('jszip')
  const data = measureSync(perf, 'read', () => fs.readFileSync(filePath))
  let zip: any
  try {
    zip = await measure(perf, 'pptx.open', () => JSZip.loadAsync(data))
  } catch (e: any) {
    throw new Error(`pptx 不是有效的 OOXML 包：${e?.message || e}`)
  }

  const slideNames = Object.keys(zip.files).filter((n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  if (!slideNames.length) throw new Error('pptx 文件结构异常，未能定位幻灯片')

  const slideNo = (n: string) => parseInt(n.replace(/^ppt\/slides\/slide/, ''), 10)
  slideNames.sort((a: string, b: string) => slideNo(a) - slideNo(b))

  let text = ''
  const slides: number[] = []
  const anchors: ChunkAnchor[] = []
  for (const name of slideNames) {
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async('string')
    // 单张幻灯片的文本先归一化换行，锚点偏移才能与写库后的 content_text 对齐
    const slideText = normalizeLineBreaks(measureSync(perf, 'pptx.slide', () => extractSlideText(xml)))
    slides.push(slideNo(name))
    if (text) text += '\n\n'
    const start = text.length
    text += slideText
    anchors.push({ kind: 'slide', value: slideNo(name), start, end: text.length })
  }
  if (!text.trim()) throw new Error('pptx 文件结构异常，未能从幻灯片中提取到文本')
  return { text, anchors, metadata: { slides } }
}

export function createPptxParser(): ParserPlugin {
  return { kind: 'parser', extensions: ['pptx'], parse: parsePptx }
}
