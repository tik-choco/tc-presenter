// Deprecated: this module's singleton MistNode was promoted to lib/mistNode
// .ts so lib/aiNetwork.ts's AI Network role could share the same real node
// instead of instantiating a second one (see mistNode.ts's header comment
// for the full rationale and the SharedMistNode adapter it now provides).
// Nothing in this app imports from this file anymore — lib/
// globalArticlesReader.ts was updated to import directly from ./mistNode.
// Kept as a thin re-export (rather than deleted) purely so a stray future
// import of this path doesn't silently create a second MistNode; every name
// below resolves to the exact same singleton as ./mistNode.
export { getNode, subscribeEvent, decodeRawPayload, isRawEvent, localNodeId, storage_get, DELIVERY_RELIABLE } from './mistNode'
