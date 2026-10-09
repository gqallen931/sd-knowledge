/**
 * 已移出 `ProcessingEngine` 主类的三个内建解析器插件（pptx / epub / xls）。
 *
 * 其余格式（pdf/word/excel/text/image/video/audio）仍复用 ProcessingEngine 的既有实现，
 * 以**薄适配器**形式在 `processingEngine.registerBuiltinParsers()` 里注册——两种形态走的是
 * 同一个注册表接口，核心不再按 `file_type` 写 switch。
 */
import { ParserPlugin, PluginManifest } from '../types'
import { builtinParserManifest } from './manifests'
import { createEpubParser } from './parserEpub'
import { createPptxParser } from './parserPptx'
import { createXlsParser } from './parserXls'

export interface BuiltinParserRegistration {
  manifest: PluginManifest
  plugin: ParserPlugin
}

/** 独立模块形态的内建解析器（pptx/epub/xls）：内建能力也走插件路径（D21） */
export function buildDetachedBuiltinParsers(): BuiltinParserRegistration[] {
  return [
    {
      manifest: builtinParserManifest({
        id: 'sd.parser.pptx',
        name: 'PPTX 解析器',
        extensions: ['pptx'],
        description: 'OOXML 演示文稿：jszip 解包后按幻灯片抽文本，产出幻灯片锚点',
      }),
      plugin: createPptxParser(),
    },
    {
      manifest: builtinParserManifest({
        id: 'sd.parser.epub',
        name: 'EPUB 解析器',
        extensions: ['epub'],
        description: '电子书：按 OPF spine 顺序逐章抽正文，产出章节锚点',
      }),
      plugin: createEpubParser(),
    },
    {
      manifest: builtinParserManifest({
        id: 'sd.parser.xls',
        name: 'XLS 解析器',
        extensions: ['xls'],
        description: '旧版二进制 Excel（BIFF）：xlsx(SheetJS) 解析，按工作表分节',
      }),
      plugin: createXlsParser(),
    },
  ]
}
