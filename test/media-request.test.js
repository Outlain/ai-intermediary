import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRequestError, nativeComfyMetadata } from '../src/media-request.js';

test('native frontend metadata is normalized without mutating or retaining cloud credentials', () => {
  const body = { extra_data: {
    comfy_usage_source: 'comfyui-frontend', preview_method: 'latent2rgb',
    auth_token_comfy_org: 'private-cloud-token', api_key_comfy_org: 'private-api-key',
    extra_pnginfo: { workflow: { nodes: [] } },
  } };
  const before = structuredClone(body);
  assert.deepEqual(nativeComfyMetadata(body), { extra_pnginfo: body.extra_data.extra_pnginfo });
  assert.deepEqual(body, before);
  assert.deepEqual(nativeComfyMetadata({}), {});
  assert.deepEqual(nativeComfyMetadata({ extra_data: { comfy_usage_source: 'comfyui-frontend' } }), {});
});

test('native metadata rejects malformed envelopes, unknown fields and oversized discarded data', () => {
  for (const body of [null, [], false, 4, 'invalid']) {
    assert.throws(() => nativeComfyMetadata(body), { code: 'invalid_body' });
  }
  for (const extra_data of [[], 'invalid', false, 1, { api_key: 'not-a-supported-field' },
    JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.throws(() => nativeComfyMetadata({ extra_data }), { code: 'media_metadata_invalid' });
  }
  assert.throws(() => nativeComfyMetadata({ extra_data: { comfy_usage_source: 'x'.repeat(1024 * 1024) } }),
    { code: 'media_metadata_too_large', statusCode: 413 });
  // Do not hide malformed retained graph metadata from the strict store.
  assert.deepEqual(nativeComfyMetadata({ extra_data: { extra_pnginfo: 'invalid' } }), { extra_pnginfo: 'invalid' });
});

test('request errors expose reviewed actions/codes only, never raw exceptions or unknown codes', () => {
  const privateText = 'private prompt /secret/path http://user:password@backend.invalid';
  for (const [code, status, text] of [
    ['media_metadata_invalid', 400, /unsupported or invalid metadata/],
    ['node_not_allowed', 422, /trusted node types/],
    ['cloud_node_forbidden', 422, /local-only/],
    ['maintenance_paused', 503, /resume/i],
    ['queue_full', 429, /queue is full/],
  ]) {
    const result = mediaRequestError(Object.assign(new Error(privateText), { code }));
    assert.equal(result.status, status);
    assert.equal(result.code, code);
    assert.match(result.error, text);
    assert.ok(result.error.includes(code), 'ComfyUI renders error text, not the sibling code');
    assert.equal(JSON.stringify(result).includes(privateText), false);
  }
  for (const code of [undefined, privateText, '__proto__', 'constructor']) {
    const result = mediaRequestError(Object.assign(new Error(privateText), { code }));
    assert.equal(result.code, 'media_request_failed');
    assert.equal(JSON.stringify(result).includes(privateText), false);
  }
  assert.equal(mediaRequestError(new SyntaxError(privateText)).code, 'invalid_body');
  assert.equal(mediaRequestError({ statusCode: 413 }).code, 'request_too_large');
  assert.equal(mediaRequestError({ statusCode: 200 }).status, 503);
  assert.equal(mediaRequestError({ code: 'media_metadata_invalid', statusCode: 422 }).status, 422);
});
