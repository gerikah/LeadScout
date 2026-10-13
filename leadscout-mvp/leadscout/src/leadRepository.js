import { getLeadId, LEAD_STATUSES } from './leadData.js';

export const LEAD_STORAGE_KEY = 'leadscout:leads:v2';
export const LEGACY_STORAGE_KEY = 'leadscout:saved';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(status) {
  if (typeof status !== 'string') return 'New';
  return LEAD_STATUSES.find((known) => known.toLowerCase() === status.trim().toLowerCase()) || 'New';
}

function isWebsiteAudit(audit) {
  return isRecord(audit) &&
    ['completed', 'inconclusive'].includes(audit.status) &&
    ['available', 'unavailable', 'unknown'].includes(audit.availability) &&
    typeof audit.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(audit.checkedAt)) &&
    Array.isArray(audit.findings) &&
    audit.findings.every((finding) => isRecord(finding) &&
      typeof finding.code === 'string' &&
      typeof finding.title === 'string' &&
      typeof finding.evidence === 'string' &&
      ['verified', 'indicator'].includes(finding.confidence)) &&
    Array.isArray(audit.redirects) &&
    isRecord(audit.https) &&
    ['available', 'unavailable', 'unknown'].includes(audit.https.status) &&
    (audit.metadata === null || (
      isRecord(audit.metadata) &&
      (audit.metadata.title === null || typeof audit.metadata.title === 'string') &&
      (audit.metadata.description === null || typeof audit.metadata.description === 'string') &&
      typeof audit.metadata.viewport === 'boolean' &&
      typeof audit.metadata.headComplete === 'boolean' &&
      isRecord(audit.metadata.openGraph) &&
      isRecord(audit.metadata.headings) &&
      ['h1', 'h2', 'h3'].every((heading) => Number.isFinite(audit.metadata.headings[heading])) &&
      isRecord(audit.metadata.imageAlt) &&
      Number.isFinite(audit.metadata.imageAlt.total) &&
      Number.isFinite(audit.metadata.imageAlt.withAlt) &&
      isRecord(audit.metadata.mobile) &&
      typeof audit.metadata.mobile.viewport === 'boolean' &&
      Array.isArray(audit.metadata.mobile.responsiveIndicators) &&
      Array.isArray(audit.metadata.mobile.fixedWidthIndicators) &&
      isRecord(audit.mobile) &&
      typeof audit.mobile.viewport === 'boolean' &&
      Array.isArray(audit.mobile.responsiveIndicators) &&
      Array.isArray(audit.mobile.fixedWidthIndicators)
    ));
}

function normalizeLead(lead) {
  if (!isRecord(lead)) return null;
  const id = getLeadId(lead);
  if (!id || typeof lead.name !== 'string' || !lead.name.trim()) return null;
  const websiteAudit = lead.websiteAudit;
  if (websiteAudit !== undefined && websiteAudit !== null && !isWebsiteAudit(websiteAudit)) {
    return null;
  }

  return {
    ...lead,
    id,
    name: lead.name.trim(),
    status: normalizeStatus(lead.status),
    notes: typeof lead.notes === 'string' ? lead.notes : '',
    savedAt: typeof lead.savedAt === 'string' || lead.savedAt === null ? lead.savedAt : null,
  };
}

function legacyState(value) {
  if (!isRecord(value)) throw new Error('Saved lead data is malformed and was not changed.');

  return Object.entries(value).reduce((legacy, [key, valueForLead]) => {
    if (!isRecord(valueForLead) || valueForLead.saved !== true) return legacy;
    const status = normalizeStatus(valueForLead.status);
    legacy[key] = { id: key, status, notes: '', savedAt: null };
    return legacy;
  }, {});
}

function parseStoredState(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Saved lead data could not be read. The stored data was left untouched.');
  }

  if (!isRecord(value)) throw new Error('Saved lead data is malformed and was not changed.');

  if (value.version === 2) {
    if (!Array.isArray(value.leads) || !isRecord(value.legacy || {})) {
      throw new Error('Saved lead data is malformed and was not changed.');
    }

    const leads = value.leads.map(normalizeLead);
    if (leads.some((lead) => !lead)) {
      throw new Error('A saved lead record is invalid. Stored data was left untouched.');
    }
    if (new Set(leads.map((lead) => lead.id)).size !== leads.length) {
      throw new Error('Duplicate saved lead records were found. Stored data was left untouched.');
    }
    const legacy = {};
    for (const [id, record] of Object.entries(value.legacy || {})) {
      if (!isRecord(record) || record.id !== id || !/^(node|way|relation)\/\d+$/.test(id)) {
        throw new Error('A legacy saved lead record is invalid. Stored data was left untouched.');
      }
      legacy[id] = {
        id,
        status: normalizeStatus(record.status),
        notes: typeof record.notes === 'string' ? record.notes : '',
        savedAt: typeof record.savedAt === 'string' && !Number.isNaN(Date.parse(record.savedAt))
          ? record.savedAt
          : null,
      };
    }
    return { version: 2, leads, legacy };
  }

  return { version: 2, leads: [], legacy: legacyState(value) };
}

export function createLeadRepository(storage = globalThis.localStorage) {
  if (!storage) throw new Error('Browser storage is unavailable.');

  function readState() {
    const current = storage.getItem(LEAD_STORAGE_KEY);
    if (current !== null) return parseStoredState(current);

    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    return legacy === null
      ? { version: 2, leads: [], legacy: {} }
      : parseStoredState(legacy);
  }

  function writeState(state) {
    try {
      storage.setItem(LEAD_STORAGE_KEY, JSON.stringify(state));
    } catch {
      throw new Error('Saved leads could not be written to browser storage. Check available storage space.');
    }
  }

  return {
    load() {
      const state = readState();
      writeState(state);
      return state;
    },

    save(lead) {
      const id = getLeadId(lead);
      if (!id || typeof lead.name !== 'string' || !lead.name.trim()) {
        throw new Error('This business has no valid source identifier and cannot be saved.');
      }

      const state = readState();
      const index = state.leads.findIndex((saved) => saved.id === id);
      const legacy = state.legacy[id];
      const previous = index === -1 ? null : state.leads[index];
      const record = normalizeLead({
        ...(previous || {}),
        ...lead,
        id,
        status: previous?.status || legacy?.status || lead.status || 'New',
        notes: previous?.notes || legacy?.notes || lead.notes || '',
        savedAt: previous ? previous.savedAt : legacy ? legacy.savedAt : new Date().toISOString(),
      });

      const leads = [...state.leads];
      if (index === -1) leads.push(record);
      else leads[index] = record;

      const next = { version: 2, leads, legacy: { ...state.legacy } };
      delete next.legacy[id];
      writeState(next);
      return record;
    },

    restoreLegacy(searchResults) {
      const state = readState();
      const byId = new Map(searchResults.map((lead) => [getLeadId(lead), lead]));
      let changed = false;
      const leads = [...state.leads];
      const legacy = { ...state.legacy };

      for (const [id, metadata] of Object.entries(legacy)) {
        const lead = byId.get(id);
        if (!lead) continue;
        leads.push(normalizeLead({ ...lead, ...metadata, id }));
        delete legacy[id];
        changed = true;
      }

      if (!changed) return state;
      const next = { version: 2, leads, legacy };
      writeState(next);
      return next;
    },

    update(id, changes) {
      if (!isRecord(changes) || Object.keys(changes).some((key) => !['status', 'notes', 'websiteAudit'].includes(key))) {
        throw new Error('Only outreach status, notes, and website audit results can be edited.');
      }

      if (changes.status !== undefined && !LEAD_STATUSES.includes(changes.status)) {
        throw new Error('Choose a valid outreach status.');
      }
      if (changes.notes !== undefined && typeof changes.notes !== 'string') {
        throw new Error('Notes must be plain text.');
      }
      if (changes.websiteAudit !== undefined && changes.websiteAudit !== null && !isWebsiteAudit(changes.websiteAudit)) {
        throw new Error('Website audit results are malformed.');
      }

      const state = readState();
      const index = state.leads.findIndex((lead) => lead.id === id);
      if (index === -1 && !state.legacy[id]) throw new Error('Saved lead was not found.');

      if (index === -1) {
        const next = {
          ...state,
          legacy: {
            ...state.legacy,
            [id]: { ...state.legacy[id], ...changes },
          },
        };
        writeState(next);
        return next;
      }

      const leads = [...state.leads];
      leads[index] = { ...leads[index], ...changes };
      const next = { ...state, leads };
      writeState(next);
      return next;
    },

    remove(id) {
      const state = readState();
      const next = {
        version: 2,
        leads: state.leads.filter((lead) => lead.id !== id),
        legacy: { ...state.legacy },
      };
      delete next.legacy[id];
      writeState(next);
      return next;
    },
  };
}
