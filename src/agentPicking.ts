import type { InstancedMesh } from 'three';

// Three.js caches these bounds. A live fleet starts empty, so refresh after each
// membership/layout update or its raycast can keep using the initial empty sphere.
export function refreshAgentHitBounds(mesh:InstancedMesh){
  mesh.boundingSphere=null;
  mesh.computeBoundingSphere();
}
