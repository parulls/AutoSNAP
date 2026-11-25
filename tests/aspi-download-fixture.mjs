/**
 * PDF bytes that satisfy the production origin gate (jsPDF / html2pdf producer).
 * This is a shape fixture for orchestration tests. It is not an official ASPI document.
 */
export function aspiDownloadFixture(label = "fixture") {
  const safe = String(label).replace(/[()\\\r\n]/g, " ").slice(0, 80);
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Producer (jsPDF 2.5.1) /Creator (html2pdf.js) /Title (${safe}) >>\nendobj\n${safe}\n%%EOF\n`);
}
