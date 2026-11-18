-- Remove AutoSNAP-generated report PDFs; only official ASPI evidence remains.
DELETE FROM autosnap_evidence_pdfs WHERE activity_id = 'autosnap-report-v1';
