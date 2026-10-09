const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const Excel = require('exceljs')
const { createRuntime } = require('../dist-electron/services/runtime')
async function main() {
 const root = path.resolve(__dirname,'../.verification/formats-'+Date.now())
 fs.mkdirSync(root,{recursive:true})
 const r=await createRuntime(path.join(root,'Data'))
 await r.db.updateSettings({vector_enabled:'false',ocr_enabled:'false'})
 const zip=new JSZip()
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>知识图谱 Word 验证 documentation@example.com</w:t></w:r></w:p></w:body></w:document>')
 const docx=path.join(root,'验证文档.docx')
 fs.writeFileSync(docx,await zip.generateAsync({type:'nodebuffer'}))
 const workbook=new Excel.Workbook();workbook.addWorksheet('计划').addRows([['任务','状态'],['知识图谱','已完成']])
 const xlsx=path.join(root,'验证表格.xlsx');await workbook.xlsx.writeFile(xlsx)
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
 const stream='BT /F1 18 Tf 50 700 Td (Knowledge PDF validation pdf@example.com) Tj ET'
 objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
 let pdf='%PDF-1.4\n';const offsets=[0]
 objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`})
 const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
 const pdfPath=path.join(root,'validation.pdf');fs.writeFileSync(pdfPath,pdf)
 const imported=await r.importFiles([docx,xlsx,pdfPath]);await r.idle()
 for(const result of imported){const d=await r.files.getFileDetail(result.documentId);assert.equal(d.processing_status,'ready',d.file_name+': '+d.processing_error);assert(d.content_text.length>10);console.log('PASS format:',d.file_type)}
 assert.equal((await r.search.fullTextSearch('知识图谱')).items.length,2)
 r.db.close()
 const base='http://127.0.0.1:18991'
 const {token}=await (await fetch(base+'/local/session')).json()
 const form=new FormData();form.append('files',new Blob(['浏览器真实上传验收 upload@example.com']),'浏览器上传验证.txt')
 const upload=await fetch(base+'/local/upload',{method:'POST',headers:{'X-SD-Session':token},body:form});assert.equal(upload.status,200)
 const result=await upload.json();assert(result[0].success)
 const detail=await (await fetch(base+'/local/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-SD-Session':token},body:JSON.stringify({method:'file.detail',args:[result[0].documentId]})})).json()
 assert.equal(detail.file_name,'浏览器上传验证.txt')
 assert.equal((await fetch(base+'/local/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403)
 console.log('PASS: DOCX/XLSX/PDF content extraction, real multipart upload, Unicode filenames, local session validation')
}
main().catch(e=>{console.error(e);process.exit(1)})
