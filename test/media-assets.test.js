import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPage, byteRange, outputAssets } from '../src/media-assets.js';

test('asset pages filter, paginate and reject invalid queries without paths or mutable operations', () => {
  const items = [1, 2, 3].map((n) => ({ id: String(n), name: String(n), display_name: `video${n}.mp4`,
    tags: ['output'], created_at: `2026-01-0${n}T00:00:00Z`, user_metadata: { jobId: 'job' } }));
  const first = assetPage(items, new URLSearchParams('include_tags=output&exclude_tags=missing&limit=2'));
  assert.deepEqual(first.assets.map((a) => a.id), ['3', '2']);
  assert.equal(first.next_cursor, '2');
  const last = assetPage(items, new URLSearchParams('after=2&limit=2'));
  assert.deepEqual(last.assets.map((a) => a.id), ['1']);
  assert.equal(last.next_cursor, undefined);
  assert.equal(assetPage(items, new URLSearchParams('include_tags=input')).total, 0);
  assert.equal(assetPage(items, new URLSearchParams('name_contains=video2')).total, 1);
  for (const value of ['limit=0', 'limit=1001', 'after=invalid', 'offset=-1', 'sort_by=path']) {
    assert.throws(() => assetPage(items, new URLSearchParams(value)), { code: 'media_asset_query_invalid' });
  }
});

test('generated assets use only source/backend scoped registered available bytes', () => {
  const job = { id: 'job', artifacts: [{ id: 'file', status: 'available', name: 'movie.mp4', bytes: 5,
    contentType: 'video/mp4', createdAt: 123 }, { id: 'old', status: 'expired' }] };
  const gateway = { jobs: (source, backend) => source === 'owner' && backend === 'comfy' ? [job] : [],
    service: { media: { store: { nativeOutputs: () => ({ '7': { videos: [{ filename: 'file' }] } }) } } } };
  assert.deepEqual(outputAssets(gateway, 'other', 'comfy'), []);
  const assets = outputAssets(gateway, 'owner', 'comfy');
  assert.equal(assets.length, 1);
  assert.equal(assets[0].user_metadata.nodeId, '7');
  assert.equal(assets[0].name, 'file');
  assert.equal(assets[0].preview_url, '/api/view?filename=file&subfolder=job&type=output');
});

test('single byte ranges clamp valid bounds and reject malformed or unsafe integers', () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.deepEqual(byteRange('bytes=0-100', 10), { start: 0, end: 9 });
  assert.deepEqual(byteRange('bytes=-100', 10), { start: 0, end: 9 });
  for (const value of ['bytes=10-', 'bytes=7-2', 'bytes=-0', 'bytes=-', 'bytes=9007199254740992-', 'bytes=0-1,4-5']) {
    assert.throws(() => byteRange(value, 10), { statusCode: 416 });
  }
  assert.throws(() => byteRange('bytes=0-', 0), { statusCode: 416 });
});
