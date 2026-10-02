// Tiny dependency-free input validators (report Phase 1.3 — Zod-style ergonomics
// without the dependency). Every mutating route parses its body through these;
// unknown keys are stripped, so queued offline replays carrying `clientRef` etc.
// stay compatible with stricter validation added later.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function vString({ min = 0, max = 10000, pattern } = {}) {
  return (v) => {
    if (typeof v !== 'string') return { err: 'must be a string' };
    if (v.length < min) return { err: `must be at least ${min} characters` };
    if (v.length > max) return { err: `must be at most ${max} characters` };
    if (pattern && !pattern.test(v)) return { err: 'has an invalid format' };
    return { value: v };
  };
}

function vNumber({ min = -Infinity, max = Infinity, int = false } = {}) {
  return (v) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return { err: 'must be a number' };
    if (int && !Number.isInteger(n)) return { err: 'must be an integer' };
    if (n < min || n > max) return { err: `must be between ${min} and ${max}` };
    return { value: n };
  };
}

function vEnum(values) {
  const set = new Set(values);
  return (v) => (set.has(v) ? { value: v } : { err: `must be one of: ${values.join(', ')}` });
}

function vDate({ optional = false } = {}) {
  return (v) => {
    if (v === undefined || v === null || v === '') {
      return optional ? { value: undefined } : { err: 'is required' };
    }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: v };
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return { value: d };
    return { err: 'must be a valid date' };
  };
}

function vUuid({ optional = false } = {}) {
  return (v) => {
    if (v === undefined || v === null) return optional ? { value: undefined } : { err: 'is required' };
    if (typeof v === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(v)) return { value: v };
    return { err: 'must be a valid id' };
  };
}

function vBool({ optional = false } = {}) {
  return (v) => {
    if (v === undefined || v === null) return optional ? { value: undefined } : { err: 'is required' };
    return { value: !!v };
  };
}

// shape: { field: validator } — validators come from the v* helpers above.
// options: { allowExtra: true } keeps unknown keys (default: stripped).
function parseBody(shape, body, { allowExtra = false } = {}) {
  const src = isPlainObject(body) ? body : {};
  const value = {};
  const errors = {};
  for (const [field, validator] of Object.entries(shape)) {
    const raw = src[field];
    if (raw === undefined) {
      errors[field] = 'is required';
      continue;
    }
    const res = validator(raw);
    if (res.err) errors[field] = res.err;
    else if (res.value !== undefined) value[field] = res.value;
  }
  if (allowExtra) {
    for (const [k, v] of Object.entries(src)) {
      if (!(k in shape) && !(k in value)) value[k] = v;
    }
  }
  const ok = Object.keys(errors).length === 0;
  return ok ? { ok: true, value } : { ok: false, errors };
}

// Optional-field variant: absent keys are allowed through untouched.
function parseBodyPartial(shape, body) {
  const src = isPlainObject(body) ? body : {};
  const value = {};
  const errors = {};
  for (const [field, validator] of Object.entries(shape)) {
    if (src[field] === undefined) continue;
    const res = validator(src[field]);
    if (res.err) errors[field] = res.err;
    else if (res.value !== undefined) value[field] = res.value;
  }
  const ok = Object.keys(errors).length === 0;
  return ok ? { ok: true, value } : { ok: false, errors };
}

module.exports = { parseBody, parseBodyPartial, vString, vNumber, vEnum, vDate, vUuid, vBool, isPlainObject };
