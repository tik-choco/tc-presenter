// three.js scene setup for a single presenter VRM avatar. Vendored/trimmed
// from tc-town's src/vrm/stage.ts (MPL-2.0): keeps the bone/bounding-box-
// driven camera framing math (bust/upper/full — solved from the model's real
// posed skeleton so tall hair/horns/etc. never get clipped by a fixed
// offset) but drops tc-town's multi-avatar shared-renderer pool and mouse-
// orbit controls. tc-presenter only ever mounts one presenter avatar at a
// time in a fixed corner of the slide, so PresenterCharacter.tsx just owns a
// single dedicated WebGLRenderer per mount instead of pooling.

import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { createVrmAnimator, type VrmAnimator } from './animation'

export interface AvatarScene {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  vrm: VRM
  animator: VrmAnimator
}

/** Standard three-point-ish soft lighting used across avatar scenes. */
export function addAvatarLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0xffffff, 0.9))
  const directional = new THREE.DirectionalLight(0xffffff, 1.2)
  directional.position.set(1, 1.5, 1)
  scene.add(directional)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.35))
}

/**
 * Build an avatar scene around a VRM, framed either as a head-and-chest
 * "bust", a head-to-hips "upper" shot, or a head-to-toe "full" body shot. In
 * all cases the camera is solved from the model's real (posed) bounding
 * box/bones so the required camera distance accounts for both the vertical
 * span *and* the horizontal width, and a portrait `aspect` doesn't clip the
 * sides even though its horizontal FOV is narrower than its vertical FOV.
 *
 * The animator (which applies the arms-down standing pose to the normalized
 * humanoid bones) is created *before* any bone/box measurement below, and
 * `vrm.update(0)` propagates that pose to world matrices first — measuring
 * the raw T-pose here would frame the shot around the wrong shoulder width
 * and head height once the arms drop on the very next real frame.
 */
export function createAvatarScene(vrm: VRM, aspect = 1, framing: 'bust' | 'upper' | 'full' = 'upper'): AvatarScene {
  const scene = new THREE.Scene()
  scene.background = null
  addAvatarLights(scene)
  scene.add(vrm.scene)

  const camera = new THREE.PerspectiveCamera(29, aspect, 0.05, 20)

  const animator = createVrmAnimator(vrm)
  vrm.update(0)
  vrm.scene.updateWorldMatrix(true, true)

  const head = vrm.humanoid?.getNormalizedBoneNode('head') ?? null
  const chest = vrm.humanoid?.getNormalizedBoneNode('upperChest') ?? vrm.humanoid?.getNormalizedBoneNode('chest') ?? null
  const hips = vrm.humanoid?.getNormalizedBoneNode('hips') ?? null
  const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm') ?? null
  const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm') ?? null

  const box = new THREE.Box3().setFromObject(vrm.scene)
  const headPos = new THREE.Vector3()
  const chestPos = new THREE.Vector3()
  const hipsPos = new THREE.Vector3()

  if (head) {
    head.getWorldPosition(headPos)
  } else {
    box.getCenter(headPos)
    headPos.y = box.max.y - (box.max.y - box.min.y) * 0.12
  }
  if (chest) {
    chest.getWorldPosition(chestPos)
  } else {
    // Fall back to a fixed offset below the head if the model has no chest bone.
    chestPos.set(headPos.x, headPos.y - 0.35, headPos.z)
  }
  if (hips) {
    hips.getWorldPosition(hipsPos)
  } else {
    hipsPos.set(chestPos.x, chestPos.y - 0.45, chestPos.z)
  }

  const vFovRad = THREE.MathUtils.degToRad(camera.fov)

  let topY: number
  let bottomY: number
  let lookY: number
  let horizontalExtent: number
  let horizontalMargin: number

  if (framing === 'full') {
    // Head-to-toe: use the posed bounding box's feet (min.y) and crown
    // (max.y) directly, plus a small top/bottom margin.
    const rawSpan = Math.max(0.5, box.max.y - box.min.y)
    const margin = rawSpan * 0.04
    topY = box.max.y + margin
    bottomY = box.min.y - margin
    lookY = (box.max.y + box.min.y) / 2 // body center, not the head-biased bust lookY
    horizontalExtent = box.max.x - box.min.x
    horizontalMargin = 1.25 // breathing room around the widest point of the (arms-down) body
  } else if (framing === 'upper') {
    // Waist-up: same crown headroom as the bust, but frame down to just
    // below the hips so the face reads large while the torso still gives
    // the shot some presence.
    const crownY = Math.max(box.max.y, headPos.y + 0.1)
    topY = crownY + (crownY - headPos.y) * 0.2
    bottomY = hipsPos.y - (chestPos.y - hipsPos.y) * 0.4
    lookY = (topY + bottomY) / 2
    horizontalExtent = box.max.x - box.min.x
    horizontalMargin = 1.2 // arms-down body width already includes the arms; modest breathing room
  } else {
    // The head bone sits roughly at eye/jaw height, well below the crown of
    // the head (and further below any hair). Use the model's actual
    // bounding box for the crown instead of a fixed offset so tall
    // hair/horns/hats on unusual models still stay fully inside the frame.
    const crownY = Math.max(box.max.y, headPos.y + 0.1)
    topY = crownY + (crownY - headPos.y) * 0.2 // small headroom above the crown
    // Frame down past the chest bone toward the solar plexus (partway to the
    // hips) so the shot reads as head-to-chest, not a tight face crop.
    bottomY = chestPos.y - (chestPos.y - hipsPos.y) * 0.35
    lookY = (topY + bottomY) / 2

    // Shoulder width (bone-to-bone), falling back to the box width.
    if (leftUpperArm && rightUpperArm) {
      const l = new THREE.Vector3()
      const r = new THREE.Vector3()
      leftUpperArm.getWorldPosition(l)
      rightUpperArm.getWorldPosition(r)
      horizontalExtent = l.distanceTo(r)
    } else {
      horizontalExtent = box.max.x - box.min.x
    }
    horizontalMargin = 1.4 // shoulder joints sit inside the body's visual width; leave room for it plus breathing space
  }

  const verticalSpan = Math.max(0.35, topY - bottomY)
  const VERTICAL_MARGIN = 1.15 // headroom so the crop doesn't touch the top/bottom edges
  const distanceForHeight = (verticalSpan * VERTICAL_MARGIN) / (2 * Math.tan(vFovRad / 2))

  // `camera.fov` is the *vertical* FOV; the horizontal FOV shrinks with a
  // portrait `aspect` (< 1). Solve for the distance that keeps the body
  // inside that narrower horizontal frame too, and use whichever distance
  // (height- or width-driven) is larger so nothing gets clipped.
  const halfWidth = (Math.max(horizontalExtent, 0.28) * horizontalMargin) / 2
  const distanceForWidth = halfWidth / (Math.tan(vFovRad / 2) * aspect)

  const distance = Math.max(distanceForHeight, distanceForWidth)

  camera.position.set(headPos.x, lookY, headPos.z + distance)
  camera.lookAt(headPos.x, lookY, headPos.z)

  // Eyes follow the (static) presenter camera for a lifelike gaze.
  if (vrm.lookAt) vrm.lookAt.target = camera

  return { scene, camera, vrm, animator }
}
