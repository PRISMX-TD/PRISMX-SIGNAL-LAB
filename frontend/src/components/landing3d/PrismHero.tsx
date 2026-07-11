// 3D 棱镜 Hero：八面体水晶拆分混沌光粒子为 SL/TP/Entry 三色光束
// 3D Prism Hero: Octahedron crystal splits chaotic light into SL/TP/Entry beams
import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Float, PointMaterial } from '@react-three/drei'
import * as THREE from 'three'
import { useTranslation } from 'react-i18next'

/* ── 混沌光粒子 / chaotic light particles ── */
function ChaosParticles() {
  const meshRef = useRef<THREE.Points>(null!)
  const count = 600
  const positions = useMemo(() => {
    const p = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = 3.5 + Math.random() * 2
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.8
      p[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      p[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) - 0.6
      p[i * 3 + 2] = r * Math.cos(phi)
    }
    return p
  }, [])

  useFrame((state) => {
    meshRef.current.rotation.y += 0.002
    meshRef.current.rotation.x += 0.001
    const s = 1 + Math.sin(state.clock.elapsedTime * 0.5) * 0.15
    meshRef.current.scale.setScalar(s)
  })

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <PointMaterial
        color="#a78bfa"
        size={0.03}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        opacity={0.6}
      />
    </points>
  )
}

/* ── 3D 棱镜水晶 / 3D prism crystal ── */
function PrismCrystal() {
  const meshRef = useRef<THREE.Mesh>(null!)
  const geo = useMemo(() => new THREE.OctahedronGeometry(0.9, 1), [])

  const mat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#a78bfa',
        emissive: '#4c1d95',
        emissiveIntensity: 0.25,
        metalness: 0.05,
        roughness: 0.12,
        transparent: true,
        opacity: 0.55,
        envMapIntensity: 0.4,
        clearcoat: 0.3,
        clearcoatRoughness: 0.1,
      }),
    [],
  )

  useFrame((state) => {
    meshRef.current.rotation.y += 0.005
    meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3) * 0.15
    meshRef.current.rotation.z += 0.003
  })

  return <mesh ref={meshRef} geometry={geo} material={mat} />
}

/* ── 环形粒子轨道 / ring particle orbit ── */
function PrismRings() {
  const ringRef = useRef<THREE.Mesh>(null!)

  const ringGeo = useMemo(() => new THREE.TorusGeometry(1.35, 0.012, 32, 100), [])
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#a78bfa',
        transparent: true,
        opacity: 0.35,
      }),
    [],
  )

  useFrame((state) => {
    ringRef.current.rotation.x += 0.003
    ringRef.current.rotation.y -= 0.005
    ringRef.current.rotation.z += 0.002
    const s = 1 + Math.sin(state.clock.elapsedTime * 0.7) * 0.06
    ringRef.current.scale.setScalar(s)
  })

  return <mesh ref={ringRef} geometry={ringGeo} material={ringMat} />
}

/* ── 射出的三色光束 / three outgoing beams ── */
function ExitBeams() {
  const groupRef = useRef<THREE.Group>(null!)

  const beams = useMemo(() => {
    const colors = [
      new THREE.Color('#a855f7'), // entry purple
      new THREE.Color('#2ee07e'), // TP green
      new THREE.Color('#ff4d67'), // SL red
    ]
    const angles = [-0.3, 0, 0.3]
    return angles.map((a, i) => {
      const dir = new THREE.Vector3(Math.sin(a), a * 0.6 - 0.1, Math.cos(a)).normalize()
      return { dir, color: colors[i] }
    })
  }, [])

  useFrame((state) => {
    if (!groupRef.current) return
    const s = 1 + Math.sin(state.clock.elapsedTime * 0.8) * 0.08
    beams.forEach((_, i) => {
      const child = groupRef.current.children[i] as THREE.Mesh
      if (child?.scale) {
        child.scale.setScalar(s)
        const mat = child.material as THREE.MeshBasicMaterial
        if (mat && 'opacity' in mat) {
          mat.opacity = 0.35 + Math.sin(state.clock.elapsedTime * 1.2 + i) * 0.15
        }
      }
    })
  })

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {beams.map((b, i) => (
        <mesh key={i} position={b.dir.clone().multiplyScalar(1.15)}>
          <cylinderGeometry args={[0.018, 0.018, 3.2, 8]} />
          <meshBasicMaterial
            color={b.color}
            transparent
            opacity={0.4}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  )
}

/* ── 背景星场 / star field ── */
function StarField() {
  const ref = useRef<THREE.Points>(null!)
  const positions = useMemo(() => {
    const p = new Float32Array(800 * 3)
    for (let i = 0; i < 800; i++) {
      p[i * 3] = (Math.random() - 0.5) * 14
      p[i * 3 + 1] = (Math.random() - 0.5) * 10
      p[i * 3 + 2] = (Math.random() - 0.5) * 8
    }
    return p
  }, [])

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <PointMaterial color="#ffffff" size={0.012} transparent opacity={0.3} depthWrite={false} />
    </points>
  )
}

/* ── 场景组合 / scene composition ── */
function PrismScene() {
  return (
    <>
      <StarField />
      <ambientLight intensity={0.4} />
      <pointLight position={[2, 1, 3]} intensity={60} color="#7c3aed" />
      <pointLight position={[-2, -1, 2]} intensity={30} color="#a78bfa" />
      <Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.3}>
        <PrismCrystal />
      </Float>
      <ChaosParticles />
      <PrismRings />
      <ExitBeams />
    </>
  )
}

/* ── Canvas 尺寸响应 / responsive canvas ── */
function ResponsiveCanvas() {
  const { size } = useThree()
  const isSmall = size.width < 768
  return (
    <Suspense fallback={null}>
      <group scale={isSmall ? 0.7 : 1}>
        <PrismScene />
      </group>
    </Suspense>
  )
}

/* ── 下方文案 / text overlay ── */
function HeroText() {
  const { t } = useTranslation()

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end pb-12 text-center">
      <div className="mx-auto inline-flex animate-fade-in-up">
        <span className="rounded-full border border-prism-500/30 bg-prism-600/10 px-4 py-1.5 text-sm font-medium text-prism-300">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-prism-400 animate-breathe" />
          {t('landing.badge')}
        </span>
      </div>

      <h1 className="mt-6 max-w-3xl animate-fade-in-up px-4 font-display text-4xl font-black leading-tight tracking-tight text-slate-50 sm:text-6xl">
        {t('landing.heroTitle1')}{' '}
        <span className="bg-neon-gradient bg-clip-text text-transparent animate-gradient-x">
          {t('landing.heroTitle2')}
        </span>
      </h1>

      <p className="mt-6 max-w-2xl animate-fade-in-up px-4 text-base leading-relaxed text-slate-400 sm:text-lg">
        {t('landing.heroSubtitle')}
      </p>

      <div className="pointer-events-auto mt-9 flex animate-fade-in-up flex-col items-center gap-3 sm:flex-row">
        <a
          href="/login?mode=register"
          className="inline-flex items-center gap-2 rounded-full bg-neon-gradient px-8 py-3.5 text-base font-bold text-white shadow-prism-lg transition-all hover:shadow-neon-cyan hover:scale-105"
        >
          {t('landing.ctaPrimary')}
        </a>
      </div>

      <p className="mt-4 animate-fade-in-up text-xs text-slate-500">{t('landing.heroNote')}</p>
    </div>
  )
}

/* ── 导出 / export ── */
export default function PrismHero() {
  return (
    <section className="relative h-[100vh] min-h-[600px] w-full overflow-hidden">
      {/* 3D canvas background */}
      <div className="absolute inset-0 z-0">
        <Canvas
          camera={{ position: [0, 0.3, 4.5], fov: 50 }}
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
        >
          <ResponsiveCanvas />
        </Canvas>
      </div>

      {/* 底部渐变遮罩 / gradient fade at bottom */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-48 bg-gradient-to-t from-ink-950 via-ink-950/70 to-transparent" />

      {/* 文字叠加层 */}
      <HeroText />
    </section>
  )
}
