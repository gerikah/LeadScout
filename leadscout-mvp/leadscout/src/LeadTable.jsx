import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  Phone,
  Trash2,
} from 'lucide-react';
import { LEAD_STATUSES } from './leadData.js';

function NotesEditor({ lead, disabled, onSave }) {
  const [draft, setDraft] = useState(lead.notes || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(lead.notes || ''), [lead.notes]);

  async function saveNotes() {
    setSaving(true);
    try {
      await onSave(lead, draft);
    } finally {
      setSaving(false);
    }
  }

  const changed = draft !== (lead.notes || '');
  return (
    <div className="notes-editor">
      <textarea
        aria-label={`Notes for ${lead.name || 'legacy saved lead'}`}
        disabled={disabled}
        rows={2}
        value={draft}
        placeholder={disabled ? 'Save this lead to add notes' : 'Add notes…'}
        onChange={(event) => setDraft(event.target.value)}
      />
      {changed && (
        <button className="save-note" disabled={saving || disabled} onClick={saveNotes}>
          <Check size={13} /> {saving ? 'Saving…' : 'Save notes'}
        </button>
      )}
    </div>
  );
}

export function LeadTable({
  leads,
  savedIds,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  onSave,
  onStatusChange,
  onNotesSave,
  onRemove,
}) {
  const allSelected = leads.length > 0 && leads.every((lead) => selectedIds.has(lead.id));

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="select-column">
              <input
                aria-label={allSelected ? 'Deselect all visible leads' : 'Select all visible leads'}
                checked={allSelected}
                onChange={() => onToggleAll(leads, allSelected)}
                type="checkbox"
              />
            </th>
            <th>BUSINESS</th>
            <th>CONTACT</th>
            <th>WEBSITE</th>
            <th>OPPORTUNITY SCORE</th>
            <th>NOTES</th>
            <th>OUTREACH</th>
            <th>SAVED</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const saved = savedIds.has(lead.id);
            return (
              <tr key={lead.id}>
                <td className="select-column">
                  <input
                    aria-label={`Select ${lead.name || 'legacy saved lead'}`}
                    checked={selectedIds.has(lead.id)}
                    onChange={() => onToggleSelected(lead.id)}
                    type="checkbox"
                  />
                </td>
                <td>
                  <div className="business">
                    <div className="business-avatar">{lead.name ? lead.name.slice(0, 1).toUpperCase() : '?'}</div>
                    <div>
                      {lead.legacy ? (
                        <strong>Business details unavailable</strong>
                      ) : (
                        <strong>{lead.name}</strong>
                      )}
                      <small>
                        {lead.legacy
                          ? `Legacy bookmark · ${lead.id}`
                          : `${lead.category || 'Business'}${lead.address ? ` · ${lead.address}` : ''}`}
                      </small>
                      {lead.location && <small className="lead-location"><MapPin size={11} /> {lead.location}</small>}
                      {lead.legacy ? (
                        <small className="legacy-notice">Search for this source record to restore its details.</small>
                      ) : (
                        <a href={lead.source} rel="noopener noreferrer" target="_blank">
                          OSM source <ArrowUpRight size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {lead.legacy ? (
                    <span className="muted">Not available</span>
                  ) : (
                    <div className="contacts">
                      {lead.phone ? <a href={`tel:${lead.phone}`}><Phone size={13} /> {lead.phone}</a> : <span className="muted"><Phone size={13} /> Not listed</span>}
                      {lead.email ? <a href={`mailto:${lead.email}`}><Mail size={13} /> {lead.email}</a> : <span className="muted"><Mail size={13} /> Not listed</span>}
                      <small className="verification">{lead.contactVerification}</small>
                    </div>
                  )}
                </td>
                <td>
                  {lead.website ? (
                    <a className="website-link" href={lead.website} rel="noopener noreferrer" target="_blank">
                      <Globe size={14} /> Visit <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span className="no-website"><Globe size={14} /> {lead.legacy ? 'Unknown' : 'Not listed'}</span>
                  )}
                </td>
                <td>
                  {lead.score === null || lead.score === undefined ? (
                    <span className="muted">Unavailable</span>
                  ) : (
                    <>
                      <div className="score">
                        <span className={`score-dot ${lead.score >= 65 ? 'hot' : ''}`} />
                        <strong>{lead.score}</strong><small>/ 100</small>
                      </div>
                      <details className="score-breakdown">
                        <summary>Why this score?</summary>
                        {lead.scoreFactors.length
                          ? <ul>{lead.scoreFactors.map((factor) => <li key={factor.label}>{factor.label} <b>+{factor.points}</b></li>)}</ul>
                          : <span>No opportunity factors found.</span>}
                      </details>
                      <small className="score-note">{lead.opportunity}</small>
                    </>
                  )}
                </td>
                <td><NotesEditor disabled={!saved} lead={lead} onSave={onNotesSave} /></td>
                <td>
                  <select
                    aria-label={`Outreach status for ${lead.name || 'legacy saved lead'}`}
                    className="status-select"
                    disabled={!saved}
                    onChange={(event) => onStatusChange(lead, event.target.value)}
                    value={lead.status || 'New'}
                  >
                    {LEAD_STATUSES.map((status) => <option key={status}>{status}</option>)}
                  </select>
                </td>
                <td>{lead.savedAt ? new Date(lead.savedAt).toLocaleDateString() : <span className="muted">Unknown</span>}</td>
                <td>
                  {saved ? (
                    <button
                      aria-label={`Remove ${lead.name || 'legacy saved lead'}`}
                      className="bookmark-btn remove-lead"
                      onClick={() => onRemove(lead)}
                      title="Remove saved lead"
                    >
                      <Trash2 size={17} />
                    </button>
                  ) : (
                    <button
                      aria-label={`Save ${lead.name}`}
                      className="bookmark-btn"
                      onClick={() => onSave(lead)}
                      title="Save lead"
                    >
                      {saved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
