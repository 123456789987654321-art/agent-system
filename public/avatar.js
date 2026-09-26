import * as THREE from 'three';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';
import { RoomEnvironment } from './vendor/three/environments/RoomEnvironment.js';
import { MeshoptDecoder } from './vendor/meshoptimizer/meshopt_decoder.mjs';
import { relaxArms } from './avatar-rig.mjs?v=arms-fit-20260926';

// Self-hosted, CC0 human mesh. Voice state controls subtle expressions, not phoneme lip sync.
const host = document.getElementById('avatar-3d');
const stage = document.getElementById('avatarStage');
const caption = stage.querySelector('.avatar-caption');
const status = document.getElementById('avatarLoadStatus');
const retry = document.getElementById('avatarRetry');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(29, 1, .01, 30);
const pivot = new THREE.Group();
scene.add(pivot);
const ambient = new THREE.HemisphereLight(0xe9f4ff, 0x65788a, 1.6);
const key = new THREE.DirectionalLight(0xfff0de, 1.45);
key.position.set(-2, 3, 4);
const fill = new THREE.DirectionalLight(0xe4edff, .48);
fill.position.set(2, 1.5, 2);
const rim = new THREE.DirectionalLight(0xc4e8ff, 2.4);
rim.position.set(1, 2, -2);
scene.add(ambient, key, fill, rim);
let renderer, model, loading = false, visible = true, frames = 0;
let head, headRest, spine, spineRest, lastFrame = 0, nextBlink = 2.6, blinkStart = -1;
let yaw = 0, targetYaw = 0, dragStart = null, dragYaw = 0;
const expressiveMeshes = [];
const rotation = new THREE.Quaternion();
const euler = new THREE.Euler();

function theme() {
  const dark = document.body.classList.contains('dark-mode');
  if (renderer) renderer.toneMappingExposure = dark ? .90 : .94;
  ambient.intensity = dark ? .55 : .65;
  rim.intensity = dark ? 1.15 : .80;
  fill.color.set(dark ? 0xd2e1ff : 0xf1f3ff);
}

function resize() {
  const captionSpace = caption.offsetHeight + 20;
  stage.style.setProperty('--avatar-caption-space', captionSpace + 'px');
  if (!renderer) return;
  const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  // Restore the waist-up portrait while keeping the current tailored outfit.
  const distance = Math.max(1.9, 1.10 / camera.aspect);
  camera.position.set(0, 1.42, distance);
  camera.lookAt(0, 1.34, 0);
  camera.updateProjectionMatrix();
}

function fail(message) {
  stage.classList.remove('avatar-model-ready');
  stage.classList.add('avatar-model-failed');
  status.textContent = message;
  retry.hidden = false;
  window.HomeAvatar.ready = false;
}

function createRenderer() {
  renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true, powerPreference:'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-label', '三维数字管家，可拖动或使用左右方向键旋转，按回车复位');
  renderer.domElement.setAttribute('role','img');
  renderer.domElement.tabIndex = 0;
  host.appendChild(renderer.domElement);
  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(environment, .04);
  scene.environment = envMap.texture;
  environment.dispose();
  pmrem.dispose();
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); fail('三维显示已暂停，可重新加载');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    if (model) { stage.classList.remove('avatar-model-failed'); stage.classList.add('avatar-model-ready'); window.HomeAvatar.ready = true; }
  });
  renderer.domElement.addEventListener('pointerdown', event => {
    dragStart = event.clientX; dragYaw = targetYaw;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (dragStart !== null) targetYaw = THREE.MathUtils.clamp(dragYaw + (event.clientX-dragStart)*.008, -1.1, 1.1);
  });
  renderer.domElement.addEventListener('pointerup', () => {dragStart = null;});
  renderer.domElement.addEventListener('pointercancel', () => {dragStart = null;});
  renderer.domElement.addEventListener('lostpointercapture', () => {dragStart = null;});
  renderer.domElement.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Enter','Home'].includes(event.key)) return;
    event.preventDefault();
    targetYaw = event.key==='ArrowLeft' ? Math.max(-1.1,targetYaw-.15) : event.key==='ArrowRight' ? Math.min(1.1,targetYaw+.15) : 0;
  });
  theme(); resize();
}

async function loadModel() {
  if (loading || model) return;
  loading = true;
  retry.hidden = true;
  stage.classList.remove('avatar-model-failed');
  status.textContent = '正在加载三维形象';
  try {
    if (!renderer) createRenderer();
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync('./assets/home-assistant.glb?v=arms-fit-20260926', event => {
      if(event.total) status.textContent = '正在加载三维形象 ' + Math.round(event.loaded/event.total*100) + '%';
    });
    model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const scale = 1.72 / (box.max.y - box.min.y);
    model.scale.setScalar(scale);
    model.position.set(-(box.max.x+box.min.x)/2*scale, -box.min.y*scale, -(box.max.z+box.min.z)/2*scale);
    model.traverse(object => {
      if(object.isMesh) {
        object.frustumCulled = false;
        if(object.morphTargetDictionary)expressiveMeshes.push(object);
        const materials = Array.isArray(object.material)?object.material:[object.material];
        for(const material of materials) {
          material.envMapIntensity = .40;
          if(material.name.includes('body'))material.roughness = .67;
          if(material.name.includes('Tailored'))material.roughness = .9;
        }
      }
      if(object.name==='Head') {head=object;headRest=object.quaternion.clone();}
      if(object.name==='Spine2') {spine=object;spineRest=object.quaternion.clone();}
    });
    pivot.add(model);
    relaxArms(model);
    stage.classList.add('avatar-model-ready');
    window.HomeAvatar.ready = true;
    status.textContent = '三维形象已加载';
    resize();
  } catch(error) {
    console.warn('Digital human unavailable:', error.message);
    fail('暂时显示静态形象');
  } finally { loading=false; }
}

function morph(name, value) {
  for(const mesh of expressiveMeshes) {
    const index = mesh.morphTargetDictionary[name];
    if(index !== undefined)mesh.morphTargetInfluences[index]=value;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if(!renderer || !model || !visible || document.hidden || now-lastFrame<32) return;
  lastFrame=now; frames++;
  const t=now/1000, animate=!reducedMotion.matches && !stage.closest('.digital-human-card')?.classList.contains('agent-offline');
  const speaking=animate && stage.classList.contains('speaking');
  const listening=stage.classList.contains('listening');
  if(t>nextBlink && animate){blinkStart=t;nextBlink=t+3.2+Math.random()*3;}
  const blink=animate && t-blinkStart<.19?Math.sin((t-blinkStart)/.19*Math.PI):0;
  morph('eyeBlinkLeft',blink); morph('eyeBlinkRight',blink);
  morph('jawOpen',speaking ? .12+.20*Math.pow(Math.sin(t*10),2) : 0);
  morph('mouthFunnel',speaking ? .09*Math.pow(Math.sin(t*7),2) : 0);
  morph('mouthSmileLeft',.16); morph('mouthSmileRight',.16);
  morph('browInnerUp',listening ? .12 : .025);
  if(head) {
    euler.set(animate ? Math.sin(t*1.2)*.014+(listening?-.015:0) : 0, animate?Math.sin(t*.6)*.028:0, animate?Math.sin(t*.7)*.009:0);
    head.quaternion.copy(headRest).multiply(rotation.setFromEuler(euler));
  }
  if(spine)spine.quaternion.copy(spineRest).multiply(rotation.setFromEuler(euler.set(animate?Math.sin(t*1.5)*.004:0,0,0)));
  yaw += (targetYaw-yaw)*.15;
  pivot.rotation.y=yaw;
  renderer.render(scene,camera);
}

window.HomeAvatar = {
  ready:false,
  reset:()=>{targetYaw=0;},
  diagnostics:()=>({ready:!!model,meshes:expressiveMeshes.length,frames,yaw,visible,webgl:!!renderer,reducedMotion:reducedMotion.matches,jaw:expressiveMeshes.find(m=>m.morphTargetDictionary.jawOpen!==undefined)?.morphTargetInfluences[expressiveMeshes.find(m=>m.morphTargetDictionary.jawOpen!==undefined).morphTargetDictionary.jawOpen] || 0}),
  framing:()=>{if(!model)return null;const bounds=new THREE.Box3().setFromObject(model),points=[];for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])points.push(new THREE.Vector3(x,y,z).project(camera));return {minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};},
  capture:()=>{if(!renderer||!model)return null;renderer.render(scene,camera);return renderer.domElement.toDataURL('image/png');}
};
retry.addEventListener('click',()=>{if(model)location.reload();else loadModel();});
new ResizeObserver(resize).observe(stage);
new ResizeObserver(resize).observe(host);
new ResizeObserver(resize).observe(caption);
new MutationObserver(theme).observe(document.body,{attributes:true,attributeFilter:['class']});
new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;}).observe(host);
requestAnimationFrame(frame);
loadModel();
