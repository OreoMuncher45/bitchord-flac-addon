/**
 * FLAC stream introspection.
 *
 * Why this file exists at all: the catalogues this addon draws on serve FLAC as
 * an extensionless `application/octet-stream` response and advertise nothing
 * about the audio inside — no `Content-Type`, no `X-Sample-Rate`, no bit depth.
 * BitChord does not take a source's word for it. `AddonSource.formatOf` reads
 * the codec we declare, but `StreamFormat.isLossless` and the whole quality
 * ranking that follows are settled against what the device actually decodes, and
 * a source that labels a lossy rendition "LOSSLESS" gains nothing from it.
 *
 * So the honest answer is read from the file rather than asserted by us: the
 * first ~128 bytes of any FLAC file are enough, because STREAMINFO is always the
 * first metadata block and is always 34 bytes long.
 *
 * Layout, per the FLAC specification:
 *
 *   "fLaC"                     4 bytes   magic
 *   block header               4 bytes   bit7 = last-block, bits0-6 = type
 *   STREAMINFO                34 bytes   mandatory, and always first
 *     16  min block size
 *     16  max block size
 *     24  min frame size
 *     24  max frame size
 *     20  sample rate in Hz
 *      3  channels - 1
 *      5  bits per sample - 1
 *     36  total samples
 *
 * The last three share a single 64-bit big-endian word, which is why they are
 * unpacked together rather than separately.
 */

/** Bytes needed to read STREAMINFO: magic + header + the 34-byte body. */
export const STREAMINFO_BYTES = 4 + 4 + 34;

/** The literal a FLAC file must begin with. */
const MAGIC = Buffer.from('fLaC', 'ascii');

/** STREAMINFO is metadata block type 0. */
const BLOCK_STREAMINFO = 0;

/**
 * Reads a FLAC header and returns what it says about the audio, or null when
 * the bytes are not a FLAC header.
 *
 * Null is a real answer and not a failure to be worked around: it means the URL
 * we were handed does not carry FLAC, which is precisely the fact a caller needs
 * in order to refuse to label it lossless.
 *
 * @param {Buffer} head at least {@link STREAMINFO_BYTES} bytes from byte zero
 * @returns {{sampleRate: number, channels: number, bitDepth: number,
 *            totalSamples: number, durationSec: number|null,
 *            minBlockSize: number, maxBlockSize: number,
 *            minFrameSize: number, maxFrameSize: number}|null}
 */
export function parseFlacStreamInfo(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) return null;
  if (!head.subarray(0, 4).equals(MAGIC)) return null;

  const isLastBlock = (head[4] & 0x80) !== 0;
  const blockType = head[4] & 0x7f;

  // A file that opens with something else is legal FLAC but not a shape we can
  // read cheaply. Say so rather than returning numbers belonging to a block
  // that was not STREAMINFO.
  if (blockType !== BLOCK_STREAMINFO) return null;

  const body = head.subarray(8, 8 + 34);
  if (body.length < 34) return null;

  const minBlockSize = body.readUInt16BE(0);
  const maxBlockSize = body.readUInt16BE(2);
  // 24-bit fields are read a byte at a time; readUIntBE only covers 16.
  const minFrameSize = (body[4] << 16) | (body[5] << 8) | body[6];
  const maxFrameSize = (body[7] << 16) | (body[8] << 8) | body[9];

  // 20 bits rate | 3 bits channels-1 | 5 bits depth-1 | 36 bits total samples
  const packed = body.readBigUInt64BE(10);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitDepth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);

  if (!sampleRate) return null;

  return {
    sampleRate,
    channels,
    bitDepth,
    totalSamples,
    durationSec: Math.round((totalSamples / sampleRate) * 100) / 100,
    minBlockSize,
    maxBlockSize,
    minFrameSize,
    maxFrameSize,
    isLastBlock,
  };
}

/**
 * Bitrate in kbps from a byte count and a duration.
 *
 * The FLAC frame headers interleave metadata, so a FLAC's own rate always sits
 * slightly above the PCM it carries. That is normal and not something to correct
 * for — we report what the file is, which is what BitChord compares against.
 *
 * @param {number} bytes
 * @param {number} durationSec
 * @returns {number|null} rounded kbps, or null when either input is unusable
 */
export function flacKbps(bytes, durationSec) {
  if (!Number.isFinite(bytes) || !Number.isFinite(durationSec)) return null;
  if (bytes <= 0 || durationSec <= 0) return null;
  return Math.round((bytes * 8) / durationSec / 1000);
}
