
import express from 'express';
import cors from 'cors';

const app = express();
// Add explicit type casting for middleware to resolve NextHandleFunction mismatch in strictly typed environments
app.use(cors() as any);
app.use(express.json() as any);

const PORT = 3000;

const BRANCH_MAPPING = {
  "ADMIN": "Administration & governance",
  "FACT":  "Factual chronology & context",
  "PEN":   "Criminal",
  "CIV":   "Civil",
  "ADM":   "Administrative",
  "MED": "Medical",
  "EXP": "Expert reports / independent expertise",
  "COR": "Correspondence (non-procedural)",
  "EVD": "Evidence repository (digital/physical references)",
  "ANA": "Analyses (legal/medical/factual syntheses)",
  "STR": "Strategy (non-disclosable internal work product)",
  "PRC": "Procedure (filings, deadlines, court steps)",
  "ARC": "Archives (frozen/closed material)"
};

// SOVEREIGN DATABASE (In-Memory)
const db: any = {
  cases: [
    {
      case_id: 'CASE-2024-001',
      case_title: 'Smith v. Global Logistics Corp.',
      jurisdiction: 'High Court of Justice',
      confidentiality_level: 'LEGAL_PRIVILEGED',
      created_at: new Date().toISOString(),
      branches: Object.keys(BRANCH_MAPPING).map(code => ({
        branch_id: `BRANCH-2024-001-${code}`,
        branch_code: code,
        branch_label: (BRANCH_MAPPING as any)[code],
        isolation_level: 'STRICT_WITH_REFERENCES',
        documents: []
      })),
      parties: [
        { party_role: 'SELF', display_label: 'Alice Smith', notes: 'Lead Claimant' },
        { party_role: 'COUNTERPARTY', display_label: 'Global Logistics Corp.', notes: 'Primary Defendant' }
      ],
      links: []
    }
  ],
  documents: [], // Flat index for fast lookup
  traces: []
};

// ENUM & TRANSITION CONSTANTS
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  "INBOX": ["REGISTERED", "DUPLICATE", "ERROR", "DISPUTED"],
  "REGISTERED": ["CLASSIFIED", "DUPLICATE", "ERROR", "DISPUTED"],
  "CLASSIFIED": ["QUALIFIED", "REDACTED", "ERROR", "DISPUTED"],
  "QUALIFIED": ["EXHIBIT_READY", "ERROR", "DISPUTED"],
  "EXHIBIT_READY": ["FILED", "ERROR", "DISPUTED"],
  "FILED": ["FROZEN", "ERROR", "DISPUTED"],
  "FROZEN": ["ARCHIVED", "ERROR", "DISPUTED"],
  "ARCHIVED": [],
  "DUPLICATE": ["ARCHIVED", "ERROR"],
  "DISPUTED": ["CLASSIFIED", "ERROR", "ARCHIVED"],
  "REDACTED": ["QUALIFIED", "ERROR"],
  "ERROR": ["INBOX", "ARCHIVED"]
};

// READ TOOLS LOGIC
const readTools = {
  case_get: (payload: any) => {
    const caseObj = db.cases.find((c: any) => c.case_id === payload.case_id);
    if (!caseObj) throw { code: 'CASE_NOT_FOUND', message: `Case ${payload.case_id} not found.` };
    
    // Enrich branches with their documents from the flat index
    const enrichedCase = {
      ...caseObj,
      branches: caseObj.branches.map((b: any) => ({
        ...b,
        documents: db.documents.filter((d: any) => d.case_id === payload.case_id && d.branch_code === b.branch_code)
      }))
    };
    return enrichedCase;
  },

  doc_get: (payload: any) => {
    const doc = db.documents.find((d: any) => d.document_id === payload.document_id && d.case_id === payload.case_id);
    if (!doc) throw { code: 'OBJECT_NOT_FOUND', message: `Document ${payload.document_id} not found in case ${payload.case_id}.` };
    return doc;
  },

  trace_query: (payload: any) => {
    const caseTraces = db.traces
      .filter((t: any) => t.case_id === payload.case_id)
      .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Descending
    return caseTraces;
  }
};

// VALIDATOR GATE (MUTATION) LOGIC
const validatorGate = {
  doc_status_transition: (payload: any) => {
    const doc = db.documents.find((d: any) => d.document_id === payload.document_id);
    if (!doc) throw { code: 'OBJECT_NOT_FOUND', message: `Record ${payload.document_id} missing.` };
    
    const allowed = ALLOWED_TRANSITIONS[doc.status] || [];
    if (!allowed.includes(payload.to_status)) {
      throw { code: 'ILLEGAL_STATUS_TRANSITION', message: `Transition ${doc.status} -> ${payload.to_status} is a compliance breach.` };
    }
    return true;
  },

  doc_rename: (payload: any) => {
    const namingRegex = /^[A-Z]{3}_\d{4}-\d{2}-\d{2}_[A-Z_]+_[a-zA-Z0-9-]+\.[a-z0-9]+$/;
    if (!namingRegex.test(payload.new_name)) {
      throw { code: 'FILENAME_NON_COMPLIANT', message: `Filename '${payload.new_name}' violates Authority Charter naming standard.` };
    }
    return true;
  },

  doc_link_create: (payload: any) => {
    if (!payload.justification || payload.justification.length < 10) {
      throw { code: 'MISSING_JUSTIFICATION', message: "Audit-grade justification (min 10 chars) required." };
    }
    const fromDoc = db.documents.find((d: any) => d.document_id === payload.from_object.object_id);
    const toDoc = db.documents.find((d: any) => d.document_id === payload.to_object.object_id);
    
    if (fromDoc && toDoc && fromDoc.case_id !== toDoc.case_id) {
      throw { code: 'BRANCH_ISOLATION_VIOLATION', message: "Cross-case linking prohibited by isolation policy." };
    }
    return true;
  }
};

// API ENDPOINT: UNIFIED GATE (READ + WRITE)
app.post('/api/gate', (req, res) => {
  const { toolName, payload, caseId } = req.body;
  const requestId = payload?.request_id || `REQ-${Date.now()}`;

  try {
    // 1. Handle READ Operations
    if (readTools[toolName as keyof typeof readTools]) {
      console.log(`[GATE] Request ${requestId}: READ execution for ${toolName}...`);
      const data = (readTools[toolName as keyof typeof readTools] as any)(payload || { case_id: caseId });
      return res.json({ ok: true, data });
    }

    // 2. Handle WRITE Operations (Validator Gate)
    console.log(`[GATE] Request ${requestId}: Validating MUTATION ${toolName}...`);
    
    if (validatorGate[toolName as keyof typeof validatorGate]) {
      (validatorGate[toolName as keyof typeof validatorGate] as any)(payload);
    }

    // State Mutation
    let traceEventId = `TRACE-${Date.now()}`;
    let resultData = { ...payload };

    if (toolName === 'doc_ingest') {
      const docId = `DOC-${Date.now()}`;
      const newDoc = { 
        ...payload.metadata, 
        document_id: docId, 
        case_id: caseId,
        branch_code: payload.branch_code,
        status: payload.metadata.status || 'INBOX',
        registered_at: new Date().toISOString(),
        artifacts: [{ 
            artifact_id: `ART-${Date.now()}`,
            document_id: docId,
            filename: payload.source.filename,
            storage_ref: payload.source.storage_ref,
            mime_type: 'application/octet-stream',
            created_at: new Date().toISOString()
        }]
      };
      db.documents.push(newDoc);
      resultData = newDoc;
    } else if (toolName === 'doc_status_transition') {
      const doc = db.documents.find((d: any) => d.document_id === payload.document_id);
      doc.status = payload.to_status;
      resultData = doc;
    }

    // 3. Automated Trace Logging for Mutations
    const traceEvent = {
      event_id: traceEventId,
      case_id: caseId || 'SYSTEM',
      timestamp: new Date().toISOString(),
      actor: 'AUTHORITATIVE_GATE',
      event_type: toolName.toUpperCase(),
      objects: payload.document_id ? [{ object_type: 'DOCUMENT', object_id: payload.document_id }] : [],
      details: { 
        summary: `Validated tool execution: ${toolName}`,
        request_id: requestId,
        payload: payload
      }
    };
    db.traces.push(traceEvent);

    res.json({ ok: true, data: resultData, trace_event_id: traceEventId });

  } catch (error: any) {
    console.error(`[GATE] Gate Error: ${error.message}`);
    const statusCode = (error.code === 'CASE_NOT_FOUND' || error.code === 'OBJECT_NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({ 
      ok: false, 
      error: { 
        code: error.code || 'VALIDATION_FAILED', 
        message: error.message 
      } 
    });
  }
});

app.listen(PORT, () => {
  console.log(`JurisBinder Sovereign Gate running on http://localhost:${PORT}`);
});
