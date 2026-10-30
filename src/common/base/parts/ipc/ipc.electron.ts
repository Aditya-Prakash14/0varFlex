// src/common/base/parts/ipc/ipc.electron.ts — the wire envelope shared by the main and renderer
// transports. Every message is a plain, structured-clone-safe object — no functions, no class
// instances, no VSBuffer in this port (upstream frames with VSBuffer; see ipc.ts in the reference).
//
// wire format:
//
//   renderer → main:  { type: 'req',         id, channelName, command, arg? }
//                     { type: 'subscribe',   id, channelName, event, arg? }
//                     { type: 'unsubscribe', id }
//   main → renderer:  { type: 'reply',       id, data? }
//                     { type: 'replyErr',    id, message }
//                     { type: 'event',       id, data }
//
// `id` is one number sequence per client: it correlates a pending call with its reply and a
// subscription with its events (the reference uses numeric RequestType/ResponseType enums for the
// same purpose — 'req'/'reply'/'replyErr'/'subscribe'/'unsubscribe'/'event' here).
//
// shortcut: everything crossing the wire must be JSON-safe. URIs, Dates, classes and functions do
// not survive structured clone — serialize at the boundary (upstream owns IURITransformer for
// URIs; nothing on our wire needs it yet).

export type WireRequest = { readonly type: 'req'; readonly id: number; readonly channelName: string; readonly command: string; readonly arg?: unknown };
export type WireSubscribe = { readonly type: 'subscribe'; readonly id: number; readonly channelName: string; readonly event: string; readonly arg?: unknown };
export type WireUnsubscribe = { readonly type: 'unsubscribe'; readonly id: number };
export type WireReply = { readonly type: 'reply'; readonly id: number; readonly data?: unknown };
export type WireReplyErr = { readonly type: 'replyErr'; readonly id: number; readonly message: string };
export type WireEvent = { readonly type: 'event'; readonly id: number; readonly data?: unknown };

export type WireMessage = WireRequest | WireSubscribe | WireUnsubscribe | WireReply | WireReplyErr | WireEvent;

/** The Electron channel name both transports send on. */
export const MINI_IPC_CHANNEL = 'mini:ipc';
