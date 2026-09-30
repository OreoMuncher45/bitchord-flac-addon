/**
 * Track ids, and making them safe to put in a URL path segment.
 *
 * BitChord takes the `id` from a `/search` row and puts it straight into
 * `/stream/{id}` as a single path segment (`AddonClient.stream` →
 * `addPathSegment`). OkHttp percent-encodes on the way out, which means a `/`
 * inside an id becomes `%2F` on the wire and is decoded back to a `/` by most
 * HTTP servers before routing ever sees it — so an id containing one arrives as
 * two path segments and is simply not found.
 *
 * The Archive's filenames are the reason this matters here: a FLAC called
 * `03 - Ventura (Live).flac` is unremarkable, and a bootleg with a `/` in it is
 * merely rare. Rather than restrict what can be searched for, ids are encoded
 * so that no byte a name may contain can act as a delimiter.
 *
 * The encoding is deliberately conditional: an id already made of characters
 * that cannot cause trouble is passed through verbatim, because a readable id is
 * worth a great deal when reading a log line. Only the rest are base64url'd.
 */

/** RFC 4648 §5: URL-safe, no padding, so it survives a path segment unencoded. */
const SAFE = /^[A-Za-z0-9._~-]+$/;

/**
 * Encodes one id for transport.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodePart(value) {
  const text = String(value ?? '');
  if (SAFE.test(text) && text.length > 0) return text;
  return `~${Buffer.from(text, 'utf8').toString('base64url')}`;
}

/**
 * The inverse, accepting both forms.
 *
 * The `~` prefix is the discriminator and is never produced by
 * {@link encodePart} for input that passed the safe test — a tilde is not in the
 * safe set — so the two encodings cannot be confused.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodePart(value) {
  const text = String(value ?? '');
  if (!text.startsWith('~')) return text;
  try {
    return Buffer.from(text.slice(1), 'base64url').toString('utf8');
  } catch {
    return text;
  }
}

/**
 * Builds the opaque id BitChord will hold for one row.
 *
 * @param {string} source
 * @param {string} nativeId the source's own handle for the track
 * @returns {string}
 */
export function makeTrackId(source, nativeId) {
  return `${source}:${encodePart(nativeId)}`;
}

/**
 * Splits an id back into the source and its native handle.
 *
 * Returns null for anything that is not one of ours, which the routes treat as
 * a miss rather than an error: BitChord only ever echoes back ids it was given,
 * so an unrecognised one is a stale row rather than a client error.
 *
 * @param {string} id
 * @returns {{source: string, nativeId: string}|null}
 */
export function parseTrackId(id) {
  const raw = String(id ?? '');
  const cut = raw.indexOf(':');
  if (cut < 1) return null;
  const source = raw.slice(0, cut);
  const nativeId = decodePart(raw.slice(cut + 1));
  if (!source || !nativeId) return null;
  return { source, nativeId };
}
