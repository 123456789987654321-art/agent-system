const fs=require('fs');
const {NodeIO}=require('../output/avatar-tools/node_modules/@gltf-transform/core');
const {ALL_EXTENSIONS}=require('../output/avatar-tools/node_modules/@gltf-transform/extensions');
const {prune,dedup,textureCompress,meshopt}=require('../output/avatar-tools/node_modules/@gltf-transform/functions');
const THREE=require('../output/avatar-tools/node_modules/three');
const sharp=require('../output/avatar-tools/node_modules/sharp');
// Rebuild from the locally retained CC0 source assets; see public/assets/BUILD.md.
process.chdir(require('node:path').resolve(__dirname, '..'));
const output=process.argv[2] || 'public/assets/home-assistant.glb';
const dir='output/fullbody-review/';
function obj(file){
 const positions=[],uvs=[],faces=[];
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  const a=line.trim().split(/\s+/),type=a.shift();
  if(type==='v')positions.push(a.map(Number));
  if(type==='vt')uvs.push(a.map(Number));
  if(type==='f')faces.push(a.map(t=>t.split('/').map(v=>Number(v)-1)));
 }
 return {positions,uvs,faces};
}
function tree(points,depth=0){
 if(!points.length)return null;
 const axis=depth%3;points.sort((a,b)=>a.p[axis]-b.p[axis]);const mid=points.length>>1;
 return {item:points[mid],axis,left:tree(points.slice(0,mid),depth+1),right:tree(points.slice(mid+1),depth+1)};
}
function nearest(root,p,count=6){
 const best=[];
 function visit(node){
  if(!node)return;
  const d=node.item.p.reduce((s,x,i)=>s+(x-p[i])**2,0);
  if(best.length<count||d<best[best.length-1].d){best.push({item:node.item,d});best.sort((a,b)=>a.d-b.d);if(best.length>count)best.pop();}
  const delta=p[node.axis]-node.item.p[node.axis];visit(delta<0?node.left:node.right);
  if(best.length<count||delta*delta<best[best.length-1].d)visit(delta<0?node.right:node.left);
 }
 visit(root);return best;
}
function parseClothes(file){
 const lines=fs.readFileSync(file,'utf8').split(/\r?\n/),mapping=[],deleted=new Set(),scales={};let section='';
 for(const raw of lines){const line=raw.trim();if(!line||line.startsWith('#'))continue;
  if(/^[xyz]_scale /.test(line)){const a=line.split(/\s+/);scales[a[0][0]]=a.slice(1).map(Number);}
  if(line.startsWith('verts ')){section='verts';continue;}
  if(line==='delete_verts'){section='delete';continue;}
  if(!/^\d/.test(line))continue;
  if(section==='verts')mapping.push(line.split(/\s+/).map(Number));
  if(section==='delete'){const a=line.split(/\s+/);for(let i=0;i<a.length;i++){const n=Number(a[i]);if(!Number.isFinite(n))continue;if(a[i+1]==='-'){for(let j=n;j<=Number(a[i+2]);j++)deleted.add(j);i+=2;}else deleted.add(n);}}
 }
 return {mapping,deleted,scales};
}
(async()=>{
 const {MeshoptEncoder}=await import('../output/avatar-tools/node_modules/meshoptimizer/index.js');await MeshoptEncoder.ready;
 const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder});
 const doc=await io.read('output/avatar-review/source-model.glb');
 const base=obj(dir+'base.obj');
 const bodyMesh=doc.getRoot().listMeshes().find(m=>m.getName()==='base');
 const body=bodyMesh.listPrimitives()[0],pos=body.getAttribute('POSITION'),uv=body.getAttribute('TEXCOORD_0');
 const joints=body.getAttribute('JOINTS_0'),weights=body.getAttribute('WEIGHTS_0');
 const bodyNode=doc.getRoot().listNodes().find(n=>n.getMesh()===bodyMesh);
 const mapped=new Map(),reverse=[];
 for(const precision of [5,4]){
  const lookup=new Map();for(const f of base.faces)for(const [vi,ti] of f){const t=base.uvs[ti];if(t)lookup.set(t[0].toFixed(precision)+','+(1-t[1]).toFixed(precision),vi);}
  for(let i=0;i<uv.getCount();i++){
   if(reverse[i]!==undefined)continue;
   const t=uv.getElement(i,[]),vi=lookup.get(t[0].toFixed(precision)+','+t[1].toFixed(precision));
   if(vi!==undefined){reverse[i]=vi;if(!mapped.has(vi))mapped.set(vi,{target:pos.getElement(i,[]),source:i});}
  }
 }
 const affine=[0,1,2].map(axis=>{const pairs=[...mapped].map(([i,v])=>[base.positions[i][axis],v.target[axis]]);const n=pairs.length,sx=pairs.reduce((s,p)=>s+p[0],0),sy=pairs.reduce((s,p)=>s+p[1],0),sxx=pairs.reduce((s,p)=>s+p[0]*p[0],0),sxy=pairs.reduce((s,p)=>s+p[0]*p[1],0);const a=(n*sxy-sx*sy)/(n*sxx-sx*sx);return [a,(sy-a*sx)/n]});console.log('Affine',affine);
 const baseTree=tree([...mapped].map(([id,v])=>({p:base.positions[id],id,...v})));
 const fittedBase=base.positions.map((p,id)=>{
  if(mapped.has(id))return mapped.get(id).target;
  const close=nearest(baseTree,p,8),sum=close.reduce((s,n)=>s+1/Math.max(.00001,n.d),0);
  return p.map((v,axis)=>v*.1+close.reduce((s,n)=>s+(n.item.target[axis]-n.item.p[axis]*.1)/Math.max(.00001,n.d)/sum,0));
 });
 // The source body is already cut away under its original outfit. Retain that
 // outfit as a weight source for the missing torso, but never render it.
 const skinPoints=[];for(const m of doc.getRoot().listMeshes().filter(m=>['base','female_casualsuit01'].includes(m.getName())))for(const prim of m.listPrimitives()){const pp=prim.getAttribute('POSITION'),jj=prim.getAttribute('JOINTS_0'),ww=prim.getAttribute('WEIGHTS_0');for(let i=0;i<pp.getCount();i++)skinPoints.push({p:pp.getElement(i,[]),j:jj.getElement(i,[]),w:ww.getElement(i,[])})}const skinTree=tree(skinPoints);
 const skinFor=p=>{
  const sums=new Map();for(const n of nearest(skinTree,p,4)){
   const js=n.item.j,ws=n.item.w,distance=Math.max(1e-7,n.d);
   for(let k=0;k<4;k++)sums.set(js[k],(sums.get(js[k])||0)+ws[k]/distance);
  }
  const ranked=[...sums].sort((a,b)=>b[1]-a[1]).slice(0,4);while(ranked.length<4)ranked.push([0,0]);
  const total=ranked.reduce((s,a)=>s+a[1],0);return {j:ranked.map(a=>a[0]),w:ranked.map(a=>a[1]/total)};
 };
 const deleted=new Set();
 const buffer=doc.getRoot().listBuffers()[0];
 function accessor(type,array){return doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);}
 async function garment(name,objFile,mhcloFile,material){
  const asset=obj(dir+objFile),clothes=parseClothes(dir+mhcloFile);clothes.deleted.forEach(i=>deleted.add(i));
  if(asset.positions.length!==clothes.mapping.length)throw Error(name+' vertex count mismatch');
  const scale=[0,1,2].map(axis=>{const s=clothes.scales['xyz'[axis]];return s?Math.abs(fittedBase[s[0]][axis]-fittedBase[s[1]][axis])/s[2]:.1;});
  const fitted=(name==='Leather shoes'||name==='Chestnut bob')?clothes.mapping.map(a=>a.length===1?fittedBase[a[0]].slice():[0,1,2].map(k=>fittedBase[a[0]][k]*a[3]+fittedBase[a[1]][k]*a[4]+fittedBase[a[2]][k]*a[5]+a[6+k]*scale[k])):asset.positions.map(p=>{
   const close=nearest(baseTree,p,16),sum=close.reduce((s,n)=>s+1/Math.max(.002,n.d),0);
   const blend=Math.max(0,Math.min(1,(Math.sqrt(close[0].d)-.30)/.60));
   return p.map((v,k)=>{const local=v*.1+close.reduce((s,n)=>s+(n.item.target[k]-n.item.p[k]*.1)/Math.max(.002,n.d)/sum,0);const global=v*affine[k][0]+affine[k][1];return local*(1-blend)+global*blend;});
  });
  // Fit shoulders and complete sleeves from the garment author's body mapping.
  // Nearest-vertex fitting collapsed the sleeve toward the trunk before posing.
  if(name==='Tailored suit') {
    const authored=clothes.mapping.map(a=>a.length===1?fittedBase[a[0]].slice():[0,1,2].map(k=>fittedBase[a[0]][k]*a[3]+fittedBase[a[1]][k]*a[4]+fittedBase[a[2]][k]*a[5]+a[6+k]*scale[k]));
    const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
    fitted.forEach((p,i)=>{
      const collar=smooth(1.34,1.46,p[1]);
      const sleeve=smooth(.15,.27,Math.abs(p[0]))*smooth(.82,1.0,p[1]);
      const blend=Math.max(collar,sleeve,smooth(1.07,1.25,p[1]));
      for(let k=0;k<3;k++)p[k]+=(authored[i][k]-p[k])*blend;
    });
  }
  if(name==='Tailored suit'||name==='Chestnut bob'){
    const adjacent=fitted.map(()=>new Set());for(const face of asset.faces)for(let i=0;i<face.length;i++){const a=face[i][0],z=face[(i+1)%face.length][0];adjacent[a].add(z);adjacent[z].add(a);}
    for(const strength of [.28,-.29,.28,-.29]){
      const before=fitted.map(v=>v.slice());for(let i=0;i<fitted.length;i++){const list=[...adjacent[i]];if(!list.length)continue;for(let k=0;k<3;k++)fitted[i][k]+=strength*(list.reduce((s,j)=>s+before[j][k],0)/list.length-before[i][k]);}
    }
  }
  const skins=fitted.map(skinFor),position=[],tex=[],joint=[],weight=[],indices=[],lookup=new Map();
  // Smooth the transferred weights so shoulder vertices bend as one fabric surface.
  if(name==='Tailored suit') {
    const adjacent=fitted.map(()=>new Set());
    for(const face of asset.faces)for(let i=0;i<face.length;i++){const a=face[i][0],b=face[(i+1)%face.length][0];adjacent[a].add(b);adjacent[b].add(a);}
    for(let pass=0;pass<8;pass++){
      const previous=skins.map(s=>({j:s.j.slice(),w:s.w.slice()}));
      for(let i=0;i<skins.length;i++){
        const neighbors=[...adjacent[i]];if(!neighbors.length)continue;
        const totals=new Map();
        for(const [v,factor] of [[i,.5],...neighbors.map(j=>[j,.5/neighbors.length])])for(let k=0;k<4;k++)totals.set(previous[v].j[k],(totals.get(previous[v].j[k])||0)+previous[v].w[k]*factor);
        const ranked=[...totals].sort((a,b)=>b[1]-a[1]).slice(0,4);while(ranked.length<4)ranked.push([0,0]);
        const sum=ranked.reduce((s,v)=>s+v[1],0);skins[i]={j:ranked.map(v=>v[0]),w:ranked.map(v=>v[1]/sum)};
      }
    }
  }
  function vertex(ref){const key=ref[0]+'/'+ref[1];if(lookup.has(key))return lookup.get(key);const index=position.length/3;lookup.set(key,index);position.push(...fitted[ref[0]]);const t=asset.uvs[ref[1]]||[0,0];tex.push(t[0],1-t[1]);joint.push(...skins[ref[0]].j);weight.push(...skins[ref[0]].w);return index;}
  for(const face of asset.faces)for(let i=1;i<face.length-1;i++)indices.push(vertex(face[0]),vertex(face[i]),vertex(face[i+1]));
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(position,3));geometry.setIndex(indices);geometry.computeVertexNormals();
  const normalSums=new Map(),norm=geometry.getAttribute('normal');
  for(const [key,index] of lookup){const id=Number(key.split('/')[0]),sum=normalSums.get(id)||[0,0,0];for(let k=0;k<3;k++)sum[k]+=norm.array[index*3+k];normalSums.set(id,sum);}
  for(const [key,index] of lookup){const sum=normalSums.get(Number(key.split('/')[0])),len=Math.hypot(...sum)||1;for(let k=0;k<3;k++)norm.array[index*3+k]=sum[k]/len;}
  const primitive=doc.createPrimitive().setAttribute('POSITION',accessor('VEC3',new Float32Array(position))).setAttribute('NORMAL',accessor('VEC3',geometry.getAttribute('normal').array)).setAttribute('TEXCOORD_0',accessor('VEC2',new Float32Array(tex))).setAttribute('JOINTS_0',accessor('VEC4',new Uint16Array(joint))).setAttribute('WEIGHTS_0',accessor('VEC4',new Float32Array(weight))).setIndices(accessor('SCALAR',new Uint32Array(indices))).setMaterial(material);
  const mesh=doc.createMesh(name).addPrimitive(primitive),node=doc.createNode(name).setMesh(mesh).setSkin(bodyNode.getSkin());
  node.setMatrix(bodyNode.getMatrix());bodyNode.getParentNode().addChild(node);
  let maxEdge=0,bad=0,example;for(let k=0;k<indices.length;k+=3)for(let a=0;a<3;a++){const i=indices[k+a],j=indices[k+(a+1)%3],d=Math.hypot(...[0,1,2].map(v=>position[i*3+v]-position[j*3+v]));if(d>maxEdge){maxEdge=d;example=[position.slice(i*3,i*3+3),position.slice(j*3,j*3+3)]}if(d>.2)bad++;}
  console.log(name,{vertices:position.length/3,triangles:indices.length/3,scale,maxEdge,bad,example});
 }
 const input=await sharp(dir+'Fsuit2.png').resize(1024,1024).removeAlpha().raw().toBuffer({resolveWithObject:true});
 for(let i=0;i<input.data.length;i+=3){const r=input.data[i],g=input.data[i+1],b=input.data[i+2];
  if(r>g*1.15&&b>g*1.10){const l=(r*.22+g*.55+b*.23);input.data[i]=Math.round(l*.33);input.data[i+1]=Math.round(l*.49);input.data[i+2]=Math.round(l*.64);}
 }
 const texture=doc.createTexture('Tailored navy suit').setImage(await sharp(input.data,{raw:{width:1024,height:1024,channels:3}}).png().toBuffer()).setMimeType('image/png');
 const suitMaterial=doc.createMaterial('Tailored navy suit').setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(.88).setDoubleSided(true);
 await garment('Tailored suit','fem_suit2.obj','toigo_female_suit_2.mhclo',suitMaterial);
 const shoeMaterial=doc.createMaterial('Slate leather shoes').setBaseColorFactor([.025,.035,.05,1]).setMetallicFactor(0).setRoughnessFactor(.44).setDoubleSided(true);
 await garment('Leather shoes','flats.obj','toigo_flats.mhclo',shoeMaterial);
 // Use the clothing author's coverage masks to avoid skin intersecting the suit.
 const oldIndices=body.getIndices().getArray(),kept=[];
 for(let i=0;i<oldIndices.length;i+=3){const tri=[oldIndices[i],oldIndices[i+1],oldIndices[i+2]];if(tri.some(v=>pos.getElement(v,[])[1]>1.475)||!tri.every(v=>deleted.has(reverse[v])))kept.push(...tri);}
 body.setIndices(accessor('SCALAR',new Uint32Array(kept)));
 for(const node of doc.getRoot().listNodes())if(node.getMesh()?.getName()==='female_casualsuit01')node.dispose();
  // Keep the wardrobe, but refine its surface and the character's portrait features.
  const hairRaw=await sharp('output/portrait-review/GingerHair.png').resize(2048,2048).removeAlpha().raw().toBuffer({resolveWithObject:true});
  for(let i=0;i<hairRaw.data.length;i+=3){const l=hairRaw.data[i]*.30+hairRaw.data[i+1]*.5+hairRaw.data[i+2]*.2;hairRaw.data[i]=Math.round(l*.28);hairRaw.data[i+1]=Math.round(l*.19);hairRaw.data[i+2]=Math.round(l*.15);}
  const hairTexture=doc.createTexture('Chestnut bob strands').setImage(await sharp(hairRaw.data,{raw:{width:2048,height:2048,channels:3}}).png().toBuffer()).setMimeType('image/png');
  const hairMaterial=doc.createMaterial('Chestnut bob').setBaseColorTexture(hairTexture).setMetallicFactor(0).setRoughnessFactor(.56).setDoubleSided(true);
  await garment('Chestnut bob','../portrait-review/bob_curled_under.obj','../portrait-review/toigo_curled_under_bob.mhclo',hairMaterial);
  for(const node of doc.getRoot().listNodes())if(['ponytail01','mind_eyebrows_02'].includes(node.getMesh()?.getName()))node.dispose();

  function portraitPoint(point){
    let [x,y,z]=point;
    if(y<1.50)return point.slice();
    const front=Math.max(0,Math.min(1,(z-.065)/.05));
    const jaw=Math.exp(-Math.pow((y-1.562)/.043,2))*front;
    x*=1-.055*jaw;
    y+=.0035*jaw;
    const eye=Math.exp(-Math.pow((Math.abs(x)-.030)/.025,2)-Math.pow((y-1.651)/.019,2))*front;
    y-=(y-1.651)*.085*eye;
    const nose=Math.exp(-Math.pow(x/.016,2)-Math.pow((y-1.619)/.026,2))*front;
    z-=.0025*nose;
    return [x,y,z];
  }
  for(const mesh of doc.getRoot().listMeshes()){
    if(!['base','high-poly','mind_eyelashes_02','teeth_base','tongue01'].includes(mesh.getName()))continue;
    for(const primitive of mesh.listPrimitives()){
      const positions=primitive.getAttribute('POSITION'),original=Array.from({length:positions.getCount()},(_,i)=>positions.getElement(i,[]));
      for(const target of primitive.listTargets()){
        const delta=target.getAttribute('POSITION');if(!delta)continue;
        for(let i=0;i<delta.getCount();i++){const d=delta.getElement(i,[]),a=portraitPoint(original[i]),b=portraitPoint(original[i].map((v,k)=>v+d[k]));delta.setElement(i,b.map((v,k)=>v-a[k]));}
      }
      original.forEach((p,i)=>positions.setElement(i,portraitPoint(p)));
      const material=primitive.getMaterial();
      if(mesh.getName()==='base')material.setBaseColorFactor([.94,.87,.83,1]).setRoughnessFactor(.67);
      if(mesh.getName()==='mind_eyelashes_02')material.setBaseColorFactor([.045,.026,.018,1]).setRoughnessFactor(.9);
    }
  }

  const browMaterial=doc.createMaterial('Soft brown eyebrows').setBaseColorFactor([.038,.022,.015,1]).setMetallicFactor(0).setRoughnessFactor(.95).setDoubleSided(true);
  for(const side of [-1,1]){
    const curve=new THREE.CatmullRomCurve3([[.012,1.663,.157],[.024,1.670,.156],[.039,1.672,.149],[.055,1.663,.137]].map(p=>new THREE.Vector3(p[0]*side,p[1],p[2])));
    const pp=[],nn=[],jj=[],ww=[],ii=[];
    for(let i=0;i<=32;i++){
      const t=i/32,p=curve.getPoint(t),width=.00165*Math.sin(Math.PI*(.10+.86*t));
      for(const edge of [-1,1]){const v=[p.x,p.y+edge*width,p.z+.0006],s=skinFor(v);pp.push(...v);nn.push(0,0,1);jj.push(...s.j);ww.push(...s.w);}
      if(i<32){const k=i*2;ii.push(k,k+1,k+2,k+1,k+3,k+2);}
    }
    const primitive=doc.createPrimitive().setAttribute('POSITION',accessor('VEC3',new Float32Array(pp))).setAttribute('NORMAL',accessor('VEC3',new Float32Array(nn))).setAttribute('JOINTS_0',accessor('VEC4',new Uint16Array(jj))).setAttribute('WEIGHTS_0',accessor('VEC4',new Float32Array(ww))).setIndices(accessor('SCALAR',new Uint16Array(ii))).setMaterial(browMaterial);
    const node=doc.createNode('Natural brow '+side).setMesh(doc.createMesh('Natural brow '+side).addPrimitive(primitive)).setSkin(bodyNode.getSkin());bodyNode.getParentNode().addChild(node);
  }

 const expressions=new Set(['eyeBlinkLeft','eyeBlinkRight','jawOpen','mouthSmileLeft','mouthSmileRight','mouthFunnel','browInnerUp']);
 for(const mesh of doc.getRoot().listMeshes()){
  const names=mesh.getExtras().targetNames||[];if(!names.length)continue;
  const selected=names.map((n,i)=>expressions.has(n)?i:-1).filter(i=>i>=0);
  for(const primitive of mesh.listPrimitives())primitive.listTargets().forEach((t,i)=>{if(!selected.includes(i))primitive.removeTarget(t);});
  mesh.setExtras({...mesh.getExtras(),targetNames:selected.map(i=>names[i])}).setWeights(selected.map(()=>0));
  for(const node of doc.getRoot().listNodes())if(node.getMesh()===mesh)node.setWeights(selected.map(()=>0));
 }
 await doc.transform(prune(),dedup(),textureCompress({encoder:sharp,targetFormat:'webp',resize:[2048,2048],quality:90}),meshopt({encoder:MeshoptEncoder,level:'medium'}));
 await io.write(output,doc);
 console.log('Saved',fs.statSync(output).size,'bytes; removed covered triangles', (oldIndices.length-kept.length)/3);
})().catch(e=>{console.error(e);process.exitCode=1;});
