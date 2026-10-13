import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadRepository, LEAD_STORAGE_KEY, LEGACY_STORAGE_KEY } from './leadRepository.js';

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

function business(overrides = {}) {
  return {
    id: 'way/42',
    name: 'North Star Cafe',
    category: 'cafe',
    address: '1 Main St',
    phone: '+63 900 000 0000',
    email: 'hello@example.com',
    website: 'https://example.com',
    source: 'https://www.openstreetmap.org/way/42',
    ...overrides,
  };
}

test('saves complete leads, deduplicates by source ID, and preserves user fields', () => {
  const storage = new MemoryStorage();
  const repository = createLeadRepository(storage);
  repository.load();
  const first = repository.save(business());
  repository.update(first.id, { status: 'Follow-up', notes: 'Call after lunch' });
  repository.save(business({ name: 'Updated source name', phone: '+63 911' }));

  const loaded = createLeadRepository(storage).load();
  assert.equal(loaded.leads.length, 1);
  assert.equal(loaded.leads[0].name, 'Updated source name');
  assert.equal(loaded.leads[0].phone, '+63 911');
  assert.equal(loaded.leads[0].status, 'Follow-up');
  assert.equal(loaded.leads[0].notes, 'Call after lunch');
  assert.ok(loaded.leads[0].savedAt);
});

test('updates status and notes and deletes the saved lead', () => {
  const repository = createLeadRepository(new MemoryStorage());
  repository.load();
  const saved = repository.save(business());
  const updated = repository.update(saved.id, { status: 'Interested', notes: 'Requested a proposal' });
  assert.equal(updated.leads[0].status, 'Interested');
  assert.equal(updated.leads[0].notes, 'Requested a proposal');
  assert.equal(repository.remove(saved.id).leads.length, 0);
});

test('preserves legacy IDs and statuses, restores real source data when rediscovered', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
    'way/42': { saved: true, status: 'To contact' },
    'node/99': { saved: true, status: 'Closed' },
    'node/100': { saved: false, status: 'New' },
  }));

  const repository = createLeadRepository(storage);
  const migrated = repository.load();
  assert.deepEqual(Object.keys(migrated.legacy).sort(), ['node/99', 'way/42']);
  assert.equal(migrated.legacy['way/42'].status, 'To Contact');
  assert.equal(migrated.legacy['way/42'].savedAt, null);
  assert.ok(storage.getItem(LEAD_STORAGE_KEY));
  assert.ok(storage.getItem(LEGACY_STORAGE_KEY), 'legacy source is retained after migration');

  const restored = repository.restoreLegacy([business({ phone: '' })]);
  assert.equal(restored.leads.length, 1);
  assert.equal(restored.leads[0].name, 'North Star Cafe');
  assert.equal(restored.leads[0].phone, '');
  assert.equal(restored.leads[0].status, 'To Contact');
  assert.equal(restored.leads[0].savedAt, null);
  assert.equal(restored.legacy['node/99'].status, 'Closed');
});

test('legacy status and notes remain editable until the source listing is found', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({
    'way/42': { saved: true, status: 'New' },
  }));
  const repository = createLeadRepository(storage);

  const updated = repository.update('way/42', { status: 'To Contact', notes: 'Rediscover this listing' });
  assert.equal(updated.legacy['way/42'].status, 'To Contact');
  assert.equal(updated.legacy['way/42'].notes, 'Rediscover this listing');
  assert.equal(repository.remove('way/42').legacy['way/42'], undefined);
});

test('invalid status updates and malformed storage fail without replacing stored bytes', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEAD_STORAGE_KEY, '{broken');
  const repository = createLeadRepository(storage);

  assert.throws(() => repository.load(), /could not be read/);
  assert.equal(storage.getItem(LEAD_STORAGE_KEY), '{broken');

  storage.setItem(LEAD_STORAGE_KEY, JSON.stringify({ version: 2, leads: [business()], legacy: {} }));
  assert.throws(() => repository.update('way/42', { status: 'Invented' }), /valid outreach status/);

  storage.setItem(LEAD_STORAGE_KEY, JSON.stringify({ version: 2, leads: [null], legacy: {} }));
  assert.throws(() => repository.load(), /record is invalid/);

  storage.setItem(LEAD_STORAGE_KEY, JSON.stringify({
    version: 2,
    leads: [business(), business()],
    legacy: {},
  }));
  assert.throws(() => repository.load(), /Duplicate saved lead records/);
});

test('storage write failures are surfaced to the caller', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEAD_STORAGE_KEY, JSON.stringify({ version: 2, leads: [], legacy: {} }));
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => createLeadRepository(storage).save(business()), /could not be written/);
});
