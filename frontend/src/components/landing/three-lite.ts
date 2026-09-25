// three 的按需出口 / the subset of three the landing page actually uses
//
// 落地页的 3D（LandingSpace + BackdropAir / BackdropShards，以及桌面的 PhoneGL）原来都是
// `await import('three')` 整包，再把命名空间对象传来传去——命名空间一旦「逃逸」，Rollup
// 就只能把 three 的全部导出都留下。改成动态 import 这个文件：这里只列真正用到的类，
// three 里其余的东西（其他材质、加载器、动画、音频……）才能被摇掉。
// 新用到一个 three 的类，先加到这里；漏加会在 tsc 里直接报错（类型取自本文件）。
// The landing 3D (LandingSpace with BackdropAir / BackdropShards, plus the
// desktop PhoneGL) used to `await import('three')` whole and pass the namespace
// object around. Once a namespace escapes, Rollup has to keep every export of
// three. Dynamically importing this file instead lists only the classes in use,
// so the rest of three (other materials, loaders, animation, audio…) can be
// tree-shaken. Add a class here before using it; forgetting fails tsc, since
// the THREE parameter types come from this file.
import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  FogExp2,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three'

// 显式拼成一个对象，而不是 `export { … } from 'three'` 的纯转发：纯转发的模块自己没有
// 代码，Rollup 会把这个「空」chunk 并进别的共享 chunk（实测并进了 Layout 与落地页共用的
// 节日轻壳 chunk），结果那个首屏就要用的 chunk 静态 import 了整个 three 块。有了这段
// 对象字面量，本文件就是一个独立的、只被动态 import 的小 chunk。
// Built as an explicit object rather than a bare `export { … } from 'three'`: a
// pure re-export module has no code of its own, and Rollup folds that "empty"
// chunk into some other shared chunk (in practice the festival-shell chunk that
// Layout and the landing page share), which then statically imported the whole
// three chunk on the first screen. The object literal keeps this file its own
// small chunk, reached only through dynamic import.
export const THREE = {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  FogExp2,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
}

export type ThreeLite = typeof THREE
