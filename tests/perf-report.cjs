/*
 * 解析分阶段耗时实测采集器
 *
 * 用法：node tests/perf-report.cjs
 *   （需先 npm run typecheck 或 tsc -p electron/tsconfig.json 产出 dist-electron）
 *
 * 做法：把仓库 docs/ 下的真实 md、根目录 3 篇文档、以及生成的 docx/xlsx/pdf 样本
 * 导入一个临时数据目录，开启 perf_log_enabled 跑完整解析链路，最后按阶段汇总耗时。
 * 结果与原始埋点行都会打印到 stdout，临时数据目录路径也会给出，便于进一步排查。
 *
 * 对照实验（同一份输入上的 A/B）：
 *   PERF_BASELINE=1       关闭分块重叠 + 批推理设为 1，复现优化前的逐块串行行为
 *   PERF_CHUNK_SIZE / PERF_CHUNK_OVERLAP / PERF_BATCH   覆盖对应设置项
 *   PERF_CONCURRENCY      覆盖解析并发度（用于定位并发冷启动下模型被重复加载的问题）
 * 例：PERF_CHUNK_OVERLAP=0 PERF_BATCH=8 node tests/perf-report.cjs
 *     PERF_CONCURRENCY=1 node tests/perf-report.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const Excel = require('exceljs')
const { createRuntime } = require('../dist-electron/services/runtime')

function collectMd(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectMd(p, out)
    else if (e.name.toLowerCase().endsWith('.md')) out.push(p)
  }
}

async function buildSamples(src) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const paras = []
  for (let i = 0; i < 40; i++) {
    paras.push(`<w:p><w:r><w:t>第 ${i + 1} 段：知识图谱实体抽取与关系构建的性能验证段落，联系人 perf${i}@example.com，机构 腾讯科技 ${i}。</w:t></w:r></w:p>`)
  }
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}</w:body></w:document>`)
  const docx = path.join(src, '性能验证.docx')
  fs.writeFileSync(docx, await zip.generateAsync({ type: 'nodebuffer' }))

  const workbook = new Excel.Workbook()
  const sheet = workbook.addWorksheet('计划')
  sheet.addRow(['任务', '负责人', '状态'])
  for (let i = 0; i < 200; i++) sheet.addRow([`任务 ${i + 1} 知识图谱构建`, `负责人 ${i + 1}`, i % 3 === 0 ? '进行中' : '已完成'])
  const xlsx = path.join(src, '性能验证.xlsx')
  await workbook.xlsx.writeFile(xlsx)

  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const stream = 'BT /F1 18 Tf 50 700 Td (Knowledge PDF performance validation perf@example.com) Tj ET'
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const pdfPath = path.join(src, '性能验证.pdf')
  fs.writeFileSync(pdfPath, pdf)

  return [docx, xlsx, pdfPath]
}

function summarize(lines) {
  const agg = new Map()
  let total = 0
  for (const line of lines) {
    const parts = line.split(' | ')
    if (parts.length < 3) continue
    const tail = parts[parts.length - 1]
    const m = /total=(\d+)ms/.exec(tail)
    if (m) total += Number(m[1])
    for (const tok of parts[parts.length - 2].split(' ')) {
      const t = /^([\w.]+)(?:×(\d+))?=(\d+)ms$/.exec(tok)
      if (!t) continue
      const prev = agg.get(t[1]) || { ms: 0, calls: 0 }
      prev.ms += Number(t[3])
      prev.calls += 1
      agg.set(t[1], prev)
    }
  }
  const rows = [...agg.entries()].sort((a, b) => b[1].ms - a[1].ms)
  console.log('\n=== 分阶段汇总（所有文档累加） ===')
  console.log('阶段'.padEnd(14) + '累计ms'.padStart(10) + '占耗时比'.padStart(11) + '文档数'.padStart(9))
  for (const [name, v] of rows) {
    const pct = total ? (v.ms / total * 100).toFixed(1) + '%' : '-'
    console.log(name.padEnd(14) + String(v.ms).padStart(10) + pct.padStart(11) + String(v.calls).padStart(9))
  }
  console.log('文档总耗时合计: ' + total + 'ms')
}

async function main() {
  const repo = path.resolve(__dirname, '..')
  const external = path.resolve(repo, '..')
  const root = path.resolve(repo, '.verification/perf-collect-' + Date.now())
  const src = path.join(root, 'source')
  fs.mkdirSync(src, { recursive: true })

  const mds = []
  collectMd(path.join(external, 'docs'), mds)
  for (const n of ['README.md', '需求文档.md', '设计开发文档.md']) {
    const p = path.join(external, n)
    if (fs.existsSync(p)) mds.push(p)
  }

  // 注意：docs/README.md 与根目录 README.md 同名，若直接按 basename 拷进同一个目录会互相覆盖，
  // 导致 inputs 里出现重复路径、实际只导入 N-1 个文件。这里给重名文件加上父目录前缀。
  const usedNames = new Set()
  const inputs = []
  for (const p of mds) {
    let name = path.basename(p)
    if (usedNames.has(name)) name = `${path.basename(path.dirname(p))}__${name}`
    usedNames.add(name)
    const dst = path.join(src, name)
    fs.copyFileSync(p, dst)
    inputs.push(dst)
  }
  const merged = path.join(src, '合并语料.md')
  fs.writeFileSync(merged, mds.map(p => `# ${path.basename(p)}\n\n` + fs.readFileSync(p, 'utf8')).join('\n\n'))
  inputs.push(merged)
  inputs.push(...await buildSamples(src))

  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ perf_log_enabled: 'true', ocr_enabled: 'false' })
  const baseline = process.env.PERF_BASELINE === '1'
  const tune = {}
  if (baseline) Object.assign(tune, { chunk_overlap: '0', embed_batch_size: '1' })
  if (process.env.PERF_CHUNK_SIZE) tune.chunk_size = process.env.PERF_CHUNK_SIZE
  if (process.env.PERF_CHUNK_OVERLAP) tune.chunk_overlap = process.env.PERF_CHUNK_OVERLAP
  if (process.env.PERF_BATCH) tune.embed_batch_size = process.env.PERF_BATCH
  if (Object.keys(tune).length) await r.db.updateSettings(tune)
  if (process.env.PERF_CONCURRENCY) r.setQueueConcurrency(Number(process.env.PERF_CONCURRENCY))
  const effective = { ...(await r.db.getSettings()) }
  console.log(`模式: ${baseline ? 'BASELINE' : 'CUSTOM'} | chunk_size=${effective.chunk_size} chunk_overlap=${effective.chunk_overlap} embed_batch_size=${effective.embed_batch_size} concurrency=${process.env.PERF_CONCURRENCY || effective.queue_concurrency}`)
  console.log(`导入 ${inputs.length} 个文件（真实文档 ${mds.length} + 合并语料 1 + 生成样本 3）`)
  const t0 = Date.now()
  const imported = await r.importFiles(inputs)
  await r.idle()
  const wall = Date.now() - t0
  const ok = imported.filter(x => x.success).length
  r.db.close()

  const logDir = path.join(root, 'Data', 'logs')
  const logFile = fs.readdirSync(logDir).find(f => f.startsWith('perf-'))
  console.log(`导入成功 ${ok}/${inputs.length}，墙钟耗时 ${wall}ms，日志 ${logFile}`)
  const lines = fs.readFileSync(path.join(logDir, logFile), 'utf8').trim().split('\n')
  console.log('\n=== 原始埋点行 ===')
  lines.forEach(l => console.log(l.replace(/^\[[^\]]+\] /, '')))
  summarize(lines)
  console.log('\n数据目录: ' + root)
}

main().catch(e => { console.error(e); process.exit(1) })
