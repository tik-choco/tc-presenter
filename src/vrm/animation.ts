// Cheap idle + speaking animation for a VRM: standing pose (arms down
// instead of the raw T-pose), auto-blink, subtle breathing/sway, and a
// mouth-open loop while the character is speaking. All effects only touch
// bones/expressions that actually exist on the model, so it is safe on any
// VRM. One VrmAnimator is created per VRM instance; call update() each frame
// BEFORE vrm.update(delta) so expression weights/pose are applied that frame.
//
// Vendored/trimmed from tc-town's src/vrm/animation.ts (MPL-2.0): the
// standing pose + idle sway is itself ported there from
// tc-vrm-viewer/src/viewer/idleMotion.ts. This copy drops tc-town's
// emotion-expression system and camera gaze-follow (both need a `Character`/
// LLM-classified emotion or an orbiting camera that don't exist here) —
// tc-presenter's presenter avatar only needs idle life plus lip-sync driven
// by a plain `speaking` boolean (see notes-tc-town.md §3).

import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

/** Preferred mouth expression names, in order (VRM1 aa / VRM0 A). */
const MOUTH_CANDIDATES = ['aa', 'a', 'A', 'ih', 'ou']

/** Drops the T-pose arms to the sides (radians, ~80deg). */
const ARM_DOWN_ANGLE = 1.4

export interface VrmAnimator {
  /** Advance idle + speaking animation. Call each frame before vrm.update(). */
  update(deltaSeconds: number, speaking: boolean): void
}

export function createVrmAnimator(vrm: VRM): VrmAnimator {
  const expressionNames = new Set(
    (vrm.expressionManager?.expressions ?? [])
      .map((expression) => expression.expressionName)
      .filter((name): name is string => Boolean(name)),
  )
  const hasBlink = expressionNames.has('blink')
  const mouthExpression = MOUTH_CANDIDATES.find((name) => expressionNames.has(name))

  // --- Standing pose (arms down instead of T-pose) + idle sway bones. ---
  const humanoid = vrm.humanoid
  const leftUpperArm = humanoid?.getNormalizedBoneNode('leftUpperArm') ?? null
  const rightUpperArm = humanoid?.getNormalizedBoneNode('rightUpperArm') ?? null
  const leftLowerArm = humanoid?.getNormalizedBoneNode('leftLowerArm') ?? null
  const rightLowerArm = humanoid?.getNormalizedBoneNode('rightLowerArm') ?? null
  // VRM0/1 rigs can bake a 180° residual into the rest pose (see rotateVRM0
  // in loader.ts), which flips which Z sign actually points the arm down —
  // derive it from the lowerArm rest position instead of assuming a fixed sign.
  const leftArmSign = leftLowerArm && leftLowerArm.position.x !== 0 ? -Math.sign(leftLowerArm.position.x) : 1
  const rightArmSign = rightLowerArm && rightLowerArm.position.x !== 0 ? -Math.sign(rightLowerArm.position.x) : -1
  // Breathing bone: prefer upperChest, falling back to chest, then spine.
  const breathBone =
    humanoid?.getNormalizedBoneNode('upperChest') ??
    humanoid?.getNormalizedBoneNode('chest') ??
    humanoid?.getNormalizedBoneNode('spine') ??
    null
  const spineBone = humanoid?.getNormalizedBoneNode('spine') ?? null
  const headBone = humanoid?.getNormalizedBoneNode('head') ?? null

  const breathBaseX = breathBone ? breathBone.rotation.x : 0
  const spineBaseZ = spineBone ? spineBone.rotation.z : 0
  const headBaseX = headBone ? headBone.rotation.x : 0
  const headBaseY = headBone ? headBone.rotation.y : 0

  // Apply the arms-down stance immediately so the model never renders (even
  // for one frame) in its raw T-pose.
  leftUpperArm?.rotation.set(0, 0, leftArmSign * ARM_DOWN_ANGLE)
  rightUpperArm?.rotation.set(0, 0, rightArmSign * ARM_DOWN_ANGLE)

  let blinkTimer = randomBlinkInterval()
  let blinkElapsed = 0
  let blinkPhase: 'idle' | 'closing' | 'opening' = 'idle'
  let blinkPhaseElapsed = 0

  let idleElapsed = 0
  let mouthElapsed = 0
  let mouthWeight = 0

  const setExpr = (name: string | undefined, weight: number) => {
    if (name) vrm.expressionManager?.setValue(name, weight)
  }

  return {
    update(deltaSeconds, speaking) {
      // --- Standing pose: keep the arms-down base rotation every frame. ---
      leftUpperArm?.rotation.set(0, 0, leftArmSign * ARM_DOWN_ANGLE)
      rightUpperArm?.rotation.set(0, 0, rightArmSign * ARM_DOWN_ANGLE)

      // --- Idle sway: tiny sinusoidal breathing/chest/spine/head motion,
      // layered on top of the standing pose's base rotations. ---
      idleElapsed += deltaSeconds
      if (breathBone) {
        breathBone.rotation.x = breathBaseX + Math.sin(idleElapsed * 1.4) * 0.02
      }
      if (spineBone) {
        spineBone.rotation.z = spineBaseZ + Math.sin(idleElapsed * 0.55) * 0.015
      }
      if (headBone) {
        headBone.rotation.y = headBaseY + Math.sin(idleElapsed * 0.3) * 0.05
        headBone.rotation.x = headBaseX + Math.sin(idleElapsed * 0.45 + 1.5) * 0.025
      }

      // --- Auto-blink. ---
      if (hasBlink) {
        blinkElapsed += deltaSeconds
        if (blinkPhase === 'idle') {
          if (blinkElapsed >= blinkTimer) {
            blinkPhase = 'closing'
            blinkPhaseElapsed = 0
            blinkElapsed = 0
          }
        } else {
          blinkPhaseElapsed += deltaSeconds
          if (blinkPhase === 'closing') {
            const weight = Math.min(1, blinkPhaseElapsed / 0.08)
            setExpr('blink', weight)
            if (weight >= 1) {
              blinkPhase = 'opening'
              blinkPhaseElapsed = 0
            }
          } else {
            const weight = Math.max(0, 1 - blinkPhaseElapsed / 0.12)
            setExpr('blink', weight)
            if (weight <= 0) {
              blinkPhase = 'idle'
              blinkTimer = randomBlinkInterval()
            }
          }
        }
      }

      // --- Mouth movement while speaking. ---
      if (mouthExpression) {
        if (speaking) {
          mouthElapsed += deltaSeconds
          // Blend two sines for a less mechanical talking cadence.
          const target = 0.5 + 0.35 * Math.sin(mouthElapsed * 17) + 0.15 * Math.sin(mouthElapsed * 5.3)
          mouthWeight = THREE.MathUtils.clamp(mouthWeight + (target - mouthWeight) * 0.5, 0, 1)
        } else {
          mouthWeight = Math.max(0, mouthWeight - deltaSeconds * 6)
        }
        setExpr(mouthExpression, mouthWeight)
      }
    },
  }
}

function randomBlinkInterval(): number {
  return 2 + Math.random() * 3
}
