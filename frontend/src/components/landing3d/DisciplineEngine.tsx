// 纪律引擎：3D 几何防护罩包裹持仓卡片，SL/TP/保本柱锁定
// Discipline Engine: 3D geometric shield encasing a position card with locked SL/TP/BE pillars
import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Float } from '@react-three/drei'
import * as THREE from 'three'
import { useTranslation } from 'react-i18next'

/* ── 防护罩 / protective dome ── */
function ShieldDome() {
  const domeRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1.5, 3), [])

  useFrame(({ clock }) => {
    domeRef.current.rotation.y += 0.003
    domeRef.current.rotation.x += 0.002
    const p = 1 + Math.sin(clock.elapsedTime * 0.6) * 0.05
    domeRef.current.scale.setScalar(p)
  })

  return (
    <mesh ref={domeRef} geometry={geo}>
      <meshPhysicalMaterial
        color="#7c3aed"
        emissive="#4c1d95"
        emissiveIntensity={0.12}
        metalness={0.05}
        roughness={0.25}
        transparent
        opacity={0.18}
        wireframe={false}
      />
    </mesh>
  )
}

/* ── 防护罩线框 / dome wireframe ── */
function ShieldWireframe() {
  const wireRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1.55, 3), [])

  useFrame(() => {
    wireRef.current.rotation.y += 0.003
    wireRef.current.rotation.x += 0.002
  })

  return (
    <mesh ref={wireRef} geometry={geo}>
      <meshBasicMaterial color="#a78bfa" wireframe transparent opacity={0.15} />
    </mesh>
  )
}

/* ── 三根锁定柱 / three locking pillars ── */
function LockPillars() {
  const pillarsRef = useRef<THREE.Group>(null!)

  const pillars = useMemo(() => {
    const configs = [
      { color: '#ff4d67', angle: -Math.PI / 4, label: 'SL LOCKED' },  // Stop Loss
      { color: '#a855f7', angle: 0, label: 'BE ACTIVE' },             // Break Even
      { color: '#2ee07e', angle: Math.PI / 4, label: 'TRAIL ON' },    // Trailing
    ]
    return configs.map((c) => {
      const x = Math.cos(c.angle) * 1.8
      const z = Math.sin(c.angle) * 1.8
      const geo = new THREE.CylinderGeometry(0.06, 0.08, 2.2, 8)
      const mat = new THREE.MeshBasicMaterial({
        color: c.color,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      return { mesh: new THREE.Mesh(geo, mat), x, z, color: c.color, label: c.label }
    })
  }, [])

  useFrame((state) => {
    pillars.forEach((p, i) => {
      p.mesh.rotation.z = (Math.sin(state.clock.elapsedTime * 0.4 + i) * 0.05)
      p.mesh.position.x = p.x
      p.mesh.position.z = p.z
    })
  })

  return (
    <group ref={pillarsRef}>
      {pillars.map((p, i) => (
        <primitive key={i} object={p.mesh} />
      ))}
    </group>
  )
}

/* ── 底部脉冲光环 / lower pulse ring ── */
function PulseRing() {
  const ringRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.TorusGeometry(1.7, 0.02, 16, 100), [])

  useFrame((state) => {
    const s = 1 + Math.sin(state.clock.elapsedTime * 0.5) * 0.08
    ringRef.current.scale.setScalar(s)
  })

  return (
    <mesh ref={ringRef} geometry={geo} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
      <meshBasicMaterial color="#a78bfa" transparent opacity={0.4} blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  )
}

/* ── 防护罩内信号卡片 / signal card inside shield ── */
function SignalCardInside() {
  const meshRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.PlaneGeometry(1.0, 0.55), [])

  const canvas = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 140
    const ctx = c.getContext('2d')!
    ctx.fillStyle = 'rgba(13,9,24,0.9)'
    ctx.beginPath()
    ctx.roundRect(8, 8, 240, 124, 16)
    ctx.fill()
    ctx.strokeStyle = 'rgba(167,139,250,0.3)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(8, 8, 240, 124, 16)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 22px "Space Grotesk", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('XAUUSD  BUY', 128, 50)
    ctx.fillStyle = '#2ee07e'
    ctx.font = 'bold 16px monospace'
    ctx.fillText('SL: 2340.60  |  TP: 2368.80', 128, 85)
    ctx.fillStyle = '#a78bfa'
    ctx.font = '12px monospace'
    ctx.fillText('LOCKED  ·  PLAN ACTIVE', 128, 115)
    return new THREE.CanvasTexture(c)
  }, [])

  useFrame((state) => {
    meshRef.current.rotation.y += 0.006
    meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.4) * 0.08
  })

  return (
    <mesh ref={meshRef} geometry={geo} position={[0, 0, 0]}>
      <meshBasicMaterial map={canvas} transparent opacity={0.9} />
    </mesh>
  )
}

/* ── 场景 / scene ── */
function EngineScene() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[3, 2, 2]} intensity={40} color="#7c3aed" />
      <pointLight position={[-3, -1, 1]} intensity={25} color="#a78bfa" />
      <ShieldDome />
      <ShieldWireframe />
      <LockPillars />
      <PulseRing />
      <Float speed={1.5} rotationIntensity={0.1} floatIntensity={0.15}>
        <SignalCardInside />
      </Float>
    </>
  )
}

function ResponsiveCanvas() {
  const { size } = useThree()
  const isSmall = size.width < 768
  return (
    <Suspense fallback={null}>
      <group scale={isSmall ? 0.65 : 1}>
        <EngineScene />
      </group>
    </Suspense>
  )
}

/* ── 文案 / text overlay ── */
function EngineText() {
  const { t } = useTranslation()

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end pb-12 text-center">
      <div className="reveal">
        <span className="eyebrow">{t('landing.deEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">
          {t('landing.deTitle')}
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-slate-400">{t('landing.deSubtitle')}</p>
      </div>
    </div>
  )
}

export default function DisciplineEngine() {
  return (
    <section id="discipline" className="relative mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="relative h-[520px] sm:h-[580px] overflow-hidden rounded-card">
        <div className="absolute inset-0 z-0 bg-ink-900">
          <Canvas
            camera={{ position: [0, 0.1, 3.2], fov: 50 }}
            dpr={[1, 1.5]}
            gl={{ antialias: true, alpha: true }}
          >
            <ResponsiveCanvas />
          </Canvas>
        </div>
        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-ink-950/60 via-transparent to-ink-950/60" />
        <EngineText />
      </div>
    </section>
  )
}
