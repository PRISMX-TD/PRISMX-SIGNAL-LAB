// 极光流体背景 / aurora fluid background
// 一个全屏 GLSL 片元着色器：simplex 噪声 + 域扭曲(domain warping) + FBM，
// 生成缓慢流动、有机的紫→深蓝→青色雾。近黑底、克制调色板，靠光影质感而非
// 具象几何体体现高级感——这是当代高端落地页(Linear/Stripe/Awwwards)的共识做法。
// 鼠标带来极轻微的流场偏移。移动端降半分辨率，reduced-motion / 无 WebGL 走静态兜底。
import { useMemo, useRef, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

type Pointer = React.MutableRefObject<{ x: number; y: number; active: number }>

// 帧率哨兵：低于 MIN_FPS 视为设备带不动着色器，切 CSS 降级并在本次会话内记住，
// 避免用户返回首页时再卡一次 / frame-rate sentinel: below MIN_FPS we swap to the
// CSS fallback and remember the verdict for this session
const SLOW_KEY = 'prismx:webgl-slow'
const MIN_FPS = 12

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uRes;
  uniform vec2 uMouse;     // 光标世界坐标 -1..1 / pointer in clip-ish space
  uniform float uPointer;  // 光标扰动强度 0..1 / ripple strength
  uniform float uScroll;   // 滚动进度 0..1 / scroll progress

  // simplex noise (Ashima) —————————————————————————————
  vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C=vec2(1.0/6.0,1.0/3.0);
    const vec4 D=vec4(0.0,0.5,1.0,2.0);
    vec3 i=floor(v+dot(v,C.yyy));
    vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz);
    vec3 l=1.0-g;
    vec3 i1=min(g.xyz,l.zxy);
    vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx;
    vec3 x2=x0-i2+C.yyy;
    vec3 x3=x0-D.yyy;
    i=mod289(i);
    vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
      +i.y+vec4(0.0,i1.y,i2.y,1.0))
      +i.x+vec4(0.0,i1.x,i2.x,1.0));
    float n_=0.142857142857;
    vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.0*floor(p*ns.z*ns.z);
    vec4 x_=floor(j*ns.z);
    vec4 y_=floor(j-7.0*x_);
    vec4 x=x_*ns.x+ns.yyyy;
    vec4 y=y_*ns.x+ns.yyyy;
    vec4 h=1.0-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy);
    vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.0+1.0;
    vec4 s1=floor(b1)*2.0+1.0;
    vec4 sh=-step(h,vec4(0.0));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
    vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x);
    vec3 p1=vec3(a0.zw,h.y);
    vec3 p2=vec3(a1.xy,h.z);
    vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
    vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
    m=m*m;
    return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }

  // FBM ——————————————————————————————————————————————
  float fbm(vec3 p){
    float f=0.0, a=0.5;
    for(int i=0;i<5;i++){ f+=a*snoise(p); p*=2.02; a*=0.5; }
    return f;
  }

  void main(){
    vec2 uv=vUv;
    float aspect=uRes.x/max(uRes.y,1.0);
    vec2 p=(uv-0.5)*vec2(aspect,1.0)*2.2;

    // 滚动只极轻微影响时间流速，不产生空间位移 / scroll barely modulates time flow
    float flow=1.0+uScroll*0.08;
    float t=uTime*0.2*flow;

    // 光标局部扰动涟漪 / localized pointer ripple (not a global shift)
    vec2 mp=uMouse*vec2(aspect,1.0)*1.1;
    float md=length(p-mp);
    float ripple=exp(-md*md*1.6)*uPointer;   // 高斯衰减的局部隆起（干涉已调弱）
    p+=normalize(p-mp+1e-4)*ripple*0.16;

    // domain warping —— 关键：让噪声看起来是流体而非数学纹路
    float w1=snoise(vec3(p*0.4+vec2(3.7,2.3), t*0.6));
    float w2=snoise(vec3(p*0.5+vec2(-1.5,4.1), t*0.7+5.0));
    vec2 warped=p+vec2(w1,w2)*(0.55+ripple*0.22);

    float n1=fbm(vec3(warped*0.7, t));
    float n2=fbm(vec3(warped*0.45-0.5, t*0.6+10.0));
    float n3=snoise(vec3(warped*0.35+vec2(n1,n2)*0.15, t*0.4));

    // 克制调色板：近黑底 → 深紫 → 靛蓝 → 青 / restrained palette
    vec3 base   = vec3(0.020, 0.012, 0.047);
    vec3 violet = vec3(0.376, 0.106, 0.706);
    vec3 indigo = vec3(0.114, 0.094, 0.435);
    vec3 cyan   = vec3(0.078, 0.494, 0.588);
    vec3 teal   = vec3(0.055, 0.365, 0.408);

    // 调色板随滚动迁移：顶部偏紫，中段偏靛蓝，底部偏青 / palette shifts with scroll
    vec3 warm = mix(violet, indigo, smoothstep(0.0,0.5,uScroll));
    vec3 cool = mix(cyan, teal, smoothstep(0.5,1.0,uScroll));

    vec3 col=base;
    col=mix(col,indigo, smoothstep(-0.2,0.7,n1)*0.7);
    col=mix(col,warm,   smoothstep(0.0,0.9,n2)*0.65);
    col=mix(col,cool,   smoothstep(0.35,1.0,n3)*(0.32+uScroll*0.12));

    // 光标处提亮，像被拨亮的流体 / brighten around pointer
    col+=cool*ripple*0.28;

    // 中心稍亮、边缘压暗（暗角）/ soft center glow + vignette
    float d=length((uv-0.5)*vec2(aspect,1.0));
    col+=violet*smoothstep(0.9,0.0,d)*0.10;
    col*=smoothstep(1.35,0.3,d);

    // 细颗粒，破除色带 / dither to kill banding
    float g=fract(sin(dot(uv,vec2(12.9898,78.233)))*43758.5453);
    col+=(g-0.5)*0.015;

    gl_FragColor=vec4(col,1.0);
  }
`

function AuroraPlane({ pointer, scroll, lite, frames }: { pointer: Pointer; scroll: React.MutableRefObject<number>; lite: boolean; frames: React.MutableRefObject<number> }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const { size, viewport } = useThree()
  const mouse = useRef(new THREE.Vector2(0, 0))

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uPointer: { value: 0 },
      uScroll: { value: 0 },
    }),
    []
  )

  useEffect(() => {
    uniforms.uRes.value.set(size.width * viewport.dpr, size.height * viewport.dpr)
  }, [size, viewport, uniforms])

  useFrame((_, delta) => {
    if (!mat.current) return
    frames.current += 1
    // 移动端限速，减轻 GPU / slow down on lite
    uniforms.uTime.value += delta * (lite ? 0.6 : 1)
    // 光标位置平滑跟随 / smooth follow pointer
    mouse.current.x += (pointer.current.x - mouse.current.x) * 0.08
    mouse.current.y += (-pointer.current.y - mouse.current.y) * 0.08
    uniforms.uMouse.value.copy(mouse.current)
    // 扰动强度：移动时被拉高(在外部置位)，此处持续衰减 / decay ripple
    uniforms.uPointer.value += (pointer.current.active - uniforms.uPointer.value) * 0.06
    pointer.current.active *= 0.9
    // 滚动进度极慢逼近，仅做超长周期调色板漂移 / barely-there scroll response
    uniforms.uScroll.value += (scroll.current - uniforms.uScroll.value) * 0.015
  })

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={mat} vertexShader={vertexShader} fragmentShader={fragmentShader} uniforms={uniforms} depthWrite={false} />
    </mesh>
  )
}

/* ── 静态兜底（无 WebGL / reduced-motion）/ static fallback ── */
function CssFallback() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#05030c]">
      <div className="absolute left-[30%] top-[35%] h-[60vh] w-[60vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600/25 blur-[120px]" />
      <div className="absolute left-[68%] top-[60%] h-[50vh] w-[50vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/15 blur-[120px]" />
      <div className="absolute left-1/2 top-1/2 h-[45vh] w-[45vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-[130px]" />
    </div>
  )
}

export default function PrismScene() {
  const pointer = useRef({ x: 0, y: 0, active: 0 })
  const scroll = useRef(0)
  const frames = useRef(0)
  const [enabled, setEnabled] = useState(true)
  const [lite, setLite] = useState(false)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const mobile = window.matchMedia('(max-width: 768px)').matches
    // 本会话已判定过"带不动"就不再重试 / already flagged slow this session
    let slow = false
    try {
      slow = sessionStorage.getItem(SLOW_KEY) === '1'
    } catch {
      slow = false
    }
    let webgl = false
    let software = false
    try {
      const c = document.createElement('canvas')
      const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
      webgl = !!gl
      if (gl) {
        // 软件渲染器（SwiftShader/llvmpipe 等，常见于虚拟机/远程桌面）跑不动
        // 全屏 FBM，首帧就可能把 GPU 进程整个卡死——渲染前就判定降级
        // software rasterizers can freeze the GPU process on the very first
        // frame of this shader — bail out before rendering anything
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
        software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    } catch {
      webgl = false
    }
    if (!webgl || software || slow || reduce) setEnabled(false)
    if (mobile) setLite(true)
  }, [])

  // 帧率哨兵：WebGL 存在但实际跑不动（老集显/远程桌面等）时自动切 CSS 降级
  // frame-rate sentinel: WebGL that exists but crawls falls back to CSS
  useEffect(() => {
    if (!enabled) return
    let timer: number
    let passes = 0
    let last = { frames: frames.current, at: performance.now() }
    const check = () => {
      const now = performance.now()
      if (document.hidden) {
        // 后台标签页 rAF 被浏览器节流，测出来必然接近 0 帧，不作数
        // rAF throttles in hidden tabs — retest once the tab is visible
        last = { frames: frames.current, at: now }
        timer = window.setTimeout(check, 2200)
        return
      }
      const fps = ((frames.current - last.frames) * 1000) / Math.max(now - last.at, 1)
      last = { frames: frames.current, at: now }
      if (fps < MIN_FPS) {
        try {
          sessionStorage.setItem(SLOW_KEY, '1')
        } catch {
          // 隐私模式写不进 sessionStorage 就只降级本次 / private mode: degrade without persisting
        }
        setEnabled(false)
        return
      }
      // 连续两次达标即认定设备没问题，停止监测 / two healthy passes end the watch
      if (++passes < 2) timer = window.setTimeout(check, 2200)
    }
    timer = window.setTimeout(check, 2200)
    return () => window.clearTimeout(timer)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let last = { x: 0, y: 0 }
    const onMove = (e: PointerEvent) => {
      const x = (e.clientX / window.innerWidth) * 2 - 1
      const y = (e.clientY / window.innerHeight) * 2 - 1
      // 移动速度越快，扰动越强 / faster move = stronger ripple
      const v = Math.min(1, (Math.abs(x - last.x) + Math.abs(y - last.y)) * 6)
      pointer.current.x = x
      pointer.current.y = y
      pointer.current.active = Math.max(pointer.current.active, 0.3 + v * 0.3)
      last = { x, y }
    }
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      scroll.current = max > 0 ? Math.min(1, window.scrollY / max) : 0
    }
    onScroll()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('scroll', onScroll)
    }
  }, [enabled])

  if (!enabled) return <CssFallback />

  return (
    <Canvas
      className="!fixed inset-0"
      dpr={lite ? 1 : [1, 1.5]}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
      frameloop="always"
    >
      <AuroraPlane pointer={pointer} scroll={scroll} lite={lite} frames={frames} />
    </Canvas>
  )
}
