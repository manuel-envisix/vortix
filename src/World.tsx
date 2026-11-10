import { Component, memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { projects as demoProjects, deliveryStatus, type Agent, type Project } from './simulation';
import { refreshAgentHitBounds } from './agentPicking';

export type Focus = { agentId?: string; projectId?: number; key: number };
type Position = [number, number, number];
type Link = { id: string; from: Position; to: Position; color: string };
type Layout = { positions: Map<string, Position>; clusters: { id: number; position: Position; count: number; radius: number }[] };
const symbols: Record<string, string> = { coding: '</>', testing: '✓', reviewing: '◇', researching: '⌕', waiting: 'Ⅱ', delegating: '⑂' };
const colors = { working: '#65d5fa', waiting: '#e4bf7b', complete: '#1de9b6', error:'#ff7b79', unknown:'#7b999b' };

// Rebuilt only when fleet membership changes, never for progress updates.
function createLayout(agents: Agent[]): Layout {
  const ids = [...new Set(agents.map(a => a.projectId))], positions = new Map<string, Position>();
  const clusters = ids.map((id, i) => {
    const angle = i / ids.length * Math.PI * 2 - .6;
    const position: Position = [Math.cos(angle) * 8, 0, Math.sin(angle) * 8];
    const group = agents.filter(a => a.projectId === id);
    group.forEach((a, n) => {
      const r = group.length === 1 ? .65 : Math.sqrt(n + 1) * .85;
      positions.set(a.id, [position[0] + Math.cos(n * 2.39996) * r, Math.sin(n * 1.8) * .85 + .7, position[2] + Math.sin(n * 2.39996) * r]);
    });
    return { id, position, count: group.length, radius: Math.max(2, Math.sqrt(group.length) * .85 + .5) };
  });
  return { positions, clusters };
}

const Atmosphere = memo(function Atmosphere({ reduced, effects }: { reduced: boolean; effects: boolean }) {
  const stars = useRef<THREE.Points>(null);
  useFrame((_, dt) => { if (stars.current && !reduced) stars.current.rotation.y += Math.min(dt, .05) * .006; });
  return <><color attach="background" args={['#061316']} /><fog attach="fog" args={['#061316', 28, 80]} /><ambientLight intensity={.9} /><pointLight position={[0, 7, 0]} intensity={35} color="#1de9b6" /><directionalLight position={[5, 12, 6]} intensity={2} />
    {effects && <Stars ref={stars} radius={65} depth={35} count={600} factor={1.6} fade speed={0} />}
    <gridHelper args={[100, 80, '#103333', '#091e23']} position={[0, -1.2, 0]} /></>;
});

const Core = memo(function Core({ reduced }: { reduced: boolean }) {
  const crystal = useRef<THREE.Mesh>(null), orbit = useRef<THREE.Group>(null);
  useFrame((_, dt) => { if (reduced) return; const delta = Math.min(dt, .05); if (crystal.current) { crystal.current.rotation.y += delta * .16; crystal.current.rotation.z += delta * .055; } if (orbit.current) orbit.current.rotation.z -= delta * .09; });
  return <group position={[0, .4, 0]}>
    <mesh ref={crystal}><icosahedronGeometry args={[.9, 0]} /><meshStandardMaterial color="#9dffe4" emissive="#00c2b8" emissiveIntensity={1} wireframe /></mesh>
    <mesh><icosahedronGeometry args={[.46, 0]} /><meshBasicMaterial color="#1de9b6" transparent opacity={.22} wireframe /></mesh>
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh><torusGeometry args={[1.45, .014, 6, 96]} /><meshBasicMaterial color="#1de9b6" transparent opacity={.5} /></mesh>
      <group ref={orbit}>{[0, 2.1, 4.2].map(angle => <mesh rotation={[0, 0, angle]} key={angle}><torusGeometry args={[1.85, .027, 6, 32, 1.2]} /><meshBasicMaterial color="#7affe0" transparent opacity={.7} /></mesh>)}</group>
      <mesh rotation={[.5, .25, 0]}><torusGeometry args={[1.62, .012, 6, 96]} /><meshBasicMaterial color="#65d5fa" transparent opacity={.5} /></mesh>
    </group>
    <Html position={[0, 1.8, 0]} center style={{ pointerEvents: 'none' }}><div className="core-label">VORTIX<span>NEURAL COMMAND CORE</span></div></Html>
  </group>;
});

const NetworkGeometry = memo(function NetworkGeometry({ layout, links, projects }: { layout: Layout; links: Link[];projects:Project[] }) {
  const rings=useRef<THREE.InstancedMesh>(null),arcs=useRef<THREE.InstancedMesh>(null);
  const network=useMemo(()=>{
    const edges=[...layout.clusters.map(c=>({from:[0,0,0] as Position,to:c.position,color:projects[c.id].color})),...links];
    const positions:number[]=[],colors:number[]=[],distances:number[]=[];const color=new THREE.Color();
    edges.forEach(e=>{positions.push(...e.from,...e.to);color.set(e.color);colors.push(color.r,color.g,color.b,color.r,color.g,color.b);distances.push(0,Math.hypot(e.to[0]-e.from[0],e.to[1]-e.from[1],e.to[2]-e.from[2]));});
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('lineDistance',new THREE.Float32BufferAttribute(distances,1));return geometry;
  },[layout,links,projects]);
  useEffect(()=>()=>network.dispose(),[network]);
  useLayoutEffect(()=>{const object=new THREE.Object3D(),color=new THREE.Color();layout.clusters.forEach((c,i)=>{object.position.set(...c.position);object.rotation.set(-Math.PI/2,0,0);object.scale.setScalar(c.radius);object.updateMatrix();rings.current?.setMatrixAt(i,object.matrix);object.rotation.z=.4;object.scale.setScalar(c.radius+.13);object.updateMatrix();arcs.current?.setMatrixAt(i,object.matrix);color.set(projects[c.id].color);rings.current?.setColorAt(i,color);arcs.current?.setColorAt(i,color);});for(const mesh of [rings.current,arcs.current]){if(mesh){mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}}},[layout,projects]);
  return <>
    <lineSegments geometry={network} dispose={null}><lineDashedMaterial vertexColors transparent opacity={.25} dashSize={.12} gapSize={.15}/></lineSegments>
    <instancedMesh ref={rings} args={[undefined,undefined,layout.clusters.length]} frustumCulled={false}><torusGeometry args={[1,.005,4,64]}/><meshBasicMaterial transparent opacity={.4}/></instancedMesh>
    <instancedMesh ref={arcs} args={[undefined,undefined,layout.clusters.length]} frustumCulled={false}><torusGeometry args={[1,.008,4,24,1.1]}/><meshBasicMaterial transparent opacity={.65}/></instancedMesh>
    {layout.clusters.map(c=><group key={c.id} position={c.position}><Html position={[0,-.7,c.radius+.5]} center style={{pointerEvents:'none'}}><div className="project-world-label" style={{color:projects[c.id].color}}>{projects[c.id].name}<span>{String(c.count).padStart(2,'0')} AGENTS · {projects[c.id].short}</span></div></Html></group>)}
  </>;
});

const EnergyFlow = memo(function EnergyFlow({ links, reduced }: { links: Link[]; reduced: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null), dummy = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => { if (!mesh.current) return; links.forEach((l, i) => mesh.current!.setColorAt(i, new THREE.Color(l.color))); if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true; }, [links]);
  useFrame(({ clock }) => {
    if (!mesh.current) return;
    links.forEach((l, i) => { const t = reduced ? .5 : (clock.elapsedTime * .18 + i * .19) % 1; dummy.position.set(l.from[0] + (l.to[0] - l.from[0]) * t, l.from[1] + (l.to[1] - l.from[1]) * t, l.from[2] + (l.to[2] - l.from[2]) * t); dummy.scale.setScalar(.055); dummy.updateMatrix(); mesh.current!.setMatrixAt(i, dummy.matrix); });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return links.length ? <instancedMesh ref={mesh} args={[undefined, undefined, links.length]} key={links.length} frustumCulled={false}><sphereGeometry args={[1, 6, 6]} /><meshBasicMaterial toneMapped={false} /></instancedMesh> : null;
});

function Fleet({ agents, layout, selected, onSelect, reduced }: { agents: Agent[]; layout: Layout; selected?: string; onSelect: (id: string) => void; reduced: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const camera = useThree(s => s.camera);
  const transform = useMemo(() => ({ matrix: new THREE.Matrix4(), scale: new THREE.Vector3(.82,.82,.82), position: new THREE.Vector3(), last: new THREE.Quaternion(0,0,0,0) }), []);
  const resources = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 28px sans-serif';
    [...Object.values(symbols), '✓', '◇', '↗', '◆', '×', '?', '◉', '✓', '!', '?', '?'].forEach((s, i) => ctx.fillText(s, i * 64 + 32, 34));
    const atlas = new THREE.CanvasTexture(canvas); atlas.minFilter = THREE.LinearFilter; atlas.generateMipmaps = false;
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('telemetry', new THREE.InstancedBufferAttribute(new Float32Array(100 * 4), 4));
    geometry.setAttribute('signalColor', new THREE.InstancedBufferAttribute(new Float32Array(100 * 3), 3));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, uniforms: { atlas: { value: atlas } },
      vertexShader: `attribute vec4 telemetry; attribute vec3 signalColor; varying vec2 vUv; varying vec4 vStatus; varying vec3 vColor;
        void main(){vUv=uv;vStatus=telemetry;vColor=signalColor;vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);center.xy+=position.xy*.82;gl_Position=projectionMatrix*center;}`,
      fragmentShader: `uniform sampler2D atlas; varying vec2 vUv; varying vec4 vStatus; varying vec3 vColor;
        float glyph(vec2 p,float index){if(p.x<0.||p.x>1.||p.y<0.||p.y>1.)return 0.;return texture2D(atlas,vec2((p.x+index)/32.,p.y)).a;}
        void main(){vec2 p=vUv-vec2(.5,.59);float d=length(p);float ring=1.-smoothstep(.012,.025,abs(d-.29));float disk=1.-smoothstep(.275,.29,d);float icon=glyph(p/.4+.5,vStatus.x);vec3 c=mix(vec3(.025,.08,.09),vColor,max(ring,icon));float a=max(disk*.95,max(ring,icon));
          float selectedRing=(1.-smoothstep(.008,.016,abs(d-.36)))*vStatus.w;c=mix(c,vColor,selectedRing);a=max(a,selectedRing);
          vec2 l=(vUv-vec2(.32,.12))/.2+.5;vec2 r=(vUv-vec2(.68,.12))/.2+.5;float left=glyph(l,7.+vStatus.y);float right=glyph(r,12.+vStatus.z);
          vec3 pr=vStatus.y<.5?vec3(.45,.58,.58):vStatus.y<1.5?vec3(.4,.75,1.):vStatus.y<2.5?vec3(.74,.6,1.):vStatus.y<3.5?vec3(1.,.45,.45):vec3(.45,.58,.58);vec3 ci=vStatus.z<.5?vec3(.9,.75,.48):vStatus.z<1.5?vec3(.1,.91,.71):vStatus.z<2.5?vec3(1.,.45,.45):vec3(.45,.58,.58);c=mix(c,pr,left);c=mix(c,ci,right);a=max(a,max(left,right));if(a<.01)discard;gl_FragColor=vec4(c,a);}`
    });
    return { geometry, material, atlas };
  }, []);
  // Resource lifetime follows this component, not the number of simulation ticks.
  useEffect(() => () => { resources.geometry.dispose(); resources.material.dispose(); resources.atlas.dispose(); }, [resources]);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    const telemetry = resources.geometry.getAttribute('telemetry') as THREE.InstancedBufferAttribute;
    const signals = resources.geometry.getAttribute('signalColor') as THREE.InstancedBufferAttribute;
    agents.forEach((a, i) => {
      const p = layout.positions.get(a.id)!; transform.position.set(...p); matrix.compose(transform.position, camera.quaternion, transform.scale); mesh.current!.setMatrixAt(i, matrix);
      const status = deliveryStatus(a); color.set(colors[a.status]); signals.setXYZ(i, color.r, color.g, color.b);
      telemetry.setXYZW(i, a.status === 'complete' ? 6 : a.activityKnown===false?16:Object.keys(symbols).indexOf(a.activity), ['draft','open','merged','closed','unknown'].indexOf(status.pr), status.ci==='passed'?1:status.ci==='failed'?2:status.ci==='unknown'?3:0, a.id === selected ? 1 : 0);
    });
    mesh.current.count = agents.length; mesh.current.instanceMatrix.needsUpdate = true; telemetry.needsUpdate = true; signals.needsUpdate = true;
    refreshAgentHitBounds(mesh.current);
  }, [agents, layout, selected, resources]);
  useFrame(() => {
    if (!mesh.current || transform.last.equals(camera.quaternion)) return;
    transform.last.copy(camera.quaternion);
    agents.forEach((a,i) => { transform.position.set(...layout.positions.get(a.id)!); transform.matrix.compose(transform.position,camera.quaternion,transform.scale); mesh.current!.setMatrixAt(i,transform.matrix); });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[resources.geometry, resources.material, 100]} dispose={null} frustumCulled={false} onPointerOver={()=>{document.body.style.cursor='pointer';}} onPointerOut={()=>{document.body.style.cursor='';}} onClick={e => { if(e.delta>5)return;e.stopPropagation(); if (e.instanceId !== undefined&&agents[e.instanceId]) onSelect(agents[e.instanceId].id); }} />;
}

// Budget background animation to 30 Hz. Camera interactions can request extra frames.
function FrameBudget({ reduced }: { reduced: boolean }) {
  const invalidate = useThree(s => s.invalidate);
  const gl = useThree(s => s.gl);
  const samples = useRef({ started: 0, frames: 0, longest: 0 });
  useFrame((_, dt) => {
    const now = performance.now(), s = samples.current;
    if (!s.started) s.started = now;
    s.frames++; s.longest = Math.max(s.longest, dt * 1000);
    if (now - s.started >= 2000) {
      gl.domElement.dataset.renderFps = (s.frames * 1000 / (now - s.started)).toFixed(1);
      gl.domElement.dataset.maxFrameIntervalMs = s.longest.toFixed(1);
      gl.domElement.dataset.drawCalls = String(gl.info.render.calls);
      s.started = now; s.frames = 0; s.longest = 0;
    }
  });
  useEffect(() => {
    let inView = true;
    const observer = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? false; if (inView) invalidate(); });
    observer.observe(gl.domElement);
    const visible = () => document.visibilityState === 'visible' && inView;
    const timer = reduced ? undefined : setInterval(() => { if (visible()) invalidate(); }, 1000 / 30);
    const resume = () => { if (visible()) invalidate(); };
    document.addEventListener('visibilitychange',resume);
    return () => { clearInterval(timer); observer.disconnect(); document.removeEventListener('visibilitychange',resume); };
  }, [invalidate, reduced, gl]);
  return null;
}

function Camera({ focus, layout, presentation, reduced, onManual }: { focus: Focus; layout: Layout; presentation: boolean; reduced: boolean; onManual: () => void }) {
  const controls = useRef<any>(null), { camera } = useThree(), goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  useEffect(() => { const p = (focus.agentId ? layout.positions.get(focus.agentId) : layout.clusters.find(c => c.id === focus.projectId)?.position) ?? [0, 0, 0]; const close = focus.agentId || focus.projectId !== undefined; goal.current = { target: new THREE.Vector3(...p), pos: new THREE.Vector3(p[0] + (close ? 5 : 17), close ? 8 : 20, p[2] + (close ? 7 : 22)) }; }, [focus, layout]);
  useFrame((_, dt) => { if (!goal.current || !controls.current) return; const factor = reduced ? 1 : 1 - Math.exp(-Math.min(dt, .05) * 4); camera.position.lerp(goal.current.pos, factor); controls.current.target.lerp(goal.current.target, factor); if (camera.position.distanceTo(goal.current.pos) < .03) goal.current = null; controls.current.update(); });
  return <OrbitControls ref={controls} makeDefault minDistance={3} maxDistance={45} maxPolarAngle={Math.PI / 2.05} autoRotate={presentation && !reduced} autoRotateSpeed={.25} onStart={() => { goal.current = null; onManual(); }} />;
}

type WorldProps = { projects?:Project[];all: Agent[]; visible: Agent[]; selected?: string; onSelect: (id: string) => void; focus: Focus; presentation: boolean; reduced: boolean; effects: boolean; onManual: () => void };
function Scene({ projects=demoProjects,all, visible, selected, onSelect, focus, presentation, reduced, effects, onManual }: WorldProps) {
  const membership = all.map(a => `${a.id}:${a.projectId}`).join(',');
  const layout = useMemo(() => createLayout(all), [membership]);
  const visibleIds = visible.map(a => a.id).join(',');
  const links = useMemo(() => { const ids = new Set(visible.map(a => a.id)); return visible.filter(a => a.parentId && ids.has(a.parentId)).map(a => ({ id: a.id, from: layout.positions.get(a.parentId!)!, to: layout.positions.get(a.id)!, color: projects[a.projectId].color })); }, [layout, visibleIds]);
  const inspected = visible.find(a => a.id === selected);
  return <><FrameBudget reduced={reduced} /><Atmosphere reduced={reduced} effects={effects} /><Core reduced={reduced} /><NetworkGeometry projects={projects} layout={layout} links={links} />
    {effects && <EnergyFlow links={links} reduced={reduced} />}<Fleet agents={visible} layout={layout} selected={selected} onSelect={onSelect} reduced={reduced} />
    {inspected && <Html position={layout.positions.get(inspected.id)!} center zIndexRange={[10,0]} style={{pointerEvents:'none'}}><div className="selected-node-label"><b>{inspected.name}</b><span>{inspected.status} · {inspected.activity}</span><small>PR {deliveryStatus(inspected).pr} · CI {deliveryStatus(inspected).ci}</small></div></Html>}
    <Camera focus={focus} layout={layout} presentation={presentation} reduced={reduced} onManual={onManual} /></>;
}
class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } render() { return this.state.failed ? this.props.fallback : this.props.children; } }
export default function World(props: WorldProps) {
  const fallback = <div className="fallback"><h2>Fleet overview</h2><p>3D is unavailable. Your agents and inspector are still accessible.</p>{props.visible.map(a => <button key={a.id} onClick={() => props.onSelect(a.id)}>{a.name} · {a.status} · PR {deliveryStatus(a).pr} · CI {deliveryStatus(a).ci}</button>)}</div>;
  return <Boundary fallback={fallback}><Canvas frameloop="demand" camera={{ position: [17, 20, 22], fov: 44 }} dpr={1} gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }} fallback={fallback}><Scene {...props} /></Canvas></Boundary>;
}
