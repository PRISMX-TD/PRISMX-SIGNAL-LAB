// 双门定价：3D 传送门展示订阅 vs 入金两种付费路径
// Two Doors: 3D portals showing subscription vs deposit paths
import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Float } from '@react-three/drei'
import * as THREE from 'three'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

/* ── 3D 门框 / 3D door frame ── */
function DoorFrame({ position, color, glowColor }: { position: [number, number, number]; color: string; glowColor: string }) {
  const frameRef = useRef<THREE.Mesh>(null!)
  const frameGeo = useMemo(() => {
    const shape = new THREE.Shape()
    const w = 1.3
    const h = 2.0
    const t = 0.08
    shape.moveTo(-w / 2, -h / 2)
    shape.lineTo(w / 2, -h / 2)
    shape.lineTo(w / 2, -h / 2 + t)
    shape.lineTo(-w / 2 + t, -h / 2 + t)
    shape.lineTo(-w / 2 + t, h / 2 - t)
    shape.lineTo(w / 2, h / 2 - t)
    shape.lineTo(w / 2, h / 2)
    shape.lineTo(-w / 2, h / 2)
    shape.lineTo(-w / 2, -h / 2)
    return new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 })
  }, [])

  useFrame(({ clock }) => {
    const s = 1 + Math.sin(clock.elapsedTime * 0.5) * 0.03
    frameRef.current.scale.setScalar(s)
  })

  return (
    <mesh ref={frameRef} geometry={frameGeo} position={position}>
      <meshPhysicalMaterial
        color={color}
        emissive={glowColor}
        emissiveIntensity={0.25}
        metalness={0.3}
        roughness={0.2}
        transparent
        opacity={0.5}
        clearcoat={0.2}
      />
    </mesh>
  )
}

/* ── 门内粒子 / inside particles ── */
function DoorParticles({ position, color }: { position: [number, number, number]; color: string }) {
  const ref = useRef<THREE.Points>(null!)
  const count = 80
  const positions_ = useMemo(() => {
    const p = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      p[i * 3] = position[0] + (Math.random() - 0.5) * 1.0
      p[i * 3 + 1] = position[1] + (Math.random() - 0.5) * 1.6
      p[i * 3 + 2] = position[2] + (Math.random() - 0.5) * 0.15
    }
    return p
  }, [position])

  useFrame(() => {
    if (!ref.current) return
    const pos = ref.current.geometry.attributes.position.array as Float32Array
    for (let i = 0; i < count; i++) {
      pos[i * 3 + 1] += 0.003
      if (pos[i * 3 + 1] > position[1] + 0.8) pos[i * 3 + 1] = position[1] - 0.8
    }
    ref.current.geometry.attributes.position.needsUpdate = true
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions_, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={0.03}
        transparent
        opacity={0.5}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}

/* ── 回旋环 / orbiting ring ── */
function OrbitRing({ position, color }: { position: [number, number, number]; color: string }) {
  const ringRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.TorusGeometry(0.7, 0.015, 16, 60), [])

  useFrame(() => {
    ringRef.current.rotation.y += 0.01
    ringRef.current.rotation.x += 0.005
  })

  return (
    <mesh ref={ringRef} geometry={geo} position={position}>
      <meshBasicMaterial color={color} transparent opacity={0.3} />
    </mesh>
  )
}

/* ── 场景 / scene ── */
function DoorsScene() {
  return (
    <>
      <ambientLight intensity={0.35} />
      <pointLight position={[0, 2, 3]} intensity={50} color="#7c3aed" />
      <pointLight position={[-3, -1, 2]} intensity={25} color="#a78bfa" />
      <pointLight position={[3, -1, 2]} intensity={25} color="#33e1ff" />

      {/* 左门：订阅 $49/月 */}
      <Float speed={1.5} rotationIntensity={0.05} floatIntensity={0.1}>
        <DoorFrame position={[-1.5, 0.15, 0]} color="#a855f7" glowColor="#4c1d95" />
        <DoorParticles position={[-1.5, 0.15, 0]} color="#a855f7" />
        <OrbitRing position={[-1.5, 0.15, 0]} color="#a78bfa" />
      </Float>

      {/* 右门：入金 $500 → PRO 赠送 */}
      <Float speed={1.5} rotationIntensity={0.05} floatIntensity={0.12}>
        <DoorFrame position={[1.5, 0.15, 0]} color="#2ee07e" glowColor="#166534" />
        <DoorParticles position={[1.5, 0.15, 0]} color="#2ee07e" />
        <OrbitRing position={[1.5, 0.15, 0]} color="#9dff5b" />
      </Float>
    </>
  )
}

function ResponsiveCanvas() {
  const { size } = useThree()
  const isSmall = size.width < 768
  return (
    <Suspense fallback={null}>
      <group scale={isSmall ? 0.55 : 1}>
        <DoorsScene />
      </group>
    </Suspense>
  )
}

/* ── 文案 / text overlay ── */
function DoorsText() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-between py-10 text-center">
      <div className="reveal">
        <span className="eyebrow">{t('landing.tdEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">
          {t('landing.tdTitle')}
        </h2>
      </div>

      {/* 两扇门卡片 */}
      <div className="grid grid-cols-2 gap-5 sm:gap-10 pointer-events-auto">
        {/* 门 A */}
        <div
          onClick={() => navigate('/login?mode=register')}
          className="cursor-pointer rounded-card border border-white/10 bg-ink-800/70 px-4 py-5 backdrop-blur transition-all hover:border-prism-500/40 hover:bg-ink-700/80 sm:px-8 sm:py-7"
        >
          <div className="text-xs text-slate-500">{t('landing.tdDoorA')}</div>
          <div className="mt-2 font-display text-2xl font-bold text-slate-50 sm:text-3xl">$49</div>
          <div className="text-xs text-slate-400">{t('landing.tdPerMonth')}</div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 sm:text-xs">{t('landing.tdDoorADesc')}</p>
        </div>

        {/* 门 B */}
        <div
          onClick={() => navigate('/login?mode=register')}
          className="cursor-pointer rounded-card border border-up/30 bg-ink-800/70 px-4 py-5 backdrop-blur transition-all hover:border-up/60 hover:bg-ink-700/80 sm:px-8 sm:py-7 relative overflow-hidden"
        >
          <div className="absolute -right-4 -top-3 rotate-12 rounded bg-up px-2.5 py-0.5 text-[9px] font-bold text-black">
            PRO
          </div>
          <div className="text-xs text-slate-500">{t('landing.tdDoorB')}</div>
          <div className="mt-2 font-display text-2xl font-bold text-up sm:text-3xl">$500</div>
          <div className="text-xs text-slate-400">{t('landing.tdDeposit')}</div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 sm:text-xs">{t('landing.tdDoorBDesc')}</p>
        </div>
      </div>

      <div className="reveal text-center">
        <p className="text-sm text-slate-400">{t('landing.tdFootnote')}</p>
      </div>
    </div>
  )
}

export default function TwoDoors() {
  return (
    <section id="pricing" className="relative mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="relative h-[520px] sm:h-[580px] overflow-hidden rounded-card">
        <div className="absolute inset-0 z-0 bg-ink-900">
          <Canvas
            camera={{ position: [0, -0.1, 3.5], fov: 55 }}
            dpr={[1, 1.5]}
            gl={{ antialias: true, alpha: true }}
          >
            <ResponsiveCanvas />
          </Canvas>
        </div>
        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-ink-950/60 via-transparent to-ink-950/60" />
        <DoorsText />
      </div>
    </section>
  )
}
