// Minimal VRM avatar reference. Mirrors the fields of tc-town's
// `VrmAvatar` (src/types.ts: `{ kind: 'vrm', blobKey, checksum, fileName }`)
// but drops the `kind` discriminant — tc-presenter has no Character/avatar
// union, just a single "presenter character" slot (see
// vrm/characterSettings.ts) that is either unset or points at one VRM.
export interface VrmAvatarRef {
  /** Record id in the shared tc-vrm-viewer/models IndexedDB library (see vrm/library.ts). */
  blobKey: string
  /** sha256 hex digest of the .vrm bytes — the cross-app stable identity, shared with tc-town/tc-vrm-viewer. */
  checksum: string
  fileName: string
}
