export const MAX_TEXT_SIZE = 102_400;
export const MAX_FILE_SIZE = 10_485_760;
export const S3_MAX_FILE_SIZE = 104_857_600;
export const MAX_FILES_PER_NOTE = 10;
export const DEFAULT_EXPIRY_SECONDS = 86_400;
export const MAX_EXPIRY_SECONDS = 2_592_000;
export const MIN_EXPIRY_SECONDS = 300;
export const NOTE_ID_LENGTH = 12;
export const CLEANUP_INTERVAL_MS = 300_000;

// Validation limits
export const MAX_ENCRYPTED_DATA_SIZE = 50_000_000;
export const MAX_NONCE_LENGTH = 48;

// Chunked upload defaults (configurable per instance via env vars)
export const DEFAULT_CHUNK_SIZE = 4_194_304; // 4MB per chunk
export const DEFAULT_MAX_CHUNKED_SIZE = 524_288_000; // 500MB max per note
export const UPLOAD_SESSION_TTL = 3_600; // 1 hour to complete upload
export const UPLOAD_ID_LENGTH = 32;

// Proof-of-Work challenge defaults. "Cap" refers to the Cap.js library
// (@cap.js/server) that issues and verifies these PoW challenges to gate
// browser writes without accounts. DEFAULT_CAP_DIFFICULTY and
// DEFAULT_CAP_CHALLENGE_COUNT are configurable per instance via the
// CAP_DIFFICULTY and CAP_CHALLENGE_COUNT env vars.
export const DEFAULT_CAP_DIFFICULTY = 4;
export const DEFAULT_CAP_CHALLENGE_COUNT = 50;
export const CAP_CHALLENGE_SIZE = 32; // bytes per challenge salt
export const CAP_CHALLENGE_EXPIRES_MS = 600_000; // 10 minutes to solve
