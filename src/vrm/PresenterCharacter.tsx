// The actual VRM render surface: loads the selected model, builds the scene
// (vrm/stage.ts), and drives a self-contained render loop (its own
// WebGLRenderer + <canvas>, disposed on unmount). This file — and everything
// it imports (three, @pixiv/three-vrm, vrm/loader.ts, vrm/stage.ts) — is only
// ever reached via a dynamic `import()`: PresentPlayer.tsx does
// `lazy(() => import('../../vrm/PresenterCharacter'))`, so three.js's sizable
// bundle only loads once a presenter character is actually enabled, never
// just from opening the app or the Present tab.
import { useEffect, useRef } from 'preact/hooks'
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { disposeVrm, loadVrmForAvatar } from './loader'
import { createAvatarScene } from './stage'
import type { VrmAvatarRef } from './types'
import './presenter-character.css'

const MAX_PIXEL_RATIO = 2

export interface PresenterCharacterProps {
  vrmRef: VrmAvatarRef
  /** Drives lip-sync — true while narration audio (or the estimated-reading fallback) is actively playing. */
  speaking: boolean
  framing?: 'bust' | 'upper' | 'full'
}

export default function PresenterCharacter({ vrmRef, speaking, framing = 'upper' }: PresenterCharacterProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Latest `speaking` value read by the render loop without re-running the
  // (expensive) load effect on every toggle.
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking

  useEffect(() => {
    let cancelled = false
    let vrm: VRM | null = null
    let renderer: THREE.WebGLRenderer | null = null
    let frameId = 0
    let ro: ResizeObserver | null = null

    loadVrmForAvatar(vrmRef)
      .then((loaded) => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (cancelled || !canvas || !container) {
          disposeVrm(loaded)
          return
        }
        vrm = loaded
        const initialAspect = container.clientWidth / Math.max(1, container.clientHeight)
        const scene = createAvatarScene(loaded, initialAspect || 1, framing)

        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
        renderer.setClearColor(0x000000, 0)

        const clock = new THREE.Clock()

        const resize = () => {
          if (!renderer) return
          const w = container.clientWidth
          const h = container.clientHeight
          if (w === 0 || h === 0) return
          const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
          renderer.setPixelRatio(dpr)
          renderer.setSize(w, h, false)
          scene.camera.aspect = w / h
          scene.camera.updateProjectionMatrix()
        }
        resize()
        ro = new ResizeObserver(resize)
        ro.observe(container)

        const tick = () => {
          const delta = clock.getDelta()
          scene.animator.update(delta, speakingRef.current)
          scene.vrm.update(delta)
          renderer?.render(scene.scene, scene.camera)
          frameId = requestAnimationFrame(tick)
        }
        frameId = requestAnimationFrame(tick)
      })
      .catch(() => {
        // Missing/corrupt model, IndexedDB unavailable, etc. — leave the
        // corner empty; callers already treat "no character" as a valid,
        // silent state (see PresentPlayer.tsx / CharacterManager.tsx).
      })

    return () => {
      cancelled = true
      if (frameId) cancelAnimationFrame(frameId)
      ro?.disconnect()
      if (vrm) disposeVrm(vrm)
      renderer?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrmRef.blobKey, vrmRef.checksum, framing])

  return (
    <div ref={containerRef} class="presenter-character">
      <canvas ref={canvasRef} class="presenter-character__canvas" />
    </div>
  )
}
