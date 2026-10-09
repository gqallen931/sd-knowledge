/**
 * 内建解析器插件：旧版二进制 `.xls`（BIFF）。
 *
 * 从 `ProcessingEngine.extractXls` 原样搬出（含错误文案与输出口径），改为独立的内建插件模块：
 * 这是「新增格式不用再改 processingEngine 的 switch」的具体证据。
 * exceljs 不支持 xls，此处用同为 SheetJS 生态的 xlsx@0.18.5，输出风格与 xlsx 分支保持一致
 * （按 sheet 分节、行内制表符拼接）。
 */
import { measureSync } from '../../perfLogger'
import { normalizeLineBreaks } from '../../chunks'
import { ChunkAnchor, ParserParseInput, ParserParseResult, ParserPlugin } from '../types'

async function parseXls(input: ParserParseInput): Promise<ParserParseResult> {
  const { filePath, perf } = input
  let XLSX: any
  try {
    XLSX = require('xlsx')
  } catch (e: any) {
    throw new Error('xls 解析依赖 xlsx 加载失败，请重新安装依赖后重试')
  }
  let workbook: any
  try {
    workbook = measureSync(perf, 'xls.parse', () => XLSX.readFile(filePath))
  } catch (e: any) {
    throw new Error(`xls 文件解析失败：${e?.message || e}`)
  }
  if (!workbook || !Array.isArray(workbook.SheetNames)) throw new Error('xls 文件结构异常，未能定位工作表')

  let text = ''
  const sheets: string[] = []
  const anchors: ChunkAnchor[] = []
  measureSync(perf, 'xls.walk', () => {
    for (const name of workbook.SheetNames as string[]) {
      const sheet = workbook.Sheets?.[name]
      if (!sheet) continue
      sheets.push(name)
      const start = text.length
      text += `## ${name}\n`
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as any[][]
      for (const row of rows) {
        const values = (row || []).filter((v: any) => v !== null && v !== undefined && v !== '')
        // 单元格可能带 \r\n：先归一化，保证锚点 start/end 与写库后的 content_text 对齐
        if (values.length) text += normalizeLineBreaks(values.join('\t')) + '\n'
      }
      // 工作表锚点（§5.6.3）：value 取 1 起的工作表序，名称与 metadata.sheets 同序对齐
      anchors.push({ kind: 'sheet', value: sheets.length, start, end: text.length })
    }
  })
  return { text, anchors, metadata: { sheets } }
}

export function createXlsParser(): ParserPlugin {
  return { kind: 'parser', extensions: ['xls'], parse: parseXls }
}
