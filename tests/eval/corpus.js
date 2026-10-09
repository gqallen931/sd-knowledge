/**
 * 评测语料装配（D11 / 架构文档 §5.4.3）。
 *
 * 语料分两部分：
 *   1. `corpus/` 下**已提交的纯文本语料**（md / txt / csv）——可直接审阅、可 diff；
 *   2. **运行时生成的二进制语料**（docx / xlsx）——避免把二进制塞进仓库，
 *      同时保证评测真的覆盖到 OOXML 解析路径（PPTX/EPUB 未纳入：见 README 的降级说明）。
 *
 * 语料一律写进**临时目录**，评测不依赖也不修改用户库。
 */
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const Excel = require('exceljs')

/** 已提交的纯文本语料所在目录 */
const CORPUS_DIR = path.join(__dirname, 'corpus')

async function writeDocx(destPath, title, paragraphs) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const body = [title, ...paragraphs]
    .map(text => `<w:p><w:r><w:t>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
  fs.writeFileSync(destPath, await zip.generateAsync({ type: 'nodebuffer' }))
}

async function writeXlsx(destPath) {
  const workbook = new Excel.Workbook()
  const sources = workbook.addWorksheet('来源分布')
  sources.addRow(['映射源', '文档数', '占用兆字节'])
  sources.addRow(['会议纪要', 128, 42])
  sources.addRow(['产品文档', 96, 87])
  sources.addRow(['技术规范', 214, 156])
  sources.addRow(['客户资料', 63, 21])
  const types = workbook.addWorksheet('类型分布')
  types.addRow(['格式', '数量', '是否可解析'])
  types.addRow(['pdf', 210, '是'])
  types.addRow(['docx', 132, '是'])
  types.addRow(['xlsx', 88, '是'])
  types.addRow(['pptx', 41, '是'])
  types.addRow(['epub', 17, '是'])
  types.addRow(['扫描图片', 13, '需要 OCR'])
  await workbook.xlsx.writeFile(destPath)
}

/** 生成 docx 语料：工作台任务说明（中文，覆盖任务看板与提醒） */
const DOCX_PARAGRAPHS = [
  '任务以分组为单位组织，一个任务只属于一个分组，换组时可以拖拽到目标分组的表头，也可以在智能详情里直接改分组字段。',
  '智能详情展示六行核心字段：负责人、参与人、截止日期、优先级、状态、所属项目。字段编辑即保存，不做额外的确认弹窗。',
  '状态分待开始、进行中、已完成三种。完成与归档是两件事：完成是任务的结果，归档是从看板收起，归档后的任务不再出现在默认视图里。',
  '逾期通知按「分组加链接标识加标题」做业务唯一键去重，未读的同一事件只会有一条通知，避免文案微调就产生重复提醒。',
  '提醒支持一次性与重复两种模式，到点后由提醒轮询写入通知，前端从消息中心读取。',
]

/**
 * 把完整语料装配到目标目录。
 * @returns {Array<{fileName: string, fileType: string, bytes: number}>} 语料清单
 */
async function buildCorpus(destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const manifest = []
  for (const entry of fs.readdirSync(CORPUS_DIR)) {
    const source = path.join(CORPUS_DIR, entry)
    if (!fs.statSync(source).isFile()) continue
    const target = path.join(destDir, entry)
    fs.copyFileSync(source, target)
    manifest.push({ fileName: entry, fileType: path.extname(entry).replace('.', '').toLowerCase(), bytes: fs.statSync(target).size })
  }
  const docx = path.join(destDir, '工作台任务说明.docx')
  await writeDocx(docx, '工作台任务说明', DOCX_PARAGRAPHS)
  manifest.push({ fileName: '工作台任务说明.docx', fileType: 'docx', bytes: fs.statSync(docx).size })
  const xlsx = path.join(destDir, '来源统计.xlsx')
  await writeXlsx(xlsx)
  manifest.push({ fileName: '来源统计.xlsx', fileType: 'xlsx', bytes: fs.statSync(xlsx).size })
  return manifest
}

module.exports = { buildCorpus, CORPUS_DIR }
