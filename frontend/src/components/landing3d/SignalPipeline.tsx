// 信号生命线：3D 管道展示信号从生成到判定的完整旅程
// Signal pipeline: 3D tunnel showing a signal's journey from generation to verdict
import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Float } from '@react-three/drei'
import * as THREE from 'three'
import { useTranslation } from 'react-i18next'

/* ── 光隧道 / light tunnel ── */
function LightTunnel() {
  const tunnelRef = useRef<THREE.Mesh>(null!)
  const tunnelGeo = useMemo(() => new THREE.TorusGeometry(1.4, 0.02, 16, 80), [])

  useFrame(() => {
    tunnelRef.current.rotation.x += 0.004
    tunnelRef.current.rotation.y += 0.003
    tunnelRef.current.rotation.z += 0.002
  })

  return (
    <mesh ref={tunnelRef} geometry={tunnelGeo}>
      <meshBasicMaterial color="#a78bfa" transparent opacity={0.2} />
    </mesh>
  )
}

/* ── 隧道内壁光轨 / inner light trails ── */
function TunnelTrails() {
  const trailsRef = useRef<THREE.Group>(null!)
  const rings: THREE.Mesh[] = []

  for (let i = 0; i < 12; i++) {
    const geo = new THREE.TorusGeometry(1.35, 0.008, 8, 40)
    const mat = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? '#7c3aed' : '#a855f7',
      transparent: true,
      opacity: 0.25,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.z = -4 + i * 0.8
    mesh.rotation.x = (i * Math.PI) / 6
    rings.push(mesh)
  }

  useFrame(() => {
    rings.forEach((r) => {
      r.rotation.x += 0.006
      r.rotation.z += 0.004
    })
  })

  return <group ref={trailsRef}>{rings.map((r, i) => <primitive key={i} object={r} />)}</group>
}

/* ── 流动的粒子流（信号卡片流动）/ flowing particle stream (signal flow) ── */
function SignalStream() {
  const streamRef = useRef<THREE.Group>(null!)
  const count = 40
  const particles: { mesh: THREE.Mesh; offset: number }[] = []

  for (let i = 0; i < count; i++) {
    const geo = new THREE.SphereGeometry(0.05, 6, 6)
    const isWin = i % 3 !== 0
    const mat = new THREE.MeshBasicMaterial({
      color: isWin ? '#2ee07e' : '#ff4d67',
      transparent: true,
      opacity: 0.8,
    })
    const mesh = new THREE.Mesh(geo, mat)
    const offset = (i / count) * Math.PI * 2
    particles.push({ mesh, offset })
  }

  useFrame((state) => {
    particles.forEach(({ mesh: m, offset }) => {
      const t = (state.clock.elapsedTime * 0.4 + offset) % (Math.PI * 2)
      const angle = t
      const radius = 1.3 + Math.sin(t * 3) * 0.15
      m.position.x = Math.cos(angle) * radius
      m.position.y = Math.sin(angle * 2) * 0.5
      m.position.z = Math.sin(angle) * radius
      const mat = m.material as THREE.MeshBasicMaterial
      mat.opacity = 0.3 + Math.sin(t * 2) * 0.3
    })
  })

  return (
    <group ref={streamRef}>
      {particles.map(({ mesh }, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </group>
  )
}

/* ── 中心判定账本：水晶板 / center ledger: crystal plate ── */
function LedgerPlate() {
  const plateRef = useRef<THREE.Mesh>(null!)
  const plateGeo = useMemo(() => new THREE.PlaneGeometry(1.6, 1.0), [])

  useFrame((state) => {
    plateRef.current.rotation.y += 0.004
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 0.6) * 0.04
    plateRef.current.scale.setScalar(pulse)
  })

  return (
    <mesh ref={plateRef} geometry={plateGeo}>
      <meshPhysicalMaterial
        color="#ffffff"
        emissive="#7c3aed"
        emissiveIntensity={0.15}
        metalness={0.1}
        roughness={0.15}
        transparent
        opacity={0.45}
      />
    </mesh>
  )
}

/* ── 管道入口与出口节点 / entry & exit nodes ── */
function PipelineNodes() {
  const nodes = useMemo(() => {
    const positions: { pos: [number, number, number]; label: string; color: string }[] = [
      { pos: [-1.6, 0, 0], label: 'SIGNAL', color: '#a855f7' },
      { pos: [1.6, 0, 0], label: 'VERDICT', color: '#33e1ff' },
    ]
    return positions
  }, [])

  return (
    <>
      {nodes.map((n, i) => (
        <Float key={i} speed={1.5} rotationIntensity={0.1} floatIntensity={0.2}>
          <mesh position={n.pos}>
            <sphereGeometry args={[0.18, 16, 16]} />
            <meshBasicMaterial color={n.color} transparent opacity={0.7} />
          </mesh>
        </Float>
      ))}
    </>
  )
}

/* ── 连接线 / connector lines ── */
function Connectors() {
  const line = useMemo(() => {
    const points = []
    for (let i = 0; i <= 60; i++) {
      const t = i / 60
      const angle = Math.PI * t
      const x = -1.6 + t * 3.2
      const y = Math.sin(angle) * 0.3
      points.push(new THREE.Vector3(x, y, Math.cos(angle * 0.5) * 0.2))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points)
    return geo
  }, [])

  return (
    <mesh>
      <primitive object={line} attach="geometry" />
      <lineBasicMaterial color="#a78bfa" transparent opacity={0.25} />
    </mesh>
  )
}

/* ── 场景 / scene ── */
function PipelineScene() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[0, 2, 2]} intensity={40} color="#7c3aed" />
      <LightTunnel />
      <TunnelTrails />
      <SignalStream />
      <LedgerPlate />
      <PipelineNodes />
      <Connectors />
    </>
  )
}

function ResponsiveCanvas() {
  const { size } = useThree()
  const isSmall = size.width < 768
  return (
    <Suspense fallback={null}>
      <group scale={isSmall ? 0.6 : 1}>
        <PipelineScene />
      </group>
    </Suspense>
  )
}

/* ── 文案覆盖 / text overlay ── */
function PipelineText() {
  const { t } = useTranslation()
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-between py-12 text-center">
      <div className="reveal">
        <span className="eyebrow">{t('landing.plEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">
          {t('landing.plTitle')}
        </h2>
      </div>

      <div className="grid grid-cols-3 gap-8 text-center">
        {[
          { step: '01', label: '生成', en: 'Generated' },
          { step: '02', label: '执行', en: 'Executed' },
          { step: '03', label: '入账', en: 'Recorded' },
        ].map((s) => (
          <div key={s.step} className="reveal text-center">
            <div className="font-mono text-2xl font-bold text-prism-300">{s.step}</div>
            <div className="mt-1 text-sm text-slate-300">{s.label}</div>
            <div className="text-[10px] text-slate-500">{s.en}</div>
          </div>
        ))}
      </div>

      <div className="reveal text-center">
        <p className="text-sm text-slate-400">{t('landing.plFootnote')}</p>
        <div className="mt-2 font-mono text-lg font-bold text-prism-300">
          {t('landing.plCounter')}
        </div>
      </div>
    </div>
  )
}

export default function SignalPipeline() {
  return (
    <section id="pipeline" className="relative mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="relative h-[520px] sm:h-[580px] overflow-hidden rounded-card">
        {/* 3D canvas */}
        <div className="absolute inset-0 z-0 bg-ink-900">
          <Canvas
            camera={{ position: [0, 0.2, 2.8], fov: 55 }}
            dpr={[1, 1.5]}
            gl={{ antialias: true, alpha: true }}
          >
            <ResponsiveCanvas />
          </Canvas>
        </div>

        {/* 渐变遮罩 */}
        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-ink-950/60 via-transparent to-ink-950/60" />

        <PipelineText />
      </div>
    </section>
  )
}
