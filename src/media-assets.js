// Read-only ComfyUI asset catalogue built exclusively from broker-owned bytes.
// Never forward gallery requests to the backend filesystem or cloud APIs.
export function outputAssets(gateway, source, backend) {
  return gateway.jobs(source, backend).flatMap((job) => {
    const outputs = gateway.service.media.store.nativeOutputs(job.id);
    return job.artifacts.filter((artifact) => artifact.status === 'available').map((artifact) => {
      const nodeId = Object.entries(outputs).find(([, node]) => Object.values(node).some((values) =>
        Array.isArray(values) && values.some((value) => value?.filename === artifact.id)))?.[0] ?? '0';
      const url = `/api/view?${new URLSearchParams({ filename: artifact.id, subfolder: job.id, type: 'output' })}`;
      return { id: artifact.id, name: artifact.id, display_name: artifact.name,
        size: artifact.bytes, mime_type: artifact.contentType, tags: ['output'],
        created_at: new Date(artifact.createdAt).toISOString(), updated_at: new Date(artifact.createdAt).toISOString(),
        preview_url: url, ...(artifact.contentType?.startsWith('image/') ? { thumbnail_url: url } : {}),
        user_metadata: { filename: artifact.name, subfolder: job.id, jobId: job.id, nodeId,
          recovered: job.recoveredOutputs === true },
        metadata: { filename: artifact.name } };
    });
  });
}

export function assetPage(items, params) {
  const invalid = () => { throw Object.assign(new Error('Invalid asset query'), { code: 'media_asset_query_invalid', statusCode: 400 }); };
  const integer = (key, fallback, max) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^\d{1,7}$/.test(value) || Number(value) > max) invalid();
    return Number(value);
  };
  const limit = integer('limit', 500, 1000);
  const offset = params.has('after') ? integer('after', 0, 1000000) : integer('offset', 0, 1000000);
  if (!limit) invalid();
  const tags = (key) => params.getAll(key).flatMap((value) => value.split(',')).filter(Boolean);
  const all = [...tags('include_tags'), ...tags('tags_all')];
  const any = tags('tags_any');
  const none = [...tags('exclude_tags'), ...tags('tags_none')];
  const names = (params.get('name_contains') ?? '').toLowerCase();
  const jobIds = tags('job_ids');
  const filtered = items.filter((asset) => all.every((tag) => asset.tags.includes(tag))
    && (!any.length || any.some((tag) => asset.tags.includes(tag)))
    && !none.some((tag) => asset.tags.includes(tag))
    && (!jobIds.length || jobIds.includes(asset.user_metadata.jobId))
    && asset.display_name.toLowerCase().includes(names));
  const sort = params.get('sort_by') ?? 'created_at';
  const order = params.get('sort_order') ?? 'desc';
  if (!['created_at', 'updated_at', 'name', 'size'].includes(sort) || !['asc', 'desc'].includes(order)) invalid();
  filtered.sort((a, b) => ((sort === 'size' ? a.size - b.size : String(a[sort]).localeCompare(String(b[sort])))
    || a.id.localeCompare(b.id)) * (order === 'asc' ? 1 : -1));
  const end = offset + limit;
  return { assets: filtered.slice(offset, end), total: filtered.length,
    has_more: end < filtered.length, ...(end < filtered.length ? { next_cursor: String(end) } : {}) };
}

export function byteRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const bad = () => { throw Object.assign(new Error('Unsatisfiable range'), { statusCode: 416 }); };
  if (!match || (!match[1] && !match[2]) || size === 0) bad();
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (![start, end, Number(match[1] || 0), Number(match[2] || 0)].every(Number.isSafeInteger)
    || (!match[1] && Number(match[2]) === 0) || start >= size || end < start) bad();
  return { start, end };
}
