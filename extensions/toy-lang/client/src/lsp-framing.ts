// extensions/toy-lang/client/src/lsp-framing.ts — kept as a re-export.
//
// A2-2 moved the implementation to src/common/base/parts/protocol/common/messageFraming.ts: the
// Debug Adapter Protocol frames messages identically to LSP, so the two share one reader/writer.
// This file stays so the LSP client's imports (and its history) are undisturbed.

export { encodeMessage, MessageReader } from '../../../../src/common/base/parts/protocol/common/messageFraming.js';
