import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_VERIFICATION,
  enrichLead,
  exportLeadsToCsv,
  filterAndSortLeads,
  scoreLead,
} from './leadData.js';

const leads = [
  {
    id: 'node/1',
    name: 'Zebra Cafe',
    category: 'cafe',
    location: 'Makati, Philippines',
    address: '1 Main St',
    phone: '+63 1',
    email: '',
    website: '',
    status: 'New',
    savedAt: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'way/2',
    name: 'Able Bakery',
    category: 'bakery',
    location: 'Manila, Philippines',
    address: '2 Baker St',
    phone: '',
    email: 'hello@example.com',
    website: 'https://example.com',
    status: 'Contacted',
    savedAt: '2026-10-02T10:00:00.000Z',
  },
  {
    id: 'node/3',
    name: 'Missing Contact Salon',
    category: 'salon',
    location: 'Manila, Philippines',
    address: '3 Garden St',
    phone: '',
    email: '',
    website: '',
    status: 'New',
    savedAt: '2026-10-03T10:00:00.000Z',
  },
];

const scoredLeads = leads.map(enrichLead);

test('scoring is deterministic and explains each applied factor', () => {
  const gap = scoreLead({ address: '' });
  assert.equal(gap.score, 75);
  assert.deepEqual(gap.factors.map((factor) => factor.points), [50, 10, 10, 5]);
  assert.equal(scoreLead({ address: '' }).score, gap.score);
  assert.equal(scoreLead({
    website: 'https://example.com',
    phone: '123',
    email: 'a@example.com',
    address: '1 Main St',
  }).score, 0);
  assert.equal(scoreLead({
    website: 'https://example.com',
    websiteCheck: { status: 'unavailable' },
    phone: '123',
    email: 'a@example.com',
    address: '1 Main St',
  }).score, 25);
  assert.equal(enrichLead({ id: 'node/1', name: 'A' }).contactVerification, CONTACT_VERIFICATION);
});

test('filters category, location, website, contacts, score, status and saved date', () => {
  assert.equal(filterAndSortLeads(scoredLeads, { minimumScore: '', maximumScore: '' }).length, 3);
  const all = filterAndSortLeads(scoredLeads, {});
  assert.deepEqual(all.map((lead) => lead.id), ['node/3', 'node/1', 'way/2']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { category: 'bakery' }).map((lead) => lead.id), ['way/2']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { location: 'makati' }).map((lead) => lead.id), ['node/1']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { website: 'not-listed' }).map((lead) => lead.id), ['node/3', 'node/1']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { contact: 'missing' }).map((lead) => lead.id), ['node/3']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { minimumScore: 70 }).map((lead) => lead.id), ['node/3']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { status: 'Contacted' }).map((lead) => lead.id), ['way/2']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { savedAfter: '2026-10-02' }).map((lead) => lead.id), ['node/3', 'way/2']);
});

test('sorting supports score, name and most recently saved', () => {
  assert.deepEqual(filterAndSortLeads(scoredLeads, { sort: 'score-asc' }).map((lead) => lead.id), ['way/2', 'node/1', 'node/3']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { sort: 'name' }).map((lead) => lead.id), ['way/2', 'node/3', 'node/1']);
  assert.deepEqual(filterAndSortLeads(scoredLeads, { sort: 'saved-desc' }).map((lead) => lead.id), ['node/3', 'way/2', 'node/1']);
});

test('CSV export quotes special characters, preserves Unicode and escapes formulas', () => {
  const csv = exportLeadsToCsv([{
    ...leads[0],
    name: '=SUM(1,2)',
    address: 'Unit "A", Main St\r\nMakati',
    notes: 'Café lead, needs follow-up',
    source: 'https://www.openstreetmap.org/node/1',
    score: 75,
    scoreFactors: [{ label: 'No website listed', points: 50 }],
  }]);

  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
  assert.ok(csv.includes('"Unit ""A"", Main St\r\nMakati"'));
  assert.ok(csv.includes('"Café lead, needs follow-up"'));
  assert.ok(csv.includes('"https://www.openstreetmap.org/node/1"'));
});
