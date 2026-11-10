import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstancedMesh,PlaneGeometry,MeshBasicMaterial,Matrix4,Raycaster,Vector3 } from 'three';
import { refreshAgentHitBounds } from './agentPicking';
test('agents arriving after an empty live scene remain clickable',()=>{
 const mesh=new InstancedMesh(new PlaneGeometry(1,1),new MeshBasicMaterial(),100);mesh.count=0;mesh.computeBoundingSphere();
 mesh.setMatrixAt(0,new Matrix4().makeTranslation(20,0,0));mesh.count=1;mesh.updateMatrixWorld(true);
 const ray=new Raycaster(new Vector3(20,0,5),new Vector3(0,0,-1));assert.equal(ray.intersectObject(mesh).length,0);
 refreshAgentHitBounds(mesh);assert.equal(ray.intersectObject(mesh)[0]?.instanceId,0);mesh.geometry.dispose();mesh.material.dispose();
});
test('picking follows a changed layout and ignores an emptied fleet',()=>{
 const mesh=new InstancedMesh(new PlaneGeometry(1,1),new MeshBasicMaterial(),2);mesh.count=1;mesh.setMatrixAt(0,new Matrix4());refreshAgentHitBounds(mesh);
 mesh.setMatrixAt(0,new Matrix4().makeTranslation(-15,2,0));refreshAgentHitBounds(mesh);mesh.updateMatrixWorld(true);
 const ray=new Raycaster(new Vector3(-15,2,5),new Vector3(0,0,-1));assert.equal(ray.intersectObject(mesh)[0]?.instanceId,0);
 mesh.count=0;refreshAgentHitBounds(mesh);assert.equal(ray.intersectObject(mesh).length,0);mesh.geometry.dispose();mesh.material.dispose();
});
